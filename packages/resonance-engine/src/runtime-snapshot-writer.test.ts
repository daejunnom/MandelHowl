import { describe, expect, it } from "vitest";
import type { DiagnosticRecord } from "../../contracts/src";
import {
  advanceMandelHowlRuntime,
  createMandelHowlRuntime,
  createRuntimeSnapshotWriter,
  getRuntimeSnapshot,
  replaceMandelHowlDataset,
  type RuntimeModalDataset,
} from "./index";

const INITIAL_DATASET_ID =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const REPLACEMENT_DATASET_ID =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const INITIAL_DIAGNOSTIC: DiagnosticRecord = Object.freeze({
  code: "runtime.snapshot.initial",
  evidenceState: "confirmed",
  severity: "info",
  messageKey: "runtime.snapshot.initial",
  evidence: Object.freeze([]),
});

const UPDATED_DIAGNOSTIC: DiagnosticRecord = Object.freeze({
  code: "runtime.snapshot.updated",
  evidenceState: "confirmed",
  severity: "warning",
  messageKey: "runtime.snapshot.updated",
  evidence: Object.freeze([]),
});

function createDataset(
  datasetId: RuntimeModalDataset["datasetId"],
  firstModeId = "mode-00",
): RuntimeModalDataset {
  return Object.freeze({
    datasetId,
    modalModelId: datasetId,
    frequencyRangeHz: Object.freeze([45, 6_000] as const),
    maximumModalCoupling: 1,
    modes: Object.freeze(
      Array.from({ length: 48 }, (_, index) =>
        Object.freeze({
          id:
            index === 0
              ? firstModeId
              : `mode-${index.toString().padStart(2, "0")}`,
          frequencyHz: 100 + index * 30,
          dampingRatio: 0.012,
          driveCoupling: 1,
          microphoneCoupling: 1,
          phaseOffsetRadians: index * 0.1,
          radiationEfficiency: 1,
          textureLayer: index,
        }),
      ),
    ),
  });
}

describe("reusable runtime snapshot writer", () => {
  it("reuses the complete 48-mode object graph and updates values in place", () => {
    let runtime = createMandelHowlRuntime({
      dataset: createDataset(INITIAL_DATASET_ID),
      diagnostics: [INITIAL_DIAGNOSTIC],
      initialFrequencyHz: 220,
    });
    const writer = createRuntimeSnapshotWriter();
    const first = writer.write(runtime);
    const firstSequence = first.sequence;
    const firstVolumeProgress = first.volume.progress;
    const root = first;
    const dial = first.dial;
    const modes = first.modes;
    const modeObjects = Array.from(first.modes);
    const microphone = first.microphone;
    const recentSamples = first.microphone.recentSamples;
    const feedback = first.feedback;
    const volume = first.volume;
    const diagnostics = first.diagnostics;

    expect(first.modes).toHaveLength(48);
    expect(first).toEqual(getRuntimeSnapshot(runtime));
    expect(writer.layoutGeneration).toBe(1);
    expect(writer.lastWriteRebuilt).toBe(true);
    expect(writer.lastWriteRebuildReason).toBe("initial");

    runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    runtime.resonance.diagnostics = Object.freeze([
      INITIAL_DIAGNOSTIC,
      UPDATED_DIAGNOSTIC,
    ]);
    const second = writer.write(runtime);

    expect(second).toBe(root);
    expect(second.dial).toBe(dial);
    expect(second.modes).toBe(modes);
    expect(second.microphone).toBe(microphone);
    expect(second.microphone.recentSamples).toBe(recentSamples);
    expect(second.feedback).toBe(feedback);
    expect(second.volume).toBe(volume);
    expect(second.diagnostics).toBe(diagnostics);
    for (let index = 0; index < second.modes.length; index += 1) {
      expect(second.modes[index]).toBe(modeObjects[index]);
    }

    expect(second.sequence).toBeGreaterThan(firstSequence);
    expect(first.sequence).toBe(second.sequence);
    expect(first.sequence).not.toBe(firstSequence);
    expect(second.volume.progress).toBeGreaterThan(
      firstVolumeProgress,
    );
    expect(second.microphone.recentSamples.length).toBeGreaterThan(0);
    expect(second.modes[4].energyNormalized).toBeGreaterThan(0);
    expect(second.activeModeId).toBe("mode-04");
    expect(second.diagnostics).toEqual([
      INITIAL_DIAGNOSTIC,
      UPDATED_DIAGNOSTIC,
    ]);
    expect(second).toEqual(getRuntimeSnapshot(runtime));
    expect(writer.layoutGeneration).toBe(1);
    expect(writer.lastWriteRebuilt).toBe(false);
    expect(writer.lastWriteRebuildReason).toBeNull();

    let publishCount = 0;
    writer.publish(runtime, (snapshot) => {
      publishCount += 1;
      expect(snapshot).toBe(second);
    });
    expect(publishCount).toBe(1);
    expect(writer.lastWriteRebuilt).toBe(false);

    runtime.resonance.measurementElapsedSeconds =
      Number.MAX_SAFE_INTEGER;
    runtime.resonance.lastSettledVolume = 73;
    const settled = writer.write(runtime);
    expect(settled).toBe(second);
    expect(settled.volume).toBe(volume);
    expect(settled.volume).toEqual({
      status: "settled",
      value: 73,
      lastSettledValue: 73,
      progress: 1,
    });
    expect(settled).toEqual(getRuntimeSnapshot(runtime));
  });

  it("reports every exceptional layout rebuild", () => {
    let runtime = createMandelHowlRuntime({
      dataset: createDataset(INITIAL_DATASET_ID),
      initialFrequencyHz: 220,
    });
    const writer = createRuntimeSnapshotWriter();
    const initial = writer.write(runtime);
    const initialModes = initial.modes;

    runtime = replaceMandelHowlDataset(
      runtime,
      createDataset(REPLACEMENT_DATASET_ID),
    );
    const replaced = writer.write(runtime);
    expect(replaced).not.toBe(initial);
    expect(replaced.modes).not.toBe(initialModes);
    expect(writer.layoutGeneration).toBe(2);
    expect(writer.lastWriteRebuilt).toBe(true);
    expect(writer.lastWriteRebuildReason).toBe("dataset-id");
    expect(replaced).toEqual(getRuntimeSnapshot(runtime));

    const beforeCapacityChange = replaced;
    const nextCapacity = writer.recentSampleCapacity + 8;
    runtime.resonance.recentMicrophoneSamples =
      new Float64Array(nextCapacity);
    runtime.resonance.recentSampleWriteIndex = 0;
    runtime.resonance.recentSampleCount = 0;
    const resized = writer.write(runtime);
    expect(resized).not.toBe(beforeCapacityChange);
    expect(writer.recentSampleCapacity).toBe(nextCapacity);
    expect(writer.layoutGeneration).toBe(3);
    expect(writer.lastWriteRebuilt).toBe(true);
    expect(writer.lastWriteRebuildReason).toBe(
      "recent-sample-capacity",
    );
    expect(resized).toEqual(getRuntimeSnapshot(runtime));

    const changedLayoutRuntime = createMandelHowlRuntime({
      dataset: createDataset(
        REPLACEMENT_DATASET_ID,
        "replacement-mode-00",
      ),
      initialFrequencyHz: 220,
    });
    const changedLayout = writer.write(changedLayoutRuntime);
    expect(changedLayout).not.toBe(resized);
    expect(writer.layoutGeneration).toBe(4);
    expect(writer.lastWriteRebuilt).toBe(true);
    expect(writer.lastWriteRebuildReason).toBe("mode-layout");
    expect(changedLayout).toEqual(
      getRuntimeSnapshot(changedLayoutRuntime),
    );
  });

  it("keeps the one-shot immutable API distinct and frozen", () => {
    let runtime = createMandelHowlRuntime({
      dataset: createDataset(INITIAL_DATASET_ID),
      initialFrequencyHz: 220,
    });
    const first = getRuntimeSnapshot(runtime);
    const second = getRuntimeSnapshot(runtime);
    const retainedSequence = first.sequence;
    const writer = createRuntimeSnapshotWriter();
    writer.write(runtime);
    runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    writer.write(runtime);

    expect(second).not.toBe(first);
    expect(first.sequence).toBe(retainedSequence);
    expect(first.sequence).not.toBe(runtime.resonance.sequence);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.dial)).toBe(true);
    expect(Object.isFrozen(first.modes)).toBe(true);
    expect(Object.isFrozen(first.modes[0])).toBe(true);
    expect(Object.isFrozen(first.microphone)).toBe(true);
    expect(
      Object.isFrozen(first.microphone.recentSamples),
    ).toBe(true);
    expect(Object.isFrozen(first.feedback)).toBe(true);
    expect(Object.isFrozen(first.volume)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
  });
});
