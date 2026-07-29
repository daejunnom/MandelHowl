/**
 * Dependency-free generator for the deliberately small YAML subset used by
 * specs/runtime. Run with:
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
const releaseLockPath = resolve(root, "release/dataset-lock.json");
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
    "datasetRelease",
    "specs/runtime/dataset-release.v1.yaml",
    "GENERATED_DATASET_RELEASE_SPEC",
    "DatasetReleaseSpec",
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
      parent.push(scalar(trimmed.slice(2)));
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

const body = `/**
 * GENERATED FILE — edit specs/runtime/*.yaml and run
 * node packages/contracts/scripts/generate-runtime-specs.mjs.
 */
import type { AudioSafetySpec, DatasetReleaseSpec, DialConfig, VolumeMapSpec } from "../runtime-config";
import type { FeedbackSpec } from "../feedback-spec";

export const RUNTIME_SPEC_SOURCE_HASHES = Object.freeze(${JSON.stringify(
  Object.fromEntries(parsed.map((item) => [item.key, hash(item.source)])),
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
const releaseSpec = parsed.find((item) => item.key === "datasetRelease").value;
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
  const currentLock = readFileSync(releaseLockPath, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  if (current !== body || currentLock !== releaseLock) {
    throw new Error(
      "Generated runtime specs or dataset lock are stale. Run generate-runtime-specs.mjs.",
    );
  }
} else {
  writeFileSync(outputPath, body, "utf8");
  writeFileSync(releaseLockPath, releaseLock, "utf8");
}
