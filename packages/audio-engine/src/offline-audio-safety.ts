import {
  GENERATED_AUDIO_SAFETY_SPEC,
  type AudioSafetySpec,
} from "../../contracts/src";
import {
  measureAudioSamples,
  type AudioLevelMeasurement,
} from "./audio-safety-math";
import { createAudioSafetyChain } from "./audio-safety-graph";

export interface OfflineAudioSafetyPoint {
  readonly frequencyHz: number;
  readonly rmsDbfs: number;
  readonly peakDbfs: number;
}

export interface OfflineAudioSafetySweep {
  readonly schemaVersion: "mandelhowl.offline-audio-safety-sweep.v1";
  readonly sampleRateHz: number;
  readonly durationSeconds: number;
  readonly frequenciesHz: readonly number[];
  readonly maximumRmsDbfs: number;
  readonly maximumPeakDbfs: number;
  readonly rmsLimitDbfs: number;
  readonly peakLimitDbfs: number;
  readonly points: readonly OfflineAudioSafetyPoint[];
  readonly passed: boolean;
}

const SWEEP_FREQUENCIES_HZ = Object.freeze([
  55, 110, 220, 440, 1_000, 3_000, 6_000,
]);
const PARTIAL_RATIOS = Object.freeze([1, 1.498, 2.01]);
const PARTIAL_WEIGHTS = Object.freeze([0.62, 0.25, 0.13]);
const SAMPLE_RATE_HZ = 48_000;
const SEGMENT_SECONDS = 0.75;
const TRANSITION_SECONDS = 0.2;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function measurementPoint(
  frequencyHz: number,
  measurement: AudioLevelMeasurement,
): OfflineAudioSafetyPoint {
  return Object.freeze({
    frequencyHz,
    rmsDbfs: measurement.rmsDbfs,
    peakDbfs: measurement.peakDbfs,
  });
}

/**
 * Renders a worst-case, full-gain sweep through the same graph constructor as
 * SafeAudioEngine. This is intentionally browser-native evidence: no mock DSP
 * or virtual VOLUME value participates in the measurement.
 */
export async function renderOfflineAudioSafetySweep(
  safety: Readonly<AudioSafetySpec> = GENERATED_AUDIO_SAFETY_SPEC,
): Promise<OfflineAudioSafetySweep> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("OfflineAudioContext is unavailable.");
  }

  const durationSeconds =
    SWEEP_FREQUENCIES_HZ.length * SEGMENT_SECONDS;
  const context = new OfflineAudioContext(
    1,
    Math.ceil(durationSeconds * SAMPLE_RATE_HZ),
    SAMPLE_RATE_HZ,
  );
  const chain = createAudioSafetyChain(context, safety);
  chain.masterGain.gain.value =
    safety.sourceMapping.maximumOutputGainLinear;

  SWEEP_FREQUENCIES_HZ.forEach((frequencyHz, index) => {
    const time = index * SEGMENT_SECONDS;
    chain.lowPass.frequency.setValueAtTime(
      clamp(
        frequencyHz * 3.2,
        Math.max(220, safety.bandLimiter.highPassHz * 2),
        safety.bandLimiter.lowPassHz,
      ),
      time,
    );
  });

  const oscillatorTypes: readonly OscillatorType[] = [
    "sine",
    "triangle",
    "sine",
  ];
  oscillatorTypes.forEach((type, partialIndex) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    gain.gain.value = PARTIAL_WEIGHTS[partialIndex] ?? 0;
    SWEEP_FREQUENCIES_HZ.forEach((frequencyHz, index) => {
      oscillator.frequency.setValueAtTime(
        clamp(
          frequencyHz * (PARTIAL_RATIOS[partialIndex] ?? 1),
          20,
          Math.min(8_000, safety.bandLimiter.lowPassHz),
        ),
        index * SEGMENT_SECONDS,
      );
    });
    oscillator.connect(gain);
    gain.connect(chain.inputMix);
    oscillator.start(0);
    oscillator.stop(durationSeconds);
  });

  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const points = SWEEP_FREQUENCIES_HZ.map((frequencyHz, index) => {
    const segmentStart =
      (index * SEGMENT_SECONDS + TRANSITION_SECONDS) * SAMPLE_RATE_HZ;
    const segmentEnd =
      (index + 1) * SEGMENT_SECONDS * SAMPLE_RATE_HZ;
    return measurementPoint(
      frequencyHz,
      measureAudioSamples(
        samples.subarray(Math.floor(segmentStart), Math.floor(segmentEnd)),
      ),
    );
  });
  const maximumRmsDbfs = Math.max(
    ...points.map(({ rmsDbfs }) => rmsDbfs),
  );
  const maximumPeakDbfs = measureAudioSamples(samples).peakDbfs;
  const passed =
    maximumRmsDbfs <= safety.rmsLimiter.maximumRmsDbfs &&
    maximumPeakDbfs <= safety.peakLimiter.ceilingDbfs;

  return Object.freeze({
    schemaVersion: "mandelhowl.offline-audio-safety-sweep.v1",
    sampleRateHz: SAMPLE_RATE_HZ,
    durationSeconds,
    frequenciesHz: SWEEP_FREQUENCIES_HZ,
    maximumRmsDbfs,
    maximumPeakDbfs,
    rmsLimitDbfs: safety.rmsLimiter.maximumRmsDbfs,
    peakLimitDbfs: safety.peakLimiter.ceilingDbfs,
    points: Object.freeze(points),
    passed,
  });
}
