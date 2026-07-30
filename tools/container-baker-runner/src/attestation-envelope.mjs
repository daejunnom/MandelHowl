import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const TARGET_PLATFORM = "linux/amd64";
export const PINNED_BASE_IMAGES = Object.freeze([
  "node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90",
  "rust:1.96.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc",
]);
export const NATIVE_BAKER_PATH =
  "/opt/mandelhowl/bin/mandelhowl-baker-native";
export const SUPERVISOR_BUNDLE_DIRECTORY =
  "baker-nversion-attestation";
export const REPORT_NAME = "attestation.json";
export const RUNNER_ATTESTATION_NAME =
  "container-runner-attestation.json";
export const CONTAINER_ENVELOPE_NAME =
  "container-envelope-attestation.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(requireObject(value, label)).sort();
  const expected = [...keys].sort();
  if (!sameJson(actual, expected)) {
    throw new Error(`${label} fields are not the closed contract`);
  }
}

function readRegularJson(directory, name) {
  const filePath = path.join(directory, name);
  const relative = path.relative(directory, filePath);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`container attestation path escaped: ${name}`);
  }
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `container attestation artifact is not a regular file: ${name}`,
    );
  }
  const bytes = readFileSync(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `container attestation artifact is not JSON: ${name}: ${error.message}`,
    );
  }
  return { bytes, value };
}

export function verifyContainerAttestationEnvelope({
  reportPath,
  reportBytes,
  report,
  expectedManifest,
}) {
  const absoluteReportPath = path.resolve(reportPath);
  if (path.basename(absoluteReportPath) !== REPORT_NAME) {
    throw new Error(
      "container attestation report must use the canonical filename",
    );
  }
  const bundleRoot = path.dirname(absoluteReportPath);
  const runnerArtifact = readRegularJson(
    bundleRoot,
    RUNNER_ATTESTATION_NAME,
  );
  const envelopeArtifact = readRegularJson(
    bundleRoot,
    CONTAINER_ENVELOPE_NAME,
  );
  const runner = requireObject(
    runnerArtifact.value,
    "container runner attestation",
  );
  const envelope = requireObject(
    envelopeArtifact.value,
    "container envelope attestation",
  );
  const expectedReportBytes =
    reportBytes ?? readFileSync(absoluteReportPath);
  let reportFromBytes;
  try {
    reportFromBytes = JSON.parse(expectedReportBytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `container attestation report bytes are not JSON: ${error.message}`,
    );
  }
  if (!sameJson(reportFromBytes, requireObject(report, "supervisor report"))) {
    throw new Error(
      "container attestation report object does not match its bound bytes",
    );
  }
  assertExactKeys(
    envelope,
    [
      "schemaVersion",
      "releaseOnly",
      "artifacts",
      "imageId",
      "supervisorState",
      "releaseEligible",
    ],
    "container envelope attestation",
  );
  if (
    envelope.schemaVersion !==
      "mandelhowl.container-baker-attestation-bundle.v1" ||
    envelope.releaseOnly !== true ||
    envelope.supervisorState !== "dual-verified" ||
    envelope.releaseEligible !== true ||
    !IMAGE_ID_PATTERN.test(envelope.imageId ?? "") ||
    !sameJson(envelope.artifacts, [
      {
        path: REPORT_NAME,
        sha256: sha256(expectedReportBytes),
      },
      {
        path: RUNNER_ATTESTATION_NAME,
        sha256: sha256(runnerArtifact.bytes),
      },
    ])
  ) {
    throw new Error("container envelope attestation is invalid");
  }

  assertExactKeys(
    runner,
    [
      "schemaVersion",
      "releaseOnly",
      "executionSurface",
      "engine",
      "image",
      "isolation",
      "injectedEnvironment",
      "containerExitCode",
      "supervisorReport",
    ],
    "container runner attestation",
  );
  assertExactKeys(
    runner.engine,
    ["name", "serverVersion", "operatingSystem"],
    "container runner engine",
  );
  assertExactKeys(
    runner.image,
    ["id", "identitySource", "targetPlatform", "pinnedBaseImages"],
    "container runner image",
  );
  assertExactKeys(
    runner.isolation,
    [
      "network",
      "rootFilesystem",
      "capabilities",
      "noNewPrivileges",
      "sourceMount",
      "outputMount",
    ],
    "container runner isolation",
  );
  assertExactKeys(
    runner.injectedEnvironment,
    [
      "MANDELHOWL_CONTAINER_IMAGE_DIGEST",
      "MANDELHOWL_CONTAINER_RUNNER_ATTESTED",
      "MANDELHOWL_MANAGED_INSTALL",
      "MANDELHOWL_NATIVE_BAKER",
      "MANDELHOWL_PYTHON",
    ],
    "container runner injected environment",
  );
  assertExactKeys(
    runner.supervisorReport,
    [
      "path",
      "sha256",
      "state",
      "releaseEligible",
      "promotionAllowed",
    ],
    "container runner supervisor report",
  );
  if (
    runner.schemaVersion !==
      "mandelhowl.container-baker-runner-attestation.v1" ||
    runner.releaseOnly !== true ||
    runner.executionSurface !==
      "offline-release-only-oci-envelope-not-browser-runtime" ||
    !["docker", "podman"].includes(runner.engine.name) ||
    typeof runner.engine.serverVersion !== "string" ||
    runner.engine.serverVersion.length === 0 ||
    runner.engine.operatingSystem !== "linux" ||
    runner.image.id !== envelope.imageId ||
    runner.image.identitySource !==
      `${runner.engine.name} image inspect .Id` ||
    runner.image.targetPlatform !== TARGET_PLATFORM ||
    !sameJson(runner.image.pinnedBaseImages, PINNED_BASE_IMAGES) ||
    !sameJson(runner.isolation, {
      network: "none",
      rootFilesystem: "read-only",
      capabilities: "all-dropped",
      noNewPrivileges: true,
      sourceMount: "not-mounted-filtered-image-snapshot",
      outputMount: "read-write",
    }) ||
    !sameJson(runner.injectedEnvironment, {
      MANDELHOWL_CONTAINER_IMAGE_DIGEST: envelope.imageId,
      MANDELHOWL_CONTAINER_RUNNER_ATTESTED: "1",
      MANDELHOWL_MANAGED_INSTALL: "1",
      MANDELHOWL_NATIVE_BAKER: NATIVE_BAKER_PATH,
      MANDELHOWL_PYTHON: "/usr/bin/python3",
    }) ||
    runner.containerExitCode !== 0 ||
    !sameJson(runner.supervisorReport, {
      path: REPORT_NAME,
      sha256: sha256(expectedReportBytes),
      state: "dual-verified",
      releaseEligible: true,
      promotionAllowed: true,
    })
  ) {
    throw new Error("container runner attestation is invalid");
  }

  const solver = requireObject(
    expectedManifest?.solverProvenance,
    "pinned manifest solverProvenance",
  );
  if (
    solver.executionKind !== "oci-container" ||
    solver.containerImageDigest !== envelope.imageId ||
    report?.state !== "dual-verified" ||
    report?.releaseEligible !== true ||
    report?.promotionAllowed !== true
  ) {
    throw new Error(
      "pinned manifest and OCI attestation image identity disagree",
    );
  }
  return Object.freeze({
    schemaVersion: envelope.schemaVersion,
    imageId: envelope.imageId,
    targetPlatform: runner.image.targetPlatform,
    executionKind: solver.executionKind,
    runnerAttestationSha256: sha256(runnerArtifact.bytes),
    envelopeAttestationSha256: sha256(envelopeArtifact.bytes),
  });
}
