const DEFAULT_SAMPLE_COUNT = 40;
const MINIMUM_SHAPE_PEAK = 1e-6;
const AUTO_RANGE_DISPLAY_PEAK = 0.78;

export interface OscilloscopePresentationInput {
  readonly recentSamples: readonly number[];
  readonly rmsNormalized: number;
  readonly peakNormalized: number;
  readonly sampleCount?: number;
}

export interface OscilloscopePresentation {
  /**
   * Display-only samples. The source samples are never mutated or fed back into
   * the resonance engine.
   */
  readonly samples: readonly number[];
  readonly rmsPercent: number;
  readonly peakPercent: number;
  readonly sourcePeakNormalized: number;
  readonly displayPeakNormalized: number;
  readonly autoGainLinear: number;
  /** Physical full-scale value represented by the top/bottom of the scope. */
  readonly verticalRangeNormalized: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function sampleCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SAMPLE_COUNT;
  }
  return Math.max(1, Math.min(512, Math.trunc(value)));
}

/**
 * Creates a stable oscilloscope view model without changing the physical
 * microphone signal. The waveform shape comes from the recent physical
 * samples. The screen is explicitly auto-ranged so quiet resonance remains
 * legible; RMS/PEAK remain physical readouts and are never inferred from the
 * enlarged screen trace.
 */
export function presentOscilloscope(
  input: OscilloscopePresentationInput,
): OscilloscopePresentation {
  const count = sampleCount(input.sampleCount);
  const sanitizedSamples = new Array<number>(count).fill(0);
  const sourceOffset = Math.max(0, input.recentSamples.length - count);
  const copiedSampleCount = Math.min(count, input.recentSamples.length);
  const targetOffset = count - copiedSampleCount;
  let sourcePeak = 0;

  for (let index = 0; index < copiedSampleCount; index += 1) {
    const sourceSample = input.recentSamples[sourceOffset + index] ?? 0;
    const sample = Number.isFinite(sourceSample)
      ? clamp(sourceSample, -1, 1)
      : 0;
    sanitizedSamples[targetOffset + index] = sample;
    sourcePeak = Math.max(sourcePeak, Math.abs(sample));
  }

  const rmsNormalized = clamp(input.rmsNormalized, 0, 1);
  const peakNormalized = clamp(input.peakNormalized, 0, 1);
  const indicatedPeak = peakNormalized;
  const autoGain =
    sourcePeak >= MINIMUM_SHAPE_PEAK
      ? AUTO_RANGE_DISPLAY_PEAK / sourcePeak
      : 1;
  let displayPeak = 0;

  const displaySamples = sanitizedSamples.map((sample) => {
    const displaySample = clamp(sample * autoGain, -1, 1);
    displayPeak = Math.max(displayPeak, Math.abs(displaySample));
    return displaySample;
  });

  return Object.freeze({
    samples: Object.freeze(displaySamples),
    rmsPercent: Math.round(rmsNormalized * 100),
    peakPercent: Math.round(peakNormalized * 100),
    sourcePeakNormalized: sourcePeak,
    displayPeakNormalized: displayPeak,
    autoGainLinear: autoGain,
    verticalRangeNormalized:
      indicatedPeak > 0
        ? clamp(indicatedPeak / AUTO_RANGE_DISPLAY_PEAK, 0, 1)
        : 0,
  });
}
