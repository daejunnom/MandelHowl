/**
 * Dependency-free generator for the deliberately small YAML subset used by
 * the canonical runtime and visual specs. Run with:
 *
 *   node packages/contracts/scripts/generate-runtime-specs.mjs
 *
 * Pass --check to verify that the generated source is current without writing.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outputPath = resolve(
  root,
  "packages/contracts/src/generated/runtime-specs.generated.ts",
);
const releaseOutputPath = resolve(
  root,
  "packages/contracts/src/generated/dataset-release.generated.ts",
);
const releaseLockPath = resolve(root, "release/dataset-lock.json");
const releaseSpecPath = "specs/runtime/dataset-release.v1.yaml";
const coverageSchemaPath = resolve(
  root,
  "packages/contracts/schemas/coverage-report.schema.json",
);
const identitySources = {
  scientificAlgorithm: "specs/physics/baker-algorithm.v1.json",
  presentationContract: "specs/runtime/ui-nversion.v1.json",
};
const sources = [
  ["dial", "specs/runtime/dial.v1.yaml", "GENERATED_DIAL_SPEC", "DialConfig"],
  [
    "feedback",
    "specs/runtime/feedback.v1.yaml",
    "GENERATED_FEEDBACK_SPEC",
    "FeedbackSpec",
  ],
  [
    "volumeMap",
    "specs/runtime/volume-map.v1.yaml",
    "GENERATED_VOLUME_MAP_SPEC",
    "VolumeMapSpec",
  ],
  [
    "audioSafety",
    "specs/runtime/audio-safety.v1.yaml",
    "GENERATED_AUDIO_SAFETY_SPEC",
    "AudioSafetySpec",
  ],
  [
    "performanceBudget",
    "specs/visual/performance-budget.v1.yaml",
    "GENERATED_PERFORMANCE_BUDGET_SPEC",
    "PerformanceBudgetSpec",
  ],
  [
    "motionSafety",
    "specs/visual/motion-safety.v1.yaml",
    "GENERATED_MOTION_SAFETY_SPEC",
    "MotionSafetySpec",
  ],
  [
    "renderQuality",
    "specs/visual/quality-tiers.v1.yaml",
    "GENERATED_RENDER_QUALITY_TIERS_SPEC",
    "RenderQualityTiersSpec",
  ],
  [
    "scene",
    "specs/visual/scene.v1.yaml",
    "GENERATED_SCENE_SPEC",
    "SceneSpec",
  ],
];

function scalar(text) {
  const value = text.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    return body === "" ? [] : body.split(",").map((entry) => scalar(entry));
  }
  return value;
}

function parseYamlSubset(source) {
  const rootObject = {};
  const stack = [{ indent: -1, value: rootObject }];
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;

    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`Sequence without array parent at line ${index + 1}`);
      }
      const itemText = trimmed.slice(2);
      const separator = itemText.indexOf(":");
      if (separator > 0) {
        const item = {};
        const key = itemText.slice(0, separator);
        const rest = itemText.slice(separator + 1).trim();
        item[key] = rest === "" ? {} : scalar(rest);
        parent.push(item);
        stack.push({ indent, value: item });
      } else {
        parent.push(scalar(itemText));
      }
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator < 1 || Array.isArray(parent)) {
      throw new Error(`Unsupported YAML at line ${index + 1}`);
    }
    const key = trimmed.slice(0, separator);
    const rest = trimmed.slice(separator + 1).trim();
    if (rest !== "") {
      parent[key] = scalar(rest);
      continue;
    }

    const nextMeaningful = lines
      .slice(index + 1)
      .find((candidate) => {
        const value = candidate.trim();
        return value !== "" && !value.startsWith("#");
      });
    const child = nextMeaningful?.trim().startsWith("- ") ? [] : {};
    parent[key] = child;
    stack.push({ indent, value: child });
  }

  return rootObject;
}

function hash(source) {
  return createHash("sha256").update(source).digest("hex");
}

const parsed = sources.map(([key, path, constant, type]) => {
  const source = readFileSync(resolve(root, path), "utf8");
  return { key, path, constant, type, source, value: parseYamlSubset(source) };
});
const releaseSpecSource = readFileSync(resolve(root, releaseSpecPath), "utf8");
const releaseSpec = parseYamlSubset(releaseSpecSource);
const nVersionContractDigests = Object.fromEntries(
  Object.entries(identitySources).map(([key, sourcePath]) => [
    key,
    `sha256:${hash(readFileSync(resolve(root, sourcePath)))}`,
  ]),
);

const body = `/**
 * GENERATED FILE — edit specs/runtime/*.yaml or specs/visual/*.yaml and run
 * node packages/contracts/scripts/generate-runtime-specs.mjs.
 */
import type { AudioSafetySpec, DialConfig, VolumeMapSpec } from "../runtime-config";
import type { FeedbackSpec } from "../feedback-spec";
import type { PerformanceBudgetSpec } from "../performance-budget";
import type { MotionSafetySpec, RenderQualityTiersSpec, SceneSpec } from "../visual-specs";

export const RUNTIME_SPEC_SOURCE_HASHES = Object.freeze(${JSON.stringify(
  Object.fromEntries(parsed.map((item) => [item.key, hash(item.source)])),
  null,
  2,
)} as const);

export const COVERAGE_REPORT_SCHEMA_SHA256 = ${JSON.stringify(
  hash(readFileSync(coverageSchemaPath)),
)};

export const N_VERSION_CONTRACT_DIGESTS = Object.freeze(${JSON.stringify(
  nVersionContractDigests,
  null,
  2,
)} as const);

${parsed
  .map(
    (item) =>
      `export const ${item.constant} = Object.freeze(${JSON.stringify(
        item.value,
        null,
        2,
      )} as const) satisfies ${item.type};`,
  )
  .join("\n\n")}
`;
const releaseBody = `/**
 * GENERATED PROMOTION PROJECTION — edit specs/runtime/dataset-release.v1.yaml
 * and run node packages/contracts/scripts/generate-runtime-specs.mjs.
 *
 * This file contains only the promoted dataset pin. Scientific/runtime source
 * attestations exclude this exact generated path to avoid a circular identity
 * dependency while continuing to bind runtime-specs.generated.ts.
 */
import type { DatasetReleaseSpec } from "../runtime-config";

export const DATASET_RELEASE_SOURCE_SHA256 = ${JSON.stringify(
  hash(releaseSpecSource),
)};

export const GENERATED_DATASET_RELEASE_SPEC = Object.freeze(${JSON.stringify(
  releaseSpec,
  null,
  2,
)} as const) satisfies DatasetReleaseSpec;
`;
const releaseLock = `${JSON.stringify(
  {
    schemaVersion: "mandelhowl.dataset-lock.v1",
    datasetId: releaseSpec.datasetId,
    datasetDirectory: releaseSpec.sourceDirectory,
    manifestSha256: releaseSpec.manifestSha256,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n");
  const currentRelease = readFileSync(releaseOutputPath, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const currentLock = readFileSync(releaseLockPath, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  if (
    current !== body ||
    currentRelease !== releaseBody ||
    currentLock !== releaseLock
  ) {
    throw new Error(
      "Generated runtime specs, dataset release projection, or dataset lock are stale. Run generate-runtime-specs.mjs.",
    );
  }
} else {
  writeFileSync(outputPath, body, "utf8");
  writeFileSync(releaseOutputPath, releaseBody, "utf8");
  writeFileSync(releaseLockPath, releaseLock, "utf8");
}
