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
} from "@/packages/asset-runtime/src";
import {
  SafeAudioEngine,
} from "@/packages/audio-engine/src";
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
} from "./challenge-host";
import { MandelHowlScene } from "./mandelhowl-scene";
import {
  installRuntimeHealthHook,
  type MandelHowlHealthSnapshot,
} from "./runtime-health";
import { RuntimeSnapshotFanout } from "./snapshot-fanout";

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
      Math.min(bounds.width, bounds.height) *
      state.dial.config.radialDeadZone,
  };
}

function activeMode(snapshot: RuntimeSnapshot): {
  index: number | null;
  phase: number;
} {
  let strongestIndex: number | null = null;
  let strongestEnergy = 1e-7;
  snapshot.modes.forEach((mode, index) => {
    if (mode.energyNormalized > strongestEnergy) {
      strongestIndex = index;
      strongestEnergy = mode.energyNormalized;
    }
  });
  return {
    index: strongestIndex,
    phase:
      strongestIndex === null
        ? 0
        : (snapshot.modes[strongestIndex]?.phaseRad ?? 0),
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
  const fanoutRef = useRef<RuntimeSnapshotFanout | null>(null);
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
  const [datasetStatus, setDatasetStatus] =
    useState<DatasetStatus>("loading");
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

    const challenge = createChallengeHostBridge((target) => {
      challengeTargetRef.current = target;
      lastReportedResultRef.current = null;
      setChallengeTarget(target);
    });
    challengeRef.current = challenge;
    challengeTargetRef.current = challenge.initialTarget;
    setChallengeTarget(challenge.initialTarget);

    // Render and audio consume every canonical snapshot. React text/meters are
    // sampled at a film-rate cadence so DOM reconciliation cannot starve the
    // fixed-step loop or the 30 FPS low-tier rendering target.
    let lastViewUpdateSeconds = Number.NEGATIVE_INFINITY;
    let lastViewDragging = runtimeRef.current.dial.dragging;
    const fanout = new RuntimeSnapshotFanout(
      [
        (snapshot) => renderer.render(snapshot),
        (snapshot) => audioEngine.applyRuntimeSnapshot(snapshot),
        (snapshot) => {
          const runtime = runtimeRef.current;
          const interactionChanged =
            runtime.dial.dragging !== lastViewDragging;
          if (
            !interactionChanged &&
            snapshot.simulationTimeSeconds - lastViewUpdateSeconds <
              1 / 24
          ) {
            return;
          }
          lastViewUpdateSeconds = snapshot.simulationTimeSeconds;
          lastViewDragging = runtime.dial.dragging;
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
        pushDiagnostic(
          createDiagnostic({
            code: "MH-SNAPSHOT-CONSUMER-FAILED",
            severity: "warning",
            messageKey: "runtime.snapshotConsumerFailed",
            evidence: [
              {
                key: "sequence",
                value: snapshot.sequence,
                source: "snapshot-fanout",
              },
              {
                key: "reason",
                value: error instanceof Error ? error.message : "unknown",
                source: "snapshot-fanout",
              },
            ],
          }),
        );
      },
    );
    fanoutRef.current = fanout;
    renderer.render(getRuntimeSnapshot(runtimeRef.current));

    const loadDataset = async () => {
      const manifestUrl =
        window.__MANDELHOWL_DATASET_URL__ ??
        GENERATED_DATASET_RELEASE_SPEC.manifestUrl;
      const result = await loadResonanceDataset({
        manifestUrl,
        expectedDatasetId: GENERATED_DATASET_RELEASE_SPEC.datasetId,
      });
      if (disposed) return;

      if (result.status === "ready") {
        await renderer.setTextureSource(plateTextureSource(result));
        if (disposed) return;
        const textureStatus = renderer.status;
        const productionTextureFailed =
          textureStatus.kind !== "static" &&
          (!textureStatus.textureReady ||
            textureStatus.datasetId !== result.manifest.datasetId);
        if (productionTextureFailed) {
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
        fanout.publish(getRuntimeSnapshot(runtimeRef.current));
      } else {
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
    void loadDataset();

    const tick = (time: number) => {
      if (disposed) return;
      const frameWorkStartedAt = performance.now();
      const elapsedMilliseconds = Math.max(0, time - previousTime);
      previousTime = time;
      longestFrameDeltaMs = Math.max(
        longestFrameDeltaMs,
        elapsedMilliseconds,
      );
      animationFrames += 1;
      runtimeRef.current = advanceMandelHowlRuntime(
        runtimeRef.current,
        Math.min(0.1, elapsedMilliseconds / 1000),
      );
      fanout.publish(getRuntimeSnapshot(runtimeRef.current));
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

    const motionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const forcedColorsQuery = window.matchMedia("(forced-colors: active)");
    const updatePresentationPreferences = () => {
      renderPreferences.reducedMotion = motionQuery.matches;
      renderPreferences.forcedColors = forcedColorsQuery.matches;
    };
    motionQuery.addEventListener("change", updatePresentationPreferences);
    forcedColorsQuery.addEventListener(
      "change",
      updatePresentationPreferences,
    );

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
        fanout.publish(getRuntimeSnapshot(runtimeRef.current));
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
        const sortedFrameWork = Array.from(
          frameWorkDurations.subarray(0, frameWorkSampleCount),
        ).sort((left, right) => left - right);
        const p95Index = Math.max(
          0,
          Math.ceil(sortedFrameWork.length * 0.95) - 1,
        );
        return {
          capturedAtMs: performance.now(),
          fanout: fanout.metrics,
          renderer:
            rendererRef.current?.status ?? rendererStatusRef.current,
          audio: audioEngine.telemetry,
          animationFrames,
          frameWorkP95Ms: sortedFrameWork[p95Index] ?? 0,
          longestFrameWorkMs,
          longestFrameDeltaMs,
          visibilityCycles,
          pausedGapResets:
            runtimeRef.current.resonance.pausedGapCount,
        };
      },
    );

    return () => {
      disposed = true;
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
      fanout.dispose();
      fanoutRef.current = null;
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
      (diagnostic) =>
        diagnostic.severity === presented.severity,
    ) ?? visibleDiagnostics[0] ?? null;

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
      diagnosticTitle={
        visibleDiagnostics.length > 0 ? presented.title : null
      }
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
