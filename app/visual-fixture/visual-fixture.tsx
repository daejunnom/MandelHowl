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

function angleForFrequency(frequency: number): number {
  const normalized =
    Math.log(frequency / 45) / Math.log(6_000 / 45);
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
): RuntimeSnapshot {
  return Object.freeze({
    ...base,
    sequence: 1,
    simulationStep: 240,
    simulationTimeSeconds: 1,
    dial: Object.freeze({
      ...base.dial,
      unwrappedAngleRad: angleForFrequency(state.frequency),
      driveFrequencyHz: state.frequency,
      previousDriveFrequencyHz: state.frequency,
      sweepRateHzPerSecond: state.dragging ? -48 : 0,
      approachDirection: state.dragging ? "decreasing" : "stationary",
    }),
    modes: Object.freeze(
      base.modes.map((mode, index) => {
        const energy =
          index === state.activeMode ? Math.max(1e-4, state.envelope) : 0;
        return Object.freeze({
          ...mode,
          amplitudeNormalized: Math.sqrt(energy),
          phaseRad: index === state.activeMode ? state.phase : 0,
          energyNormalized: energy,
        });
      }),
    ),
    microphone: Object.freeze({
      rmsNormalized: state.microphoneRms,
      peakNormalized: state.microphonePeak,
      recentSamples: microphoneSamples(state.phase),
    }),
    feedback: Object.freeze({
      envelopeNormalized: state.envelope,
      loopSignalNormalized:
        Math.sin(state.phase) * state.envelope,
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

export function MandelHowlVisualFixture({
  stateName,
}: {
  readonly stateName: string;
}) {
  const state = STATES[stateName] ?? STATES.decayed;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rendererStatus, setRendererStatus] =
    useState<PlateRendererStatus | null>(null);
  const [fixtureStatus, setFixtureStatus] =
    useState<"loading" | "ready" | "error">("loading");

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
          state.renderQuality === "canvas"
            ? undefined
            : state.renderQuality,
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
        initialFrequencyHz: state.frequency,
        datasetReadiness: "verified",
      });
      activeRenderer.render(
        rendererSnapshot(getRuntimeSnapshot(runtime), state),
      );
      setRendererStatus(activeRenderer.status);
      setFixtureStatus("ready");
    });

    return () => {
      disposed = true;
      activeRenderer.dispose();
    };
  }, [state]);

  return (
    <>
      <MandelHowlScene
        frequency={state.frequency}
        angle={angleForFrequency(state.frequency)}
        volume={state.volume}
        regime={state.regime}
        envelope={state.envelope}
        activeMode={state.activeMode}
        measurementProgress={state.measurementProgress}
        measurementStatus={state.measurementStatus}
        microphoneRms={state.microphoneRms}
        microphonePeak={state.microphonePeak}
        microphoneSamples={microphoneSamples(state.phase)}
        activeModePhase={state.phase}
        audioEnabled={state.audioEnabled}
        rendererKind={rendererStatus?.kind ?? state.rendererKind}
        renderQuality={rendererStatus?.quality ?? state.renderQuality}
        datasetStatus="verified"
        dragging={state.dragging}
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
        data-texture-ready={String(
          rendererStatus?.textureReady ?? false,
        )}
      />
    </>
  );
}
