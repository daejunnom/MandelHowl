import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COVERAGE_REPORT_SCHEMA_SHA256,
  GENERATED_FEEDBACK_SPEC,
} from "./index";

interface CoverageSchema {
  readonly additionalProperties: boolean;
  readonly required: readonly string[];
  readonly properties: {
    readonly runtimeAlgorithmRevision: {
      readonly const: string;
    };
    readonly generatedBy: {
      readonly additionalProperties: boolean;
      readonly required: readonly string[];
    };
    readonly runtimeSpecSha256: {
      readonly additionalProperties: boolean;
      readonly required: readonly string[];
    };
    readonly traces: {
      readonly items: { readonly $ref: string };
    };
    readonly outputs: {
      readonly items: {
        readonly properties: {
          readonly trace: { readonly $ref: string };
        };
      };
    };
  };
}

const schemaPath = resolve(
  process.cwd(),
  "packages/contracts/schemas/coverage-report.schema.json",
);
const schemaBytes = readFileSync(schemaPath);
const schema = JSON.parse(schemaBytes.toString("utf8")) as CoverageSchema;

describe("reachability coverage wire contract", () => {
  it("binds the report to every runtime-facing algorithm and spec", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "runtimeAlgorithmRevision",
        "coverageContract",
        "generatedBy",
        "runtimeSpecSha256",
        "traces",
        "outputs",
      ]),
    );
    expect(schema.properties.runtimeAlgorithmRevision.const).toBe(
      GENERATED_FEEDBACK_SPEC.algorithmRevision,
    );
    expect(schema.properties.generatedBy.additionalProperties).toBe(false);
    expect(schema.properties.generatedBy.required).toEqual(
      expect.arrayContaining([
        "algorithm",
        "feedbackAlgorithmRevision",
        "perValueRuntimeLookup",
        "randomSource",
      ]),
    );
    expect(schema.properties.runtimeSpecSha256.required).toEqual([
      "dial",
      "feedback",
      "volumeMap",
      "audioSafety",
      "uiNVersion",
    ]);
  });

  it("publishes the exact schema digest and resolvable trace references", () => {
    expect(createHash("sha256").update(schemaBytes).digest("hex")).toBe(
      COVERAGE_REPORT_SCHEMA_SHA256,
    );
    for (const reference of [
      schema.properties.traces.items.$ref,
      schema.properties.outputs.items.properties.trace.$ref,
    ]) {
      expect(reference.startsWith("#")).toBe(false);
      expect(existsSync(resolve(dirname(schemaPath), reference))).toBe(true);
    }
  });

  it("keeps production coverage generation behind the manifest boundary", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "tests/runtime/generate-reachability-report.ts",
      ),
      "utf8",
    );
    expect(source).toContain(
      "--manifest is required whenever --modes is supplied",
    );
    expect(source).toContain("manifest.files.modes.sha256");
    expect(source).toContain("manifest.frequencyRange.minimumHz");
    expect(source).toContain("manifest.frequencyRange.maximumHz");
    expect(source).not.toContain(
      "frequencyRangeHz: Object.freeze([45, 6000]",
    );
  });
});
