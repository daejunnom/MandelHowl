import { describe, expect, it } from "vitest";
import type {
  FrequencyResponseTable,
  ResonanceDataset,
} from "../../contracts/src";
import { GENERATED_FEEDBACK_SPEC } from "../../contracts/src";
import {
  advanceResonance,
  classifyResonanceRegime,
  createResonanceState,
  estimateOpenLoopMarginAtFrequency,
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
    const snapshot = simulate(369.2, 12);
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

  it("uses the canonical growth-slope and decayed-envelope thresholds", () => {
    const thresholds =
      GENERATED_FEEDBACK_SPEC.regimeThresholds;
    expect(
      classifyResonanceRegime(
        thresholds.criticalLoopMarginHalfWidth + 0.01,
        thresholds.decayingMaximumEnvelope,
        0,
        0,
      ),
    ).toBe("decaying");
    expect(
      classifyResonanceRegime(
        thresholds.criticalLoopMarginHalfWidth + 0.01,
        thresholds.decayingMaximumEnvelope,
        0,
        thresholds.growingMinimumSlopePerSecond,
      ),
    ).toBe("growing");
    expect(
      classifyResonanceRegime(
        thresholds.criticalLoopMarginHalfWidth + 0.01,
        thresholds.decayingMaximumEnvelope + 1e-6,
        0,
        0,
      ),
    ).toBe("growing");
  });

  it("does not let residual envelope widen the critical classification", () => {
    expect(classifyResonanceRegime(-0.08, 0.5)).toBe("decaying");
    expect(classifyResonanceRegime(-0.08, 0.93)).toBe("saturated");
  });

  it("retains a gradual residual tail after leaving a saturated mode", () => {
    let state = createResonanceState({ initialFrequencyHz: 369.2 });
    for (let elapsed = 0; elapsed < 12; elapsed += 1 / 60) {
      state = advanceResonance(state, 1 / 60, {
        frequencyHz: 369.2,
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

  it("caps full modal updates to the canonical active set without allocating", () => {
    const dataset: RuntimeModalDataset = Object.freeze({
      datasetId: SYNTHETIC_DATASET_ID,
      modalModelId: SYNTHETIC_DATASET_ID,
      frequencyRangeHz: Object.freeze([90, 120] as const),
      maximumModalCoupling: 1,
      modes: Object.freeze(
        Array.from({ length: 32 }, (_, index) =>
          Object.freeze({
            id: `dense-${index}`,
            frequencyHz: 100 + index * 0.05,
            dampingRatio: 0.01,
            driveCoupling: 1 - index * 0.01,
            microphoneCoupling: 1,
            phaseOffsetRadians: index * 0.05,
            radiationEfficiency: 1,
            textureLayer: index,
          }),
        ),
      ),
    });
    const state = createResonanceState({
      dataset,
      initialFrequencyHz: 100,
    });
    const buffers = {
      response: state.modeResponseScratch,
      drive: state.modeDriveScoreScratch,
      loop: state.modeLoopScoreScratch,
      frequencyOrder: state.frequencySortedModeIndices,
      updateIndices: state.modeUpdateIndices,
      updateMarks: state.modeUpdateMarks,
      nonzeroIndices: state.nonzeroModeIndices,
      nextNonzeroIndices: state.nextNonzeroModeIndices,
      active: state.activeModeIndices,
      priority: state.activeModePriorityScratch,
    };
    for (let index = 0; index < 240; index += 1) {
      advanceResonance(state, 1 / 240, {
        frequencyHz: 100,
        sweepHzPerSecond: 0,
        direction: 0,
      });
      expect(state.activeModeCount).toBeLessThanOrEqual(
        GENERATED_FEEDBACK_SPEC.modalSelection.maximumActiveModes,
      );
    }
    expect(
      Array.from(state.modeEnergy).filter((energy) => energy > 0),
    ).toHaveLength(
      GENERATED_FEEDBACK_SPEC.modalSelection.maximumActiveModes,
    );
    expect(state.modeResponseScratch).toBe(buffers.response);
    expect(state.modeDriveScoreScratch).toBe(buffers.drive);
    expect(state.modeLoopScoreScratch).toBe(buffers.loop);
    expect(state.frequencySortedModeIndices).toBe(
      buffers.frequencyOrder,
    );
    expect(state.modeUpdateIndices).toBe(buffers.updateIndices);
    expect(state.modeUpdateMarks).toBe(buffers.updateMarks);
    expect(state.nonzeroModeIndices).toBe(buffers.nonzeroIndices);
    expect(state.nextNonzeroModeIndices).toBe(
      buffers.nextNonzeroIndices,
    );
    expect(state.activeModeIndices).toBe(buffers.active);
    expect(state.activeModePriorityScratch).toBe(buffers.priority);
  });

  it("updates only the sorted frequency window plus nonzero residual modes", () => {
    const ascendingModes = Array.from({ length: 32 }, (_, index) =>
      Object.freeze({
        id: `sparse-${index}`,
        frequencyHz: 100 + index * 50,
        dampingRatio: 0.01,
        driveCoupling: 1,
        microphoneCoupling: 1,
        phaseOffsetRadians: index * 0.03,
        radiationEfficiency: 1,
        textureLayer: index,
      }),
    );
    const dataset: RuntimeModalDataset = Object.freeze({
      datasetId: SYNTHETIC_DATASET_ID,
      modalModelId: SYNTHETIC_DATASET_ID,
      frequencyRangeHz: Object.freeze([90, 1_700] as const),
      maximumModalCoupling: 1,
      // Deliberately reverse storage order so the hot path must use its
      // precomputed frequency index and restore original-index sum order.
      modes: Object.freeze([...ascendingModes].reverse()),
    });
    const state = createResonanceState({
      dataset,
      initialFrequencyHz: 100,
    });
    const lowModeIndex = dataset.modes.findIndex(
      ({ frequencyHz }) => frequencyHz === 100,
    );
    const buffers = {
      frequencyOrder: state.frequencySortedModeIndices,
      updateIndices: state.modeUpdateIndices,
      updateMarks: state.modeUpdateMarks,
      nonzeroIndices: state.nonzeroModeIndices,
      nextNonzeroIndices: state.nextNonzeroModeIndices,
    };

    for (let step = 0; step < 120; step += 1) {
      advanceResonance(state, 1 / 240, {
        frequencyHz: 100,
        sweepHzPerSecond: 0,
        direction: 0,
      });
    }
    expect(state.modeUpdateCount).toBeLessThan(dataset.modes.length);
    expect(state.nonzeroModeCount).toBeGreaterThan(0);
    const residualBefore = state.modeEnergy[lowModeIndex] ?? 0;
    expect(residualBefore).toBeGreaterThan(0);

    advanceResonance(state, 1 / 240, {
      frequencyHz: 1_000,
      sweepHzPerSecond: 0,
      direction: 0,
    });
    expect(
      Array.from(
        state.modeUpdateIndices.subarray(0, state.modeUpdateCount),
      ),
    ).toContain(lowModeIndex);
    expect(state.modeUpdateCount).toBeLessThan(dataset.modes.length);
    expect(state.modeEnergy[lowModeIndex] ?? 0).toBeLessThan(
      residualBefore,
    );
    expect(state.frequencySortedModeIndices).toBe(
      buffers.frequencyOrder,
    );
    expect(state.modeUpdateIndices).toBe(buffers.updateIndices);
    expect(state.modeUpdateMarks).toBe(buffers.updateMarks);
    expect(state.nonzeroModeIndices).toBe(buffers.nonzeroIndices);
    expect(state.nextNonzeroModeIndices).toBe(
      buffers.nextNonzeroIndices,
    );
  });

  it("reserves a bounded update slot for a new capture when residuals fill the active set", () => {
    const maximumActiveModes =
      GENERATED_FEEDBACK_SPEC.modalSelection.maximumActiveModes;
    const captureIndex = maximumActiveModes;
    const modes = Array.from(
      { length: maximumActiveModes + 1 },
      (_, index) =>
        Object.freeze({
          id: `capture-reservation-${index}`,
          frequencyHz: 100 + index * 100,
          dampingRatio: 0.01,
          driveCoupling: index === captureIndex ? 0.2 : 1,
          microphoneCoupling: 1,
          phaseOffsetRadians: index * 0.01,
          radiationEfficiency: 1,
          textureLayer: index,
        }),
    );
    const dataset: RuntimeModalDataset = Object.freeze({
      datasetId: SYNTHETIC_DATASET_ID,
      modalModelId: SYNTHETIC_DATASET_ID,
      frequencyRangeHz: Object.freeze([90, 1_500] as const),
      maximumModalCoupling: 1,
      modes: Object.freeze(modes),
    });
    const state = createResonanceState({
      dataset,
      initialFrequencyHz: modes[captureIndex].frequencyHz,
    });
    for (let index = 0; index < maximumActiveModes; index += 1) {
      state.modeEnergy[index] = 0.95;
      state.nonzeroModeIndices[index] = index;
    }
    state.nonzeroModeCount = maximumActiveModes;

    advanceResonance(state, 1 / 240, {
      frequencyHz: modes[captureIndex].frequencyHz,
      sweepHzPerSecond: 0,
      direction: 0,
    });

    expect(
      Array.from(
        state.activeModeIndices.subarray(0, state.activeModeCount),
      ),
    ).toContain(captureIndex);
    expect(state.activeModeIndex).toBe(captureIndex);
    expect(state.activeModeCount).toBe(maximumActiveModes);
  });

  it("applies the canonical biquad Q and feedback phase to loop margin", () => {
    const frequencyHz = 100;
    const loopPhase =
      -Math.PI *
        2 *
        frequencyHz *
        GENERATED_FEEDBACK_SPEC.loop.delaySeconds +
      GENERATED_FEEDBACK_SPEC.loop.phaseOffsetRad;
    const alignedDataset: RuntimeModalDataset = Object.freeze({
      datasetId: SYNTHETIC_DATASET_ID,
      modalModelId: SYNTHETIC_DATASET_ID,
      frequencyRangeHz: Object.freeze([45, 6_000] as const),
      maximumModalCoupling: 1,
      modes: Object.freeze([
        Object.freeze({
          id: "aligned",
          frequencyHz,
          dampingRatio: 0.01,
          driveCoupling: 1,
          microphoneCoupling: 1,
          phaseOffsetRadians: -loopPhase,
          radiationEfficiency: 1,
          textureLayer: 0,
        }),
      ]),
    });
    const q = GENERATED_FEEDBACK_SPEC.loop.filter.q;
    const highRatio =
      frequencyHz /
      GENERATED_FEEDBACK_SPEC.loop.filter.highPassHz;
    const highPass =
      highRatio ** 2 /
      Math.sqrt(
        (1 - highRatio ** 2) ** 2 +
          (highRatio / q) ** 2,
      );
    const lowRatio =
      frequencyHz /
      GENERATED_FEEDBACK_SPEC.loop.filter.lowPassHz;
    const lowPass =
      1 /
      Math.sqrt(
        (1 - lowRatio ** 2) ** 2 +
          (lowRatio / q) ** 2,
      );
    const expectedMargin =
      Math.min(1, highPass * lowPass) *
        GENERATED_FEEDBACK_SPEC.loop.gainLinear -
      1;
    expect(
      estimateOpenLoopMarginAtFrequency(
        alignedDataset,
        frequencyHz,
      ),
    ).toBeCloseTo(expectedMargin, 12);

    const quadratureDataset = {
      ...alignedDataset,
      modes: Object.freeze([
        Object.freeze({
          ...alignedDataset.modes[0],
          phaseOffsetRadians: -loopPhase + Math.PI / 2,
        }),
      ]),
    };
    expect(
      estimateOpenLoopMarginAtFrequency(
        quadratureDataset,
        frequencyHz,
      ),
    ).toBeCloseTo(-1, 12);

    const antiAlignedDataset = {
      ...alignedDataset,
      modes: Object.freeze([
        Object.freeze({
          ...alignedDataset.modes[0],
          phaseOffsetRadians: -loopPhase + Math.PI,
        }),
      ]),
    };
    expect(
      estimateOpenLoopMarginAtFrequency(
        antiAlignedDataset,
        frequencyHz,
      ),
    ).toBeCloseTo(-1, 12);
  });

  it("sums active modal microphone returns before the canonical delay-filter-gain loop", () => {
    const frequencyHz = 100;
    const mode = Object.freeze({
      id: "microphone-a",
      frequencyHz,
      dampingRatio: 0.01,
      driveCoupling: 1,
      microphoneCoupling: 1,
      phaseOffsetRadians: 0,
      radiationEfficiency: 1,
      textureLayer: 0,
    });
    const datasetWithReturn = (
      secondDriveCoupling: number,
    ): RuntimeModalDataset =>
      Object.freeze({
        datasetId: SYNTHETIC_DATASET_ID,
        modalModelId: SYNTHETIC_DATASET_ID,
        frequencyRangeHz: Object.freeze([90, 110] as const),
        maximumModalCoupling: 1,
        modes: Object.freeze([
          mode,
          Object.freeze({
            ...mode,
            id: "microphone-b",
            driveCoupling: secondDriveCoupling,
            textureLayer: 1,
          }),
        ]),
      });
    const summed = createResonanceState({
      dataset: datasetWithReturn(1),
      initialFrequencyHz: frequencyHz,
    });
    const control = createResonanceState({
      dataset: datasetWithReturn(0),
      initialFrequencyHz: frequencyHz,
    });
    for (let step = 0; step < 96; step += 1) {
      const input = {
        frequencyHz,
        sweepHzPerSecond: 0,
        direction: 0 as const,
      };
      advanceResonance(summed, 1 / 240, input);
      advanceResonance(control, 1 / 240, input);
    }

    const summedReturn = Array.from(summed.delayBuffer).reduce(
      (total, sample) => total + Math.abs(sample),
      0,
    );
    const controlReturn = Array.from(control.delayBuffer).reduce(
      (total, sample) => total + Math.abs(sample),
      0,
    );
    expect(summedReturn).toBeGreaterThan(controlReturn);
    expect(Math.abs(summed.feedbackLoopSignal)).toBeGreaterThan(
      Math.abs(control.feedbackLoopSignal),
    );
    expect(Math.abs(summed.feedbackLoopSignal)).toBeLessThanOrEqual(
      GENERATED_FEEDBACK_SPEC.limiter.ceilingNormalized,
    );
    expect(summed.delayWriteIndex).toBe(control.delayWriteIndex);
  });

  it("preserves speed- and direction-dependent capture histories", () => {
    function sweep(
      startHz: number,
      endHz: number,
      seconds: number,
    ) {
      const state = createResonanceState({
        initialFrequencyHz: startHz,
      });
      const steps = Math.round(seconds * 240);
      for (let index = 1; index <= steps; index += 1) {
        const progress = index / steps;
        const frequencyHz =
          startHz + (endHz - startHz) * progress;
        advanceResonance(state, 1 / 240, {
          frequencyHz,
          sweepHzPerSecond: (endHz - startHz) / seconds,
          direction: endHz > startHz ? 1 : -1,
        });
      }
      return state;
    }

    const slow = sweep(180, 221.4, 2);
    const fast = sweep(180, 221.4, 0.1);
    expect(slow.modeEnergy[4]).toBeGreaterThan(fast.modeEnergy[4]);

    const increasing = sweep(180, 221.4, 1);
    const decreasing = sweep(262, 221.4, 1);
    expect(increasing.modeEnergy[4]).not.toBeCloseTo(
      decreasing.modeEnergy[4],
      8,
    );
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
