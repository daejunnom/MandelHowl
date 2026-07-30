import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DATASET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/u;
const MINIMUM_NODE_ENGINE_PATTERN = /^>=(\d+)\.(\d+)\.(\d+)$/u;

const DATASET_RELEASE_KEYS = Object.freeze([
  "schemaVersion",
  "canonicalOwner",
  "manifestUrl",
  "datasetId",
  "manifestSha256",
  "modalModelId",
  "sourceDirectory",
  "loadingPolicy",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(requireObject(value, label)).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields are not the closed contract.`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseYamlScalar(source) {
  const value = source.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    return Number(value);
  }
  if (value.length === 0) {
    throw new Error("Dataset release YAML contains an empty scalar.");
  }
  return value;
}

export function parseDatasetReleaseYaml(source) {
  if (typeof source !== "string") {
    throw new Error("Dataset release YAML must be text.");
  }
  const root = {};
  let parent = null;
  for (const [index, rawLine] of source.replaceAll("\r\n", "\n").split("\n").entries()) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    if (rawLine.includes("\t")) {
      throw new Error(`Dataset release YAML line ${index + 1} contains a tab.`);
    }
    const indentation = rawLine.length - rawLine.trimStart().length;
    if (indentation !== 0 && indentation !== 2) {
      throw new Error(
        `Dataset release YAML line ${index + 1} has unsupported indentation.`,
      );
    }
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(`Dataset release YAML line ${index + 1} is invalid.`);
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) {
      throw new Error(
        `Dataset release YAML line ${index + 1} has an invalid key.`,
      );
    }
    if (indentation === 0) {
      if (Object.hasOwn(root, key)) {
        throw new Error(`Dataset release YAML repeats ${key}.`);
      }
      if (rawValue.length === 0) {
        const child = {};
        root[key] = child;
        parent = child;
      } else {
        root[key] = parseYamlScalar(rawValue);
        parent = null;
      }
      continue;
    }
    if (parent === null) {
      throw new Error(
        `Dataset release YAML line ${index + 1} has no parent mapping.`,
      );
    }
    if (Object.hasOwn(parent, key)) {
      throw new Error(`Dataset release YAML repeats nested ${key}.`);
    }
    if (rawValue.length === 0) {
      throw new Error(
        `Dataset release YAML line ${index + 1} nests too deeply.`,
      );
    }
    parent[key] = parseYamlScalar(rawValue);
  }
  return root;
}

export function parseGeneratedDatasetReleaseProjection(
  source,
  expectedSourceSha256,
) {
  if (typeof source !== "string") {
    throw new Error("Generated dataset release projection must be text.");
  }
  if (!SHA256_PATTERN.test(expectedSourceSha256 ?? "")) {
    throw new Error("Canonical dataset release source SHA-256 is invalid.");
  }
  const hashMatches = [
    ...source.matchAll(
      /export const DATASET_RELEASE_SOURCE_SHA256 = "([a-f0-9]{64})";/gu,
    ),
  ];
  if (
    hashMatches.length !== 1 ||
    hashMatches[0]?.[1] !== expectedSourceSha256
  ) {
    throw new Error(
      "Generated dataset release projection does not bind the canonical YAML bytes.",
    );
  }
  const prefix =
    "export const GENERATED_DATASET_RELEASE_SPEC = Object.freeze(";
  const suffix = " as const) satisfies DatasetReleaseSpec;";
  const prefixIndex = source.indexOf(prefix);
  if (
    prefixIndex < 0 ||
    source.indexOf(prefix, prefixIndex + prefix.length) >= 0
  ) {
    throw new Error(
      "Generated dataset release projection has no unique object export.",
    );
  }
  const jsonStart = prefixIndex + prefix.length;
  const suffixIndex = source.indexOf(suffix, jsonStart);
  if (
    suffixIndex < 0 ||
    source.indexOf(suffix, suffixIndex + suffix.length) >= 0
  ) {
    throw new Error(
      "Generated dataset release projection has no unique export terminator.",
    );
  }
  let projection;
  try {
    projection = JSON.parse(source.slice(jsonStart, suffixIndex));
  } catch (error) {
    throw new Error(
      `Generated dataset release projection is not canonical JSON: ${error.message}`,
    );
  }
  return requireObject(projection, "Generated dataset release projection");
}

function assertDatasetReleaseShape(spec, label) {
  assertExactKeys(spec, DATASET_RELEASE_KEYS, label);
  assertExactKeys(spec.canonicalOwner, ["path", "policy"], `${label}.canonicalOwner`);
  if (
    spec.schemaVersion !== "mandelhowl.dataset-release.v1" ||
    spec.canonicalOwner.path !== "specs/runtime/dataset-release.v1.yaml" ||
    spec.canonicalOwner.policy !== "edit-source-regenerate-derived" ||
    spec.manifestUrl !== "/runtime/manifest.json" ||
    !DATASET_ID_PATTERN.test(spec.datasetId ?? "") ||
    !SHA256_PATTERN.test(spec.manifestSha256 ?? "") ||
    !DATASET_ID_PATTERN.test(spec.modalModelId ?? "") ||
    !/^assets\/generated\/[a-f0-9]{64}$/u.test(
      spec.sourceDirectory ?? "",
    ) ||
    spec.loadingPolicy !==
      "verified-before-activation-with-analytical-fallback"
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

export function assertDatasetReleaseBindings({
  releaseSpecSource,
  generatedProjectionSource,
  lock,
  manifest,
  manifestBytes,
}) {
  const canonical = parseDatasetReleaseYaml(releaseSpecSource);
  const canonicalSourceSha256 = sha256(Buffer.from(releaseSpecSource, "utf8"));
  const generated = parseGeneratedDatasetReleaseProjection(
    generatedProjectionSource,
    canonicalSourceSha256,
  );
  assertDatasetReleaseShape(canonical, "Canonical dataset release spec");
  assertDatasetReleaseShape(generated, "Generated dataset release projection");
  if (!sameJson(generated, canonical)) {
    throw new Error(
      "Generated dataset release projection differs from the canonical YAML.",
    );
  }
  assertExactKeys(
    lock,
    ["schemaVersion", "datasetId", "datasetDirectory", "manifestSha256"],
    "Dataset lock",
  );
  if (
    lock.schemaVersion !== "mandelhowl.dataset-lock.v1" ||
    !DATASET_ID_PATTERN.test(lock.datasetId ?? "") ||
    !SHA256_PATTERN.test(lock.manifestSha256 ?? "")
  ) {
    throw new Error("Dataset lock is invalid.");
  }
  const requiredManifest = requireObject(manifest, "Pinned manifest");
  const requiredManifestBytes = Buffer.isBuffer(manifestBytes)
    ? manifestBytes
    : Buffer.from(manifestBytes);
  const manifestSha256 = sha256(requiredManifestBytes);
  const modesSha256 = requiredManifest.files?.modes?.sha256;
  if (
    !DATASET_ID_PATTERN.test(requiredManifest.datasetId ?? "") ||
    !SHA256_PATTERN.test(modesSha256 ?? "")
  ) {
    throw new Error(
      "Pinned manifest has no valid dataset or modal-model identity.",
    );
  }
  const directoryName = requiredManifest.datasetId.slice("sha256:".length);
  const expectedSourceDirectory = `assets/generated/${directoryName}`;
  const expectedModalModelId = `sha256:${modesSha256}`;
  const expected = [
    ["canonical datasetId", canonical.datasetId, requiredManifest.datasetId],
    ["canonical manifestSha256", canonical.manifestSha256, manifestSha256],
    ["canonical modalModelId", canonical.modalModelId, expectedModalModelId],
    [
      "canonical sourceDirectory",
      canonical.sourceDirectory,
      expectedSourceDirectory,
    ],
    ["lock datasetId", lock.datasetId, requiredManifest.datasetId],
    ["lock manifestSha256", lock.manifestSha256, manifestSha256],
    ["lock datasetDirectory", lock.datasetDirectory, expectedSourceDirectory],
  ];
  for (const [label, actual, required] of expected) {
    if (actual !== required) {
      throw new Error(`Dataset release binding mismatch: ${label}.`);
    }
  }
  return Object.freeze({
    canonicalSourceSha256,
    datasetId: requiredManifest.datasetId,
    manifestSha256,
    modalModelId: expectedModalModelId,
    sourceDirectory: expectedSourceDirectory,
  });
}

function parseNodeVersion(value, label) {
  const match = NODE_VERSION_PATTERN.exec(value ?? "");
  if (match === null) {
    throw new Error(`${label} is not a complete Node.js version.`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function assertNodeVersionPolicy(nodeVersion, nodeEngine) {
  const engineMatch = MINIMUM_NODE_ENGINE_PATTERN.exec(nodeEngine ?? "");
  if (engineMatch === null) {
    throw new Error(
      "package.json engines.node must be one closed >=major.minor.patch policy.",
    );
  }
  const actual = parseNodeVersion(nodeVersion, "Provenance Node.js version");
  const minimum = engineMatch.slice(1).map(Number);
  if (compareVersions(actual, minimum) < 0) {
    throw new Error(
      `Provenance Node.js version ${nodeVersion} does not satisfy ${nodeEngine}.`,
    );
  }
}

export function assertReleaseProvenanceBindings({
  releaseProvenance,
  manifest,
  manifestSha256,
  headCommit,
  headCommitTimestamp,
  currentNodeVersion,
  nodeEngine,
}) {
  const provenance = requireObject(
    releaseProvenance,
    "Release provenance",
  );
  const requiredManifest = requireObject(manifest, "Pinned manifest");
  if (
    provenance.schemaVersion !== "mandelhowl.release-provenance.v4" ||
    provenance.datasetId !== requiredManifest.datasetId ||
    provenance.datasetManifestSha256 !== manifestSha256 ||
    provenance.webCommit !== headCommit ||
    provenance.webCommitTimestamp !== headCommitTimestamp
  ) {
    throw new Error(
      "Release provenance does not match the source commit and dataset.",
    );
  }
  if (provenance.plateSpecSha256 !== requiredManifest.plate?.specSha256) {
    throw new Error(
      "Release provenance plate specification does not match the manifest.",
    );
  }
  if (
    requiredManifest.solverProvenance === null ||
    typeof requiredManifest.solverProvenance !== "object" ||
    Array.isArray(requiredManifest.solverProvenance) ||
    !sameJson(provenance.solver, requiredManifest.solverProvenance)
  ) {
    throw new Error(
      "Release provenance solver evidence does not match the manifest.",
    );
  }
  assertExactKeys(
    provenance.buildContract,
    ["packageManager", "nodeVersion", "buildCommand", "workerEntrypoint"],
    "Release provenance buildContract",
  );
  if (
    provenance.buildContract.packageManager !== "npm" ||
    provenance.buildContract.nodeVersion !== currentNodeVersion ||
    provenance.buildContract.buildCommand !== "npm run build" ||
    provenance.buildContract.workerEntrypoint !== "dist/server/index.js"
  ) {
    throw new Error("Release provenance build contract is invalid.");
  }
  assertNodeVersionPolicy(provenance.buildContract.nodeVersion, nodeEngine);
  assertNodeVersionPolicy(currentNodeVersion, nodeEngine);
  return Object.freeze({
    webCommit: headCommit,
    webCommitTimestamp: headCommitTimestamp,
    nodeVersion: currentNodeVersion,
    nodeEngine,
  });
}
