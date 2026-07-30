import { describe, expect, it } from "vitest";
import type { ModalSnapshot } from "../../contracts/src";
import {
  createAudibleModalVoiceBuffer,
  writeAudibleModalVoices,
} from "./modal-voice-bank";

function mode(
  modeId: string,
  frequencyHz: number,
  amplitude: number,
  phaseRad: number,
  audibleWeightNormalized: number,
): ModalSnapshot {
  return {
    modeId,
    naturalFrequencyHz: frequencyHz,
    audibleWeightNormalized,
    amplitudeNormalized: amplitude,
    phaseRad,
    energyNormalized: amplitude * amplitude,
  };
}

describe("canonical audible modal voice projection", () => {
  it("selects signed phase projections and normalizes by absolute sum", () => {
    const target = createAudibleModalVoiceBuffer(2);
    const identities = {
      modeIndices: target.modeIndices,
      frequenciesHz: target.frequenciesHz,
      weights: target.weights,
    };
    const modes = [
      mode("m0", 100, 0.5, 0, 1),
      mode("m1", 200, 0.8, Math.PI, 0.75),
      mode("m2", 300, 0.1, 0, 1),
    ];

    expect(writeAudibleModalVoices(modes, 1e-6, target)).toBe(true);
    expect(target.count).toBe(2);
    expect(Array.from(target.modeIndices)).toEqual([1, 0]);
    expect(Array.from(target.frequenciesHz)).toEqual([200, 100]);
    expect(target.weights[0]).toBeLessThan(0);
    expect(target.weights[1]).toBeGreaterThan(0);
    expect(
      Math.abs(target.weights[0]) + Math.abs(target.weights[1]),
    ).toBeCloseTo(1, 12);

    expect(writeAudibleModalVoices(modes.slice(0, 1), 1e-6, target)).toBe(
      true,
    );
    expect(target.modeIndices).toBe(identities.modeIndices);
    expect(target.frequenciesHz).toBe(identities.frequenciesHz);
    expect(target.weights).toBe(identities.weights);
  });

  it("fails closed and clears every voice when a mode is invalid", () => {
    const target = createAudibleModalVoiceBuffer(2);
    const invalid = {
      ...mode("invalid", 220, 0.5, 0, 1),
      naturalFrequencyHz: Number.NaN,
    };
    expect(writeAudibleModalVoices([invalid], 1e-6, target)).toBe(false);
    expect(target.count).toBe(0);
    expect(Array.from(target.weights)).toEqual([0, 0]);
    expect(Array.from(target.frequenciesHz)).toEqual([0, 0]);
  });
});
