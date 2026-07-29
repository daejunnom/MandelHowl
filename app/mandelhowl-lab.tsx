"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  loadResonanceDataset,
  type ResonanceDatasetLoadResult,
  type VerifiedAssetProgressEvent,
} from "@/packages/asset-runtime/src";
import { SafeAudioEngine } from "@/packages/audio-engine/src";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  type DiagnosticRecord,
  type RuntimeSnapshot,
} from "@/packages/contracts/src";
import {
  createDiagnostic,
  diagnosticsForCapabilities,
  mergeDiagnostics,
  presentDiagnostics,
  probeRuntimeCapabilities,
} from "@/packages/diagnostics/src";
import {
  type DialCommand,
  type DialKeyboardKey,
} from "@/packages/dial-engine/src";
import {
  createPlateRenderer,
  type PlateRenderer,
  type PlateRendererStatus,
  type PlateTextureSource,
} from "@/packages/render-engine/src";
import {
  advanceMandelHowlRuntime,
  createMandelHowlRuntime,
  createRuntimeSnapshotWriter,
  dispatchRuntimeDial,
  getRuntimeSnapshot,
  PROTOTYPE_MODAL_DATASET,
  replaceMandelHowlDataset,
  resetMandelHowlRuntimeAfterPausedGap,
  type MandelHowlRuntimeState,
} from "@/packages/resonance-engine/src";
import {
  createChallengeHostBridge,
  type ChallengeHostBridge,
  installRuntimeHealthHook,
  RuntimeSnapshotLeaseFanout,
  RuntimeSnapshotStore,
  type MandelHowlHealthSnapshot,
} from "@/packages/browser-runtime/src";
import { MandelHowlScene } from "./mandelhowl-scene";

interface ViewState {
  readonly snapshot: RuntimeSnapshot;
  readonly dragging: boolean;
  readonly minimumFrequencyHz: number;
  readonly maximumFrequencyHz: number;
}

type DatasetStatus = "loading" | "verified" | "prototype" | "error";

const DIAL_KEYS = new Set<string>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

const PRESENTATION_SNAPSHOT_INTERVAL_SECONDS = 1 / 24;

const PROTOTYPE_DIAGNOSTIC = createDiagnostic({
  code: "MH-DATASET-PROTOTYPE",
  severity: "info",
  evidenceState: "needs_evidence",
  messageKey: "dataset.prototype",
  evidence: [
    {
      key: "dataset",
      value: "prototype-analytical-plate-v1",
      source: "runtime-system",
    },
    {
      key: "productionBakeRequired",
      value: true,
      source: "runtime-system",
    },
  ],
});

const DATASET_PENDING_DIAGNOSTIC = createDiagnostic({
  code: "MH-DATASET-PENDING",
  severity: "info",
  messageKey: "dataset.pending",
  evidence: [
    {
      key: "manifestUrl",
      value: "/runtime/manifest.json",
      source: "asset-runtime",
    },
  ],
});

function dialCommandPoint(
  event: PointerEvent<HTMLDivElement>,
  state: MandelHowlRuntimeState,
) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    point: {
      x: event.clientX,
      y: event.clientY,
    },
    center: {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    },
    deadZoneRadius:
      Math.min(bounds.width, bounds.height) * state.dial.config.radialDeadZone,
  };
}

export function activeMode(snapshot: RuntimeSnapshot): {
  index: number | null;
  phase: number;
} {
  if (snapshot.activeModeId === null) {
    return { index: null, phase: 0 };
  }
  const capturedIndex = snapshot.modes.findIndex(
    (mode) => mode.modeId === snapshot.activeModeId,
  );
  return {
    index: capturedIndex >= 0 ? capturedIndex : null,
    phase:
      capturedIndex >= 0 ? (snapshot.modes[capturedIndex]?.phaseRad ?? 0) : 0,
  };
}

function plateTextureSource(
  result: Extract<ResonanceDatasetLoadResult, { status: "ready" }>,
): PlateTextureSource {
  return Object.freeze({
    datasetId: result.manifest.datasetId,
    atlases: Object.freeze(
      result.manifest.files.textures.map((texture) =>
        Object.freeze({
          kind: texture.kind,
          url: result.assetUrls.byPath[texture.path],
          mediaType: texture.mediaType,
          modeIds: texture.modeIds,
          width: texture.widthPx,
          height: texture.heightPx,
          layers: texture.layers,
          bytes: result.assets.get(texture.path),
        }),
      ),
    ),
  });
}

interface PlateTexturePreviewQueue {
  readonly onAssetVerified: (event: VerifiedAssetProgressEvent) => void;
  readonly waitForIdle: () => Promise<void>;
  readonly dispose: () => void;
}

function previewTextureSource(
  event: VerifiedAssetProgressEvent,
): PlateTextureSource | null {
  const texture = event.texture;
  if (
    event.datasetReady !== false ||
    event.textureKind !== "sand-density" ||
    texture?.kind !== "sand-density"
  ) {
    return null;
  }

  return Object.freeze({
    // Keep the canonical ID so the final full-source install can reuse this
    // upload. Scientific VERIFIED authority remains exclusively with the
    // loader's ready result and datasetStatus, never renderer telemetry.
    datasetId: event.datasetId,
    atlases: Object.freeze([
      Object.freeze({
        kind: "sand-density",
        url: event.url,
        mediaType: event.mediaType,
        // Preserve production IDs exactly. Prototype pXX IDs therefore cannot
        // be accidentally mapped to production layers by array position.
        modeIds: texture.modeIds,
        width: texture.widthPx,
        height: texture.heightPx,
        layers: texture.layers,
        bytes: event.bytes,
      }),
    ]),
  });
}

/**
 * Serializes the synchronous loader progress callback onto the renderer's
 * asynchronous texture API. Preview failures are observed and contained; the
 * final, complete source is still independently installed and status-checked.
 */
export function createPlateTexturePreviewQueue(
  renderer: Pick<PlateRenderer, "setTextureSource">,
): PlateTexturePreviewQueue {
  let disposed = false;
  let acceptedDatasetId: string | null = null;
  let tail: Promise<void> = Promise.resolve();

  const onAssetVerified = (event: VerifiedAssetProgressEvent) => {
    if (disposed || acceptedDatasetId !== null) return;
    const source = previewTextureSource(event);
    if (!source) return;
    acceptedDatasetId = event.datasetId;
    tail = tail
      .then(async () => {
        if (disposed) return;
        await renderer.setTextureSource(source);
      })
      .catch(() => {
        // Prewarming is observational. A rejected preview must neither become
        // unhandled nor authorize the runtime dataset transition.
      });
  };

  return Object.freeze({
    onAssetVerified,
    waitForIdle: () => tail,
    dispose: () => {
      disposed = true;
    },
  });
}

function diagnosticSignature(records: readonly DiagnosticRecord[]): string {
  return records
    .map(
      (record) =>
        `${record.code}:${record.severity}:${record.evidenceState}:${record.messageKey}`,
    )
    .sort()
    .join("|");
}

export function MandelHowlLab() {
  const [initialRuntime] = useState(() =>
    createMandelHowlRuntime({
      initialFrequencyHz: 220,
      diagnostics: [PROTOTYPE_DIAGNOSTIC],
      datasetReadiness: "analytical-fallback",
    }),
  );
  const runtimeRef = useRef<MandelHowlRuntimeState>(initialRuntime);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PlateRenderer | null>(null);
  const rendererStatusRef = useRef<PlateRendererStatus | null>(null);
  const challengeRef = useRef<ChallengeHostBridge | null>(null);
  const challengeTargetRef = useRef<number | null>(null);
  const lastReportedResultRef = useRef<string | null>(null);
  const [audioEngine] = useState(() => new SafeAudioEngine());

  const initialSnapshot = getRuntimeSnapshot(initialRuntime);
  const [viewState, setViewState] = useState<ViewState>(() => ({
    snapshot: initialSnapshot,
    dragging: initialRuntime.dial.dragging,
    minimumFrequencyHz: initialRuntime.dial.config.minFrequencyHz,
    maximumFrequencyHz: initialRuntime.dial.config.maxFrequencyHz,
  }));
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [datasetStatus, setDatasetStatus] = useState<DatasetStatus>("loading");
  const [challengeTarget, setChallengeTarget] = useState<number | null>(null);
  const [rendererStatus, setRendererStatus] =
    useState<PlateRendererStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<readonly DiagnosticRecord[]>(
    () => [PROTOTYPE_DIAGNOSTIC, DATASET_PENDING_DIAGNOSTIC],
  );
  const lastSnapshotDiagnosticSignatureRef = useRef(
    diagnosticSignature(initialSnapshot.diagnostics),
  );

  const pushDiagnostic = useCallback((diagnostic: DiagnosticRecord) => {
    setDiagnostics((current) => mergeDiagnostics(current, [diagnostic]));
  }, []);
  useEffect(() => {
    audioEngine.setObservers({ onDiagnostic: pushDiagnostic });
    return () => {
      audioEngine.setObservers({});
    };
  }, [audioEngine, pushDiagnostic]);

  const dispatchDial = useCallback((command: DialCommand) => {
    runtimeRef.current = dispatchRuntimeDial(runtimeRef.current, command);
  }, []);

  const activateAudio = useCallback(async () => {
    if (audioEngine.isActivated) return;
    const active = await audioEngine.activate();
    setAudioEnabled(Boolean(active));
  }, [audioEngine]);

  const onDialPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some assistive pointer adapters do not expose capture.
      }
      const currentRuntime = runtimeRef.current;
      dispatchDial({
        type: "pointer-start",
        ...dialCommandPoint(event, currentRuntime),
        timestampMs: event.timeStamp,
      });
      // Gesture affordance is local UI state, so it can update immediately
      // without allocating or retaining an extra runtime snapshot.
      setViewState((current) =>
        current.dragging ? current : { ...current, dragging: true },
      );
      void activateAudio();
    },
    [activateAudio, dispatchDial],
  );

  const onDialPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const currentRuntime = runtimeRef.current;
      if (!currentRuntime.dial.dragging) return;
      event.preventDefault();
      dispatchDial({
        type: "pointer-move",
        ...dialCommandPoint(event, currentRuntime),
        timestampMs: event.timeStamp,
      });
    },
    [dispatchDial],
  );

  const finishPointerGesture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (runtimeRef.current.dial.dragging) {
        dispatchDial({
          type: "pointer-end",
          timestampMs: event.timeStamp,
        });
      }
      setViewState((current) =>
        current.dragging ? { ...current, dragging: false } : current,
      );
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [dispatchDial],
  );

  const onDialLostPointerCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!runtimeRef.current.dial.dragging) return;
      dispatchDial({
        type: "pointer-end",
        timestampMs: event.timeStamp,
      });
      setViewState((current) =>
        current.dragging ? { ...current, dragging: false } : current,
      );
    },
    [dispatchDial],
  );

  const onDialKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!DIAL_KEYS.has(event.key)) return;
      event.preventDefault();
      dispatchDial({
        type: "keyboard",
        key: event.key as DialKeyboardKey,
        timestampMs: event.timeStamp,
      });
      void activateAudio();
    },
    [activateAudio, dispatchDial],
  );

  const onDialWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      dispatchDial({
        type: "wheel",
        deltaY: event.deltaY,
        timestampMs: event.timeStamp,
      });
      void activateAudio();
    },
    [activateAudio, dispatchDial],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let animationFrame = 0;
    let previousTime = performance.now();
    let animationFrames = 0;
    const frameWorkDurations = new Float64Array(240);
    let frameWorkSampleCount = 0;
    let frameWorkWriteIndex = 0;
    let longestFrameWorkMs = 0;
    let longestFrameDeltaMs = 0;
    let visibilityCycles = 0;

    const capabilities = probeRuntimeCapabilities();
    const renderPreferences = {
      reducedMotion: capabilities.reducedMotion,
      forcedColors: capabilities.forcedColors,
    };
    setDiagnostics((current) =>
      mergeDiagnostics(current, diagnosticsForCapabilities(capabilities)),
    );

    const renderer = createPlateRenderer(canvas, {
      preferences: renderPreferences,
      logicalProcessors: capabilities.logicalProcessors,
      deviceMemoryGb: capabilities.deviceMemoryGb,
      fallbackModes: PROTOTYPE_MODAL_DATASET.modes.map((mode) => ({
        modeId: mode.id,
        radialOrder: mode.radialOrder,
        angularOrder: mode.angularOrder,
      })),
      onDiagnostic: pushDiagnostic,
      onStatus: (status) => {
        rendererStatusRef.current = status;
        setRendererStatus((current) => {
          if (
            current?.kind === status.kind &&
            current.quality === status.quality &&
            current.datasetId === status.datasetId &&
            current.textureReady === status.textureReady &&
            current.contextLost === status.contextLost
          ) {
            return current;
          }
          return status;
        });
      },
    });
    rendererRef.current = renderer;
    rendererStatusRef.current = renderer.status;
    setRendererStatus(renderer.status);
    const texturePreviewQueue = createPlateTexturePreviewQueue(renderer);
    const datasetAbortController = new AbortController();

    const challenge = createChallengeHostBridge((target) => {
      challengeTargetRef.current = target;
      lastReportedResultRef.current = null;
      setChallengeTarget(target);
    });
    challengeRef.current = challenge;
    challengeTargetRef.current = challenge.initialTarget;
    setChallengeTarget(challenge.initialTarget);

    const reportConsumerFailure = (
      lane: "hot-path" | "presentation",
      error: unknown,
      sequence: number,
    ) => {
      // Only copy primitives from a hot-path lease. React state and diagnostic
      // queues must never retain the writer-owned backing graph.
      const reason = error instanceof Error ? error.message : "unknown";
      pushDiagnostic(
        createDiagnostic({
          code: "MH-SNAPSHOT-CONSUMER-FAILED",
          severity: "warning",
          messageKey: "runtime.snapshotConsumerFailed",
          evidence: [
            {
              key: "sequence",
              value: sequence,
              source: `snapshot-${lane}`,
            },
            {
              key: "reason",
              value: reason,
              source: `snapshot-${lane}`,
            },
          ],
        }),
      );
    };

    // Renderer and audio are synchronous, non-retaining consumers of the same
    // reusable lease. A consumer failure is isolated so the other still sees
    // the current frame.
    const snapshotWriter = createRuntimeSnapshotWriter();
    const hotPathFanout = new RuntimeSnapshotLeaseFanout(
      [
        (snapshot) => renderer.render(snapshot),
        (snapshot) => audioEngine.applyRuntimeSnapshot(snapshot),
      ],
      (error, snapshot) => {
        reportConsumerFailure("hot-path", error, snapshot.sequence);
      },
    );

    // React, challenge reporting, and diagnostics receive owned immutable
    // snapshots only. This fan-out is published at no more than 24 Hz during
    // normal animation so presentation work cannot starve the fixed-step loop.
    const presentationFanout = new RuntimeSnapshotStore(
      getRuntimeSnapshot(runtimeRef.current),
      [
        (snapshot) => {
          const runtime = runtimeRef.current;
          setViewState({
            snapshot,
            dragging: runtime.dial.dragging,
            minimumFrequencyHz: runtime.dial.config.minFrequencyHz,
            maximumFrequencyHz: runtime.dial.config.maxFrequencyHz,
          });
        },
        (snapshot) => {
          if (snapshot.volume.status !== "settled") return;
          const target = challengeTargetRef.current;
          const signature = `${snapshot.datasetId}:${target ?? "none"}:${snapshot.volume.value}`;
          if (signature === lastReportedResultRef.current) return;
          lastReportedResultRef.current = signature;
          challenge.reportSettledResult({
            targetVolume: target,
            volume: snapshot.volume.value,
            sequence: snapshot.sequence,
            datasetId: snapshot.datasetId,
            reached: target !== null && snapshot.volume.value === target,
          });
        },
        (snapshot) => {
          const signature = diagnosticSignature(snapshot.diagnostics);
          if (signature === lastSnapshotDiagnosticSignatureRef.current) return;
          lastSnapshotDiagnosticSignatureRef.current = signature;
          setDiagnostics((current) =>
            mergeDiagnostics(current, snapshot.diagnostics),
          );
        },
      ],
      (error, snapshot) => {
        reportConsumerFailure("presentation", error, snapshot.sequence);
      },
    );
    let lastPresentationTimeSeconds =
      runtimeRef.current.resonance.simulationTimeSeconds;
    let lastPresentationDatasetId =
      runtimeRef.current.resonance.dataset.datasetId;
    const publishPresentationFrame = (force = false) => {
      const runtime = runtimeRef.current;
      const simulationTimeSeconds =
        runtime.resonance.simulationTimeSeconds;
      const datasetId = runtime.resonance.dataset.datasetId;
      const datasetChanged = datasetId !== lastPresentationDatasetId;
      if (
        !force &&
        !datasetChanged &&
        simulationTimeSeconds - lastPresentationTimeSeconds <
          PRESENTATION_SNAPSHOT_INTERVAL_SECONDS
      ) {
        return;
      }

      const snapshot = getRuntimeSnapshot(runtime);
      if (presentationFanout.publish(snapshot)) {
        lastPresentationTimeSeconds = snapshot.simulationTimeSeconds;
        lastPresentationDatasetId = snapshot.datasetId;
      }
    };

    hotPathFanout.publish(snapshotWriter.write(runtimeRef.current));

    const loadDataset = async () => {
      const manifestUrl =
        window.__MANDELHOWL_DATASET_URL__ ??
        GENERATED_DATASET_RELEASE_SPEC.manifestUrl;
      const result = await loadResonanceDataset({
        manifestUrl,
        expectedDatasetId: GENERATED_DATASET_RELEASE_SPEC.datasetId,
        signal: datasetAbortController.signal,
        onAssetVerified: texturePreviewQueue.onAssetVerified,
      });
      await texturePreviewQueue.waitForIdle();
      texturePreviewQueue.dispose();
      if (disposed) return;

      if (result.status === "ready") {
        try {
          await renderer.setTextureSource(plateTextureSource(result));
        } catch {
          if (!disposed) {
            try {
              await renderer.setTextureSource(null);
            } catch {
              // A renderer that rejects both install and clear remains
              // untrusted; the runtime stays on the labelled prototype.
            }
            if (!disposed) setDatasetStatus("error");
          }
          return;
        }
        if (disposed) return;
        const textureStatus = renderer.status;
        const productionTextureFailed =
          textureStatus.kind !== "static" &&
          (textureStatus.contextLost ||
            !textureStatus.textureReady ||
            textureStatus.datasetId !== result.manifest.datasetId);
        if (productionTextureFailed) {
          try {
            await renderer.setTextureSource(null);
          } catch {
            // Status remains fail-closed below even if clearing also fails.
          }
          if (disposed) return;
          setDatasetStatus("error");
          return;
        }
        runtimeRef.current = replaceMandelHowlDataset(
          runtimeRef.current,
          result.dataset,
          result.diagnostics,
        );
        setDatasetStatus("verified");
        setDiagnostics((current) =>
          mergeDiagnostics(
            current.filter(
              (diagnostic) =>
                diagnostic.code !== "MH-DATASET-PENDING" &&
                diagnostic.code !== "MH-DATASET-PROTOTYPE",
            ),
            result.diagnostics,
          ),
        );
        hotPathFanout.publish(snapshotWriter.write(runtimeRef.current));
        publishPresentationFrame(true);
      } else {
        try {
          await renderer.setTextureSource(null);
        } catch {
          // The failed dataset is never installed into the runtime.
        }
        if (disposed) return;
        setDatasetStatus("error");
        setDiagnostics((current) =>
          mergeDiagnostics(
            current.filter(
              (diagnostic) => diagnostic.code !== "MH-DATASET-PENDING",
            ),
            result.diagnostics,
          ),
        );
      }
    };
    void loadDataset().catch(async () => {
      await texturePreviewQueue.waitForIdle();
      texturePreviewQueue.dispose();
      if (disposed) return;
      try {
        await renderer.setTextureSource(null);
      } catch {
        // Unexpected loader and renderer failures still leave the prototype
        // runtime in place and prevent a VERIFIED presentation.
      }
      if (!disposed) setDatasetStatus("error");
    });

    const tick = (time: number) => {
      if (disposed) return;
      const frameWorkStartedAt = performance.now();
      const elapsedMilliseconds = Math.max(0, time - previousTime);
      previousTime = time;
      longestFrameDeltaMs = Math.max(longestFrameDeltaMs, elapsedMilliseconds);
      animationFrames += 1;
      runtimeRef.current = advanceMandelHowlRuntime(
        runtimeRef.current,
        Math.min(0.1, elapsedMilliseconds / 1000),
      );
      hotPathFanout.publish(snapshotWriter.write(runtimeRef.current));
      publishPresentationFrame();
      const frameWorkMs = performance.now() - frameWorkStartedAt;
      longestFrameWorkMs = Math.max(longestFrameWorkMs, frameWorkMs);
      frameWorkDurations[frameWorkWriteIndex] = frameWorkMs;
      frameWorkWriteIndex =
        (frameWorkWriteIndex + 1) % frameWorkDurations.length;
      frameWorkSampleCount = Math.min(
        frameWorkDurations.length,
        frameWorkSampleCount + 1,
      );
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forcedColorsQuery = window.matchMedia("(forced-colors: active)");
    const updatePresentationPreferences = () => {
      renderPreferences.reducedMotion = motionQuery.matches;
      renderPreferences.forcedColors = forcedColorsQuery.matches;
    };
    motionQuery.addEventListener("change", updatePresentationPreferences);
    forcedColorsQuery.addEventListener("change", updatePresentationPreferences);

    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => renderer.resize())
        : null;
    resizeObserver?.observe(canvas);

    const onVisibilityChange = () => {
      visibilityCycles += 1;
      previousTime = performance.now();
      if (document.visibilityState === "hidden") {
        runtimeRef.current = resetMandelHowlRuntimeAfterPausedGap(
          runtimeRef.current,
        );
        hotPathFanout.publish(snapshotWriter.write(runtimeRef.current));
        publishPresentationFrame(true);
        void audioEngine.suspend("hidden").then(() => {
          if (!disposed) setAudioEnabled(false);
        });
      }
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void audioEngine.suspend("hidden");
      } else {
        void audioEngine.dispose();
      }
      setAudioEnabled(false);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);

    const removeHealthHook = installRuntimeHealthHook(
      (): MandelHowlHealthSnapshot => {
        const runtime = runtimeRef.current;
        const activeModeIndex = runtime.resonance.activeModeIndex;
        const sortedFrameWork = Array.from(
          frameWorkDurations.subarray(0, frameWorkSampleCount),
        ).sort((left, right) => left - right);
        const p95Index = Math.max(
          0,
          Math.ceil(sortedFrameWork.length * 0.95) - 1,
        );
        return {
          capturedAtMs: performance.now(),
          presentationFanout: presentationFanout.metrics,
          hotPathFanout: hotPathFanout.metrics,
          renderer: rendererRef.current?.status ?? rendererStatusRef.current,
          audio: audioEngine.telemetry,
          animationFrames,
          frameWorkP95Ms: sortedFrameWork[p95Index] ?? 0,
          longestFrameWorkMs,
          longestFrameDeltaMs,
          visibilityCycles,
          pausedGapResets: runtimeRef.current.resonance.pausedGapCount,
          runtime: {
            sequence: runtime.resonance.sequence,
            simulationTimeSeconds:
              runtime.resonance.simulationTimeSeconds,
            driveFrequencyHz: runtime.dial.frequencyHz,
            activeModeId:
              activeModeIndex === null
                ? null
                : (runtime.resonance.dataset.modes[activeModeIndex]?.id ??
                  null),
          },
        };
      },
    );

    return () => {
      disposed = true;
      datasetAbortController.abort();
      texturePreviewQueue.dispose();
      window.cancelAnimationFrame(animationFrame);
      motionQuery.removeEventListener("change", updatePresentationPreferences);
      forcedColorsQuery.removeEventListener(
        "change",
        updatePresentationPreferences,
      );
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      removeHealthHook();
      challenge.dispose();
      challengeRef.current = null;
      presentationFanout.dispose();
      hotPathFanout.dispose();
      renderer.dispose();
      rendererRef.current = null;
      void audioEngine.dispose();
    };
  }, [audioEngine, pushDiagnostic]);

  const snapshot = viewState.snapshot;
  const mode = activeMode(snapshot);
  const volume =
    snapshot.volume.status === "settled"
      ? snapshot.volume.value
      : (snapshot.volume.lastSettledValue ?? 0);
  const visibleDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code !== "DATASET_READY",
  );
  const presented = presentDiagnostics(visibleDiagnostics);
  const primaryDiagnostic =
    visibleDiagnostics.find(
      (diagnostic) => diagnostic.severity === presented.severity,
    ) ??
    visibleDiagnostics[0] ??
    null;

  return (
    <MandelHowlScene
      frequency={snapshot.dial.driveFrequencyHz}
      frequencyMin={viewState.minimumFrequencyHz}
      frequencyMax={viewState.maximumFrequencyHz}
      angle={snapshot.dial.unwrappedAngleRad}
      volume={volume}
      regime={snapshot.regime}
      envelope={snapshot.feedback.envelopeNormalized}
      activeMode={mode.index}
      activeModePhase={mode.phase}
      measurementProgress={snapshot.volume.progress}
      measurementStatus={snapshot.volume.status}
      microphoneRms={snapshot.microphone.rmsNormalized}
      microphonePeak={snapshot.microphone.peakNormalized}
      microphoneSamples={snapshot.microphone.recentSamples}
      audioEnabled={audioEnabled}
      rendererKind={rendererStatus?.kind ?? "static"}
      renderQuality={rendererStatus?.quality ?? "reduced"}
      datasetStatus={datasetStatus}
      diagnosticSeverity={presented.severity}
      diagnosticTitle={visibleDiagnostics.length > 0 ? presented.title : null}
      diagnosticMessage={
        visibleDiagnostics.length > 0 ? presented.message : null
      }
      diagnosticCode={primaryDiagnostic?.code ?? null}
      diagnosticDetail={presented.developerLines[0] ?? null}
      challengeTarget={challengeTarget}
      dragging={viewState.dragging}
      onDialPointerDown={onDialPointerDown}
      onDialPointerMove={onDialPointerMove}
      onDialPointerUp={finishPointerGesture}
      onDialPointerCancel={finishPointerGesture}
      onDialLostPointerCapture={onDialLostPointerCapture}
      onDialKeyDown={onDialKeyDown}
      onDialWheel={onDialWheel}
      canvasRef={canvasRef}
    />
  );
}
