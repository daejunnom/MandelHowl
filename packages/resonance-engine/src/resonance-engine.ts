import {
  PROTOTYPE_MODAL_DATASET,
  type PrototypeModalDataset,
} from "./prototype-dataset";

const TAU = Math.PI * 2;
const FIXED_STEP_SECONDS = 1 / 120;
const MAX_ADVANCE_SECONDS = 0.25;
const MEASUREMENT_WINDOW_SECONDS = 1.25;

export type ResonanceRegime =
  | "decaying"
  | "critical"
  | "growing"
  | "saturated";

export interface ResonanceDrive {
  readonly frequencyHz: number;
  readonly sweepHzPerSecond?: number;
  readonly direction?: -1 | 0 | 1;
}

export interface ResonanceState {
  readonly schemaVersion: "mandelhowl.resonance-state.v1";
  readonly dataset: PrototypeModalDataset;
  readonly simulationTimeSeconds: number;
  readonly accumulatorSeconds: number;
  readonly driveFrequencyHz: number;
  readonly previousDriveFrequencyHz: number;
  readonly sweepHzPerSecond: number;
  readonly approachDirection: -1 | 0 | 1;
  readonly modeEnergy: readonly number[];
  readonly modePhaseRadians: readonly number[];
  readonly feedbackEnvelope: number;
  readonly microphoneRms: number;
  readonly microphonePeak: number;
  readonly regime: ResonanceRegime;
  readonly activeModeIndex: number | null;
  readonly instantaneousVolume: number;
  readonly settledVolume: number;
  readonly measurementElapsedSeconds: number;
}

export interface ResonanceSnapshot {
  readonly schemaVersion: "mandelhowl.runtime-resonance-snapshot.v1";
  readonly datasetId: string;
  readonly simulationTimeSeconds: number;
  readonly frequencyHz: number;
  readonly sweepHzPerSecond: number;
  readonly modeEnergy: readonly number[];
  readonly feedbackEnvelope: number;
  readonly microphoneRms: number;
  readonly microphonePeak: number;
  readonly regime: ResonanceRegime;
  readonly activeModeIndex: number | null;
  readonly volume: number;
  readonly measurementProgress: number;
  readonly settled: boolean;
}

export interface CreateResonanceOptions {
  readonly dataset?: PrototypeModalDataset;
  readonly initialFrequencyHz?: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finiteOr(value, minimum)));
}

function sign(value: number, deadBand = 1e-6): -1 | 0 | 1 {
  if (value > deadBand) return 1;
  if (value < -deadBand) return -1;
  return 0;
}

function wrapPhase(value: number): number {
  const wrapped = value % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function smoothstep(value: number): number {
  const unit = clamp(value, 0, 1);
  return unit * unit * (3 - 2 * unit);
}

function responseAtFrequency(
  frequencyHz: number,
  modeFrequencyHz: number,
  dampingRatio: number,
): number {
  const bandwidthHz = Math.max(
    1.6,
    modeFrequencyHz * (dampingRatio * 3.4 + 0.0045),
  );
  const normalizedDetuning = (frequencyHz - modeFrequencyHz) / bandwidthHz;
  return 1 / (1 + normalizedDetuning * normalizedDetuning);
}

function volumeFromRms(rms: number, envelope: number): number {
  const safeRms = clamp(rms, 0, 1);
  const safeEnvelope = clamp(envelope, 0, 1);

  if (safeRms < 0.018 || safeEnvelope < 0.012) {
    return 0;
  }

  if (safeRms >= 0.86 || safeEnvelope >= 0.965) {
    return 100;
  }

  const normalized = (safeRms - 0.018) / (0.86 - 0.018);
  return Math.round(1 + smoothstep(normalized) * 98);
}

function classifyRegime(
  loopMargin: number,
  envelope: number,
): ResonanceRegime {
  if (envelope >= 0.92) {
    return "saturated";
  }
  if (loopMargin > 0.075) {
    return "growing";
  }
  if (loopMargin >= -0.075 || (envelope > 0.08 && envelope < 0.76)) {
    return "critical";
  }
  return "decaying";
}

export function createResonanceState(
  options: CreateResonanceOptions = {},
): ResonanceState {
  const dataset = options.dataset ?? PROTOTYPE_MODAL_DATASET;
  const [minimumFrequency, maximumFrequency] = dataset.frequencyRangeHz;
  const frequencyHz = clamp(
    finiteOr(options.initialFrequencyHz, 220),
    minimumFrequency,
    maximumFrequency,
  );

  return {
    schemaVersion: "mandelhowl.resonance-state.v1",
    dataset,
    simulationTimeSeconds: 0,
    accumulatorSeconds: 0,
    driveFrequencyHz: frequencyHz,
    previousDriveFrequencyHz: frequencyHz,
    sweepHzPerSecond: 0,
    approachDirection: 0,
    modeEnergy: dataset.modes.map(() => 0),
    modePhaseRadians: dataset.modes.map((mode) => mode.phaseOffsetRadians),
    feedbackEnvelope: 0,
    microphoneRms: 0,
    microphonePeak: 0,
    regime: "decaying",
    activeModeIndex: null,
    instantaneousVolume: 0,
    settledVolume: 0,
    measurementElapsedSeconds: 0,
  };
}

function integrateFixedStep(
  state: ResonanceState,
  drive: ResonanceDrive,
): ResonanceState {
  const [minimumFrequency, maximumFrequency] = state.dataset.frequencyRangeHz;
  const frequencyHz = clamp(
    finiteOr(drive.frequencyHz, state.driveFrequencyHz),
    minimumFrequency,
    maximumFrequency,
  );
  const inferredSweep =
    (frequencyHz - state.driveFrequencyHz) / FIXED_STEP_SECONDS;
  const sweepHzPerSecond = clamp(
    finiteOr(drive.sweepHzPerSecond, inferredSweep),
    -8_000,
    8_000,
  );
  const approachDirection =
    drive.direction === -1 || drive.direction === 0 || drive.direction === 1
      ? drive.direction
      : sign(sweepHzPerSecond, 0.05);
  const speedCapture = Math.exp(-Math.abs(sweepHzPerSecond) / 260);

  let strongestModeIndex = -1;
  let strongestScore = 0;
  let responseSum = 0;
  let microphoneWeight = 0;
  const modeEnergy = new Array<number>(state.dataset.modes.length);
  const modePhaseRadians = new Array<number>(state.dataset.modes.length);

  for (let index = 0; index < state.dataset.modes.length; index += 1) {
    const mode = state.dataset.modes[index];
    const response = responseAtFrequency(
      frequencyHz,
      mode.frequencyHz,
      mode.dampingRatio,
    );
    const coupling =
      response * mode.driveCoupling * mode.microphoneCoupling;
    const directionalPhase =
      approachDirection === 0
        ? 1
        : 1 +
          approachDirection *
            Math.sin(mode.phaseOffsetRadians) *
            0.035;
    const score = coupling * directionalPhase;
    responseSum += score;

    if (score > strongestScore) {
      strongestScore = score;
      strongestModeIndex = index;
    }

    const oldEnergy = clamp(state.modeEnergy[index] ?? 0, 0, 1);
    const retainedDrive = 0.18 + speedCapture * 0.82;
    const targetEnergy = clamp(
      score *
        retainedDrive *
        (0.32 + state.feedbackEnvelope * 1.34),
      0,
      1,
    );
    const followsAttack = targetEnergy > oldEnergy;
    const followRate = followsAttack
      ? 2.4 + response * 3.8
      : 0.52 + mode.dampingRatio * 18;
    const nextEnergy =
      oldEnergy +
      (targetEnergy - oldEnergy) *
        (1 - Math.exp(-followRate * FIXED_STEP_SECONDS));
    modeEnergy[index] = clamp(nextEnergy, 0, 1);

    const phase = wrapPhase(
      (state.modePhaseRadians[index] ?? mode.phaseOffsetRadians) +
        TAU *
          (mode.frequencyHz - frequencyHz) *
          FIXED_STEP_SECONDS *
          0.085,
    );
    modePhaseRadians[index] = phase;
    microphoneWeight +=
      Math.sqrt(modeEnergy[index]) *
      mode.microphoneCoupling *
      (0.72 + Math.sin(phase) * 0.12);
  }

  const adjacentResponse = clamp(responseSum - strongestScore, 0, 1);
  const phaseA =
    strongestModeIndex >= 0 ? modePhaseRadians[strongestModeIndex] : 0;
  const phaseB =
    strongestModeIndex >= 0
      ? modePhaseRadians[
          Math.min(strongestModeIndex + 1, modePhaseRadians.length - 1)
        ]
      : 0;
  const beat = 0.5 + 0.5 * Math.sin(phaseA - phaseB);
  const historyBoost = state.feedbackEnvelope > 0.46 ? 0.055 : 0;
  const loopGain =
    strongestScore * 1.31 +
    adjacentResponse * (0.18 + beat * 0.08) +
    historyBoost;
  const loopMargin = loopGain - 1;

  let envelope = state.feedbackEnvelope;
  if (loopMargin > 0.075) {
    const growthRate = 0.42 + loopMargin * 2.25;
    envelope +=
      (1 - envelope) *
      (1 - Math.exp(-growthRate * FIXED_STEP_SECONDS));
  } else if (loopMargin < -0.075) {
    const decayRate = 0.68 + Math.abs(loopMargin) * 1.55;
    envelope *= Math.exp(-decayRate * FIXED_STEP_SECONDS);
  } else {
    const criticalTarget = clamp(
      0.22 + beat * 0.36 + adjacentResponse * 0.18,
      0.12,
      0.76,
    );
    envelope +=
      (criticalTarget - envelope) *
      (1 - Math.exp(-0.92 * FIXED_STEP_SECONDS));
  }
  envelope = clamp(envelope, 0, 1);

  const normalizedMicrophone = clamp(
    microphoneWeight / Math.max(1, state.dataset.modes.length * 0.19),
    0,
    1,
  );
  const beatModulation = 0.78 + beat * 0.22;
  const microphoneRms = clamp(
    envelope *
      beatModulation *
      (0.66 + normalizedMicrophone * 0.42),
    0,
    1,
  );
  const microphonePeak = clamp(
    microphoneRms * (1.06 + adjacentResponse * 0.16),
    0,
    1,
  );
  const instantaneousVolume = volumeFromRms(microphoneRms, envelope);
  const regime = classifyRegime(loopMargin, envelope);

  const frequencyMotion = Math.abs(sweepHzPerSecond);
  const changedFrequency =
    Math.abs(frequencyHz - state.driveFrequencyHz) > 0.12;
  const stableEnough = frequencyMotion < 1.2 && !changedFrequency;
  const measurementElapsedSeconds = stableEnough
    ? Math.min(
        MEASUREMENT_WINDOW_SECONDS,
        state.measurementElapsedSeconds + FIXED_STEP_SECONDS,
      )
    : Math.max(
        0,
        state.measurementElapsedSeconds - FIXED_STEP_SECONDS * 2.4,
      );
  const settledVolume =
    measurementElapsedSeconds >= MEASUREMENT_WINDOW_SECONDS
      ? instantaneousVolume
      : state.settledVolume;

  return {
    ...state,
    simulationTimeSeconds:
      state.simulationTimeSeconds + FIXED_STEP_SECONDS,
    driveFrequencyHz: frequencyHz,
    previousDriveFrequencyHz: state.driveFrequencyHz,
    sweepHzPerSecond,
    approachDirection,
    modeEnergy,
    modePhaseRadians,
    feedbackEnvelope: envelope,
    microphoneRms,
    microphonePeak,
    regime,
    activeModeIndex:
      strongestScore >= 0.075 && strongestModeIndex >= 0
        ? strongestModeIndex
        : null,
    instantaneousVolume,
    settledVolume,
    measurementElapsedSeconds,
  };
}

export function advanceResonance(
  state: ResonanceState,
  deltaSeconds: number,
  drive: ResonanceDrive = { frequencyHz: state.driveFrequencyHz },
): ResonanceState {
  const requestedDelta = clamp(
    finiteOr(deltaSeconds, 0),
    0,
    MAX_ADVANCE_SECONDS,
  );
  let accumulator = state.accumulatorSeconds + requestedDelta;
  let nextState = state;

  while (accumulator + 1e-12 >= FIXED_STEP_SECONDS) {
    nextState = integrateFixedStep(nextState, drive);
    accumulator -= FIXED_STEP_SECONDS;
  }

  return {
    ...nextState,
    accumulatorSeconds: Math.max(0, accumulator),
  };
}

export function getResonanceSnapshot(
  state: ResonanceState,
): ResonanceSnapshot {
  const measurementProgress = clamp(
    state.measurementElapsedSeconds / MEASUREMENT_WINDOW_SECONDS,
    0,
    1,
  );

  return Object.freeze({
    schemaVersion: "mandelhowl.runtime-resonance-snapshot.v1",
    datasetId: state.dataset.datasetId,
    simulationTimeSeconds: state.simulationTimeSeconds,
    frequencyHz: state.driveFrequencyHz,
    sweepHzPerSecond: state.sweepHzPerSecond,
    modeEnergy: Object.freeze([...state.modeEnergy]),
    feedbackEnvelope: state.feedbackEnvelope,
    microphoneRms: state.microphoneRms,
    microphonePeak: state.microphonePeak,
    regime: state.regime,
    activeModeIndex: state.activeModeIndex,
    volume:
      measurementProgress >= 1
        ? state.settledVolume
        : state.instantaneousVolume,
    measurementProgress,
    settled: measurementProgress >= 1,
  });
}

export const initResonance = createResonanceState;
export const stepResonance = advanceResonance;
