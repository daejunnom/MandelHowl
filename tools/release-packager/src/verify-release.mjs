import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
const runtimeRoot = path.join(projectRoot, "public", "runtime");
const manifestPath = path.join(runtimeRoot, "manifest.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

function collectAssetReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectAssetReferences(item, references);
    return references;
  }

  if (!value || typeof value !== "object") {
    return references;
  }

  if (
    typeof value.path === "string" &&
    typeof value.sha256 === "string" &&
    Number.isInteger(value.byteLength)
  ) {
    references.push(value);
    return references;
  }

  for (const child of Object.values(value)) {
    collectAssetReferences(child, references);
  }
  return references;
}

await Promise.all([
  access(path.join(projectRoot, ".openai", "hosting.json")),
  access(path.join(projectRoot, "dist", "server", "index.js")),
  access(path.join(projectRoot, "LICENSE")),
  access(path.join(projectRoot, "THIRD_PARTY_NOTICES.md")),
  access(path.join(projectRoot, "public", "_headers")),
  access(path.join(runtimeRoot, "release-provenance.json")),
  access(path.join(runtimeRoot, "LICENSE.txt")),
  access(path.join(runtimeRoot, "THIRD_PARTY_NOTICES.md")),
  access(path.join(projectRoot, "release", "dataset-lock.json")),
  access(
    path.join(
      projectRoot,
      "release",
      "third-party-license-inventory.json",
    ),
  ),
]);

const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const lock = JSON.parse(
  await readFile(
    path.join(projectRoot, "release", "dataset-lock.json"),
    "utf8",
  ),
);
const releaseProvenance = JSON.parse(
  await readFile(
    path.join(runtimeRoot, "release-provenance.json"),
    "utf8",
  ),
);

if (manifest.schemaVersion !== "mandelhowl.resonance-manifest.v1") {
  throw new Error(`Unsupported manifest: ${manifest.schemaVersion}`);
}
if (!/^sha256:[a-f0-9]{64}$/.test(manifest.datasetId ?? "")) {
  throw new Error("Dataset ID is not content-addressed.");
}
const directoryName = manifest.datasetId.slice("sha256:".length);
if (
  lock.schemaVersion !== "mandelhowl.dataset-lock.v1" ||
  lock.datasetId !== manifest.datasetId ||
  lock.datasetDirectory !== `assets/generated/${directoryName}` ||
  lock.manifestSha256 !== sha256(manifestBytes)
) {
  throw new Error("release/dataset-lock.json does not pin this manifest.");
}
if (
  releaseProvenance.schemaVersion !==
    "mandelhowl.release-provenance.v1" ||
  releaseProvenance.datasetId !== manifest.datasetId ||
  releaseProvenance.datasetManifestSha256 !== sha256(manifestBytes) ||
  releaseProvenance.webCommit !== git("rev-parse", "HEAD")
) {
  throw new Error("Release provenance does not match HEAD and the dataset.");
}

const sourceInputs = [
  ["packageLockSha256", "package-lock.json"],
  ["licenseSha256", "LICENSE"],
  ["thirdPartyNoticesSha256", "THIRD_PARTY_NOTICES.md"],
  [
    "thirdPartyLicenseInventorySha256",
    "release/third-party-license-inventory.json",
  ],
  ["securityHeadersSha256", "public/_headers"],
];
for (const [key, file] of sourceInputs) {
  const actual = sha256(await readFile(path.join(projectRoot, file)));
  if (releaseProvenance.inputs?.[key] !== actual) {
    throw new Error(`Release provenance input mismatch: ${file}`);
  }
}

if (process.argv.includes("--require-clean")) {
  if (
    releaseProvenance.sourceTreeDirty ||
    git("status", "--porcelain", "--untracked-files=no").length > 0
  ) {
    throw new Error("A clean tracked source tree is required for release.");
  }
}

const references = collectAssetReferences(manifest.files);
if (references.length < 8) {
  throw new Error("Manifest does not reference the complete runtime dataset.");
}

for (const reference of references) {
  const absolutePath = path.resolve(runtimeRoot, reference.path);
  const relativePath = path.relative(runtimeRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe manifest path: ${reference.path}`);
  }

  const bytes = await readFile(absolutePath);
  const fileStat = await stat(absolutePath);
  if (fileStat.size !== reference.byteLength) {
    throw new Error(`Byte length mismatch: ${reference.path}`);
  }
  if (sha256(bytes) !== reference.sha256) {
    throw new Error(`SHA-256 mismatch: ${reference.path}`);
  }
}

const headers = await readFile(path.join(projectRoot, "public", "_headers"), "utf8");
for (const required of [
  "Content-Security-Policy",
  "Permissions-Policy",
  "X-Content-Type-Options",
]) {
  if (!headers.includes(required)) {
    throw new Error(`Missing security header: ${required}`);
  }
}

process.stdout.write(
  `Verified ${references.length} content-addressed assets for ${manifest.datasetId}.\n`,
);
