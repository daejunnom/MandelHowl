import { describe, expect, it } from "vitest";
import {
  advanceResonance,
  createResonanceState,
  getResonanceSnapshot,
} from "./resonance-engine";

function simulate(
  frequencyHz: number,
  seconds: number,
  initialFrequencyHz = frequencyHz,
) {
  let state = createResonanceState({ initialFrequencyHz });
  const frameStep = 1 / 60;
  for (let elapsed = 0; elapsed < seconds; elapsed += frameStep) {
    state = advanceResonance(state, frameStep, {
      frequencyHz,
      sweepHzPerSecond: 0,
      direction: 0,
    });
  }
  return getResonanceSnapshot(state);
}

describe("resonance engine", () => {
  it("is deterministic for the same dataset and drive trace", () => {
    const first = simulate(221.4, 8);
    const second = simulate(221.4, 8);
    expect(first).toEqual(second);
  });

  it("grows and reaches the virtual limiter at a strong mode", () => {
    const snapshot = simulate(221.4, 12);
    expect(snapshot.regime).toBe("saturated");
    expect(snapshot.volume).toBe(100);
    expect(snapshot.feedbackEnvelope).toBeGreaterThanOrEqual(0.92);
  });

  it("decays to zero away from modal bands", () => {
    const snapshot = simulate(760, 8);
    expect(snapshot.regime).toBe("decaying");
    expect(snapshot.volume).toBe(0);
    expect(snapshot.feedbackEnvelope).toBeLessThan(0.02);
  });

  it("guards the numerical state against non-finite drive input", () => {
    let state = createResonanceState();
    state = advanceResonance(state, Number.POSITIVE_INFINITY, {
      frequencyHz: Number.NaN,
      sweepHzPerSecond: Number.NEGATIVE_INFINITY,
    });
    const snapshot = getResonanceSnapshot(state);
    expect(Number.isFinite(snapshot.frequencyHz)).toBe(true);
    expect(Number.isFinite(snapshot.feedbackEnvelope)).toBe(true);
    expect(Number.isFinite(snapshot.microphoneRms)).toBe(true);
    expect(snapshot.volume).toBeGreaterThanOrEqual(0);
    expect(snapshot.volume).toBeLessThanOrEqual(100);
  });
});
