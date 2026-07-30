"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import type { DialCommand } from "@/packages/dial-engine/src";
import {
  createPlateRenderer,
  type PlateRenderer,
  type PlateRendererStatus,
  type PlateTextureSource,
} from "@/packages/render-engine/src";
import { SettledRenderAttestationTracker } from "@/packages/presentation-model/src";
import {
  advanceMandelHowlRuntimeInPlace,
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
  MandelHowlUiSnapshotStore,
  RuntimeSnapshotLeaseFanout,
  RuntimeSnapshotStore,
  type MandelHowlBrowserRuntimePort,
  type MandelHowlHealthSnapshot,
} from "@/packages/browser-runtime/src";
import { MandelHowlUiHost } from "./mandelhowl-ui-host";
import "./mandelhowl.css";

interface ViewState {
  readonly snapshot: RuntimeSnapshot;
  readonly dragging: boolean;
  readonly minimumFrequencyHz: number;
  readonly maximumFrequencyHz: number;
}

interface ViewPlateRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PlateRenderer;
  readonly resizeObserver: ResizeObserver | null;
  readonly reportAvailabilityFailure: (error: unknown) => void;
}

type DatasetStatus = "loading" | "verified" | "prototype" | "error";

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

export function shouldPublishSettledVolumeImmediately(
  previous: Pick<RuntimeSnapshot["volume"], "status" | "value">,
  current: Pick<RuntimeSnapshot["volume"], "status" | "value">,
): boolean {
  if (current.status !== "settled") return false;
  return (
    previous.status !== "settled" ||
    previous.value !== current.value
  );
}

function plateTextureSource(
  result: Extract<ResonanceDatasetLoadResult, { status: "ready" }>,
): PlateTextureSource {
  const deferredByPath = new Map(
    Object.values(result.textureAssets)
      .flat()
      .map((texture) => [texture.path, texture] as const),
  );
  return Object.freeze({
    datasetId: result.manifest.datasetId,
    loadingPolicy:
      result.manifest.algorithmRevision === undefined
        ? "eager-verified"
        : "mode-sharded-lazy-verified",
    materialSectionProfile:
      result.manifest.plate.materialSectionProfile,
    presentationModes: result.presentationModes,
    atlases: Object.freeze(
      result.manifest.files.textures.map((texture) => {
        const deferred = deferredByPath.get(texture.path);
        return Object.freeze({
          kind: texture.kind,
          url: deferred?.url ?? result.assetUrls.byPath[texture.path],
          mediaType: texture.mediaType,
          modeIds: texture.modeIds,
          width: texture.widthPx,
          height: texture.heightPx,
          layers: texture.layers,
          bytes: result.assets.get(texture.path),
          loadBytes: deferred?.loadBytes,
        });
      }),
    ),
  });
}

function rendererRejectedTextureSource(
  status: PlateRendererStatus,
  source: PlateTextureSource,
): boolean {
  return (
    status.contextLost ||
    status.datasetId !== source.datasetId ||
    // Canvas is the fail-operational presentation boundary. A verified
    // provider may still fail to decode/upload there; the shared presentation
    // gate keeps the UI in streaming/analytical-fallback state without
    // needlessly replacing an otherwise healthy framework view.
    (status.kind !== "canvas2d" &&
      source.loadingPolicy !== "mode-sharded-lazy-verified" &&
      !status.textureReady)
  );
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
  const viewRenderersRef = useRef<ViewPlateRenderer[]>([]);
  const secondaryTextureSourceRef = useRef<PlateTextureSource | null>(null);
  const rendererStatusRef = useRef<PlateRendererStatus | null>(null);
  const challengeRef = useRef<ChallengeHostBridge | null>(null);
  const challengeTargetRef = useRef<number | null>(null);
  const lastReportedResultRef = useRef<string | null>(null);
  const [audioEngine] = useState(() => new SafeAudioEngine());
  const [settledRenderAttestation] = useState(
    () => new SettledRenderAttestationTracker(),
  );

  const initialSnapshot = getRuntimeSnapshot(initialRuntime);
  const [runtimeSnapshots] = useState(
    () => new RuntimeSnapshotStore(initialSnapshot),
  );
  const [uiSnapshots] = useState(
    () =>
      new MandelHowlUiSnapshotStore({
        contractVersion: "mandelhowl.ui-port.v1",
        revision: 0,
        runtime: initialSnapshot,
        minimumFrequencyHz: initialRuntime.dial.config.minFrequencyHz,
        maximumFrequencyHz: initialRuntime.dial.config.maxFrequencyHz,
        radialDeadZone: initialRuntime.dial.config.radialDeadZone,
        dragging: initialRuntime.dial.dragging,
        audioEnabled: false,
        datasetStatus: "loading",
        renderer: null,
        diagnostic: {
          severity: "info",
          title: null,
          message: null,
          code: "MH-DATASET-PENDING",
          detail: null,
        },
        challengeTarget: null,
      }),
  );
  const uiRevisionRef = useRef(0);
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
    if (audioEngine.isActivated) return true;
    const active = await audioEngine.activate();
    setAudioEnabled(Boolean(active));
    return Boolean(active);
  }, [audioEngine]);

  const suspendAudioForUiIsolation = useCallback(() => {
    void audioEngine
      .suspend("error")
      .catch(() => {
        // The safe audio engine already reports lifecycle failures.
      })
      .finally(() => {
        setAudioEnabled(false);
      });
  }, [audioEngine]);

  const setDragging = useCallback((dragging: boolean) => {
    setViewState((current) =>
      current.dragging === dragging ? current : { ...current, dragging },
    );
  }, []);

  const mountViewPlate = useCallback(
    (canvas: HTMLCanvasElement) => {
      const capabilities = probeRuntimeCapabilities();
      let candidate: ViewPlateRenderer | null = null;
      let attached = true;
      let availabilityFailure: unknown | null = null;
      const availabilityFailureConsumers = new Set<
        (error: unknown) => void
      >();
      const reportAvailabilityFailure = (error: unknown) => {
        if (!attached || availabilityFailure !== null) return;
        availabilityFailure =
          error ??
          new Error("The attached plate renderer became unavailable.");
        for (const consumer of Array.from(availabilityFailureConsumers)) {
          try {
            consumer(availabilityFailure);
          } catch {
            // A supervisor observer cannot retain or destabilize the session.
          }
        }
      };
      const renderer = createPlateRenderer(canvas, {
        preferences: {
          reducedMotion: capabilities.reducedMotion,
          forcedColors: capabilities.forcedColors,
        },
        logicalProcessors: capabilities.logicalProcessors,
        deviceMemoryGb: capabilities.deviceMemoryGb,
        fallbackModes: PROTOTYPE_MODAL_DATASET.modes.map((mode) => ({
          modeId: mode.id,
          radialOrder: mode.radialOrder,
          angularOrder: mode.angularOrder,
        })),
        onDiagnostic: pushDiagnostic,
        onStatus: (status) => {
          if (
            candidate === null ||
            viewRenderersRef.current.at(-1) !== candidate
          ) {
            return;
          }
          if (status.contextLost) {
            candidate.reportAvailabilityFailure(
              new Error(
                "The attached plate renderer lost its graphics context.",
              ),
            );
            return;
          }
          rendererStatusRef.current = status;
          setRendererStatus((current) => {
            if (
              current?.kind === status.kind &&
              current.quality === status.quality &&
              current.degradationStage === status.degradationStage &&
              current.datasetId === status.datasetId &&
              current.textureReady === status.textureReady &&
              current.materialSectionReady ===
                status.materialSectionReady &&
              current.contextLost === status.contextLost
            ) {
              return current;
            }
            return status;
          });
        },
      });
      const resizeObserver =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => renderer.resize())
          : null;
      candidate = Object.freeze({
        canvas,
        renderer,
        resizeObserver,
        reportAvailabilityFailure,
      });
      viewRenderersRef.current = [...viewRenderersRef.current, candidate];
      rendererStatusRef.current = renderer.status;
      setRendererStatus(Object.freeze({ ...renderer.status }));
      resizeObserver?.observe(canvas);
      const textureSource = secondaryTextureSourceRef.current;
      if (textureSource) {
        void renderer
          .setTextureSource(textureSource)
          .then(async () => {
            const status = renderer.status;
            if (
              status.kind !== "static" &&
              rendererRejectedTextureSource(status, textureSource)
            ) {
              reportAvailabilityFailure(
                new Error(
                  status.contextLost
                    ? "The attached plate renderer lost its graphics context."
                    : status.datasetId !== textureSource.datasetId
                      ? "The attached plate renderer selected the wrong verified dataset."
                      : "The attached plate renderer rejected the verified texture.",
                ),
              );
              await renderer.setTextureSource(null);
            }
          })
          .catch(async (error: unknown) => {
            reportAvailabilityFailure(error);
            try {
              await renderer.setTextureSource(null);
            } catch {
              // The view stays on the CSS plate if even clearing is rejected.
            }
            pushDiagnostic(
              createDiagnostic({
                code: "MH-UI-PLATE-ATTACH-FAILED",
                severity: "warning",
                messageKey: "runtime.rendererFallback",
                evidence: [
                  {
                    key: "candidate",
                    value: "view",
                    source: "ui-supervisor",
                  },
                ],
              }),
            );
          });
      }

      return Object.freeze({
        subscribeAvailabilityFailure: (
          consumer: (error: unknown) => void,
        ) => {
          if (!attached) {
            consumer(
              availabilityFailure ??
                new Error("The plate attachment has already been detached."),
            );
            return () => {};
          }
          availabilityFailureConsumers.add(consumer);
          if (availabilityFailure !== null) {
            consumer(availabilityFailure);
          }
          return () => {
            availabilityFailureConsumers.delete(consumer);
          };
        },
        detach: () => {
          if (!attached) return;
          attached = false;
          availabilityFailureConsumers.clear();
          resizeObserver?.disconnect();
          settledRenderAttestation.clear(canvas);
          if (renderer.canvas !== canvas) {
            settledRenderAttestation.clear(renderer.canvas);
          }
          viewRenderersRef.current = viewRenderersRef.current.filter(
            (entry) => entry !== candidate,
          );
          renderer.dispose();
          const fallbackStatus =
            viewRenderersRef.current.at(-1)?.renderer.status ??
            rendererRef.current?.status ??
            null;
          rendererStatusRef.current = fallbackStatus;
          setRendererStatus(
            fallbackStatus
              ? Object.freeze({ ...fallbackStatus })
              : null,
          );
        },
      });
    },
    [pushDiagnostic, settledRenderAttestation],
  );

  const uiPort = useMemo<MandelHowlBrowserRuntimePort>(
    () => {
      // The frozen port stores callbacks but never invokes them during render.
      // eslint-disable-next-line react-hooks/refs
      return Object.freeze({
        contractVersion: "mandelhowl.ui-port.v1" as const,
        snapshots: runtimeSnapshots,
        presentation: uiSnapshots,
        mountPlate: mountViewPlate,
        dispatchDial,
        setDragging,
        activateAudio,
      });
    },
    [
      activateAudio,
      dispatchDial,
      mountViewPlate,
      runtimeSnapshots,
      setDragging,
      uiSnapshots,
    ],
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
        if (viewRenderersRef.current.length > 0) return;
        rendererStatusRef.current = status;
        setRendererStatus((current) => {
          if (
            current?.kind === status.kind &&
            current.quality === status.quality &&
            current.degradationStage === status.degradationStage &&
            current.datasetId === status.datasetId &&
            current.textureReady === status.textureReady &&
            current.materialSectionReady ===
              status.materialSectionReady &&
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
    setRendererStatus(Object.freeze({ ...renderer.status }));
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
        (snapshot) => {
          const activeView = viewRenderersRef.current.at(-1);
          if (!activeView) {
            renderer.render(snapshot);
            const visibleCanvas = renderer.canvas;
            if (visibleCanvas !== canvas) {
              settledRenderAttestation.clear(canvas);
            }
            settledRenderAttestation.record(visibleCanvas, snapshot);
            return;
          }
          try {
            activeView.renderer.render(snapshot);
            const visibleCanvas = activeView.renderer.canvas;
            if (visibleCanvas !== activeView.canvas) {
              settledRenderAttestation.clear(activeView.canvas);
            }
            settledRenderAttestation.record(visibleCanvas, snapshot);
          } catch (error) {
            // View-local GPU failure must not remove the shared render lane.
            // Quarantine it and resume on the next view or parking canvas.
            activeView.reportAvailabilityFailure(error);
            activeView.resizeObserver?.disconnect();
            settledRenderAttestation.clear(activeView.canvas);
            if (activeView.renderer.canvas !== activeView.canvas) {
              settledRenderAttestation.clear(activeView.renderer.canvas);
            }
            viewRenderersRef.current = viewRenderersRef.current.filter(
              (entry) => entry !== activeView,
            );
            activeView.renderer.dispose();
            const nextView = viewRenderersRef.current.at(-1);
            const recoveryRenderer = nextView?.renderer ?? renderer;
            recoveryRenderer.render(snapshot);
            settledRenderAttestation.record(
              recoveryRenderer.canvas,
              snapshot,
            );
          }
        },
        (snapshot) => audioEngine.applyRuntimeSnapshot(snapshot),
      ],
      (error, snapshot) => {
        reportConsumerFailure("hot-path", error, snapshot.sequence);
      },
    );

    // React, challenge reporting, and diagnostics receive owned immutable
    // snapshots only. This fan-out is published at no more than 24 Hz during
    // normal animation so presentation work cannot starve the fixed-step loop.
    const presentationUnsubscribers = [
      runtimeSnapshots.subscribe((snapshot) => {
          const runtime = runtimeRef.current;
          setViewState({
            snapshot,
            dragging: runtime.dial.dragging,
            minimumFrequencyHz: runtime.dial.config.minFrequencyHz,
            maximumFrequencyHz: runtime.dial.config.maxFrequencyHz,
          });
        }),
      runtimeSnapshots.subscribe((snapshot) => {
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
        }),
      runtimeSnapshots.subscribe((snapshot) => {
          const signature = diagnosticSignature(snapshot.diagnostics);
          if (signature === lastSnapshotDiagnosticSignatureRef.current) return;
          lastSnapshotDiagnosticSignatureRef.current = signature;
          setDiagnostics((current) =>
            mergeDiagnostics(current, snapshot.diagnostics),
          );
        }),
    ];
    let lastPresentationTimeSeconds =
      runtimeRef.current.resonance.simulationTimeSeconds;
    let lastPresentationDatasetId =
      runtimeRef.current.resonance.dataset.datasetId;
    const lastObservedHotVolume: {
      status: RuntimeSnapshot["volume"]["status"];
      value: number | null;
    } = {
      status: initialSnapshot.volume.status,
      value: initialSnapshot.volume.value,
    };
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
      if (runtimeSnapshots.publish(snapshot)) {
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
        const textureSource = plateTextureSource(result);
        secondaryTextureSourceRef.current = textureSource;
        try {
          await renderer.setTextureSource(textureSource);
        } catch {
          secondaryTextureSourceRef.current = null;
          await Promise.allSettled(
            viewRenderersRef.current.map(({ renderer: viewRenderer }) =>
              viewRenderer.setTextureSource(null),
            ),
          );
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
        const visibleViewRenderers = [...viewRenderersRef.current];
        await Promise.allSettled(
          visibleViewRenderers.map(async (viewRenderer) => {
            try {
              await viewRenderer.renderer.setTextureSource(textureSource);
              const status = viewRenderer.renderer.status;
              if (
                status.kind !== "static" &&
                rendererRejectedTextureSource(status, textureSource)
              ) {
                throw new Error(
                  status.contextLost
                    ? "The visible plate renderer lost its graphics context."
                    : status.datasetId !== result.manifest.datasetId
                      ? "The visible plate renderer selected the wrong verified dataset."
                      : "The visible plate renderer rejected the verified texture.",
                );
              }
            } catch (error) {
              // A verified parking renderer cannot authorize a visibly broken
              // framework attachment. Quarantine that view so the independent
              // standby gets its own renderer and the same texture source.
              viewRenderer.reportAvailabilityFailure(error);
              throw error;
            }
          }),
        );
        if (disposed) return;
        const textureStatus = renderer.status;
        const productionTextureFailed =
          textureStatus.kind !== "static" &&
          rendererRejectedTextureSource(
            textureStatus,
            textureSource,
          );
        if (productionTextureFailed) {
          secondaryTextureSourceRef.current = null;
          try {
            await renderer.setTextureSource(null);
          } catch {
            // Status remains fail-closed below even if clearing also fails.
          }
          await Promise.allSettled(
            viewRenderersRef.current.map(({ renderer: viewRenderer }) =>
              viewRenderer.setTextureSource(null),
            ),
          );
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
        secondaryTextureSourceRef.current = null;
        await Promise.allSettled(
          viewRenderersRef.current.map(({ renderer: viewRenderer }) =>
            viewRenderer.setTextureSource(null),
          ),
        );
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
    void loadDataset().catch(async (error: unknown) => {
      await texturePreviewQueue.waitForIdle();
      texturePreviewQueue.dispose();
      if (disposed) return;
      secondaryTextureSourceRef.current = null;
      await Promise.allSettled(
        viewRenderersRef.current.map(({ renderer: viewRenderer }) =>
          viewRenderer.setTextureSource(null),
        ),
      );
      try {
        await renderer.setTextureSource(null);
      } catch {
        // Unexpected loader and renderer failures still leave the prototype
        // runtime in place and prevent a VERIFIED presentation.
      }
      if (!disposed) {
        setDatasetStatus("error");
        setDiagnostics((current) =>
          mergeDiagnostics(
            current.filter(
              (diagnostic) =>
                diagnostic.code !== "MH-DATASET-PENDING",
            ),
            [
              createDiagnostic({
                code: "MH-DATASET-INTEGRITY",
                severity: "warning",
                messageKey: "dataset.unexpectedLoadFailure",
                evidence: [
                  {
                    key: "errorKind",
                    value:
                      error instanceof Error
                        ? error.name
                        : typeof error,
                    source: "asset-runtime",
                  },
                ],
              }),
            ],
          ),
        );
      }
    });

    const tick = (time: number) => {
      if (disposed) return;
      const frameWorkStartedAt = performance.now();
      const elapsedMilliseconds = Math.max(0, time - previousTime);
      previousTime = time;
      longestFrameDeltaMs = Math.max(longestFrameDeltaMs, elapsedMilliseconds);
      animationFrames += 1;
      runtimeRef.current = advanceMandelHowlRuntimeInPlace(
        runtimeRef.current,
        Math.min(0.1, elapsedMilliseconds / 1000),
      );
      const hotSnapshot = snapshotWriter.write(runtimeRef.current);
      hotPathFanout.publish(hotSnapshot);
      const settledVolumeChanged =
        shouldPublishSettledVolumeImmediately(
          lastObservedHotVolume,
          hotSnapshot.volume,
        );
      lastObservedHotVolume.status = hotSnapshot.volume.status;
      lastObservedHotVolume.value = hotSnapshot.volume.value;
      publishPresentationFrame(settledVolumeChanged);
      const frameWorkMs = performance.now() - frameWorkStartedAt;
      (
        viewRenderersRef.current.at(-1)?.renderer ?? renderer
      ).recordFrameTiming(frameWorkMs);
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
          presentationFanout: runtimeSnapshots.metrics,
          hotPathFanout: hotPathFanout.metrics,
          renderer:
            viewRenderersRef.current.at(-1)?.renderer.status ??
            rendererRef.current?.status ??
            rendererStatusRef.current,
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
      for (const unsubscribe of presentationUnsubscribers) unsubscribe();
      hotPathFanout.dispose();
      settledRenderAttestation.clear(canvas);
      if (renderer.canvas !== canvas) {
        settledRenderAttestation.clear(renderer.canvas);
      }
      renderer.dispose();
      rendererRef.current = null;
      for (const viewRenderer of viewRenderersRef.current) {
        viewRenderer.resizeObserver?.disconnect();
        settledRenderAttestation.clear(viewRenderer.canvas);
        if (viewRenderer.renderer.canvas !== viewRenderer.canvas) {
          settledRenderAttestation.clear(viewRenderer.renderer.canvas);
        }
        viewRenderer.renderer.dispose();
      }
      viewRenderersRef.current = [];
      secondaryTextureSourceRef.current = null;
      void audioEngine.dispose();
    };
  }, [
    audioEngine,
    initialSnapshot.volume.status,
    initialSnapshot.volume.value,
    pushDiagnostic,
    runtimeSnapshots,
    settledRenderAttestation,
  ]);

  const snapshot = viewState.snapshot;
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

  useEffect(() => {
    uiRevisionRef.current += 1;
    uiSnapshots.publish({
      contractVersion: "mandelhowl.ui-port.v1",
      revision: uiRevisionRef.current,
      runtime: snapshot,
      minimumFrequencyHz: viewState.minimumFrequencyHz,
      maximumFrequencyHz: viewState.maximumFrequencyHz,
      radialDeadZone: runtimeRef.current.dial.config.radialDeadZone,
      dragging: viewState.dragging,
      audioEnabled,
      datasetStatus,
      renderer: rendererStatus,
      diagnostic: {
        severity: presented.severity,
        title: visibleDiagnostics.length > 0 ? presented.title : null,
        message: visibleDiagnostics.length > 0 ? presented.message : null,
        code: primaryDiagnostic?.code ?? null,
        detail: presented.developerLines[0] ?? null,
      },
      challengeTarget,
    });
  }, [
    audioEnabled,
    challengeTarget,
    datasetStatus,
    presented.developerLines,
    presented.message,
    presented.severity,
    presented.title,
    primaryDiagnostic?.code,
    rendererStatus,
    snapshot,
    uiSnapshots,
    viewState.dragging,
    viewState.maximumFrequencyHz,
    viewState.minimumFrequencyHz,
    visibleDiagnostics.length,
  ]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="mh-session-canvas"
        aria-hidden="true"
        tabIndex={-1}
      />
      <MandelHowlUiHost
        runtime={uiPort}
        onDiagnostic={pushDiagnostic}
        onAllVersionsUnavailable={suspendAudioForUiIsolation}
      />
    </>
  );
}
