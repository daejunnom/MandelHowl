import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
let sourceArgument = process.argv[2];
let lock = null;

if (!sourceArgument) {
  const lockPath = path.join(projectRoot, "release", "dataset-lock.json");
  lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (
    lock?.schemaVersion !== "mandelhowl.dataset-lock.v1" ||
    typeof lock?.datasetDirectory !== "string"
  ) {
    throw new Error("release/dataset-lock.json is invalid.");
  }
  sourceArgument = lock.datasetDirectory;
}

if (typeof sourceArgument !== "string") {
  throw new Error(
    "Usage: node tools/release-packager/src/stage-runtime-assets.mjs [assets/generated/<dataset-hash>]",
  );
}

const generatedRoot = path.join(projectRoot, "assets", "generated");
const sourceDirectory = path.resolve(projectRoot, sourceArgument);
const relativeSource = path.relative(generatedRoot, sourceDirectory);

if (
  relativeSource.startsWith("..") ||
  path.isAbsolute(relativeSource) ||
  relativeSource.length === 0
) {
  throw new Error("Dataset source must be a hashed child of assets/generated.");
}

const manifestPath = path.join(sourceDirectory, "manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const manifestSha256 = createHash("sha256")
  .update(manifestBytes)
  .digest("hex");
const directoryName = manifest?.contentAddressing?.directoryName;

if (
  typeof directoryName !== "string" ||
  !/^[a-f0-9]{64}$/.test(directoryName) ||
  path.basename(sourceDirectory) !== directoryName ||
  manifest.datasetId !== `sha256:${directoryName}`
) {
  throw new Error("Dataset directory does not match its content-addressed ID.");
}
if (
  lock &&
  (lock.datasetId !== manifest.datasetId ||
    lock.manifestSha256 !== manifestSha256)
) {
  throw new Error("Dataset lock does not match the selected manifest.");
}

const destination = path.join(projectRoot, "public", "runtime");
const publicRoot = path.join(projectRoot, "public");
const relativeDestination = path.relative(publicRoot, destination);
if (
  relativeDestination !== "runtime" ||
  path.isAbsolute(relativeDestination)
) {
  throw new Error("Refusing to replace an unsafe runtime staging path.");
}
await rm(destination, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });
await cp(sourceDirectory, destination, {
  recursive: true,
  force: true,
  filter(source) {
    return !path.basename(source).startsWith(".");
  },
});

const stagedManifest = path.join(destination, "manifest.json");
const stagedStat = await stat(stagedManifest);
if (!stagedStat.isFile()) {
  throw new Error("Staged runtime manifest is missing.");
}

process.stdout.write(`${destination}\n`);
