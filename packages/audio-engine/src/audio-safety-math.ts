import type {
  AudioSafetySpec,
  ResonanceRegime,
} from "../../contracts/src";

const SILENCE_FLOOR = 0.000_01;

export interface ExposureState {
  readonly highFrequencySeconds: number;
  readonly saturationSeconds: number;
  readonly active: boolean;
}

export interface MutableExposureState {
  highFrequencySeconds: number;
  saturationSeconds: number;
  active: boolean;
}

export interface AudioLevelMeasurement {
  readonly rmsLinear: number;
  readonly peakLinear: number;
  readonly rmsDbfs: number;
  readonly peakDbfs: number;
}

export function linearToDb(value: number): number {
  if (Number.isNaN(value) || value <= 0) return -120;
  if (!Number.isFinite(value)) return 120;
  return 20 * Math.log10(value);
}

export function dbToLinear(value: number): number {
  return Number.isFinite(value) ? Math.pow(10, value / 20) : 0;
}

export function measureAudioSamples(
  samples: ArrayLike<number>,
): AudioLevelMeasurement {
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index]) ? samples[index] : 0;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return Object.freeze({
    rmsLinear: rms,
    peakLinear: peak,
    rmsDbfs: linearToDb(rms),
    peakDbfs: linearToDb(peak),
  });
}

export function updateExposureState(
  previous: ExposureState,
  frame: {
    readonly frequency: number;
    readonly envelope: number;
    readonly regime: ResonanceRegime;
  },
  elapsedSeconds: number,
  spec: Readonly<AudioSafetySpec>,
): ExposureState {
  const next: MutableExposureState = {
    highFrequencySeconds: previous.highFrequencySeconds,
    saturationSeconds: previous.saturationSeconds,
    active: previous.active,
  };
  updateExposureStateInPlace(
    next,
    frame,
    elapsedSeconds,
    spec,
  );
  return Object.freeze(next);
}

/** Allocation-free exposure update for the live audio-frame path. */
export function updateExposureStateInPlace(
  state: MutableExposureState,
  frame: {
    readonly frequency: number;
    readonly envelope: number;
    readonly regime: ResonanceRegime;
  },
  elapsedSeconds: number,
  spec: Readonly<AudioSafetySpec>,
): MutableExposureState {
  const elapsed = Math.min(
    0.25,
    Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0),
  );
  const frequency = Number.isFinite(frame.frequency)
    ? frame.frequency
    : 0;
  const envelope = Number.isFinite(frame.envelope)
    ? frame.envelope
    : 0;
  const highFrequency =
    frequency >= spec.exposureGuard.highFrequencyThresholdHz &&
    envelope > 0.12;
  const saturated = frame.regime === "saturated" && envelope > 0.8;
  const highFrequencySeconds = highFrequency
    ? state.highFrequencySeconds + elapsed
    : Math.max(0, state.highFrequencySeconds - elapsed * 2);
  const saturationSeconds = saturated
    ? state.saturationSeconds + elapsed
    : Math.max(0, state.saturationSeconds - elapsed * 2);

  state.highFrequencySeconds = highFrequencySeconds;
  state.saturationSeconds = saturationSeconds;
  state.active =
    highFrequencySeconds >=
      spec.exposureGuard.maximumContinuousHighFrequencySeconds ||
    saturationSeconds >=
      spec.exposureGuard.maximumContinuousSaturationSeconds;
  return state;
}

export function outputGainFromEnvelope(
  envelope: number,
  regime: ResonanceRegime,
  exposureGuardActive: boolean,
  spec: Readonly<AudioSafetySpec>,
): number {
  const safeEnvelope = Math.min(
    1,
    Math.max(0, Number.isFinite(envelope) ? envelope : 0),
  );
  const guardTrim = exposureGuardActive
    ? dbToLinear(-spec.exposureGuard.attenuationDb)
    : 1;
  const regimeTrim = regime === "saturated" ? 0.82 : 1;
  return Math.min(
    spec.sourceMapping.maximumOutputGainLinear,
    Math.pow(safeEnvelope, spec.sourceMapping.exponent) *
      spec.sourceMapping.maximumOutputGainLinear *
      regimeTrim *
      guardTrim,
  );
}

export function rateLimitGain(
  previousGain: number,
  targetGain: number,
  elapsedSeconds: number,
  maximumChangeDbPerSecond: number,
  maximumGain: number,
): number {
  const safeMaximumGain = Math.max(
    0,
    Number.isFinite(maximumGain) ? maximumGain : 0,
  );
  const safePreviousGain = Math.min(
    safeMaximumGain,
    Math.max(0, Number.isFinite(previousGain) ? previousGain : 0),
  );
  const safeTargetGain = Math.min(
    safeMaximumGain,
    Math.max(0, Number.isFinite(targetGain) ? targetGain : 0),
  );
  const currentDb = linearToDb(
    Math.max(SILENCE_FLOOR, safePreviousGain),
  );
  const targetDb = linearToDb(
    Math.max(SILENCE_FLOOR, safeTargetGain),
  );
  const maximumDelta =
    Math.max(
      0,
      Number.isFinite(maximumChangeDbPerSecond)
        ? maximumChangeDbPerSecond
        : 0,
    ) *
    Math.max(
      0,
      Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0,
    );
  const delta = Math.min(
    maximumDelta,
    Math.max(-maximumDelta, targetDb - currentDb),
  );
  const nextGain =
    safeTargetGain <= 0 && currentDb + delta <= -100
      ? 0
      : dbToLinear(currentDb + delta);
  return Math.min(safeMaximumGain, Math.max(0, nextGain));
}
