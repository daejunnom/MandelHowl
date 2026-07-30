import { describe, expect, it } from "vitest";
import { GENERATED_MOTION_SAFETY_SPEC } from "../../contracts/src";
import { presentCausalMotion } from "./causal-motion-presenter";

describe("causal apparatus motion presenter", () => {
  it("maps log drive frequency to a bounded perceptual cone tempo", () => {
    const low = presentCausalMotion({
      driveFrequencyHz: 45,
      minimumFrequencyHz: 45,
      maximumFrequencyHz: 6_000,
      feedbackEnvelopeNormalized: 0,
      microphoneRmsNormalized: 0,
    });
    const high = presentCausalMotion({
      driveFrequencyHz: 6_000,
      minimumFrequencyHz: 45,
      maximumFrequencyHz: 6_000,
      feedbackEnvelopeNormalized: 0,
      microphoneRmsNormalized: 0,
    });

    expect(low.driveCycleSeconds).toBe(0.92);
    expect(high.driveCycleSeconds).toBeCloseTo(
      1 / GENERATED_MOTION_SAFETY_SPEC.limits.maximumCablePulseHz,
    );
    expect(high.driveCycleSeconds).toBeLessThan(low.driveCycleSeconds);
    expect(
      Math.min(
        low.driveCycleSeconds,
        high.driveCycleSeconds,
        low.returnCycleSeconds,
        high.returnCycleSeconds,
      ),
    ).toBeGreaterThanOrEqual(
      1 / GENERATED_MOTION_SAFETY_SPEC.limits.maximumCablePulseHz,
    );
    expect(high.statusCycleSeconds).toBeGreaterThanOrEqual(
      2 / GENERATED_MOTION_SAFETY_SPEC.limits.maximumFlashHz,
    );
  });

  it("keeps microphone and feedback motion tied to their own signals", () => {
    const silent = presentCausalMotion({
      driveFrequencyHz: 220,
      minimumFrequencyHz: 45,
      maximumFrequencyHz: 6_000,
      feedbackEnvelopeNormalized: 0,
      microphoneRmsNormalized: 0,
    });
    const captured = presentCausalMotion({
      driveFrequencyHz: 220,
      minimumFrequencyHz: 45,
      maximumFrequencyHz: 6_000,
      feedbackEnvelopeNormalized: 0.75,
      microphoneRmsNormalized: 0.42,
    });

    expect(silent.microphoneLevelNormalized).toBe(0);
    expect(silent.feedbackLevelNormalized).toBe(0);
    expect(silent.speakerTravelNormalized).toBeCloseTo(0.08);
    expect(captured.microphoneLevelNormalized).toBeCloseTo(0.42);
    expect(captured.feedbackLevelNormalized).toBeCloseTo(0.75);
    expect(captured.speakerTravelNormalized).toBeGreaterThan(
      silent.speakerTravelNormalized,
    );
    expect(captured.feedbackCycleSeconds).toBeLessThan(
      silent.feedbackCycleSeconds,
    );
  });

  it("clamps malformed presentation inputs without changing domain state", () => {
    expect(
      presentCausalMotion({
        driveFrequencyHz: Number.POSITIVE_INFINITY,
        minimumFrequencyHz: 45,
        maximumFrequencyHz: 6_000,
        feedbackEnvelopeNormalized: 2,
        microphoneRmsNormalized: Number.NaN,
      }),
    ).toMatchObject({
      microphoneLevelNormalized: 0,
      feedbackLevelNormalized: 1,
      speakerTravelNormalized: 1,
    });
  });
});
