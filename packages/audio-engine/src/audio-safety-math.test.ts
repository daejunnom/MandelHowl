import { describe, expect, it } from "vitest";
import { GENERATED_AUDIO_SAFETY_SPEC } from "../../contracts/src";
import {
  measureAudioSamples,
  outputGainFromEnvelope,
  rateLimitGain,
  updateExposureState,
  updateExposureStateInPlace,
} from "./audio-safety-math";

describe("audio safety math", () => {
  it("keeps the canonical drive and modal source budget at unity", () => {
    expect(
      GENERATED_AUDIO_SAFETY_SPEC.modalTimbre.driveToneWeight +
        GENERATED_AUDIO_SAFETY_SPEC.modalTimbre.modalVoiceWeight,
    ).toBeLessThanOrEqual(1);
    expect(
      GENERATED_AUDIO_SAFETY_SPEC.sourceMapping
        .maximumOutputGainLinear,
    ).toBeLessThanOrEqual(0.1);
  });

  it("caps physical-envelope gain independently of virtual volume", () => {
    expect(
      outputGainFromEnvelope(
        1,
        "growing",
        false,
        GENERATED_AUDIO_SAFETY_SPEC,
      ),
    ).toBeLessThanOrEqual(
      GENERATED_AUDIO_SAFETY_SPEC.sourceMapping.maximumOutputGainLinear,
    );
    expect(
      outputGainFromEnvelope(
        1,
        "saturated",
        true,
        GENERATED_AUDIO_SAFETY_SPEC,
      ),
    ).toBeLessThan(0.03);
  });

  it("rate limits gain changes in decibels", () => {
    const first = rateLimitGain(0.01, 0.1, 0.1, 12, 0.1);
    expect(first).toBeCloseTo(0.011_481, 4);
    expect(first).toBeLessThan(0.1);
  });

  it("reaches the safe maximum in two seconds independent of render cadence", () => {
    const maximumGain =
      GENERATED_AUDIO_SAFETY_SPEC.sourceMapping.maximumOutputGainLinear;
    const maximumChangeDbPerSecond =
      GENERATED_AUDIO_SAFETY_SPEC.gainSmoothing.maximumChangeDbPerSecond;

    for (const framesPerSecond of [30, 60, 120, 144, 240]) {
      let gain = 0;
      for (let frame = 1; frame <= framesPerSecond * 2; frame += 1) {
        gain = rateLimitGain(
          gain,
          maximumGain,
          1 / framesPerSecond,
          maximumChangeDbPerSecond,
          maximumGain,
        );
        expect(gain).toBeLessThanOrEqual(maximumGain);
        if (frame === framesPerSecond) {
          expect(gain).toBeCloseTo(0.001, 8);
        }
      }
      expect(gain).toBeCloseTo(maximumGain, 8);
    }
  });

  it("measures finite RMS and peak while rejecting invalid samples", () => {
    const measured = measureAudioSamples([1, -1, Number.NaN, 0]);
    expect(measured.peakLinear).toBe(1);
    expect(measured.rmsLinear).toBeCloseTo(Math.sqrt(0.5), 5);
  });

  it("fails closed for non-finite gain and exposure inputs", () => {
    expect(
      outputGainFromEnvelope(
        Number.NaN,
        "growing",
        false,
        GENERATED_AUDIO_SAFETY_SPEC,
      ),
    ).toBe(0);
    expect(
      rateLimitGain(
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NaN,
        40,
        GENERATED_AUDIO_SAFETY_SPEC.sourceMapping
          .maximumOutputGainLinear,
      ),
    ).toBe(0);
    const exposure = updateExposureState(
      {
        highFrequencySeconds: 0,
        saturationSeconds: 0,
        active: false,
      },
      {
        frequency: Number.NaN,
        envelope: Number.NaN,
        regime: "saturated",
      },
      Number.POSITIVE_INFINITY,
      GENERATED_AUDIO_SAFETY_SPEC,
    );
    expect(exposure).toEqual({
      highFrequencySeconds: 0,
      saturationSeconds: 0,
      active: false,
    });
  });

  it("activates exposure protection after the canonical duration", () => {
    let exposure = {
      highFrequencySeconds: 0,
      saturationSeconds: 0,
      active: false,
    };
    for (let index = 0; index < 33; index += 1) {
      exposure = updateExposureState(
        exposure,
        { frequency: 4_000, envelope: 0.8, regime: "growing" },
        0.25,
        GENERATED_AUDIO_SAFETY_SPEC,
      );
    }
    expect(exposure.active).toBe(true);
    expect(exposure.highFrequencySeconds).toBeGreaterThanOrEqual(8);
  });

  it("updates live exposure state without replacing its identity", () => {
    const exposure = {
      highFrequencySeconds: 0,
      saturationSeconds: 0,
      active: false,
    };
    const identity = exposure;
    for (let index = 0; index < 10_000; index += 1) {
      expect(
        updateExposureStateInPlace(
          exposure,
          {
            frequency: 4_000,
            envelope: 0.8,
            regime: "growing",
          },
          1 / 240,
          GENERATED_AUDIO_SAFETY_SPEC,
        ),
      ).toBe(identity);
    }
    expect(exposure.active).toBe(true);
  });
});
