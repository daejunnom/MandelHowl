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

export interface AudioLevelMeasurement {
  readonly rmsLinear: number;
  readonly peakLinear: number;
  readonly rmsDbfs: number;
  readonly peakDbfs: number;
}

export function linearToDb(value: number): number {
  return value <= 0 ? -120 : 20 * Math.log10(value);
}

export function dbToLinear(value: number): number {
  return Math.pow(10, value / 20);
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
  const elapsed = Math.min(0.25, Math.max(0, elapsedSeconds));
  const highFrequency =
    frame.frequency >= spec.exposureGuard.highFrequencyThresholdHz &&
    frame.envelope > 0.12;
  const saturated = frame.regime === "saturated" && frame.envelope > 0.8;
  const highFrequencySeconds = highFrequency
    ? previous.highFrequencySeconds + elapsed
    : Math.max(0, previous.highFrequencySeconds - elapsed * 2);
  const saturationSeconds = saturated
    ? previous.saturationSeconds + elapsed
    : Math.max(0, previous.saturationSeconds - elapsed * 2);

  return Object.freeze({
    highFrequencySeconds,
    saturationSeconds,
    active:
      highFrequencySeconds >=
        spec.exposureGuard.maximumContinuousHighFrequencySeconds ||
      saturationSeconds >=
        spec.exposureGuard.maximumContinuousSaturationSeconds,
  });
}

export function outputGainFromEnvelope(
  envelope: number,
  regime: ResonanceRegime,
  exposureGuardActive: boolean,
  spec: Readonly<AudioSafetySpec>,
): number {
  const safeEnvelope = Math.min(1, Math.max(0, envelope));
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
  const currentDb = linearToDb(Math.max(SILENCE_FLOOR, previousGain));
  const targetDb = linearToDb(Math.max(SILENCE_FLOOR, targetGain));
  const maximumDelta =
    Math.max(0, maximumChangeDbPerSecond) *
    Math.max(0, elapsedSeconds);
  const delta = Math.min(
    maximumDelta,
    Math.max(-maximumDelta, targetDb - currentDb),
  );
  const nextGain =
    targetGain <= 0 && currentDb + delta <= -100
      ? 0
      : dbToLinear(currentDb + delta);
  return Math.min(Math.max(0, maximumGain), nextGain);
}
