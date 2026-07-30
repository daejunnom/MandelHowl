export interface CausalMotionPresentationInput {
  readonly driveFrequencyHz: number;
  readonly minimumFrequencyHz: number;
  readonly maximumFrequencyHz: number;
  readonly feedbackEnvelopeNormalized: number;
  readonly microphoneRmsNormalized: number;
}

export interface CausalMotionPresentation {
  /**
   * Perceptual, display-only cone cycle. Audible frequencies are compressed
   * into a motion-safe range instead of trying to animate CSS at audio rate.
   */
  readonly driveCycleSeconds: number;
  readonly returnCycleSeconds: number;
  readonly feedbackCycleSeconds: number;
  readonly statusCycleSeconds: number;
  readonly speakerTravelNormalized: number;
  readonly microphoneLevelNormalized: number;
  readonly feedbackLevelNormalized: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function canonicalSeconds(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Projects one canonical runtime snapshot into causal apparatus motion.
 *
 * This is presentation-only: it never feeds values back into the dial,
 * resonance, volume, or audio engines. Log frequency controls perceptual
 * motion tempo; measured microphone RMS and the feedback envelope control
 * their respective visible signal strengths.
 */
export function presentCausalMotion(
  input: CausalMotionPresentationInput,
): CausalMotionPresentation {
  const minimum = Math.max(1e-6, input.minimumFrequencyHz);
  const maximum = Math.max(minimum, input.maximumFrequencyHz);
  const frequency = clamp(input.driveFrequencyHz, minimum, maximum);
  const denominator = Math.log(maximum / minimum);
  const normalizedFrequency =
    denominator > 0 ? Math.log(frequency / minimum) / denominator : 0;
  const feedbackLevel = clamp(input.feedbackEnvelopeNormalized, 0, 1);
  const microphoneLevel = clamp(input.microphoneRmsNormalized, 0, 1);
  const minimumCycleSeconds =
    1 / GENERATED_MOTION_SAFETY_SPEC.limits.maximumCablePulseHz;

  return Object.freeze({
    driveCycleSeconds: canonicalSeconds(
      minimumCycleSeconds + (1 - normalizedFrequency) * 0.42,
    ),
    returnCycleSeconds: canonicalSeconds(
      minimumCycleSeconds + (1 - normalizedFrequency) * 0.58,
    ),
    feedbackCycleSeconds: canonicalSeconds(
      Math.max(
        minimumCycleSeconds,
        2.6 - feedbackLevel * 1.75,
      ),
    ),
    statusCycleSeconds: canonicalSeconds(
      Math.max(
        1.35,
        2 / GENERATED_MOTION_SAFETY_SPEC.limits.maximumFlashHz,
      ),
    ),
    // The fixed drive remains faintly visible below loop capture. Feedback
    // then supplies the larger round-trip cone excursion.
    speakerTravelNormalized: 0.08 + feedbackLevel * 0.92,
    microphoneLevelNormalized: microphoneLevel,
    feedbackLevelNormalized: feedbackLevel,
  });
}
import { GENERATED_MOTION_SAFETY_SPEC } from "../../contracts/src";
