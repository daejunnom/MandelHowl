"use client";

import { useEffect, useRef, useState } from "react";
import {
  loadResonanceDataset,
  type ResonanceDatasetLoadResult,
} from "@/packages/asset-runtime/src";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_DIAL_SPEC,
  type RuntimeSnapshot,
} from "@/packages/contracts/src";
import {
  DEFAULT_DIAL_CONFIG,
  frequencyToAngle,
} from "@/packages/dial-engine/src";
import { CanvasPlateRenderer } from "@/packages/render-engine/src/canvas-plate-renderer";
import {
  createPlateRenderer,
  nearestInBandTextureModeId,
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
import "../mandelhowl.css";

interface VisualState {
  readonly frequency: number;
  readonly volume: number;
  readonly regime: MandelHowlRegime;
  readonly envelope: number;
  readonly activeMode: number | null;
  /** Dataset-relative selection resolved only after the pinned modes load. */
  readonly modeQuantile?: number;
  /** Presentation fixture offset from the selected natural frequency. */
  readonly modeFrequencyRatio?: number;
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

interface ModalIdentity {
  readonly modeId: string;
  readonly naturalFrequencyHz: number;
}

const DIAL_MINIMUM_FREQUENCY_HZ =
  GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz;
const DIAL_MAXIMUM_FREQUENCY_HZ =
  GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz;

function logarithmicFrequencyAt(normalized: number): number {
  const bounded = Math.min(1, Math.max(0, normalized));
  return (
    DIAL_MINIMUM_FREQUENCY_HZ *
    Math.pow(
      DIAL_MAXIMUM_FREQUENCY_HZ / DIAL_MINIMUM_FREQUENCY_HZ,
      bounded,
    )
  );
}

const STATES: Readonly<Record<string, VisualState>> = Object.freeze({
  decayed: {
    frequency: DIAL_MINIMUM_FREQUENCY_HZ,
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
    frequency: logarithmicFrequencyAt(0.25),
    volume: 0,
    regime: "decaying",
    envelope: 0.08,
    activeMode: null,
    modeQuantile: 0.25,
    modeFrequencyRatio: 0.97,
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
    frequency: logarithmicFrequencyAt(0.75),
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: null,
    modeQuantile: 0.75,
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
    frequency: logarithmicFrequencyAt(0.75),
    volume: 75,
    regime: "critical",
    envelope: 0.7,
    activeMode: null,
    modeQuantile: 0.75,
    modeFrequencyRatio: 1.0003,
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
    frequency: logarithmicFrequencyAt(0.75),
    volume: 88,
    regime: "growing",
    envelope: 0.84,
    activeMode: null,
    modeQuantile: 0.75,
    modeFrequencyRatio: 1.0006,
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
    frequency: logarithmicFrequencyAt(0.9),
    volume: 100,
    regime: "saturated",
    envelope: 1,
    activeMode: null,
    modeQuantile: 0.9,
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
    frequency: logarithmicFrequencyAt(0.75),
    volume: 37,
    regime: "critical",
    envelope: 0.36,
    activeMode: null,
    modeQuantile: 0.75,
    modeFrequencyRatio: 0.9995,
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
    frequency: logarithmicFrequencyAt(0.75),
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: null,
    modeQuantile: 0.75,
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
    frequency: logarithmicFrequencyAt(0.75),
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: null,
    modeQuantile: 0.75,
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
  "runtime-pressure-canvas": {
    frequency: logarithmicFrequencyAt(0.75),
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: null,
    modeQuantile: 0.75,
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
  "runtime-pressure-normal": {
    frequency: logarithmicFrequencyAt(0.75),
    volume: 50,
    regime: "critical",
    envelope: 0.48,
    activeMode: null,
    modeQuantile: 0.75,
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
});

const TEMPORAL_OLD_STATE: VisualState = Object.freeze({
  frequency: logarithmicFrequencyAt(0.25),
  volume: 63,
  regime: "growing",
  envelope: 0.82,
  activeMode: null,
  modeQuantile: 0.25,
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
  frequency: logarithmicFrequencyAt(0.75),
  volume: 77,
  regime: "critical",
  envelope: 0.78,
  activeMode: null,
  modeQuantile: 0.75,
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

interface TemporalFixtureSelection {
  readonly oldState: VisualState;
  readonly newState: VisualState;
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
  readonly sandLikeSamples: number;
  readonly sandContrast: number;
  readonly snapshotSignature: string;
  readonly activeModeId: string;
  readonly oldModeId: string;
  readonly newModeId: string;
  readonly frequency: string;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

const PENDING_OBSERVATION: RenderObservation = Object.freeze({
  stage: "pending",
  pixelSignature: "pending",
  sandLikeSamples: 0,
  sandContrast: 0,
  snapshotSignature: "pending",
  activeModeId: "none",
  oldModeId: "pending",
  newModeId: "pending",
  frequency: "pending",
  canvasWidth: 0,
  canvasHeight: 0,
});

function angleForFrequency(frequency: number): number {
  return frequencyToAngle(frequency, DEFAULT_DIAL_CONFIG);
}

function modeIndexAtQuantile(
  modes: readonly ModalIdentity[],
  quantile: number,
): number {
  if (modes.length === 0) {
    throw new Error("The pinned visual fixture dataset contains no modes.");
  }
  const bounded = Math.min(1, Math.max(0, quantile));
  return Math.round((modes.length - 1) * bounded);
}

function resolveVisualState(
  template: VisualState,
  modes: readonly ModalIdentity[],
  explicitModeId: string | null = null,
): VisualState {
  if (template.modeQuantile === undefined && explicitModeId === null) {
    return template;
  }
  const activeMode =
    explicitModeId === null
      ? modeIndexAtQuantile(modes, template.modeQuantile ?? 0)
      : modes.findIndex((mode) => mode.modeId === explicitModeId);
  if (activeMode < 0) {
    throw new Error(
      `The requested pinned visual fixture mode ${explicitModeId} is unavailable.`,
    );
  }
  const naturalFrequencyHz = modes[activeMode]?.naturalFrequencyHz;
  if (
    naturalFrequencyHz === undefined ||
    !Number.isFinite(naturalFrequencyHz)
  ) {
    throw new Error("The selected visual fixture mode has no finite frequency.");
  }
  const frequency = Math.min(
    DIAL_MAXIMUM_FREQUENCY_HZ,
    Math.max(
      DIAL_MINIMUM_FREQUENCY_HZ,
      naturalFrequencyHz * (template.modeFrequencyRatio ?? 1),
    ),
  );
  return Object.freeze({
    ...template,
    frequency,
    activeMode,
  });
}

function createTemporalFixtureSelection(
  modes: readonly ModalIdentity[],
  usesCanvas: boolean,
): TemporalFixtureSelection {
  const parameters = new URLSearchParams(window.location.search);
  const oldTemplate = usesCanvas
    ? TEMPORAL_OLD_CANVAS_STATE
    : TEMPORAL_OLD_STATE;
  const newTemplate = usesCanvas
    ? TEMPORAL_NEW_CANVAS_STATE
    : TEMPORAL_NEW_STATE;
  const oldState = resolveVisualState(
    oldTemplate,
    modes,
    parameters.get("oldModeId"),
  );
  const newState = resolveVisualState(
    newTemplate,
    modes,
    parameters.get("newModeId"),
  );
  if (
    oldState.activeMode === null ||
    newState.activeMode === null ||
    oldState.activeMode === newState.activeMode
  ) {
    throw new Error(
      "Temporal fixtures require two distinct pinned dataset modes.",
    );
  }
  return Object.freeze({ oldState, newState });
}

function microphoneSamples(
  phase: number,
  indicatedPeak: number,
): readonly number[] {
  const physicalScale = Math.max(0, Math.min(1, indicatedPeak)) * 0.08;
  return Array.from({ length: 40 }, (_, index) => {
    const time = index / 39;
    return (
      (Math.sin(time * Math.PI * 8 + phase) * 0.7 +
        Math.sin(time * Math.PI * 13 - phase * 0.5) * 0.3) *
      physicalScale
    );
  });
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
      recentSamples: microphoneSamples(state.phase, state.microphonePeak),
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

function platePixelMetrics(
  canvas: HTMLCanvasElement,
  rendererKind: "webgl2" | "canvas2d",
): {
  readonly signature: string;
  readonly sandLikeSamples: number;
  readonly sandContrast: number;
} {
  const { width, height } = canvas;
  if (width < 1 || height < 1) {
    return { signature: "empty", sandLikeSamples: 0, sandContrast: 0 };
  }

  let pixels: Uint8Array | Uint8ClampedArray;
  if (rendererKind === "webgl2") {
    const context = canvas.getContext("webgl2");
    if (!context) {
      return {
        signature: "webgl2-unavailable",
        sandLikeSamples: 0,
        sandContrast: 0,
      };
    }
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
    if (!context) {
      return {
        signature: "canvas2d-unavailable",
        sandLikeSamples: 0,
        sandContrast: 0,
      };
    }
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
  let sandLikeSamples = 0;
  let sandContrast = 0;
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
      const redGreenChroma = red - green;
      const greenBlueChroma = green - blue;
      const sampleContrast = Math.min(redGreenChroma, greenBlueChroma);
      // The plate is neutral gray; baked grains are deliberately warm gold.
      // This metric verifies actual framebuffer contrast for both renderers,
      // rather than only checking that any pixels changed over time.
      if (alpha > 0 && redGreenChroma >= 22 && greenBlueChroma >= 45) {
        sandLikeSamples += 1;
        sandContrast = Math.max(sandContrast, sampleContrast);
      }
      lumaTotal = (lumaTotal + red * 3 + green * 6 + blue + alpha) >>> 0;
    }
  }

  return {
    signature: [
      `${width}x${height}`,
      fnv1a32(sampled.subarray(0, writeIndex)),
      opaqueSamples.toString(16),
      lumaTotal.toString(16),
    ].join(":"),
    sandLikeSamples,
    sandContrast,
  };
}

function temporalSnapshot(
  base: RuntimeSnapshot,
  stage: TemporalStage | "new-only" | "150ms",
  selection: TemporalFixtureSelection,
): RuntimeSnapshot {
  const { oldState, newState } = selection;
  const oldMode = oldState.activeMode;
  const newMode = newState.activeMode;
  if (oldMode === null || newMode === null) {
    throw new Error("Temporal fixture modes must be defined.");
  }

  if (stage === "baseline") {
    return rendererSnapshot(base, oldState, {
      sequence: 1,
      simulationTimeSeconds: 1,
      activeMode: oldMode,
      modes: [
        {
          index: oldMode,
          energy: oldState.envelope,
          phase: oldState.phase,
        },
      ],
    });
  }

  const commonOptions: FixtureSnapshotOptions = {
    activeMode: newMode,
    previousFrequency: oldState.frequency,
    sweepRateHzPerSecond:
      newState.frequency - oldState.frequency,
  };
  if (stage === "one-frame" || stage === "new-only") {
    return rendererSnapshot(base, newState, {
      ...commonOptions,
      sequence: 2,
      simulationTimeSeconds: 1 + 1 / 60,
      modes: [
        {
          index: oldMode,
          energy: 0,
          phase: oldState.phase,
        },
        {
          index: newMode,
          energy: 0,
          phase: newState.phase,
        },
      ],
    });
  }
  if (stage === "50ms") {
    return rendererSnapshot(base, newState, {
      ...commonOptions,
      sequence: 3,
      simulationTimeSeconds: 1.05,
      modes: [
        {
          index: oldMode,
          energy: 0,
          phase: oldState.phase,
        },
        {
          index: newMode,
          energy: 0.56,
          phase: newState.phase,
        },
      ],
    });
  }
  if (stage === "150ms") {
    return rendererSnapshot(base, newState, {
      ...commonOptions,
      sequence: 4,
      simulationTimeSeconds: 1.15,
      modes: [
        {
          index: oldMode,
          energy: 0,
          phase: oldState.phase,
        },
        {
          index: newMode,
          energy: 0.68,
          phase: newState.phase,
        },
      ],
    });
  }
  return rendererSnapshot(base, newState, {
    ...commonOptions,
    sequence: 5,
    simulationTimeSeconds: 1.25,
    modes: [
      {
        index: oldMode,
        energy: 0,
        phase: oldState.phase,
      },
      {
        index: newMode,
        energy: newState.envelope,
        phase: newState.phase,
      },
    ],
  });
}

function renderAndObserve(
  renderer: PlateRenderer,
  canvas: HTMLCanvasElement,
  snapshot: RuntimeSnapshot,
  stage: RenderObservation["stage"],
  selection: TemporalFixtureSelection | null = null,
): RenderObservation {
  renderer.render(snapshot);
  const oldModeIndex = selection?.oldState.activeMode ?? null;
  const newModeIndex = selection?.newState.activeMode ?? null;
  const oldModeId =
    oldModeIndex === null ? null : snapshot.modes[oldModeIndex]?.modeId;
  const newModeId =
    newModeIndex === null ? null : snapshot.modes[newModeIndex]?.modeId;
  const rendererKind =
    renderer.status.kind === "webgl2" ? "webgl2" : "canvas2d";
  const activeCanvas = renderer.canvas ?? canvas;
  const pixelMetrics = platePixelMetrics(activeCanvas, rendererKind);
  return Object.freeze({
    stage,
    pixelSignature: pixelMetrics.signature,
    sandLikeSamples: pixelMetrics.sandLikeSamples,
    sandContrast: pixelMetrics.sandContrast,
    snapshotSignature: snapshotSignature(snapshot),
    activeModeId: snapshot.activeModeId ?? "none",
    oldModeId: oldModeId ?? "none",
    newModeId: newModeId ?? "none",
    frequency: snapshot.dial.driveFrequencyHz.toFixed(2),
    canvasWidth: activeCanvas.width,
    canvasHeight: activeCanvas.height,
  });
}

async function waitForLazyTextureShards(
  renderer: PlateRenderer,
  snapshot: RuntimeSnapshot,
  loadingPolicy: PlateTextureSource["loadingPolicy"],
): Promise<void> {
  if (loadingPolicy !== "mode-sharded-lazy-verified") return;
  if (
    snapshot.activeModeId === null &&
    snapshot.modes.every((mode) => mode.energyNormalized <= 0) &&
    nearestInBandTextureModeId(snapshot) === null
  ) {
    return;
  }
  renderer.render(snapshot);
  const deadline = performance.now() + 10_000;
  while (!renderer.status.textureReady) {
    if (performance.now() >= deadline) {
      throw new Error("The selected verified texture shards did not load.");
    }
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 10);
    });
  }
  // The load callback resets GPU residency. Paint once after readiness so the
  // next observation samples uploaded selected layers, not the fallback frame.
  renderer.render(snapshot);
}

export function MandelHowlVisualFixture({
  stateName,
}: {
  readonly stateName: string;
}) {
  const pressureStageMatch = /^runtime-pressure-([0-6])$/u.exec(
    stateName,
  );
  const pressureStage = pressureStageMatch
    ? Number(pressureStageMatch[1])
    : stateName === "runtime-pressure-canvas"
      ? 6
      : stateName === "runtime-pressure-normal"
        ? 2
        : null;
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
      : pressureStage !== null
        ? STATES.critical
        : (STATES[stateName] ?? STATES.decayed);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PlateRenderer | null>(null);
  const baseSnapshotRef = useRef<RuntimeSnapshot | null>(null);
  const temporalSelectionRef =
    useRef<TemporalFixtureSelection | null>(null);
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
      if (pressureStage !== null) {
        (
          renderer as PlateRenderer & {
            setDegradationStageForTesting(
              stage: 0 | 1 | 2 | 3 | 4 | 5 | 6,
            ): void;
          }
        ).setDegradationStageForTesting(
          pressureStage as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        );
      }
      renderer.resize();
      setRendererStatus(Object.freeze({ ...renderer.status }));
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
      const textureSource = plateTextureSource(result);
      await activeRenderer.setTextureSource(textureSource);
      if (
        disposed ||
        activeRenderer.status.contextLost ||
        (textureSource.loadingPolicy !==
          "mode-sharded-lazy-verified" &&
          !activeRenderer.status.textureReady) ||
        activeRenderer.status.datasetId !== result.manifest.datasetId
      ) {
        if (!disposed) setFixtureStatus("error");
        return;
      }
      const temporalSelection = isTemporal
        ? createTemporalFixtureSelection(result.dataset.modes, usesCanvas)
        : null;
      const resolvedState =
        temporalSelection === null
          ? resolveVisualState(state, result.dataset.modes)
          : temporalTransition
            ? temporalSelection.oldState
            : temporalSelection.newState;
      const runtime = createMandelHowlRuntime({
        dataset: result.dataset,
        initialFrequencyHz:
          temporalSelection?.oldState.frequency ?? resolvedState.frequency,
        datasetReadiness: "verified",
      });
      const baseSnapshot = getRuntimeSnapshot(runtime);
      rendererRef.current = activeRenderer;
      baseSnapshotRef.current = baseSnapshot;
      temporalSelectionRef.current = temporalSelection;
      setPresentedState(resolvedState);
      if (temporalNewOnly) {
        if (temporalSelection === null) {
          throw new Error("Temporal new-only fixture selection is unavailable.");
        }
        const snapshot = temporalSnapshot(
          baseSnapshot,
          "new-only",
          temporalSelection,
        );
        await waitForLazyTextureShards(
          activeRenderer,
          snapshot,
          textureSource.loadingPolicy,
        );
        setObservation(
          renderAndObserve(
            activeRenderer,
            canvas,
            snapshot,
            "new-only",
            temporalSelection,
          ),
        );
      } else if (temporalTransition) {
        if (temporalSelection === null) {
          throw new Error("Temporal transition fixture selection is unavailable.");
        }
        const snapshot = temporalSnapshot(
          baseSnapshot,
          "baseline",
          temporalSelection,
        );
        await waitForLazyTextureShards(
          activeRenderer,
          snapshot,
          textureSource.loadingPolicy,
        );
        setObservation(
          renderAndObserve(
            activeRenderer,
            canvas,
            snapshot,
            "baseline",
            temporalSelection,
          ),
        );
      } else {
        const snapshot = rendererSnapshot(baseSnapshot, resolvedState);
        await waitForLazyTextureShards(
          activeRenderer,
          snapshot,
          textureSource.loadingPolicy,
        );
        setObservation(
          renderAndObserve(activeRenderer, canvas, snapshot, "static"),
        );
      }
      setRendererStatus(Object.freeze({ ...activeRenderer.status }));
      setFixtureStatus("ready");
    }).catch(() => {
      if (!disposed) setFixtureStatus("error");
    });

    return () => {
      disposed = true;
      if (frameRequestRef.current !== null) {
        cancelAnimationFrame(frameRequestRef.current);
        frameRequestRef.current = null;
      }
      rendererRef.current = null;
      baseSnapshotRef.current = null;
      temporalSelectionRef.current = null;
      activeRenderer.dispose();
    };
  }, [
    isTemporal,
    pressureStage,
    state,
    stateName,
    temporalNewOnly,
    temporalTransition,
    usesCanvas,
  ]);

  const renderTemporalStage = (stage: TemporalStage) => {
    const renderer = rendererRef.current;
    const baseSnapshot = baseSnapshotRef.current;
    const temporalSelection = temporalSelectionRef.current;
    const canvas = canvasRef.current;
    if (
      !temporalTransition ||
      !renderer ||
      !baseSnapshot ||
      !temporalSelection ||
      !canvas
    ) {
      return;
    }
    const renderStage = () => {
      if (stage === "250ms") {
        // The visual filter intentionally caps one integration delta at
        // 100 ms. Advance through 150 ms first so this stage represents the
        // full 250 ms transition rather than a capped 150 ms approximation.
        renderer.render(
          temporalSnapshot(baseSnapshot, "150ms", temporalSelection),
        );
      }
      const snapshot = temporalSnapshot(
        baseSnapshot,
        stage,
        temporalSelection,
      );
      setObservation(
        renderAndObserve(
          renderer,
          canvas,
          snapshot,
          stage,
          temporalSelection,
        ),
      );
      setRendererStatus(Object.freeze({ ...renderer.status }));
      if (stage !== "baseline") {
        setPresentedState(temporalSelection.newState);
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
        snapshotSequence={1}
        angle={angleForFrequency(presentedState.frequency)}
        volume={presentedState.volume}
        regime={presentedState.regime}
        envelope={presentedState.envelope}
        activeMode={presentedState.activeMode}
        measurementProgress={presentedState.measurementProgress}
        measurementStatus={presentedState.measurementStatus}
        microphoneRms={presentedState.microphoneRms}
        microphonePeak={presentedState.microphonePeak}
        microphoneSamples={microphoneSamples(
          presentedState.phase,
          presentedState.microphonePeak,
        )}
        activeModePhase={presentedState.phase}
        audioEnabled={presentedState.audioEnabled}
        rendererKind={rendererStatus?.kind ?? presentedState.rendererKind}
        renderQuality={rendererStatus?.quality ?? presentedState.renderQuality}
        renderDegradationStage={rendererStatus?.degradationStage ?? 0}
        materialSectionReady={
          rendererStatus?.materialSectionReady ?? false
        }
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
        data-render-quality={rendererStatus?.quality ?? "pending"}
        data-texture-ready={String(rendererStatus?.textureReady ?? false)}
        data-degradation-stage={String(
          rendererStatus?.degradationStage ?? -1,
        )}
        data-temporal-stage={observation.stage}
        data-pixel-signature={observation.pixelSignature}
        data-sand-like-samples={observation.sandLikeSamples}
        data-sand-contrast={observation.sandContrast}
        data-snapshot-signature={observation.snapshotSignature}
        data-active-mode-id={observation.activeModeId}
        data-old-mode-id={observation.oldModeId}
        data-new-mode-id={observation.newModeId}
        data-frequency={observation.frequency}
        data-canvas-width={String(observation.canvasWidth)}
        data-canvas-height={String(observation.canvasHeight)}
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
