import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import challengeSamples from "../../../specs/challenge/sample-targets.v1.json";
import type {
  ReachabilityCoverageReport,
  ResonanceTrajectoryTrace,
} from "../../contracts/src";
import { GENERATED_FEEDBACK_SPEC } from "../../contracts/src";
import { COVERAGE_REPORT_SCHEMA_SHA256 } from "../../contracts/src";
import {
  advanceMandelHowlRuntime,
  advanceMandelHowlRuntimeInPlace,
  advanceResonance,
  createMandelHowlRuntime,
  createResonanceState,
  getRuntimeSnapshot,
  getResonanceSnapshot,
  RUNTIME_FEEDBACK_ALGORITHM_REVISION,
  volumeFromVirtualRms,
  dispatchRuntimeDial,
} from "./index";
import { replayResonanceTrajectory } from "../../../tools/reachability-generator/src/trajectory-coverage";
import { decodeModesBinaryV1 } from "../../asset-runtime/src";
import type { RuntimeModalDataset } from "./index";
import { GENERATED_PERFORMANCE_BUDGET_SPEC } from "../../contracts/src";

function simulateFrames(
  frameSeconds: number,
  frameCount: number,
) {
  let state = createResonanceState({ initialFrequencyHz: 221.4 });
  for (let index = 0; index < frameCount; index += 1) {
    state = advanceResonance(state, frameSeconds, {
      frequencyHz: 221.4,
      sweepHzPerSecond: 0,
      direction: 0,
    });
  }
  return getResonanceSnapshot(state);
}

describe("runtime contracts", () => {
  it("publishes the immediate captured mode identity with deterministic nulls", () => {
    let inactive = createMandelHowlRuntime({
      initialFrequencyHz: 45,
    });
    expect(getRuntimeSnapshot(inactive).activeModeId).toBeNull();
    inactive = advanceMandelHowlRuntime(inactive, 1 / 60);
    expect(inactive.resonance.activeModeIndex).toBeNull();
    expect(getRuntimeSnapshot(inactive).activeModeId).toBeNull();

    let captured = createMandelHowlRuntime({
      initialFrequencyHz: 221.4,
    });
    expect(getRuntimeSnapshot(captured).activeModeId).toBeNull();
    captured = advanceMandelHowlRuntime(captured, 1 / 60);
    expect(captured.resonance.activeModeIndex).toBe(4);
    expect(getRuntimeSnapshot(captured).activeModeId).toBe("p05");

    captured.resonance.activeModeIndex = Number.MAX_SAFE_INTEGER;
    expect(getRuntimeSnapshot(captured).activeModeId).toBeNull();
  });

  it("is frame-rate independent at 30, 60 and 144 Hz", () => {
    const at30 = simulateFrames(1 / 30, 240);
    const at60 = simulateFrames(1 / 60, 480);
    const at144 = simulateFrames(1 / 144, 1152);

    expect(at30.simulationStep).toBe(at60.simulationStep);
    expect(at144.simulationStep).toBe(at60.simulationStep);
    expect(at30.feedbackEnvelope).toBeCloseTo(at60.feedbackEnvelope, 12);
    expect(at144.feedbackEnvelope).toBeCloseTo(at60.feedbackEnvelope, 12);
    expect(at30.modeEnergy).toEqual(at60.modeEnergy);
    expect(at144.modeEnergy).toEqual(at60.modeEnergy);
    expect(at30.volume).toBe(at60.volume);
    expect(at144.volume).toBe(at60.volume);
  });

  it("keeps every production hot-path state and scratch identity stable", () => {
    const runtime = createMandelHowlRuntime({
      initialFrequencyHz: 221.4,
    });
    const identities = {
      runtime,
      dial: runtime.dial,
      resonance: runtime.resonance,
      modeEnergy: runtime.resonance.modeEnergy,
      modePhase: runtime.resonance.modePhaseRadians,
      responseScratch: runtime.resonance.modeResponseScratch,
      driveScratch: runtime.resonance.modeDriveScoreScratch,
      loopScratch: runtime.resonance.modeLoopScoreScratch,
      frequencyOrder:
        runtime.resonance.frequencySortedModeIndices,
      updateIndices: runtime.resonance.modeUpdateIndices,
      updateMarks: runtime.resonance.modeUpdateMarks,
      nonzeroIndices: runtime.resonance.nonzeroModeIndices,
      nextNonzeroIndices:
        runtime.resonance.nextNonzeroModeIndices,
      activeIndices: runtime.resonance.activeModeIndices,
      activePriority:
        runtime.resonance.activeModePriorityScratch,
    };

    let returned = runtime;
    for (let frame = 0; frame < 10_000; frame += 1) {
      returned = advanceMandelHowlRuntimeInPlace(
        runtime,
        1 / 60,
      );
    }
    expect(returned).toBe(runtime);
    expect(runtime.dial).toBe(identities.dial);
    expect(runtime.resonance).toBe(identities.resonance);
    expect(runtime.resonance.modeEnergy).toBe(identities.modeEnergy);
    expect(runtime.resonance.modePhaseRadians).toBe(
      identities.modePhase,
    );
    expect(runtime.resonance.modeResponseScratch).toBe(
      identities.responseScratch,
    );
    expect(runtime.resonance.modeDriveScoreScratch).toBe(
      identities.driveScratch,
    );
    expect(runtime.resonance.modeLoopScoreScratch).toBe(
      identities.loopScratch,
    );
    expect(runtime.resonance.frequencySortedModeIndices).toBe(
      identities.frequencyOrder,
    );
    expect(runtime.resonance.modeUpdateIndices).toBe(
      identities.updateIndices,
    );
    expect(runtime.resonance.modeUpdateMarks).toBe(
      identities.updateMarks,
    );
    expect(runtime.resonance.nonzeroModeIndices).toBe(
      identities.nonzeroIndices,
    );
    expect(runtime.resonance.nextNonzeroModeIndices).toBe(
      identities.nextNonzeroIndices,
    );
    expect(runtime.resonance.activeModeIndices).toBe(
      identities.activeIndices,
    );
    expect(runtime.resonance.activeModePriorityScratch).toBe(
      identities.activePriority,
    );
  });

  it(
    "keeps fixed buffers finite and identity-stable for the canonical one-hour simulation soak",
    () => {
      const runtime = createMandelHowlRuntime({
        initialFrequencyHz: 221.4,
      });
      const fixedStepSeconds =
        GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds;
      const stepCount = Math.round(
        GENERATED_PERFORMANCE_BUDGET_SPEC.simulationSoak
          .durationSeconds / fixedStepSeconds,
      );
      const identities = {
        modeEnergy: runtime.resonance.modeEnergy,
        modePhase: runtime.resonance.modePhaseRadians,
        responseScratch: runtime.resonance.modeResponseScratch,
        driveScratch: runtime.resonance.modeDriveScoreScratch,
        loopScratch: runtime.resonance.modeLoopScoreScratch,
        frequencyOrder:
          runtime.resonance.frequencySortedModeIndices,
        updateIndices: runtime.resonance.modeUpdateIndices,
        updateMarks: runtime.resonance.modeUpdateMarks,
        nonzeroIndices: runtime.resonance.nonzeroModeIndices,
        nextNonzeroIndices:
          runtime.resonance.nextNonzeroModeIndices,
        delayBuffer: runtime.resonance.delayBuffer,
        rmsWindow: runtime.resonance.rmsWindow,
        activeIndices: runtime.resonance.activeModeIndices,
        activePriority:
          runtime.resonance.activeModePriorityScratch,
      };

      for (let step = 0; step < stepCount; step += 1) {
        advanceMandelHowlRuntimeInPlace(runtime, fixedStepSeconds);
      }

      expect(runtime.resonance.modeEnergy).toBe(identities.modeEnergy);
      expect(runtime.resonance.modePhaseRadians).toBe(
        identities.modePhase,
      );
      expect(runtime.resonance.modeResponseScratch).toBe(
        identities.responseScratch,
      );
      expect(runtime.resonance.modeDriveScoreScratch).toBe(
        identities.driveScratch,
      );
      expect(runtime.resonance.modeLoopScoreScratch).toBe(
        identities.loopScratch,
      );
      expect(runtime.resonance.frequencySortedModeIndices).toBe(
        identities.frequencyOrder,
      );
      expect(runtime.resonance.modeUpdateIndices).toBe(
        identities.updateIndices,
      );
      expect(runtime.resonance.modeUpdateMarks).toBe(
        identities.updateMarks,
      );
      expect(runtime.resonance.nonzeroModeIndices).toBe(
        identities.nonzeroIndices,
      );
      expect(runtime.resonance.nextNonzeroModeIndices).toBe(
        identities.nextNonzeroIndices,
      );
      expect(runtime.resonance.delayBuffer).toBe(
        identities.delayBuffer,
      );
      expect(runtime.resonance.rmsWindow).toBe(identities.rmsWindow);
      expect(runtime.resonance.activeModeIndices).toBe(
        identities.activeIndices,
      );
      expect(runtime.resonance.activeModePriorityScratch).toBe(
        identities.activePriority,
      );
      expect(
        [
          ...runtime.resonance.modeEnergy,
          ...runtime.resonance.modePhaseRadians,
          ...runtime.resonance.delayBuffer,
          ...runtime.resonance.rmsWindow,
        ].every(Number.isFinite),
      ).toBe(true);
      expect(runtime.resonance.simulationStep).toBe(stepCount);
    },
    30_000,
  );

  it("resets delayed transients instead of integrating a paused-tab gap", () => {
    const state = createResonanceState({ initialFrequencyHz: 221.4 });
    advanceResonance(state, 1 / 60, {
      frequencyHz: 221.4,
      sweepHzPerSecond: 0,
      direction: 0,
    });
    const beforeStep = state.simulationStep;
    state.delayBuffer.fill(0.5);
    advanceResonance(state, 2, {
      frequencyHz: 221.4,
      sweepHzPerSecond: 0,
      direction: 0,
    });

    expect(state.simulationStep).toBe(beforeStep);
    expect(state.pausedGapCount).toBe(1);
    expect(Array.from(state.delayBuffer)).toEqual(
      Array.from(state.delayBuffer, () => 0),
    );
    expect(state.feedbackLoopSignal).toBe(0);
  });

  it("exposes MEASURING without transient volume and settles atomically", () => {
    let runtime = createMandelHowlRuntime({
      initialFrequencyHz: 369.2,
    });
    const initial = getRuntimeSnapshot(runtime);
    expect(initial.volume).toEqual({
      status: "measuring",
      value: null,
      lastSettledValue: null,
      progress: 0,
    });

    for (let index = 0; index < 720; index += 1) {
      runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    }
    const settled = getRuntimeSnapshot(runtime);
    expect(settled.volume.status).toBe("settled");
    expect(settled.volume.value).toBe(100);
    expect(settled.feedback.envelopeNormalized).toBeGreaterThan(0.92);
    expect(settled.feedback.limiterActive).toBe(true);
    expect(settled.feedback.limiterGainReductionDb).toBeGreaterThanOrEqual(
      0.5,
    );
    expect(runtime.resonance.gateOpen).toBe(true);
    expect(
      Array.from(runtime.resonance.delayBuffer).some(
        (sample) => Math.abs(sample) > 0,
      ),
    ).toBe(true);
    expect(
      Math.abs(settled.feedback.loopSignalNormalized),
    ).toBeLessThanOrEqual(
      GENERATED_FEEDBACK_SPEC.limiter.ceilingNormalized,
    );
    expect(settled.modes).toHaveLength(runtime.resonance.dataset.modes.length);

    runtime = dispatchRuntimeDial(runtime, {
      type: "keyboard",
      key: "ArrowRight",
      timestampMs: 12_001,
    });
    runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    expect(getRuntimeSnapshot(runtime).volume).toMatchObject({
      status: "measuring",
      value: null,
      lastSettledValue: 100,
    });
  });

  it("implements the canonical logarithmic RMS mapping without holes", () => {
    expect(volumeFromVirtualRms(0)).toBe(0);
    expect(volumeFromVirtualRms(0.003)).toBe(0);
    expect(volumeFromVirtualRms(0.62)).toBe(100);
    const values = new Set<number>();
    for (let index = 0; index <= 20_000; index += 1) {
      const rms = 0.003 * Math.pow(0.62 / 0.003, index / 20_000);
      values.add(volumeFromVirtualRms(rms));
    }
    expect(Array.from({ length: 101 }, (_, value) => value)).toEqual(
      expect.arrayContaining([...values]),
    );
    for (let value = 1; value <= 99; value += 1) {
      expect(values.has(value)).toBe(true);
    }
  });
});

describe("reachability evidence", () => {
  const report = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "tests/runtime/fixtures/reachability-report.json",
      ),
      "utf8",
    ),
  ) as ReachabilityCoverageReport;

  function productionDataset(): RuntimeModalDataset {
    const generatedRoot = resolve(process.cwd(), "assets/generated");
    const expectedDigest = report.modalModelId.slice("sha256:".length);
    for (const entry of readdirSync(generatedRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(generatedRoot, entry.name, "modes.bin");
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== expectedDigest) continue;
      const modes = decodeModesBinaryV1(bytes);
      const maximumModalCoupling = Math.max(
        Number.EPSILON,
        ...modes.map((mode) =>
          Math.abs(
            mode.actuatorCoupling * mode.microphoneCoupling,
          ),
        ),
      );
      return Object.freeze({
        datasetId: `sha256:${digest}`,
        modalModelId: `sha256:${digest}`,
        frequencyRangeHz: Object.freeze([45, 6000] as const),
        maximumModalCoupling,
        modes: Object.freeze(
          modes.map((mode) =>
            Object.freeze({
              id: mode.modeId,
              frequencyHz: mode.naturalFrequencyHz,
              dampingRatio: mode.dampingRatio,
              driveCoupling: Math.abs(mode.actuatorCoupling),
              microphoneCoupling: Math.abs(mode.microphoneCoupling),
              phaseOffsetRadians:
                mode.phaseReferenceRad +
                (mode.actuatorCoupling * mode.microphoneCoupling < 0
                  ? Math.PI
                  : 0),
              radiationEfficiency: mode.radiationEfficiency,
              textureLayer: mode.textureLayer,
            }),
          ),
        ),
      });
    }
    throw new Error(
      `No generated modes.bin matches ${report.modalModelId}`,
    );
  }

  it(
    "independently recomputes the uniform static extreme distribution target",
    () => {
      const dataset = productionDataset();
      const sampleCount = 401;
      const durationSeconds = 10;
      const fixedStepSeconds =
        GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds;
      const stepCount = Math.round(
        durationSeconds / fixedStepSeconds,
      );
      let zeroCount = 0;
      let hundredCount = 0;
      let intermediateCount = 0;

      for (let sample = 0; sample < sampleCount; sample += 1) {
        const frequencyHz =
          dataset.frequencyRangeHz[0] +
          (dataset.frequencyRangeHz[1] -
            dataset.frequencyRangeHz[0]) *
            (sample / (sampleCount - 1));
        let state = createResonanceState({
          dataset,
          initialFrequencyHz: frequencyHz,
        });
        for (let step = 0; step < stepCount; step += 1) {
          state = advanceResonance(
            state,
            fixedStepSeconds,
            {
              frequencyHz,
              sweepHzPerSecond: 0,
              direction: 0,
            },
          );
        }
        const value = getResonanceSnapshot(state).lastSettledVolume;
        if (value === 0) zeroCount += 1;
        else if (value === 100) hundredCount += 1;
        else intermediateCount += 1;
      }
      const extremeFraction =
        (zeroCount + hundredCount) / sampleCount;

      expect({
        sampleCount,
        zeroCount,
        hundredCount,
        intermediateCount,
        extremeFraction,
      }).toEqual({
        sampleCount: report.staticDistribution.sampleCount,
        zeroCount: report.staticDistribution.zeroCount,
        hundredCount: report.staticDistribution.hundredCount,
        intermediateCount:
          report.staticDistribution.intermediateCount,
        extremeFraction:
          report.staticDistribution.extremeFraction,
      });
      expect(extremeFraction).toBeGreaterThanOrEqual(0.9);
      expect(report.staticDistribution.requiredExtremeFraction).toBe(
        0.9,
      );
      expect(report.staticDistribution.passed).toBe(true);
      expect(report.missingValues).toEqual([]);
      expect(report.outputs).toHaveLength(101);
      expect(report.perValueRuntimeExceptionTable).toBe(false);
      expect(report.verificationStatus).toBe(
        "runtime-replay-verified",
      );
      expect(report.runtimeAlgorithmRevision).toBe(
        RUNTIME_FEEDBACK_ALGORITHM_REVISION,
      );
      expect(report.coverageContract).toEqual({
        schemaVersion: report.schemaVersion,
        schemaSha256: COVERAGE_REPORT_SCHEMA_SHA256,
      });
      expect(report.generatedBy.feedbackAlgorithmRevision).toBe(
        RUNTIME_FEEDBACK_ALGORITHM_REVISION,
      );
      expect(report.generatedBy.feedbackAlgorithmRevision).toBe(
        GENERATED_FEEDBACK_SPEC.algorithmRevision,
      );
      expect(report.coveredValues).toEqual(
        Array.from({ length: 101 }, (_, value) => value),
      );
    },
    60_000,
  );

  it("replays every canonical read-only challenge sample target", () => {
    expect(challengeSamples.schemaVersion).toBe(
      "mandelhowl.challenge-samples.v1",
    );
    const dataset = productionDataset();
    for (const sample of challengeSamples.targets) {
      const output = report.outputs.find(
        ({ target }) => target === sample.targetVolume,
      );
      expect(
        output,
        `missing challenge sample ${sample.challengeId}`,
      ).toBeDefined();
      const replay = replayResonanceTrajectory(
        dataset,
        output!.trace,
      );
      expect(
        replay.matchedExpectedVolume,
        `challenge sample ${sample.challengeId}`,
      ).toBe(true);
    }
  });

  it(
    "replays every generated 0..100 trajectory against the engine",
    () => {
      const dataset = productionDataset();
      for (const trace of report.traces as readonly ResonanceTrajectoryTrace[]) {
        const replay = replayResonanceTrajectory(dataset, trace);
        expect(
          replay.matchedExpectedVolume,
          `trace ${trace.traceId}`,
        ).toBe(true);
      }
    },
    60_000,
  );
});
