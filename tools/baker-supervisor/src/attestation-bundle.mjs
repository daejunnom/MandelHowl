import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import {
  inspectDatasetPackage,
  packagesAreExactlyIdentical,
} from "./package-integrity.mjs";
import { compareDatasetsSafely } from "./semantic-diff.mjs";

export const ATTESTATION_BUNDLE_SCHEMA =
  "mandelhowl.baker-attestation-bundle.v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertSafeBundleRoot(bundleRoot) {
  const root = path.resolve(bundleRoot);
  const parent = path.dirname(root);
  if (root === parent || path.basename(root).length === 0) {
    throw new Error("attestation bundle root is unsafe");
  }
  if (existsSync(root)) {
    throw new Error("attestation bundle root already exists");
  }
  mkdirSync(parent, { recursive: true });
  return root;
}

function candidateDescriptor(backend, source, bundleRoot) {
  const sourceIdentity = inspectDatasetPackage(source);
  const directoryName = sourceIdentity.datasetId.slice("sha256:".length);
  const relativePath = `candidates/${backend}/${directoryName}`;
  const destination = path.join(bundleRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const copiedIdentity = inspectDatasetPackage(destination);
  if (!packagesAreExactlyIdentical(sourceIdentity, copiedIdentity)) {
    throw new Error(
      `attestation bundle ${backend} candidate changed while copying`,
    );
  }
  return {
    relativePath,
    ...copiedIdentity,
  };
}

export function createAttestationBundle({
  bundleRoot,
  rustCandidate,
  pythonCandidate,
}) {
  const root = assertSafeBundleRoot(bundleRoot);
  mkdirSync(root);
  try {
    return {
      schemaVersion: ATTESTATION_BUNDLE_SCHEMA,
      reportRelativePath: "attestation.json",
      candidates: {
        rust: candidateDescriptor("rust", rustCandidate, root),
        python: candidateDescriptor("python", pythonCandidate, root),
      },
    };
  } catch (error) {
    // `root` was proven absent immediately before this function created it.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function assertPortableCandidatePath(relativePath, backend, directoryName) {
  const required = `candidates/${backend}/${directoryName}`;
  if (relativePath !== required) {
    throw new Error(
      `attestation bundle ${backend} candidate path must be ${required}`,
    );
  }
}

function assertContainedRealPath(root, candidate, label) {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const relation = path.relative(realRoot, realCandidate);
  if (
    relation === "" ||
    path.isAbsolute(relation) ||
    relation.startsWith("..")
  ) {
    throw new Error(`${label} escapes the attestation bundle`);
  }
  return realCandidate;
}

function assertIdentity(actual, expected, label) {
  const required = requireObject(expected, label);
  for (const key of [
    "datasetId",
    "manifestSha256",
    "checksumsSha256",
    "exactPackageFingerprintSha256",
  ]) {
    const expectedValue = required[key];
    if (
      typeof expectedValue !== "string" ||
      (key === "datasetId"
        ? !/^sha256:[a-f0-9]{64}$/.test(expectedValue)
        : !SHA256_PATTERN.test(expectedValue)) ||
      actual[key] !== expectedValue
    ) {
      throw new Error(`attestation bundle ${label}.${key} mismatch`);
    }
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function verifyAttestationBundle({
  reportPath,
  report,
  projectRoot,
}) {
  const reportAbsolute = path.resolve(reportPath);
  const bundleRoot = path.dirname(reportAbsolute);
  const reportMetadata = requireObject(
    report?.attestationBundle,
    "attestationBundle",
  );
  if (
    reportMetadata.schemaVersion !== ATTESTATION_BUNDLE_SCHEMA ||
    reportMetadata.reportRelativePath !== "attestation.json" ||
    path.basename(reportAbsolute) !== reportMetadata.reportRelativePath
  ) {
    throw new Error("Baker attestation bundle report contract is invalid");
  }
  const candidates = requireObject(
    reportMetadata.candidates,
    "attestationBundle.candidates",
  );
  const verified = {};
  for (const backend of ["rust", "python"]) {
    const descriptor = requireObject(
      candidates[backend],
      `attestationBundle.candidates.${backend}`,
    );
    const datasetId = descriptor.datasetId;
    if (
      typeof datasetId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(datasetId)
    ) {
      throw new Error(
        `attestation bundle ${backend} dataset identity is invalid`,
      );
    }
    const directoryName = datasetId.slice("sha256:".length);
    assertPortableCandidatePath(
      descriptor.relativePath,
      backend,
      directoryName,
    );
    const candidate = assertContainedRealPath(
      bundleRoot,
      path.resolve(
        bundleRoot,
        ...descriptor.relativePath.split("/"),
      ),
      `${backend} candidate`,
    );
    const identity = inspectDatasetPackage(candidate);
    assertIdentity(
      identity,
      descriptor,
      `attestationBundle.candidates.${backend}`,
    );
    const backendOutput = report?.backends?.[backend]?.output;
    if (
      backendOutput?.datasetId !== identity.datasetId ||
      backendOutput?.manifestSha256 !== identity.manifestSha256
    ) {
      throw new Error(
        `attestation bundle ${backend} candidate disagrees with the process report`,
      );
    }
    verified[backend] = { candidate, identity };
  }

  const comparison = compareDatasetsSafely({
    projectRoot,
    leftRoot: verified.rust.candidate,
    rightRoot: verified.python.candidate,
    expectedLeftGenerator: "tools/physics-baker-rs",
    expectedRightGenerator: "tools/physics-baker",
  });
  if (!comparison.equivalent || !sameJson(comparison, report.comparison)) {
    throw new Error(
      "Baker attestation bundle candidates do not reproduce the reported semantic comparison",
    );
  }
  return {
    rust: verified.rust.identity,
    python: verified.python.identity,
    comparison,
  };
}
