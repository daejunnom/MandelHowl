import { describe, expect, it } from "vitest";
import {
  advanceResonance,
  classifyResonanceRegime,
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

  it("keeps critical behavior inside a narrow symmetric loop-margin band", () => {
    expect(classifyResonanceRegime(0.025, 0.5)).toBe("critical");
    expect(classifyResonanceRegime(-0.025, 0.5)).toBe("critical");
    expect(classifyResonanceRegime(0.025_001, 0.5)).toBe("growing");
    expect(classifyResonanceRegime(-0.025_001, 0.5)).toBe("decaying");
  });

  it("does not let residual envelope widen the critical classification", () => {
    expect(classifyResonanceRegime(-0.08, 0.5)).toBe("decaying");
    expect(classifyResonanceRegime(-0.08, 0.93)).toBe("saturated");
  });

  it("retains a gradual residual tail after leaving a saturated mode", () => {
    let state = createResonanceState({ initialFrequencyHz: 221.4 });
    for (let elapsed = 0; elapsed < 12; elapsed += 1 / 60) {
      state = advanceResonance(state, 1 / 60, {
        frequencyHz: 221.4,
        sweepHzPerSecond: 0,
        direction: 0,
      });
    }

    const saturatedEnvelope = state.feedbackEnvelope;
    for (let elapsed = 0; elapsed < 0.25; elapsed += 1 / 60) {
      state = advanceResonance(state, 1 / 60, {
        frequencyHz: 760,
        sweepHzPerSecond: 0,
        direction: 0,
      });
    }

    expect(saturatedEnvelope).toBeGreaterThanOrEqual(0.92);
    expect(state.feedbackEnvelope).toBeGreaterThan(0.5);
    expect(state.feedbackEnvelope).toBeLessThan(saturatedEnvelope);
    expect(state.regime).toBe("decaying");
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
