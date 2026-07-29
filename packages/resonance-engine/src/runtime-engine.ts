import type {
  DialSnapshot,
  DiagnosticRecord,
  FeedbackSnapshot,
  MicrophoneSnapshot,
  ModalSnapshot,
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

const MEASUREMENT_TOTAL_SECONDS =
  GENERATED_VOLUME_MAP_SPEC.measurement.minimumObservationSeconds +
  GENERATED_VOLUME_MAP_SPEC.measurement.stabilityWindowSeconds +
  GENERATED_VOLUME_MAP_SPEC.measurement.confirmationHoldSeconds;

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

export type RuntimeSnapshotRebuildReason =
  | "initial"
  | "dataset-id"
  | "mode-layout"
  | "recent-sample-capacity";

declare const RUNTIME_SNAPSHOT_LEASE: unique symbol;

/**
 * Nominal read-only view whose backing graph is invalidated by the writer's
 * next `write()`. It is intentionally distinct from an owned immutable
 * `RuntimeSnapshot`, even though it exposes the same snapshot fields.
 */
export type RuntimeSnapshotLease = RuntimeSnapshot & {
  readonly [RUNTIME_SNAPSHOT_LEASE]: "valid-until-next-write";
};

export type RuntimeSnapshotConsumer = (
  snapshot: RuntimeSnapshotLease,
) => void;

/**
 * Allocation-free projector for the per-frame snapshot hot path.
 *
 * `write()` returns a read-only lease over mutable backing storage. The lease,
 * including every nested object and array, remains valid only until the next
 * `write()` call. Consumers should normally receive it through `publish()` and
 * must not retain it after the synchronous callback returns.
 * Never put this lease in React state, a retaining fan-out, or an asynchronous
 * callback; those consumers must continue to use immutable
 * `getRuntimeSnapshot()` copies.
 *
 * The backing graph is rebuilt only on the first write, a dataset-id change, a
 * mode id/order/count change, or a recent-sample ring-capacity change.
 * `lastWriteRebuilt`, `lastWriteRebuildReason`, and `layoutGeneration` expose
 * those exceptional allocations.
 */
export interface RuntimeSnapshotWriter {
  readonly layoutGeneration: number;
  readonly lastWriteRebuilt: boolean;
  readonly lastWriteRebuildReason: RuntimeSnapshotRebuildReason | null;
  readonly recentSampleCapacity: number;
  write(state: MandelHowlRuntimeState): RuntimeSnapshotLease;
  publish(
    state: MandelHowlRuntimeState,
    consumer: RuntimeSnapshotConsumer,
  ): void;
}

type MutableDialSnapshot = {
  -readonly [Key in keyof DialSnapshot]: DialSnapshot[Key];
};

type MutableModalSnapshot = {
  -readonly [Key in keyof ModalSnapshot]: ModalSnapshot[Key];
};

type MutableFeedbackSnapshot = {
  -readonly [Key in keyof FeedbackSnapshot]: FeedbackSnapshot[Key];
};

type MutableMicrophoneSnapshot = Omit<
  {
    -readonly [Key in keyof MicrophoneSnapshot]:
      MicrophoneSnapshot[Key];
  },
  "recentSamples"
> & {
  recentSamples: number[];
};

interface MutableVolumeSnapshot {
  status: "measuring" | "settled";
  value: number | null;
  lastSettledValue: number | null;
  progress: number;
}

interface MutableRuntimeSnapshot {
  schemaVersion: RuntimeSnapshot["schemaVersion"];
  unitSystem: RuntimeSnapshot["unitSystem"];
  datasetId: RuntimeSnapshot["datasetId"];
  sequence: number;
  simulationStep: number;
  simulationTimeSeconds: number;
  dial: MutableDialSnapshot;
  modes: MutableModalSnapshot[];
  activeModeId: string | null;
  microphone: MutableMicrophoneSnapshot;
  feedback: MutableFeedbackSnapshot;
  regime: RuntimeSnapshot["regime"];
  volume: MutableVolumeSnapshot;
  diagnostics: DiagnosticRecord[];
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
  const progress = Math.min(
    1,
    Math.max(
      0,
      state.measurementElapsedSeconds /
        MEASUREMENT_TOTAL_SECONDS,
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

function createMutableSnapshot(
  state: MandelHowlRuntimeState,
): MutableRuntimeSnapshot {
  const resonance = state.resonance;
  const modes = new Array<MutableModalSnapshot>(
    resonance.dataset.modes.length,
  );
  for (let index = 0; index < modes.length; index += 1) {
    modes[index] = {
      modeId: resonance.dataset.modes[index].id,
      amplitudeNormalized: 0,
      phaseRad: 0,
      energyNormalized: 0,
    };
  }

  const sampleCapacity = resonance.recentMicrophoneSamples.length;
  const samples = new Array<number>(sampleCapacity);
  for (let index = 0; index < sampleCapacity; index += 1) {
    samples[index] = 0;
  }
  samples.length = 0;

  return {
    schemaVersion: "mandelhowl.runtime-snapshot.v1",
    unitSystem: "SI",
    datasetId: resonance.dataset.datasetId,
    sequence: 0,
    simulationStep: 0,
    simulationTimeSeconds: 0,
    dial: {
      unwrappedAngleRad: 0,
      angularVelocityRadPerSecond: 0,
      driveFrequencyHz: 0,
      previousDriveFrequencyHz: 0,
      sweepRateHzPerSecond: 0,
      approachDirection: "stationary",
      stationaryTimeSeconds: 0,
      atMinimumEndStop: false,
      atMaximumEndStop: false,
    },
    modes,
    activeModeId: null,
    microphone: {
      rmsNormalized: 0,
      peakNormalized: 0,
      recentSamples: samples,
    },
    feedback: {
      envelopeNormalized: 0,
      loopSignalNormalized: 0,
      limiterGainReductionDb: 0,
      limiterActive: false,
    },
    regime: "decaying",
    volume: {
      status: "measuring",
      value: null,
      lastSettledValue: null,
      progress: 0,
    },
    diagnostics: [],
  };
}

function writeRecentSamples(
  target: number[],
  state: ResonanceState,
): void {
  const capacity = state.recentMicrophoneSamples.length;
  const count = Math.min(state.recentSampleCount, capacity);
  target.length = count;
  if (capacity === 0) return;
  const start =
    (state.recentSampleWriteIndex - count + capacity) % capacity;
  for (let index = 0; index < count; index += 1) {
    target[index] =
      state.recentMicrophoneSamples[(start + index) % capacity];
  }
}

function writeVolumeSnapshot(
  target: MutableVolumeSnapshot,
  state: ResonanceState,
): void {
  const progress = Math.min(
    1,
    Math.max(
      0,
      state.measurementElapsedSeconds /
        MEASUREMENT_TOTAL_SECONDS,
    ),
  );
  target.lastSettledValue = state.lastSettledVolume;
  if (progress < 1 || state.lastSettledVolume === null) {
    target.status = "measuring";
    target.value = null;
    target.progress = Math.min(progress, 1 - Number.EPSILON);
    return;
  }
  target.status = "settled";
  target.value = state.lastSettledVolume;
  target.progress = 1;
}

function writeDiagnostics(
  target: DiagnosticRecord[],
  stateDiagnostics: readonly DiagnosticRecord[],
  resonanceDiagnostics: readonly DiagnosticRecord[],
): void {
  target.length = 0;
  for (let index = 0; index < stateDiagnostics.length; index += 1) {
    target[target.length] = stateDiagnostics[index];
  }
  for (let index = 0; index < resonanceDiagnostics.length; index += 1) {
    const candidate = resonanceDiagnostics[index];
    let duplicate = false;
    for (
      let existingIndex = 0;
      existingIndex < stateDiagnostics.length;
      existingIndex += 1
    ) {
      const existing = stateDiagnostics[existingIndex];
      if (
        existing.code === candidate.code &&
        existing.messageKey === candidate.messageKey
      ) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      target[target.length] = candidate;
    }
  }
}

class ReusableRuntimeSnapshotWriter
  implements RuntimeSnapshotWriter
{
  private snapshot: MutableRuntimeSnapshot | null = null;
  private generation = 0;
  private didRebuild = false;
  private rebuildReason: RuntimeSnapshotRebuildReason | null = null;
  private sampleCapacity = 0;

  get layoutGeneration(): number {
    return this.generation;
  }

  get lastWriteRebuilt(): boolean {
    return this.didRebuild;
  }

  get lastWriteRebuildReason():
    | RuntimeSnapshotRebuildReason
    | null {
    return this.rebuildReason;
  }

  get recentSampleCapacity(): number {
    return this.sampleCapacity;
  }

  write(state: MandelHowlRuntimeState): RuntimeSnapshotLease {
    const reason = this.detectRebuildReason(state);
    this.didRebuild = reason !== null;
    this.rebuildReason = reason;
    if (reason !== null) {
      this.snapshot = createMutableSnapshot(state);
      this.sampleCapacity =
        state.resonance.recentMicrophoneSamples.length;
      this.generation += 1;
    }

    const target = this.snapshot;
    if (target === null) {
      throw new Error("Runtime snapshot writer failed to initialize");
    }
    this.project(target, state);
    return target as unknown as RuntimeSnapshotLease;
  }

  publish(
    state: MandelHowlRuntimeState,
    consumer: RuntimeSnapshotConsumer,
  ): void {
    consumer(this.write(state));
  }

  private detectRebuildReason(
    state: MandelHowlRuntimeState,
  ): RuntimeSnapshotRebuildReason | null {
    const target = this.snapshot;
    if (target === null) return "initial";
    const resonance = state.resonance;
    if (target.datasetId !== resonance.dataset.datasetId) {
      return "dataset-id";
    }
    if (target.modes.length !== resonance.dataset.modes.length) {
      return "mode-layout";
    }
    for (let index = 0; index < target.modes.length; index += 1) {
      if (
        target.modes[index].modeId !==
        resonance.dataset.modes[index].id
      ) {
        return "mode-layout";
      }
    }
    if (
      this.sampleCapacity !==
      resonance.recentMicrophoneSamples.length
    ) {
      return "recent-sample-capacity";
    }
    return null;
  }

  private project(
    target: MutableRuntimeSnapshot,
    state: MandelHowlRuntimeState,
  ): void {
    const resonance = state.resonance;
    const dial = state.dial;
    target.datasetId = resonance.dataset.datasetId;
    target.sequence = resonance.sequence;
    target.simulationStep = resonance.simulationStep;
    target.simulationTimeSeconds =
      resonance.simulationTimeSeconds;

    target.dial.unwrappedAngleRad = dial.unwrappedAngleRadians;
    target.dial.angularVelocityRadPerSecond =
      dial.angularVelocityRadiansPerSecond;
    target.dial.driveFrequencyHz = dial.frequencyHz;
    target.dial.previousDriveFrequencyHz =
      dial.previousFrequencyHz;
    target.dial.sweepRateHzPerSecond =
      dial.frequencySweepHzPerSecond;
    target.dial.approachDirection = approachDirection(
      dial.direction,
    );
    target.dial.stationaryTimeSeconds = dial.stoppedSeconds;
    target.dial.atMinimumEndStop =
      dial.effectiveAngleRadians <= dial.config.minAngleRadians;
    target.dial.atMaximumEndStop =
      dial.effectiveAngleRadians >= dial.config.maxAngleRadians;

    for (let index = 0; index < target.modes.length; index += 1) {
      const energy = Math.min(
        1,
        Math.max(0, resonance.modeEnergy[index] ?? 0),
      );
      const mode = target.modes[index];
      mode.modeId = resonance.dataset.modes[index].id;
      mode.amplitudeNormalized = Math.sqrt(energy);
      mode.phaseRad = resonance.modePhaseRadians[index] ?? 0;
      mode.energyNormalized = energy;
    }

    target.activeModeId =
      resonance.activeModeIndex === null
        ? null
        : (resonance.dataset.modes[resonance.activeModeIndex]
            ?.id ?? null);
    target.microphone.rmsNormalized = resonance.microphoneRms;
    target.microphone.peakNormalized =
      resonance.microphonePeak;
    writeRecentSamples(
      target.microphone.recentSamples,
      resonance,
    );

    target.feedback.envelopeNormalized =
      resonance.feedbackEnvelope;
    target.feedback.loopSignalNormalized =
      resonance.feedbackLoopSignal;
    target.feedback.limiterGainReductionDb =
      resonance.limiterGainReductionDb;
    target.feedback.limiterActive = resonance.limiterActive;
    target.regime = resonance.regime;
    writeVolumeSnapshot(target.volume, resonance);
    writeDiagnostics(
      target.diagnostics,
      state.diagnostics,
      resonance.diagnostics,
    );
  }
}

export function createRuntimeSnapshotWriter(): RuntimeSnapshotWriter {
  return new ReusableRuntimeSnapshotWriter();
}

export function getRuntimeSnapshot(
  state: MandelHowlRuntimeState,
): RuntimeSnapshot {
  const resonance = state.resonance;
  const dial = state.dial;
  const activeModeId =
    resonance.activeModeIndex === null
      ? null
      : (resonance.dataset.modes[resonance.activeModeIndex]?.id ?? null);
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
    activeModeId,
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
