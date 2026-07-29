import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readJsonObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  return requireObject(value, label);
}

function safeDatasetPath(root, relative, label) {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.includes("\\")
  ) {
    throw new Error(`${label} path is not a safe portable relative path`);
  }
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (
    relation === "" ||
    path.isAbsolute(relation) ||
    relation.startsWith("..")
  ) {
    throw new Error(`${label} path escapes the dataset root`);
  }
  return resolved;
}

function requireDescriptor(value, label) {
  const descriptor = requireObject(value, label);
  if (
    typeof descriptor.path !== "string" ||
    !SHA256_PATTERN.test(descriptor.sha256 ?? "") ||
    !Number.isSafeInteger(descriptor.byteLength) ||
    descriptor.byteLength < 0
  ) {
    throw new Error(`${label} has an invalid path, SHA-256, or byte length`);
  }
  return descriptor;
}

function manifestDescriptors(value, label = "manifest.files") {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      manifestDescriptors(child, `${label}[${index}]`),
    );
  }
  const object = requireObject(value, label);
  if (
    Object.hasOwn(object, "path") ||
    Object.hasOwn(object, "sha256") ||
    Object.hasOwn(object, "byteLength")
  ) {
    return [requireDescriptor(object, label)];
  }
  return Object.entries(object).flatMap(([key, child]) =>
    manifestDescriptors(child, `${label}.${key}`),
  );
}

function actualInventory(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("dataset inventory must not contain symbolic links");
    }
    if (entry.isDirectory()) {
      result.push(...actualInventory(root, absolute));
    } else if (entry.isFile()) {
      result.push(path.relative(root, absolute).replaceAll("\\", "/"));
    } else {
      throw new Error("dataset inventory contains a non-file artifact");
    }
  }
  return result.sort();
}

function verifyFile(root, descriptor, label) {
  const absolute = safeDatasetPath(root, descriptor.path, label);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} does not resolve to a regular file`);
  }
  const bytes = readFileSync(absolute);
  if (
    bytes.length !== descriptor.byteLength ||
    sha256(bytes) !== descriptor.sha256
  ) {
    throw new Error(`${label} byte length or SHA-256 does not match`);
  }
  return bytes;
}

/**
 * Verify the complete immutable package inventory without spawning a backend.
 * Scientific validity remains the responsibility of the independent bakers;
 * this check binds every copied byte to the manifest/checksums inventory.
 */
export function inspectDatasetPackage(datasetRoot) {
  const root = path.resolve(datasetRoot);
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("dataset root is not a directory");
  }
  const directoryName = path.basename(root);
  if (!SHA256_PATTERN.test(directoryName)) {
    throw new Error("dataset directory is not content-addressed");
  }

  const manifestPath = path.join(root, "manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = readJsonObject(manifestBytes, "manifest.json");
  const expectedDatasetId = `sha256:${directoryName}`;
  if (
    manifest.datasetId !== expectedDatasetId ||
    manifest.contentAddressing?.directoryName !== directoryName
  ) {
    throw new Error("manifest dataset identity does not match its directory");
  }

  const descriptors = manifestDescriptors(manifest.files);
  const descriptorPaths = new Set();
  for (const descriptor of descriptors) {
    if (descriptorPaths.has(descriptor.path)) {
      throw new Error(`manifest repeats descriptor ${descriptor.path}`);
    }
    descriptorPaths.add(descriptor.path);
  }
  const checksumsDescriptor = descriptors.find(
    (descriptor) => descriptor.path === "checksums.json",
  );
  if (!checksumsDescriptor) {
    throw new Error("manifest does not bind checksums.json");
  }
  const checksumsBytes = verifyFile(
    root,
    checksumsDescriptor,
    "manifest checksums descriptor",
  );
  const checksums = readJsonObject(checksumsBytes, "checksums.json");
  if (
    checksums.schemaVersion !== "mandelhowl.checksums.v1" ||
    checksums.algorithm !== "sha256" ||
    !Array.isArray(checksums.files)
  ) {
    throw new Error("checksums.json contract is invalid");
  }

  const checksumRows = new Map();
  for (const [index, raw] of checksums.files.entries()) {
    const descriptor = requireDescriptor(
      raw,
      `checksums.files[${index}]`,
    );
    if (
      descriptor.path === "manifest.json" ||
      descriptor.path === "checksums.json" ||
      checksumRows.has(descriptor.path)
    ) {
      throw new Error(`checksums.json has an invalid duplicate ${descriptor.path}`);
    }
    verifyFile(root, descriptor, `checksums.files[${index}]`);
    checksumRows.set(descriptor.path, {
      path: descriptor.path,
      byteLength: descriptor.byteLength,
      sha256: descriptor.sha256,
    });
  }

  for (const descriptor of descriptors) {
    if (descriptor.path === "checksums.json") continue;
    const checksum = checksumRows.get(descriptor.path);
    if (
      checksum?.byteLength !== descriptor.byteLength ||
      checksum?.sha256 !== descriptor.sha256
    ) {
      throw new Error(
        `manifest descriptor ${descriptor.path} is not exactly bound by checksums.json`,
      );
    }
  }

  const expectedInventory = [
    "checksums.json",
    "manifest.json",
    ...checksumRows.keys(),
  ].sort();
  const inventory = actualInventory(root);
  if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
    throw new Error("dataset contains missing or untracked inventory entries");
  }

  const files = [...checksumRows.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const identity = {
    datasetId: expectedDatasetId,
    manifestSha256: sha256(manifestBytes),
    checksumsSha256: sha256(checksumsBytes),
    files,
  };
  return {
    ...identity,
    exactPackageFingerprintSha256: sha256(
      Buffer.from(JSON.stringify(identity), "utf8"),
    ),
  };
}

export function packagesAreExactlyIdentical(left, right) {
  return (
    left.datasetId === right.datasetId &&
    left.manifestSha256 === right.manifestSha256 &&
    left.checksumsSha256 === right.checksumsSha256 &&
    left.exactPackageFingerprintSha256 ===
      right.exactPackageFingerprintSha256
  );
}
