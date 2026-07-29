import { describe, expect, it } from "vitest";
import type {
  FrequencyResponseTable,
  ResonanceDataset,
} from "../../contracts/src";
import {
  advanceResonance,
  classifyResonanceRegime,
  createResonanceState,
  getResonanceSnapshot,
  interpolateBakedFrequencyResponse,
  runtimeModalDatasetFromResonanceDataset,
  type RuntimeModalDataset,
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

const SYNTHETIC_DATASET_ID =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const;
const SYNTHETIC_MODES_HASH =
  "1111111111111111111111111111111111111111111111111111111111111111";

function syntheticResponse(): FrequencyResponseTable {
  return Object.freeze({
    sampleCount: 3,
    frequenciesHz: Object.freeze([10, 100, 1_000]),
    real: Object.freeze([0, 2, 4]),
    imaginary: Object.freeze([1, -1, 3]),
  });
}

function runtimeDatasetWithResponse(
  response: FrequencyResponseTable = syntheticResponse(),
): RuntimeModalDataset {
  return Object.freeze({
    datasetId: SYNTHETIC_DATASET_ID,
    modalModelId: SYNTHETIC_DATASET_ID,
    frequencyRangeHz: Object.freeze([10, 1_000] as const),
    maximumModalCoupling: 1,
    modes: Object.freeze([]),
    response,
  });
}

describe("baked aggregate frequency response", () => {
  it("preserves the decoded response when projecting a verified dataset", () => {
    const response = syntheticResponse();
    const decoded = {
      manifest: {
        datasetId: SYNTHETIC_DATASET_ID,
        frequencyRange: {
          minimumHz: 10,
          maximumHz: 1_000,
        },
        files: {
          modes: {
            sha256: SYNTHETIC_MODES_HASH,
          },
        },
      },
      modes: [],
      response,
    } as unknown as ResonanceDataset;

    const projected =
      runtimeModalDatasetFromResonanceDataset(decoded);

    expect(projected.response).toEqual(response);
    expect(projected.response).not.toBe(response);
    expect(Object.isFrozen(projected.response)).toBe(true);
    expect(Object.isFrozen(projected.response?.frequenciesHz)).toBe(
      true,
    );
  });

  it("interpolates real and imaginary parts on the baked log-frequency grid", () => {
    const response = interpolateBakedFrequencyResponse(
      runtimeDatasetWithResponse(),
      Math.sqrt(10 * 100),
    );

    expect(response).toMatchObject({
      frequencyHz: Math.sqrt(10 * 100),
      lowerSampleIndex: 0,
      upperSampleIndex: 1,
    });
    expect(response?.real).toBeCloseTo(1, 14);
    expect(response?.imaginary).toBeCloseTo(0, 14);
    expect(response?.magnitude).toBeCloseTo(1, 14);
    expect(response?.phaseRadians).toBeCloseTo(0, 14);
  });

  it("returns exact grid samples and clamps finite out-of-range frequencies", () => {
    const dataset = runtimeDatasetWithResponse();
    expect(interpolateBakedFrequencyResponse(dataset, 100)).toMatchObject({
      frequencyHz: 100,
      real: 2,
      imaginary: -1,
      lowerSampleIndex: 1,
      upperSampleIndex: 1,
    });
    expect(interpolateBakedFrequencyResponse(dataset, -20)).toMatchObject({
      frequencyHz: 10,
      real: 0,
      imaginary: 1,
      lowerSampleIndex: 0,
      upperSampleIndex: 0,
    });
    expect(interpolateBakedFrequencyResponse(dataset, 20_000)).toMatchObject({
      frequencyHz: 1_000,
      real: 4,
      imaginary: 3,
      lowerSampleIndex: 2,
      upperSampleIndex: 2,
    });
  });

  it("is optional for analytical datasets and rejects non-finite queries", () => {
    const dataset = {
      ...runtimeDatasetWithResponse(),
      response: undefined,
    };
    expect(
      interpolateBakedFrequencyResponse(dataset, 100),
    ).toBeNull();
    expect(() =>
      interpolateBakedFrequencyResponse(
        runtimeDatasetWithResponse(),
        Number.NaN,
      ),
    ).toThrow(/finite/);
  });
});
