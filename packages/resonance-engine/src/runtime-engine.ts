import type {
  DialSnapshot,
  DiagnosticRecord,
  ResonanceDataset,
  RuntimeSnapshot,
  VolumeSnapshot,
} from "../../contracts/src";
import { GENERATED_VOLUME_MAP_SPEC } from "../../contracts/src";
import {
  createDialState,
  reduceDialState,
  stepDialState,
  type DialCommand,
  type DialConfig,
  type DialState,
} from "../../dial-engine/src";
import {
  advanceResonance,
  createResonanceState,
  replaceResonanceDataset,
  resetResonanceAfterPausedGap,
  type ResonanceState,
  type RuntimeModalDataset,
} from "./resonance-engine";

export interface MandelHowlRuntimeState {
  readonly schemaVersion: "mandelhowl.runtime-state.v1";
  readonly dial: DialState;
  readonly resonance: ResonanceState;
  readonly datasetReadiness: "analytical-fallback" | "verified";
  readonly diagnostics: readonly DiagnosticRecord[];
}

export interface CreateMandelHowlRuntimeOptions {
  readonly dataset?: RuntimeModalDataset | ResonanceDataset;
  readonly initialFrequencyHz?: number;
  readonly dialConfig?: Partial<Omit<DialConfig, "version">>;
  readonly diagnostics?: readonly DiagnosticRecord[];
  readonly datasetReadiness?: "analytical-fallback" | "verified";
}

export function createMandelHowlRuntime(
  options: CreateMandelHowlRuntimeOptions = {},
): MandelHowlRuntimeState {
  const dial = createDialState({
    config: options.dialConfig,
    initialFrequencyHz: options.initialFrequencyHz,
  });
  const diagnostics = Object.freeze([...(options.diagnostics ?? [])]);
  return Object.freeze({
    schemaVersion: "mandelhowl.runtime-state.v1",
    dial,
    resonance: createResonanceState({
      dataset: options.dataset,
      initialFrequencyHz: dial.frequencyHz,
      diagnostics,
    }),
    datasetReadiness:
      options.datasetReadiness ??
      (options.dataset ? "verified" : "analytical-fallback"),
    diagnostics,
  });
}

export function dispatchRuntimeDial(
  state: MandelHowlRuntimeState,
  command: DialCommand,
): MandelHowlRuntimeState {
  return Object.freeze({
    ...state,
    dial: reduceDialState(state.dial, command),
  });
}

export function advanceMandelHowlRuntime(
  state: MandelHowlRuntimeState,
  frameDeltaSeconds: number,
): MandelHowlRuntimeState {
  const dial = stepDialState(state.dial, frameDeltaSeconds);
  const resonance = advanceResonance(
    state.resonance,
    frameDeltaSeconds,
    {
      frequencyHz: dial.frequencyHz,
      sweepHzPerSecond: dial.frequencySweepHzPerSecond,
      direction: dial.direction,
    },
  );
  return Object.freeze({
    ...state,
    dial,
    resonance,
  });
}

export function resetMandelHowlRuntimeAfterPausedGap(
  state: MandelHowlRuntimeState,
): MandelHowlRuntimeState {
  return Object.freeze({
    ...state,
    resonance: resetResonanceAfterPausedGap(state.resonance),
  });
}

function approachDirection(
  direction: -1 | 0 | 1,
): DialSnapshot["approachDirection"] {
  if (direction < 0) return "decreasing";
  if (direction > 0) return "increasing";
  return "stationary";
}

function createVolumeSnapshot(
  state: ResonanceState,
): VolumeSnapshot {
  const measurementTotalSeconds =
    GENERATED_VOLUME_MAP_SPEC.measurement.minimumObservationSeconds +
    GENERATED_VOLUME_MAP_SPEC.measurement.stabilityWindowSeconds +
    GENERATED_VOLUME_MAP_SPEC.measurement.confirmationHoldSeconds;
  const progress = Math.min(
    1,
    Math.max(
      0,
      state.measurementElapsedSeconds /
        measurementTotalSeconds,
    ),
  );
  if (progress < 1 || state.lastSettledVolume === null) {
    return Object.freeze({
      status: "measuring",
      value: null,
      lastSettledValue: state.lastSettledVolume,
      progress: Math.min(progress, 1 - Number.EPSILON),
    });
  }
  return Object.freeze({
    status: "settled",
    value: state.lastSettledVolume,
    lastSettledValue: state.lastSettledVolume,
    progress: 1,
  });
}

function recentSamples(state: ResonanceState): readonly number[] {
  const result: number[] = [];
  const count = state.recentSampleCount;
  const start =
    (state.recentSampleWriteIndex -
      count +
      state.recentMicrophoneSamples.length) %
    state.recentMicrophoneSamples.length;
  for (let index = 0; index < count; index += 1) {
    result.push(
      state.recentMicrophoneSamples[
        (start + index) % state.recentMicrophoneSamples.length
      ],
    );
  }
  return Object.freeze(result);
}

export function getRuntimeSnapshot(
  state: MandelHowlRuntimeState,
): RuntimeSnapshot {
  const resonance = state.resonance;
  const dial = state.dial;
  const diagnostics = Object.freeze([
    ...state.diagnostics,
    ...resonance.diagnostics.filter(
      (candidate) =>
        !state.diagnostics.some(
          (existing) =>
            existing.code === candidate.code &&
            existing.messageKey === candidate.messageKey,
        ),
    ),
  ]);
  return Object.freeze({
    schemaVersion: "mandelhowl.runtime-snapshot.v1",
    unitSystem: "SI",
    datasetId: resonance.dataset.datasetId,
    sequence: resonance.sequence,
    simulationStep: resonance.simulationStep,
    simulationTimeSeconds: resonance.simulationTimeSeconds,
    dial: Object.freeze({
      unwrappedAngleRad: dial.unwrappedAngleRadians,
      angularVelocityRadPerSecond:
        dial.angularVelocityRadiansPerSecond,
      driveFrequencyHz: dial.frequencyHz,
      previousDriveFrequencyHz: dial.previousFrequencyHz,
      sweepRateHzPerSecond: dial.frequencySweepHzPerSecond,
      approachDirection: approachDirection(dial.direction),
      stationaryTimeSeconds: dial.stoppedSeconds,
      atMinimumEndStop:
        dial.effectiveAngleRadians <= dial.config.minAngleRadians,
      atMaximumEndStop:
        dial.effectiveAngleRadians >= dial.config.maxAngleRadians,
    }),
    modes: Object.freeze(
      resonance.dataset.modes.map((mode, index) => {
        const energy = Math.min(
          1,
          Math.max(0, resonance.modeEnergy[index] ?? 0),
        );
        return Object.freeze({
          modeId: mode.id,
          amplitudeNormalized: Math.sqrt(energy),
          phaseRad: resonance.modePhaseRadians[index] ?? 0,
          energyNormalized: energy,
        });
      }),
    ),
    microphone: Object.freeze({
      rmsNormalized: resonance.microphoneRms,
      peakNormalized: resonance.microphonePeak,
      recentSamples: recentSamples(resonance),
    }),
    feedback: Object.freeze({
      envelopeNormalized: resonance.feedbackEnvelope,
      loopSignalNormalized: resonance.feedbackLoopSignal,
      limiterGainReductionDb: resonance.limiterGainReductionDb,
      limiterActive: resonance.limiterActive,
    }),
    regime: resonance.regime,
    volume: createVolumeSnapshot(resonance),
    diagnostics,
  });
}

export function replaceMandelHowlDataset(
  state: MandelHowlRuntimeState,
  dataset: RuntimeModalDataset | ResonanceDataset,
  diagnostics: readonly DiagnosticRecord[] = [],
): MandelHowlRuntimeState {
  const combinedDiagnostics = Object.freeze([...diagnostics]);
  return Object.freeze({
    ...state,
    resonance: replaceResonanceDataset(
      state.resonance,
      dataset,
      combinedDiagnostics,
    ),
    datasetReadiness: "verified",
    diagnostics: combinedDiagnostics,
  });
}
