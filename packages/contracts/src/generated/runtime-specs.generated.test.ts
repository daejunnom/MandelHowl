import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_DIAL_SPEC,
  GENERATED_FEEDBACK_SPEC,
  GENERATED_VOLUME_MAP_SPEC,
  RUNTIME_SPEC_SOURCE_HASHES,
} from "./runtime-specs.generated";
import {
  DATASET_RELEASE_SOURCE_SHA256,
  GENERATED_DATASET_RELEASE_SPEC,
} from "./dataset-release.generated";

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(process.cwd(), path)))
    .digest("hex");
}

function readSchema(path: string): {
  readonly required?: readonly string[];
  readonly properties?: Readonly<
    Record<
      string,
      {
        readonly required?: readonly string[];
        readonly items?: {
          readonly required?: readonly string[];
        };
      }
    >
  >;
  readonly $defs?: Readonly<
    Record<
      string,
      {
        readonly required?: readonly string[];
      }
    >
  >;
} {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), path), "utf8"),
  ) as ReturnType<typeof readSchema>;
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
      DATASET_RELEASE_SOURCE_SHA256,
    );
    expect(RUNTIME_SPEC_SOURCE_HASHES).not.toHaveProperty("datasetRelease");
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

  it("keeps every handoff plate, manifest, and runtime snapshot field in the closed schemas", () => {
    const plate = readSchema(
      "packages/contracts/schemas/plate-spec.schema.json",
    );
    const manifest = readSchema(
      "packages/contracts/schemas/resonance-manifest.schema.json",
    );
    const snapshot = readSchema(
      "packages/contracts/schemas/runtime-snapshot.schema.json",
    );

    expect(plate.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "plateId",
        "geometry",
        "boundaryCondition",
        "material",
        "mandelbrotField",
        "thicknessMapping",
        "massMapping",
        "actuator",
        "virtualMicrophone",
        "frequencyRange",
        "solverRequest",
        "textureRequest",
      ]),
    );
    expect(manifest.required).toEqual(
      expect.arrayContaining([
        "datasetId",
        "plate",
        "solverProvenance",
        "modeCount",
        "frequencyRange",
        "units",
        "coordinateSystem",
        "runtimeCompatibility",
        "files",
      ]),
    );
    expect(manifest.properties?.files.required).toEqual(
      expect.arrayContaining([
        "modes",
        "response",
        "textures",
        "convergenceReport",
        "coverageReport",
      ]),
    );
    expect(snapshot.required).toEqual(
      expect.arrayContaining([
        "simulationTimeSeconds",
        "dial",
        "modes",
        "microphone",
        "feedback",
        "regime",
        "volume",
        "diagnostics",
      ]),
    );
    expect(snapshot.$defs?.dial.required).toEqual(
      expect.arrayContaining([
        "unwrappedAngleRad",
        "driveFrequencyHz",
      ]),
    );
    expect(snapshot.$defs?.mode.required).toEqual(
      expect.arrayContaining(["amplitudeNormalized", "phaseRad"]),
    );
    expect(snapshot.$defs?.microphone.required).toEqual(
      expect.arrayContaining(["rmsNormalized", "peakNormalized"]),
    );
    expect(snapshot.$defs?.feedback.required).toEqual(
      expect.arrayContaining(["envelopeNormalized"]),
    );
    expect(snapshot.$defs?.measuringVolume.required).toEqual(
      expect.arrayContaining(["value", "progress"]),
    );
    expect(snapshot.$defs?.settledVolume.required).toEqual(
      expect.arrayContaining(["value", "progress"]),
    );
  });
});
