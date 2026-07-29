import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_DIAL_SPEC,
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_FEEDBACK_SPEC,
  GENERATED_VOLUME_MAP_SPEC,
  RUNTIME_SPEC_SOURCE_HASHES,
} from "./runtime-specs.generated";

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(process.cwd(), path)))
    .digest("hex");
}

describe("generated runtime specifications", () => {
  it("fails closed when any canonical YAML changes without regeneration", () => {
    expect(sha256("specs/runtime/dial.v1.yaml")).toBe(
      RUNTIME_SPEC_SOURCE_HASHES.dial,
    );
    expect(sha256("specs/runtime/feedback.v1.yaml")).toBe(
      RUNTIME_SPEC_SOURCE_HASHES.feedback,
    );
    expect(sha256("specs/runtime/volume-map.v1.yaml")).toBe(
      RUNTIME_SPEC_SOURCE_HASHES.volumeMap,
    );
    expect(sha256("specs/runtime/audio-safety.v1.yaml")).toBe(
      RUNTIME_SPEC_SOURCE_HASHES.audioSafety,
    );
    expect(sha256("specs/runtime/dataset-release.v1.yaml")).toBe(
      RUNTIME_SPEC_SOURCE_HASHES.datasetRelease,
    );
  });

  it("keeps all runtime frequency and timing owners aligned", () => {
    expect(GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz).toBe(45);
    expect(GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz).toBe(6000);
    expect(GENERATED_FEEDBACK_SPEC.loop.filter.highPassHz).toBe(
      GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
    );
    expect(GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds).toBe(1 / 240);
    expect(
      GENERATED_FEEDBACK_SPEC.simulation.maximumStepsPerFrame *
        GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds,
    ).toBe(
      GENERATED_FEEDBACK_SPEC.simulation.maximumCatchUpSeconds,
    );
    expect(GENERATED_VOLUME_MAP_SPEC.mapping.intermediateRange).toEqual([
      1,
      99,
    ]);
    expect(GENERATED_DATASET_RELEASE_SPEC.datasetId).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });
});
