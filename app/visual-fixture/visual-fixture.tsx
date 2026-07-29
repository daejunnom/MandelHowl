"use client";

import { useEffect, useRef, useState } from "react";
import {
  loadResonanceDataset,
  type ResonanceDatasetLoadResult,
} from "@/packages/asset-runtime/src";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  type RuntimeSnapshot,
} from "@/packages/contracts/src";
import { CanvasPlateRenderer } from "@/packages/render-engine/src/canvas-plate-renderer";
import {
  createPlateRenderer,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateTextureSource,
} from "@/packages/render-engine/src";
import {
  createMandelHowlRuntime,
  getRuntimeSnapshot,
} from "@/packages/resonance-engine/src";
import { MandelHowlScene, type MandelHowlRegime } from "../mandelhowl-scene";

interface VisualState {
  readonly frequency: number;
  readonly volume: number;
  readonly regime: MandelHowlRegime;
  readonly envelope: number;
  readonly activeMode: number | null;
  readonly measurementProgress: number;
  readonly measurementStatus: "measuring" | "settled";
  readonly microphoneRms: number;
  readonly microphonePeak: number;
  readonly phase: number;
  readonly dragging: boolean;
  readonly audioEnabled: boolean;
  readonly rendererKind: "webgl2" | "canvas2d";
  readonly renderQuality: "high" | "reduced" | "canvas";
}

const STATES: Readonly<Record<string, VisualState>> = Object.freeze({
  decayed: {
    frequency: 45,
    volume: 0,
    regime: "decaying",
    envelope: 0,
    activeMode: null,
    measurementProgress: 1,
    measurementStatus: "settled",
    microphoneRms: 0,
    microphonePeak: 0,
    phase: 0,
    dragging: false,
    audioEnabled: false,
    rendererKind: "webgl2",
    renderQuality: "high",
  },
  "weak-nonresonant": {
    frequency: 842,
    volume: 0,
    regime: "decaying",
    envelope: 0.08,
    activeMode: 11,
    measurementProgress: 0.62,
    measurementStatus: "measuring",
    microphoneRms: 0.018,
    microphonePeak: 0.032,
    phase: 0.35,
    dragging: false,
    audioEnabled: false,
    rendererKind: "webgl2",
    renderQuality: "high",
  },
  critical: {
    frequency: 4_629.35,
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: 44,
    measurementProgress: 1,
    measurementStatus: "settled",
    microphoneRms: 0.31,
    microphonePeak: 0.43,
    phase: 1.22,
    dragging: false,
    audioEnabled: true,
    rendererKind: "webgl2",
    renderQuality: "high",
  },
  burst: {
    frequency: 4_630.9,
    volume: 75,
    regime: "critical",
    envelope: 0.7,
    activeMode: 44,
    measurementProgress: 0.78,
    measurementStatus: "measuring",
    microphoneRms: 0.47,
    microphonePeak: 0.66,
    phase: 2.46,
    dragging: false,
    audioEnabled: true,
    rendererKind: "webgl2",
    renderQuality: "high",
  },
  growing: {
    frequency: 4_632.1,
    volume: 88,
    regime: "growing",
    envelope: 0.84,
    activeMode: 44,
    measurementProgress: 0.92,
    measurementStatus: "measuring",
    microphoneRms: 0.56,
    microphonePeak: 0.77,
    phase: 3.18,
    dragging: false,
    audioEnabled: true,
    rendererKind: "webgl2",
    renderQuality: "high",
  },
  saturated: {
    frequency: 4_690.89,
    volume: 100,
    regime: "saturated",
    envelope: 1,
    activeMode: 45,
    measurementProgress: 1,
    measurementStatus: "settled",
    microphoneRms: 0.62,
    microphonePeak: 0.86,
    phase: 4.64,
    dragging: false,
    audioEnabled: true,
    rendererKind: "webgl2",
    renderQuality: "high",
  },
  "reverse-reverb": {
    frequency: 4_627.2,
    volume: 37,
    regime: "critical",
    envelope: 0.36,
    activeMode: 44,
    measurementProgress: 0.34,
    measurementStatus: "measuring",
    microphoneRms: 0.22,
    microphonePeak: 0.35,
    phase: -1.4,
    dragging: true,
    audioEnabled: true,
    rendererKind: "webgl2",
    renderQuality: "high",
  },
  "reduced-motion": {
    frequency: 4_629.35,
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: 44,
    measurementProgress: 1,
    measurementStatus: "settled",
    microphoneRms: 0.31,
    microphonePeak: 0.43,
    phase: 1.22,
    dragging: false,
    audioEnabled: true,
    rendererKind: "webgl2",
    renderQuality: "reduced",
  },
  "canvas-fallback": {
    frequency: 4_629.35,
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: 44,
    measurementProgress: 1,
    measurementStatus: "settled",
    microphoneRms: 0.31,
    microphonePeak: 0.43,
    phase: 1.22,
    dragging: false,
    audioEnabled: true,
    rendererKind: "canvas2d",
    renderQuality: "canvas",
  },
});

const TEMPORAL_OLD_STATE: VisualState = Object.freeze({
  frequency: 4_629.35,
  volume: 63,
  regime: "growing",
  envelope: 0.82,
  activeMode: 44,
  measurementProgress: 1,
  measurementStatus: "settled",
  microphoneRms: 0.48,
  microphonePeak: 0.66,
  phase: 0.72,
  dragging: false,
  audioEnabled: true,
  rendererKind: "webgl2",
  renderQuality: "high",
});

const TEMPORAL_NEW_STATE: VisualState = Object.freeze({
  frequency: 4_690.89,
  volume: 77,
  regime: "critical",
  envelope: 0.78,
  activeMode: 45,
  measurementProgress: 0.52,
  measurementStatus: "measuring",
  microphoneRms: 0.41,
  microphonePeak: 0.58,
  phase: 2.18,
  dragging: true,
  audioEnabled: true,
  rendererKind: "webgl2",
  renderQuality: "high",
});

const TEMPORAL_OLD_CANVAS_STATE: VisualState = Object.freeze({
  ...TEMPORAL_OLD_STATE,
  rendererKind: "canvas2d",
  renderQuality: "canvas",
});

const TEMPORAL_NEW_CANVAS_STATE: VisualState = Object.freeze({
  ...TEMPORAL_NEW_STATE,
  rendererKind: "canvas2d",
  renderQuality: "canvas",
});

type TemporalStage = "baseline" | "one-frame" | "50ms" | "250ms";

interface ModalFixtureOverride {
  readonly index: number;
  readonly energy: number;
  readonly phase: number;
}

interface FixtureSnapshotOptions {
  readonly sequence?: number;
  readonly simulationTimeSeconds?: number;
  readonly activeMode?: number | null;
  readonly previousFrequency?: number;
  readonly sweepRateHzPerSecond?: number;
  readonly modes?: readonly ModalFixtureOverride[];
}

interface RenderObservation {
  readonly stage: TemporalStage | "new-only" | "static" | "pending";
  readonly pixelSignature: string;
  readonly snapshotSignature: string;
  readonly activeModeId: string;
  readonly oldModeId: string;
  readonly newModeId: string;
  readonly frequency: string;
}

const PENDING_OBSERVATION: RenderObservation = Object.freeze({
  stage: "pending",
  pixelSignature: "pending",
  snapshotSignature: "pending",
  activeModeId: "none",
  oldModeId: "pending",
  newModeId: "pending",
  frequency: "pending",
});

function angleForFrequency(frequency: number): number {
  const normalized = Math.log(frequency / 45) / Math.log(6_000 / 45);
  return -Math.PI * 3 + normalized * Math.PI * 6;
}

function microphoneSamples(phase: number): readonly number[] {
  return Array.from({ length: 40 }, (_, index) => {
    const time = index / 39;
    return (
      Math.sin(time * Math.PI * 8 + phase) * 0.7 +
      Math.sin(time * Math.PI * 13 - phase * 0.5) * 0.3
    );
  });
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

function rendererSnapshot(
  base: RuntimeSnapshot,
  state: VisualState,
  options: FixtureSnapshotOptions = {},
): RuntimeSnapshot {
  const activeMode =
    options.activeMode === undefined ? state.activeMode : options.activeMode;
  const simulationTimeSeconds = options.simulationTimeSeconds ?? 1;
  const previousFrequency = options.previousFrequency ?? state.frequency;
  const sweepRate = options.sweepRateHzPerSecond ?? (state.dragging ? -48 : 0);
  const modalOverrides = options.modes;
  return Object.freeze({
    ...base,
    sequence: options.sequence ?? 1,
    simulationStep: Math.round(simulationTimeSeconds * 240),
    simulationTimeSeconds,
    dial: Object.freeze({
      ...base.dial,
      unwrappedAngleRad: angleForFrequency(state.frequency),
      driveFrequencyHz: state.frequency,
      previousDriveFrequencyHz: previousFrequency,
      sweepRateHzPerSecond: sweepRate,
      approachDirection:
        sweepRate > 0
          ? "increasing"
          : sweepRate < 0
            ? "decreasing"
            : "stationary",
    }),
    modes: Object.freeze(
      base.modes.map((mode, index) => {
        const modalOverride = modalOverrides?.find(
          (candidate) => candidate.index === index,
        );
        const energy = modalOverrides
          ? (modalOverride?.energy ?? 0)
          : index === activeMode
            ? Math.max(1e-4, state.envelope)
            : 0;
        return Object.freeze({
          ...mode,
          amplitudeNormalized: Math.sqrt(energy),
          phaseRad:
            modalOverride?.phase ?? (index === activeMode ? state.phase : 0),
          energyNormalized: energy,
        });
      }),
    ),
    activeModeId:
      activeMode === null ? null : (base.modes[activeMode]?.modeId ?? null),
    microphone: Object.freeze({
      rmsNormalized: state.microphoneRms,
      peakNormalized: state.microphonePeak,
      recentSamples: microphoneSamples(state.phase),
    }),
    feedback: Object.freeze({
      envelopeNormalized: state.envelope,
      loopSignalNormalized: Math.sin(state.phase) * state.envelope,
      limiterGainReductionDb: state.regime === "saturated" ? 7.5 : 0,
      limiterActive: state.regime === "saturated",
    }),
    regime: state.regime,
    volume:
      state.measurementStatus === "settled"
        ? Object.freeze({
            status: "settled" as const,
            value: state.volume,
            lastSettledValue: state.volume,
            progress: 1 as const,
          })
        : Object.freeze({
            status: "measuring" as const,
            value: null,
            lastSettledValue: state.volume,
            progress: state.measurementProgress,
          }),
    diagnostics: Object.freeze([]),
  });
}

function fnv1a32(values: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < values.length; index += 1) {
    hash ^= values[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function snapshotSignature(snapshot: RuntimeSnapshot): string {
  const serialized = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(serialized);
  return `${serialized.length}:${fnv1a32(bytes)}`;
}

function platePixelSignature(
  canvas: HTMLCanvasElement,
  rendererKind: "webgl2" | "canvas2d",
): string {
  const { width, height } = canvas;
  if (width < 1 || height < 1) return "empty";

  let pixels: Uint8Array | Uint8ClampedArray;
  if (rendererKind === "webgl2") {
    const context = canvas.getContext("webgl2");
    if (!context) return "webgl2-unavailable";
    pixels = new Uint8Array(width * height * 4);
    context.readPixels(
      0,
      0,
      width,
      height,
      context.RGBA,
      context.UNSIGNED_BYTE,
      pixels,
    );
  } else {
    const context = canvas.getContext("2d");
    if (!context) return "canvas2d-unavailable";
    pixels = context.getImageData(0, 0, width, height).data;
  }

  const targetSamples = 65_536;
  const pixelStride = Math.max(
    1,
    Math.floor(Math.sqrt((width * height) / targetSamples)),
  );
  const sampled = new Uint8Array(
    Math.ceil(width / pixelStride) * Math.ceil(height / pixelStride) * 4,
  );
  let writeIndex = 0;
  let opaqueSamples = 0;
  let lumaTotal = 0;
  for (let y = 0; y < height; y += pixelStride) {
    for (let x = 0; x < width; x += pixelStride) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      const alpha = pixels[offset + 3] ?? 0;
      sampled[writeIndex] = red;
      sampled[writeIndex + 1] = green;
      sampled[writeIndex + 2] = blue;
      sampled[writeIndex + 3] = alpha;
      writeIndex += 4;
      if (alpha > 0) opaqueSamples += 1;
      lumaTotal = (lumaTotal + red * 3 + green * 6 + blue + alpha) >>> 0;
    }
  }

  return [
    `${width}x${height}`,
    fnv1a32(sampled.subarray(0, writeIndex)),
    opaqueSamples.toString(16),
    lumaTotal.toString(16),
  ].join(":");
}

function temporalSnapshot(
  base: RuntimeSnapshot,
  stage: TemporalStage | "new-only" | "150ms",
): RuntimeSnapshot {
  const oldMode = TEMPORAL_OLD_STATE.activeMode;
  const newMode = TEMPORAL_NEW_STATE.activeMode;
  if (oldMode === null || newMode === null) {
    throw new Error("Temporal fixture modes must be defined.");
  }

  if (stage === "baseline") {
    return rendererSnapshot(base, TEMPORAL_OLD_STATE, {
      sequence: 1,
      simulationTimeSeconds: 1,
      activeMode: oldMode,
      modes: [
        {
          index: oldMode,
          energy: TEMPORAL_OLD_STATE.envelope,
          phase: TEMPORAL_OLD_STATE.phase,
        },
      ],
    });
  }

  const commonOptions: FixtureSnapshotOptions = {
    activeMode: newMode,
    previousFrequency: TEMPORAL_OLD_STATE.frequency,
    sweepRateHzPerSecond:
      TEMPORAL_NEW_STATE.frequency - TEMPORAL_OLD_STATE.frequency,
  };
  if (stage === "one-frame" || stage === "new-only") {
    return rendererSnapshot(base, TEMPORAL_NEW_STATE, {
      ...commonOptions,
      sequence: 2,
      simulationTimeSeconds: 1 + 1 / 60,
      modes: [
        {
          index: oldMode,
          energy: 0,
          phase: TEMPORAL_OLD_STATE.phase,
        },
        {
          index: newMode,
          energy: 0,
          phase: TEMPORAL_NEW_STATE.phase,
        },
      ],
    });
  }
  if (stage === "50ms") {
    return rendererSnapshot(base, TEMPORAL_NEW_STATE, {
      ...commonOptions,
      sequence: 3,
      simulationTimeSeconds: 1.05,
      modes: [
        {
          index: oldMode,
          energy: 0,
          phase: TEMPORAL_OLD_STATE.phase,
        },
        {
          index: newMode,
          energy: 0.56,
          phase: TEMPORAL_NEW_STATE.phase,
        },
      ],
    });
  }
  if (stage === "150ms") {
    return rendererSnapshot(base, TEMPORAL_NEW_STATE, {
      ...commonOptions,
      sequence: 4,
      simulationTimeSeconds: 1.15,
      modes: [
        {
          index: oldMode,
          energy: 0,
          phase: TEMPORAL_OLD_STATE.phase,
        },
        {
          index: newMode,
          energy: 0.68,
          phase: TEMPORAL_NEW_STATE.phase,
        },
      ],
    });
  }
  return rendererSnapshot(base, TEMPORAL_NEW_STATE, {
    ...commonOptions,
    sequence: 5,
    simulationTimeSeconds: 1.25,
    modes: [
      {
        index: oldMode,
        energy: 0,
        phase: TEMPORAL_OLD_STATE.phase,
      },
      {
        index: newMode,
        energy: TEMPORAL_NEW_STATE.envelope,
        phase: TEMPORAL_NEW_STATE.phase,
      },
    ],
  });
}

function renderAndObserve(
  renderer: PlateRenderer,
  canvas: HTMLCanvasElement,
  snapshot: RuntimeSnapshot,
  stage: RenderObservation["stage"],
): RenderObservation {
  renderer.render(snapshot);
  const oldModeId =
    TEMPORAL_OLD_STATE.activeMode === null
      ? null
      : snapshot.modes[TEMPORAL_OLD_STATE.activeMode]?.modeId;
  const newModeId =
    TEMPORAL_NEW_STATE.activeMode === null
      ? null
      : snapshot.modes[TEMPORAL_NEW_STATE.activeMode]?.modeId;
  const rendererKind =
    renderer.status.kind === "webgl2" ? "webgl2" : "canvas2d";
  return Object.freeze({
    stage,
    pixelSignature: platePixelSignature(canvas, rendererKind),
    snapshotSignature: snapshotSignature(snapshot),
    activeModeId: snapshot.activeModeId ?? "none",
    oldModeId: oldModeId ?? "none",
    newModeId: newModeId ?? "none",
    frequency: snapshot.dial.driveFrequencyHz.toFixed(2),
  });
}

export function MandelHowlVisualFixture({
  stateName,
}: {
  readonly stateName: string;
}) {
  const temporalTransition =
    stateName === "temporal-transition" ||
    stateName === "temporal-transition-canvas";
  const temporalNewOnly =
    stateName === "temporal-new-only" ||
    stateName === "temporal-new-only-canvas";
  const isTemporal = temporalTransition || temporalNewOnly;
  const usesCanvas = stateName.endsWith("-canvas");
  const state = temporalTransition
    ? usesCanvas
      ? TEMPORAL_OLD_CANVAS_STATE
      : TEMPORAL_OLD_STATE
    : temporalNewOnly
      ? usesCanvas
        ? TEMPORAL_NEW_CANVAS_STATE
        : TEMPORAL_NEW_STATE
      : (STATES[stateName] ?? STATES.decayed);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PlateRenderer | null>(null);
  const baseSnapshotRef = useRef<RuntimeSnapshot | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const [rendererStatus, setRendererStatus] =
    useState<PlateRendererStatus | null>(null);
  const [fixtureStatus, setFixtureStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [presentedState, setPresentedState] = useState<VisualState>(state);
  const [observation, setObservation] =
    useState<RenderObservation>(PENDING_OBSERVATION);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let renderer: PlateRenderer | null = null;
    const options: PlateRendererOptions = {
      preferences: {
        reducedMotion: state.renderQuality === "reduced",
        forcedColors: false,
        preferredQuality:
          state.renderQuality === "canvas" ? undefined : state.renderQuality,
      },
      onStatus: (status) => {
        if (!disposed) setRendererStatus(status);
      },
    };

    try {
      if (state.rendererKind === "canvas2d") {
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) throw new Error("Canvas2D is unavailable.");
        renderer = new CanvasPlateRenderer(canvas, context, options);
      } else {
        renderer = createPlateRenderer(canvas, options);
      }
      renderer.resize();
      setRendererStatus(renderer.status);
    } catch {
      setFixtureStatus("error");
      return;
    }

    const activeRenderer = renderer;
    void loadResonanceDataset({
      manifestUrl: GENERATED_DATASET_RELEASE_SPEC.manifestUrl,
      expectedDatasetId: GENERATED_DATASET_RELEASE_SPEC.datasetId,
    }).then(async (result) => {
      if (disposed) return;
      if (result.status !== "ready") {
        setFixtureStatus("error");
        return;
      }
      await activeRenderer.setTextureSource(plateTextureSource(result));
      if (
        disposed ||
        !activeRenderer.status.textureReady ||
        activeRenderer.status.datasetId !== result.manifest.datasetId
      ) {
        if (!disposed) setFixtureStatus("error");
        return;
      }
      const runtime = createMandelHowlRuntime({
        dataset: result.dataset,
        initialFrequencyHz: isTemporal
          ? TEMPORAL_OLD_STATE.frequency
          : state.frequency,
        datasetReadiness: "verified",
      });
      const baseSnapshot = getRuntimeSnapshot(runtime);
      rendererRef.current = activeRenderer;
      baseSnapshotRef.current = baseSnapshot;
      if (temporalNewOnly) {
        const snapshot = temporalSnapshot(baseSnapshot, "new-only");
        setObservation(
          renderAndObserve(activeRenderer, canvas, snapshot, "new-only"),
        );
      } else if (temporalTransition) {
        const snapshot = temporalSnapshot(baseSnapshot, "baseline");
        setObservation(
          renderAndObserve(activeRenderer, canvas, snapshot, "baseline"),
        );
      } else {
        activeRenderer.render(rendererSnapshot(baseSnapshot, state));
      }
      setRendererStatus(activeRenderer.status);
      setFixtureStatus("ready");
    });

    return () => {
      disposed = true;
      if (frameRequestRef.current !== null) {
        cancelAnimationFrame(frameRequestRef.current);
        frameRequestRef.current = null;
      }
      rendererRef.current = null;
      baseSnapshotRef.current = null;
      activeRenderer.dispose();
    };
  }, [isTemporal, state, temporalNewOnly, temporalTransition]);

  const renderTemporalStage = (stage: TemporalStage) => {
    const renderer = rendererRef.current;
    const baseSnapshot = baseSnapshotRef.current;
    const canvas = canvasRef.current;
    if (!temporalTransition || !renderer || !baseSnapshot || !canvas) {
      return;
    }
    const renderStage = () => {
      if (stage === "250ms") {
        // The visual filter intentionally caps one integration delta at
        // 100 ms. Advance through 150 ms first so this stage represents the
        // full 250 ms transition rather than a capped 150 ms approximation.
        renderer.render(temporalSnapshot(baseSnapshot, "150ms"));
      }
      const snapshot = temporalSnapshot(baseSnapshot, stage);
      setObservation(renderAndObserve(renderer, canvas, snapshot, stage));
      setRendererStatus(renderer.status);
      if (stage !== "baseline") {
        setPresentedState(
          usesCanvas ? TEMPORAL_NEW_CANVAS_STATE : TEMPORAL_NEW_STATE,
        );
      }
    };
    if (stage === "one-frame") {
      if (frameRequestRef.current !== null) {
        cancelAnimationFrame(frameRequestRef.current);
      }
      frameRequestRef.current = requestAnimationFrame(() => {
        frameRequestRef.current = null;
        renderStage();
      });
      return;
    }
    renderStage();
  };

  return (
    <>
      <MandelHowlScene
        frequency={presentedState.frequency}
        angle={angleForFrequency(presentedState.frequency)}
        volume={presentedState.volume}
        regime={presentedState.regime}
        envelope={presentedState.envelope}
        activeMode={presentedState.activeMode}
        measurementProgress={presentedState.measurementProgress}
        measurementStatus={presentedState.measurementStatus}
        microphoneRms={presentedState.microphoneRms}
        microphonePeak={presentedState.microphonePeak}
        microphoneSamples={microphoneSamples(presentedState.phase)}
        activeModePhase={presentedState.phase}
        audioEnabled={presentedState.audioEnabled}
        rendererKind={rendererStatus?.kind ?? presentedState.rendererKind}
        renderQuality={rendererStatus?.quality ?? presentedState.renderQuality}
        datasetStatus="verified"
        dragging={presentedState.dragging}
        onDialPointerDown={() => {}}
        onDialPointerMove={() => {}}
        onDialPointerUp={() => {}}
        onDialPointerCancel={() => {}}
        onDialLostPointerCapture={() => {}}
        onDialKeyDown={() => {}}
        onDialWheel={() => {}}
        canvasRef={canvasRef}
      />
      <output
        hidden
        data-testid="visual-renderer-status"
        data-status={fixtureStatus}
        data-renderer={rendererStatus?.kind ?? "pending"}
        data-texture-ready={String(rendererStatus?.textureReady ?? false)}
        data-temporal-stage={observation.stage}
        data-pixel-signature={observation.pixelSignature}
        data-snapshot-signature={observation.snapshotSignature}
        data-active-mode-id={observation.activeModeId}
        data-old-mode-id={observation.oldModeId}
        data-new-mode-id={observation.newModeId}
        data-frequency={observation.frequency}
      />
      {isTemporal ? (
        <div hidden>
          <button
            type="button"
            data-testid="temporal-step-one-frame"
            onClick={() => renderTemporalStage("one-frame")}
          />
          <button
            type="button"
            data-testid="temporal-step-50ms"
            onClick={() => renderTemporalStage("50ms")}
          />
          <button
            type="button"
            data-testid="temporal-step-250ms"
            onClick={() => renderTemporalStage("250ms")}
          />
        </div>
      ) : null}
    </>
  );
}
