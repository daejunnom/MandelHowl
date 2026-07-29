import { describe, expect, it } from "vitest";
import { presentOscilloscope } from "./oscilloscope-presenter";

describe("oscilloscope presenter", () => {
  it("auto-ranges a quiet physical waveform to the measured display peak", () => {
    const physicalSamples = Object.freeze([0, 0.01, -0.02, 0.015]);
    const before = [...physicalSamples];

    const presentation = presentOscilloscope({
      recentSamples: physicalSamples,
      rmsNormalized: 0.31,
      peakNormalized: 0.5,
      sampleCount: 4,
    });

    expect(physicalSamples).toEqual(before);
    expect(presentation.samples).toEqual([0, 0.39, -0.78, 0.585]);
    expect(presentation.sourcePeakNormalized).toBeCloseTo(0.02, 12);
    expect(presentation.displayPeakNormalized).toBeCloseTo(0.78, 12);
    expect(presentation.autoGainLinear).toBeCloseTo(39, 12);
    expect(presentation.verticalRangeNormalized).toBeCloseTo(0.5 / 0.78, 12);
    expect(presentation.rmsPercent).toBe(31);
    expect(presentation.peakPercent).toBe(50);
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation.samples)).toBe(true);
  });

  it("fits an already large waveform to the same auto range and preserves sign", () => {
    const presentation = presentOscilloscope({
      recentSamples: [-0.8, 0.4],
      rmsNormalized: 0.2,
      peakNormalized: 0.5,
      sampleCount: 2,
    });

    expect(presentation.samples).toEqual([-0.78, 0.39]);
    expect(presentation.autoGainLinear).toBeCloseTo(0.975, 12);
    expect(presentation.displayPeakNormalized).toBeCloseTo(0.78, 12);
  });

  it("sanitizes invalid values and left-pads the latest sample window", () => {
    const presentation = presentOscilloscope({
      recentSamples: [1, 2, Number.NaN, -0.25],
      rmsNormalized: Number.NaN,
      peakNormalized: 0,
      sampleCount: 3,
    });

    expect(presentation.samples).toEqual([0.78, 0, -0.195]);
    expect(presentation.rmsPercent).toBe(0);
    expect(presentation.peakPercent).toBe(0);

    const padded = presentOscilloscope({
      recentSamples: [0.2],
      rmsNormalized: 0,
      peakNormalized: 0.2,
      sampleCount: 3,
    });
    expect(padded.samples).toEqual([0, 0, 0.78]);
  });

  it("does not amplify numerical silence", () => {
    const presentation = presentOscilloscope({
      recentSamples: [0, 1e-9, -1e-9],
      rmsNormalized: 0.4,
      peakNormalized: 0.6,
      sampleCount: 3,
    });

    expect(presentation.autoGainLinear).toBe(1);
    expect(presentation.displayPeakNormalized).toBe(1e-9);
  });
});
