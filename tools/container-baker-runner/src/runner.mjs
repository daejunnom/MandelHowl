import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { verifyAttestationBundle } from "../../baker-supervisor/src/attestation-bundle.mjs";
import { pinnedDatasetDirectoryName } from "../../release-packager/src/pinned-attestation.mjs";
import {
  CONTAINER_ENVELOPE_NAME,
  IMAGE_ID_PATTERN,
  NATIVE_BAKER_PATH,
  PINNED_BASE_IMAGES,
  REPORT_NAME,
  RUNNER_ATTESTATION_NAME,
  SUPERVISOR_BUNDLE_DIRECTORY,
  TARGET_PLATFORM,
  verifyContainerAttestationEnvelope,
} from "./attestation-envelope.mjs";

export {
  IMAGE_ID_PATTERN,
  PINNED_BASE_IMAGES,
  TARGET_PLATFORM,
} from "./attestation-envelope.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_ROOT = path.resolve(
  sourceDirectory,
  "..",
  "..",
  "..",
);
export const DEFAULT_IMAGE_TAG = "mandelhowl-baker-release:local";
export const DEFAULT_OUTPUT_LEAF = "latest";
const IMAGE_TAG_PATTERN =
  /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-z0-9][a-z0-9._-]{0,127})?$/;
const OUTPUT_LEAF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_LEAF_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SUPERVISOR_TIMEOUT_MS = 2_400_000;
const HOST_TIMEOUT_MS = SUPERVISOR_TIMEOUT_MS + 120_000;

function diagnostic(code, message, evidence = {}) {
  const error = new Error(message);
  error.code = code;
  error.evidence = evidence;
  return error;
}

function assertEngine(value) {
  if (value !== "docker" && value !== "podman") {
    throw diagnostic(
      "MH_CONTAINER_ENGINE_INVALID",
      "--engine must be docker or podman",
    );
  }
  return value;
}

function assertImageTag(value) {
  if (!IMAGE_TAG_PATTERN.test(value) || value.includes("..")) {
    throw diagnostic(
      "MH_CONTAINER_IMAGE_TAG_INVALID",
      "image tag contains unsupported characters",
    );
  }
  return value;
}

function assertOutputLeaf(value) {
  if (
    !OUTPUT_LEAF_PATTERN.test(value) ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    WINDOWS_DEVICE_LEAF_PATTERN.test(value)
  ) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      "--output-dir must be one safe directory name, not a path",
    );
  }
  return value;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw diagnostic(
      "MH_CONTAINER_ARGUMENT_INVALID",
      `${label} requires a positive integer`,
    );
  }
  return parsed;
}

export function parseContainerRunnerArguments(arguments_) {
  const options = {
    command: "run",
    dryRun: false,
    engine: "docker",
    imageTag: DEFAULT_IMAGE_TAG,
    outputLeaf: DEFAULT_OUTPUT_LEAF,
    stageReleaseEvidence: false,
    timeoutMs: HOST_TIMEOUT_MS,
  };
  const values = [...arguments_];
  let doctorUnsupportedOption = null;
  if (values[0] === "run" || values[0] === "doctor") {
    options.command = values.shift();
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") {
      options.dryRun = true;
    } else if (value === "--stage-release-evidence") {
      doctorUnsupportedOption ??= value;
      options.stageReleaseEvidence = true;
    } else if (value === "--engine") {
      options.engine = assertEngine(values[index + 1]);
      index += 1;
    } else if (value === "--tag") {
      doctorUnsupportedOption ??= value;
      options.imageTag = assertImageTag(values[index + 1] ?? "");
      index += 1;
    } else if (value === "--output-dir") {
      doctorUnsupportedOption ??= value;
      options.outputLeaf = assertOutputLeaf(values[index + 1] ?? "");
      index += 1;
    } else if (value === "--timeout-ms") {
      doctorUnsupportedOption ??= value;
      options.timeoutMs = parsePositiveInteger(
        values[index + 1],
        "--timeout-ms",
      );
      index += 1;
    } else {
      throw diagnostic(
        "MH_CONTAINER_ARGUMENT_INVALID",
        `unsupported container runner argument: ${value}`,
      );
    }
  }
  if (options.command === "doctor" && options.dryRun) {
    throw diagnostic(
      "MH_CONTAINER_ARGUMENT_INVALID",
      "doctor is already read-only and does not accept --dry-run",
    );
  }
  if (
    options.command === "doctor" &&
    doctorUnsupportedOption !== null
  ) {
    throw diagnostic(
      "MH_CONTAINER_ARGUMENT_INVALID",
      `${doctorUnsupportedOption} is valid only for run`,
    );
  }
  return Object.freeze(options);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function rejectUnsafeMountPath(value, label) {
  if (/[\0\r\n,]/.test(value)) {
    throw diagnostic(
      "MH_CONTAINER_MOUNT_PATH_INVALID",
      `${label} contains a character unsupported by OCI bind mounts`,
    );
  }
}

function lstatIfPresent(value) {
  try {
    return lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function ensureContainedRealDirectory(directory, parent, label) {
  const existing = lstatIfPresent(directory);
  if (existing !== null) {
    const metadata = existing;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw diagnostic(
        "MH_CONTAINER_OUTPUT_PATH_INVALID",
        `${label} must be a real directory`,
      );
    }
  } else {
    mkdirSync(directory);
  }
  const canonical = realpathSync(directory);
  if (!isWithin(parent, canonical)) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      `${label} resolves outside its required parent`,
    );
  }
  return canonical;
}

export function resolveSafeOutputDirectory(
  projectRoot,
  outputLeaf,
  { create = false } = {},
) {
  assertOutputLeaf(outputLeaf);
  const root = path.resolve(projectRoot);
  const base = path.join(root, "work", "container-baker-runs");
  const output = path.join(base, outputLeaf);
  rejectUnsafeMountPath(root, "project root");
  rejectUnsafeMountPath(output, "output directory");
  if (!create) return output;

  const canonicalRoot = realpathSync(root);
  const canonicalWork = ensureContainedRealDirectory(
    path.join(root, "work"),
    canonicalRoot,
    "container output work directory",
  );
  const canonicalBase = ensureContainedRealDirectory(
    base,
    canonicalWork,
    "container output base",
  );
  return ensureContainedRealDirectory(
    output,
    canonicalBase,
    "container output",
  );
}

function numericContainerUser() {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return null;
  }
  const uid = process.getuid();
  const gid = process.getgid();
  return Number.isSafeInteger(uid) && Number.isSafeInteger(gid)
    ? `${uid}:${gid}`
    : null;
}

export function createContainerPlan({
  projectRoot = DEFAULT_PROJECT_ROOT,
  outputDirectory,
  engine = "docker",
  imageTag = DEFAULT_IMAGE_TAG,
  imageId = "<sha256-image-id-after-build>",
  containerUser = numericContainerUser(),
}) {
  assertEngine(engine);
  assertImageTag(imageTag);
  const root = path.resolve(projectRoot);
  const output = path.resolve(outputDirectory);
  const requiredOutputBase = path.join(
    root,
    "work",
    "container-baker-runs",
  );
  if (!isWithin(requiredOutputBase, output) || output === requiredOutputBase) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      "container output must remain below work/container-baker-runs",
    );
  }
  rejectUnsafeMountPath(root, "project root");
  rejectUnsafeMountPath(output, "output directory");
  if (
    imageId !== "<sha256-image-id-after-build>" &&
    !IMAGE_ID_PATTERN.test(imageId)
  ) {
    throw diagnostic(
      "MH_CONTAINER_IMAGE_ID_INVALID",
      "OCI image inspect did not return a sha256 image ID",
    );
  }
  const dockerfile = path.join(
    root,
    "tools",
    "container-baker-runner",
    "Dockerfile",
  );
  const buildArguments = Object.freeze([
    "build",
    "--pull",
    "--platform",
    TARGET_PLATFORM,
    "--file",
    dockerfile,
    "--tag",
    imageTag,
    "--label",
    "dev.mandelhowl.execution-surface=release-only-baker",
    root,
  ]);
  const inspectArguments = Object.freeze([
    "image",
    "inspect",
    ...(engine === "docker"
      ? ["--platform", TARGET_PLATFORM]
      : []),
    "--format",
    "{{.Os}}|{{.Architecture}}|{{.Id}}",
    imageTag,
  ]);
  const environment = Object.freeze({
    MANDELHOWL_CONTAINER_IMAGE_DIGEST: imageId,
    MANDELHOWL_CONTAINER_RUNNER_ATTESTED: "1",
    MANDELHOWL_MANAGED_INSTALL: "1",
    MANDELHOWL_NATIVE_BAKER: NATIVE_BAKER_PATH,
    MANDELHOWL_PYTHON: "/usr/bin/python3",
  });
  const runArguments = [
    "run",
    "--rm",
    "--platform",
    TARGET_PLATFORM,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=2147483648",
    "--mount",
    `type=bind,source=${output},target=/out`,
    "--workdir",
    "/workspace",
  ];
  if (containerUser) runArguments.push("--user", containerUser);
  for (const [name, value] of Object.entries(environment)) {
    runArguments.push("--env", `${name}=${value}`);
  }
  runArguments.push(
    imageTag,
    "node",
    "tools/baker-supervisor/src/supervisor.mjs",
    "generate",
    "--strict",
    "--release",
    "--coverage-report",
    "tests/runtime/fixtures/reachability-report.json",
    "--timeout-ms",
    String(SUPERVISOR_TIMEOUT_MS),
    "--output-root",
    "/out/datasets",
    "--attestation-bundle",
    `/out/${SUPERVISOR_BUNDLE_DIRECTORY}`,
    "--report-file",
    `/out/${SUPERVISOR_BUNDLE_DIRECTORY}/${REPORT_NAME}`,
  );
  return Object.freeze({
    schemaVersion: "mandelhowl.container-baker-plan.v1",
    releaseOnly: true,
    targetPlatform: TARGET_PLATFORM,
    pinnedBaseImages: PINNED_BASE_IMAGES,
    engine,
    imageTag,
    imageId,
    projectRoot: root,
    outputDirectory: output,
    environment,
    buildArguments,
    inspectArguments,
    runArguments: Object.freeze(runArguments),
  });
}

export function parseImageInspection(source) {
  const [os, architecture, imageId, ...extra] = source.trim().split("|");
  if (
    extra.length > 0 ||
    os !== "linux" ||
    architecture !== "amd64" ||
    !IMAGE_ID_PATTERN.test(imageId)
  ) {
    throw diagnostic(
      "MH_CONTAINER_IMAGE_ID_INVALID",
      "image inspection must return linux|amd64|sha256:<64 lowercase hex>",
      { output: source.trim().slice(0, 256) },
    );
  }
  return Object.freeze({ os, architecture, imageId });
}

function executeProcess({
  executable,
  arguments_,
  cwd,
  timeoutMs,
  spawn = spawnSync,
}) {
  const result = spawn(executable, arguments_, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stdout = result.stdout?.toString?.() ?? "";
  const stderr = result.stderr?.toString?.() ?? "";
  if (result.error?.code === "ENOENT") {
    throw diagnostic(
      "MH_CONTAINER_ENGINE_MISSING",
      `${executable} is not installed or not on PATH`,
    );
  }
  if (
    result.error?.code === "ETIMEDOUT" ||
    result.signal === "SIGTERM" ||
    result.signal === "SIGKILL"
  ) {
    throw diagnostic(
      "MH_CONTAINER_ENGINE_TIMEOUT",
      `${executable} did not finish within ${timeoutMs} ms`,
    );
  }
  if (result.error) {
    throw diagnostic(
      "MH_CONTAINER_ENGINE_FAILED",
      result.error.message,
    );
  }
  return Object.freeze({
    status: result.status ?? 1,
    stdout,
    stderr,
  });
}

function requireSuccess(result, code, operation) {
  if (result.status !== 0) {
    throw diagnostic(
      code,
      `${operation} failed with exit code ${result.status}`,
      {
        stderr: result.stderr.trim().slice(0, 4_096),
        stdout: result.stdout.trim().slice(0, 4_096),
      },
    );
  }
  return result;
}

export function diagnoseContainerEngine({
  engine = "docker",
  projectRoot = DEFAULT_PROJECT_ROOT,
  spawn = spawnSync,
}) {
  assertEngine(engine);
  try {
    const info = requireSuccess(
      executeProcess({
        executable: engine,
        arguments_: [
          "info",
          "--format",
          engine === "podman" ? "{{.Host.Os}}" : "{{.OSType}}",
        ],
        cwd: projectRoot,
        timeoutMs: 15_000,
        spawn,
      }),
      "MH_CONTAINER_ENGINE_UNAVAILABLE",
      `${engine} info`,
    );
    const operatingSystem = info.stdout.trim();
    if (operatingSystem !== "linux") {
      throw diagnostic(
        "MH_CONTAINER_ENGINE_NOT_LINUX",
        `${engine} is not using a Linux OCI engine`,
        { operatingSystem },
      );
    }
    const version = requireSuccess(
      executeProcess({
        executable: engine,
        arguments_: [
          "version",
          "--format",
          engine === "podman"
            ? "{{.Client.Version}}"
            : "{{.Server.Version}}",
        ],
        cwd: projectRoot,
        timeoutMs: 15_000,
        spawn,
      }),
      "MH_CONTAINER_ENGINE_UNAVAILABLE",
      `${engine} version`,
    ).stdout.trim();
    return Object.freeze({
      schemaVersion: "mandelhowl.container-baker-doctor.v1",
      available: true,
      engine,
      operatingSystem,
      serverVersion: version,
      releaseOnly: true,
    });
  } catch (error) {
    return Object.freeze({
      schemaVersion: "mandelhowl.container-baker-doctor.v1",
      available: false,
      engine,
      operatingSystem: null,
      serverVersion: null,
      releaseOnly: true,
      code: error.code ?? "MH_CONTAINER_ENGINE_UNAVAILABLE",
      message: error.message,
      evidence: error.evidence ?? {},
    });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readSupervisorReport(
  outputDirectory,
  projectRoot,
  { requireAttestationBundle = true } = {},
) {
  const reportPath = path.join(
    outputDirectory,
    SUPERVISOR_BUNDLE_DIRECTORY,
    REPORT_NAME,
  );
  const metadata = lstatSync(reportPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw diagnostic(
      "MH_CONTAINER_REPORT_INVALID",
      "supervisor report is not a regular file",
    );
  }
  const bytes = readFileSync(reportPath);
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw diagnostic(
      "MH_CONTAINER_REPORT_INVALID",
      `supervisor report is not valid JSON: ${error.message}`,
    );
  }
  if (
    report?.schemaVersion !==
      "mandelhowl.baker-supervisor-result.v1" ||
    report.command !== "generate"
  ) {
    throw diagnostic(
      "MH_CONTAINER_REPORT_INVALID",
      "supervisor report has an unsupported contract",
    );
  }
  if (requireAttestationBundle) {
    verifyAttestationBundle({
      reportPath,
      report,
      projectRoot,
    });
  }
  return { bytes, report, reportPath };
}

function writeJson(outputDirectory, name, value) {
  const destination = path.join(outputDirectory, name);
  if (!isWithin(outputDirectory, destination)) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      "attestation output escaped its bind-mounted directory",
    );
  }
  if (lstatIfPresent(destination) !== null) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      "attestation destination already exists",
    );
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(destination, bytes, { encoding: "utf8", flag: "wx" });
  return { bytes, destination };
}

function writeAttestationBundle({
  outputDirectory,
  plan,
  engineDoctor,
  containerExitCode,
  supervisor,
}) {
  const supervisorSha256 = sha256(supervisor.bytes);
  const runnerAttestation = Object.freeze({
    schemaVersion: "mandelhowl.container-baker-runner-attestation.v1",
    releaseOnly: true,
    executionSurface:
      "offline-release-only-oci-envelope-not-browser-runtime",
    engine: {
      name: plan.engine,
      serverVersion: engineDoctor.serverVersion,
      operatingSystem: engineDoctor.operatingSystem,
    },
    image: {
      id: plan.imageId,
      identitySource: `${plan.engine} image inspect .Id`,
      targetPlatform: plan.targetPlatform,
      pinnedBaseImages: plan.pinnedBaseImages,
    },
    isolation: {
      network: "none",
      rootFilesystem: "read-only",
      capabilities: "all-dropped",
      noNewPrivileges: true,
      sourceMount: "not-mounted-filtered-image-snapshot",
      outputMount: "read-write",
    },
    injectedEnvironment: {
      MANDELHOWL_CONTAINER_IMAGE_DIGEST: plan.imageId,
      MANDELHOWL_CONTAINER_RUNNER_ATTESTED: "1",
      MANDELHOWL_MANAGED_INSTALL: "1",
      MANDELHOWL_NATIVE_BAKER: NATIVE_BAKER_PATH,
      MANDELHOWL_PYTHON: "/usr/bin/python3",
    },
    containerExitCode,
    supervisorReport: {
      path: REPORT_NAME,
      sha256: supervisorSha256,
      state: supervisor.report.state ?? null,
      releaseEligible: supervisor.report.releaseEligible ?? false,
      promotionAllowed: supervisor.report.promotionAllowed ?? false,
    },
  });
  const supervisorBundleRoot = path.join(
    outputDirectory,
    SUPERVISOR_BUNDLE_DIRECTORY,
  );
  const runnerArtifact = writeJson(
    supervisorBundleRoot,
    RUNNER_ATTESTATION_NAME,
    runnerAttestation,
  );
  const bundle = Object.freeze({
    schemaVersion: "mandelhowl.container-baker-attestation-bundle.v1",
    releaseOnly: true,
    artifacts: Object.freeze([
      Object.freeze({
        path: REPORT_NAME,
        sha256: supervisorSha256,
      }),
      Object.freeze({
        path: RUNNER_ATTESTATION_NAME,
        sha256: sha256(runnerArtifact.bytes),
      }),
    ]),
    imageId: plan.imageId,
    supervisorState: supervisor.report.state ?? null,
    releaseEligible: supervisor.report.releaseEligible ?? false,
  });
  writeJson(supervisorBundleRoot, CONTAINER_ENVELOPE_NAME, bundle);
  return Object.freeze({ bundle, runnerAttestation });
}

function readRustCandidateManifest(bundleRoot, report) {
  const relativePath =
    report?.attestationBundle?.candidates?.rust?.relativePath;
  if (
    typeof relativePath !== "string" ||
    !relativePath.startsWith("candidates/rust/")
  ) {
    throw diagnostic(
      "MH_CONTAINER_REPORT_INVALID",
      "Rust candidate attestation path is missing",
    );
  }
  const manifestPath = path.resolve(
    bundleRoot,
    ...relativePath.split("/"),
    "manifest.json",
  );
  if (!isWithin(bundleRoot, manifestPath)) {
    throw diagnostic(
      "MH_CONTAINER_REPORT_INVALID",
      "Rust candidate manifest escaped the attestation bundle",
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function stageReleaseAttestationEvidence({
  projectRoot = DEFAULT_PROJECT_ROOT,
  outputDirectory,
  supervisor,
}) {
  const root = realpathSync(path.resolve(projectRoot));
  const requiredOutputBase = path.join(
    root,
    "work",
    "container-baker-runs",
  );
  const outputBaseMetadata = lstatIfPresent(requiredOutputBase);
  if (
    outputBaseMetadata === null ||
    !outputBaseMetadata.isDirectory() ||
    outputBaseMetadata.isSymbolicLink()
  ) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      "release evidence source must use work/container-baker-runs",
    );
  }
  const canonicalOutputBase = realpathSync(requiredOutputBase);
  if (!isWithin(root, canonicalOutputBase)) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      "release evidence output base resolves outside the project root",
    );
  }
  const canonicalOutput = realpathSync(path.resolve(outputDirectory));
  if (
    canonicalOutput === canonicalOutputBase ||
    !isWithin(canonicalOutputBase, canonicalOutput)
  ) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_PATH_INVALID",
      "release evidence source is outside work/container-baker-runs",
    );
  }
  const sourceBundle = path.join(
    canonicalOutput,
    SUPERVISOR_BUNDLE_DIRECTORY,
  );
  const sourceMetadata = lstatSync(sourceBundle);
  const canonicalSource = realpathSync(sourceBundle);
  if (
    !sourceMetadata.isDirectory() ||
    sourceMetadata.isSymbolicLink() ||
    !isWithin(canonicalOutput, canonicalSource)
  ) {
    throw diagnostic(
      "MH_CONTAINER_REPORT_INVALID",
      "container attestation source is not a contained real directory",
    );
  }
  const sourceManifest = readRustCandidateManifest(
    canonicalSource,
    supervisor.report,
  );
  verifyContainerAttestationEnvelope({
    reportPath: supervisor.reportPath,
    reportBytes: supervisor.bytes,
    report: supervisor.report,
    expectedManifest: sourceManifest,
  });

  const directoryName = pinnedDatasetDirectoryName(
    supervisor.report?.backends?.rust?.output?.datasetId,
  );
  const releaseRoot = ensureContainedRealDirectory(
    path.join(root, "release"),
    root,
    "release directory",
  );
  const attestationRoot = ensureContainedRealDirectory(
    path.join(releaseRoot, "attestations"),
    releaseRoot,
    "release attestation directory",
  );
  const destination = path.join(attestationRoot, directoryName);
  if (lstatIfPresent(destination) !== null) {
    throw diagnostic(
      "MH_CONTAINER_RELEASE_EVIDENCE_EXISTS",
      `committed release attestation already exists for ${directoryName}`,
    );
  }

  const stagingParent = mkdtempSync(
    path.join(attestationRoot, ".staging-"),
  );
  const stagingBundle = path.join(stagingParent, "bundle");
  try {
    cpSync(canonicalSource, stagingBundle, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
    const copiedReportPath = path.join(stagingBundle, REPORT_NAME);
    const copiedReportBytes = readFileSync(copiedReportPath);
    const copiedReport = JSON.parse(copiedReportBytes.toString("utf8"));
    verifyAttestationBundle({
      reportPath: copiedReportPath,
      report: copiedReport,
      projectRoot: root,
    });
    const copiedManifest = readRustCandidateManifest(
      stagingBundle,
      copiedReport,
    );
    const envelope = verifyContainerAttestationEnvelope({
      reportPath: copiedReportPath,
      reportBytes: copiedReportBytes,
      report: copiedReport,
      expectedManifest: copiedManifest,
    });
    if (
      copiedReport?.backends?.rust?.output?.datasetId !==
        `sha256:${directoryName}`
    ) {
      throw diagnostic(
        "MH_CONTAINER_REPORT_INVALID",
        "copied release attestation changed its Rust dataset identity",
      );
    }
    renameSync(stagingBundle, destination);
    return Object.freeze({
      schemaVersion:
        "mandelhowl.committed-oci-attestation-location.v1",
      datasetId: `sha256:${directoryName}`,
      relativeDirectory:
        `release/attestations/${directoryName}`,
      reportPath: path.join(destination, REPORT_NAME),
      imageId: envelope.imageId,
    });
  } finally {
    if (lstatIfPresent(stagingParent) !== null) {
      rmSync(stagingParent, { recursive: true, force: true });
    }
  }
}

export function runContainerBake({
  options,
  projectRoot = DEFAULT_PROJECT_ROOT,
  spawn = spawnSync,
}) {
  const outputDirectory = resolveSafeOutputDirectory(
    projectRoot,
    options.outputLeaf,
    { create: !options.dryRun },
  );
  if (!options.dryRun && readdirSync(outputDirectory).length !== 0) {
    throw diagnostic(
      "MH_CONTAINER_OUTPUT_NOT_FRESH",
      "the selected output directory must be empty",
      { outputDirectory },
    );
  }
  const pendingPlan = createContainerPlan({
    projectRoot,
    outputDirectory,
    engine: options.engine,
    imageTag: options.imageTag,
  });
  if (options.dryRun) {
    return Object.freeze({
      schemaVersion: "mandelhowl.container-baker-dry-run.v1",
      executed: false,
      releaseOnly: true,
      note:
        "No engine command ran; the image ID environment is resolved only after a successful build and inspect.",
      plan: pendingPlan,
    });
  }

  const engineDoctor = diagnoseContainerEngine({
    engine: options.engine,
    projectRoot,
    spawn,
  });
  if (!engineDoctor.available) {
    throw diagnostic(
      engineDoctor.code,
      engineDoctor.message,
      engineDoctor.evidence,
    );
  }
  requireSuccess(
    executeProcess({
      executable: options.engine,
      arguments_: pendingPlan.buildArguments,
      cwd: projectRoot,
      timeoutMs: options.timeoutMs,
      spawn,
    }),
    "MH_CONTAINER_IMAGE_BUILD_FAILED",
    "OCI image build",
  );
  const inspection = parseImageInspection(
    requireSuccess(
      executeProcess({
        executable: options.engine,
        arguments_: pendingPlan.inspectArguments,
        cwd: projectRoot,
        timeoutMs: 30_000,
        spawn,
      }),
      "MH_CONTAINER_IMAGE_INSPECT_FAILED",
      "OCI image inspect",
    ).stdout,
  );
  const plan = createContainerPlan({
    projectRoot,
    outputDirectory,
    engine: options.engine,
    imageTag: options.imageTag,
    imageId: inspection.imageId,
  });
  const containerResult = executeProcess({
    executable: options.engine,
    arguments_: plan.runArguments,
    cwd: projectRoot,
    timeoutMs: options.timeoutMs,
    spawn,
  });
  let supervisor;
  try {
    supervisor = readSupervisorReport(outputDirectory, projectRoot, {
      requireAttestationBundle: containerResult.status === 0,
    });
  } catch (error) {
    throw diagnostic(
      error?.code === "ENOENT"
        ? "MH_CONTAINER_REPORT_MISSING"
        : "MH_CONTAINER_REPORT_INVALID",
      `container did not leave a verifiable supervisor report: ${error.message}`,
      {
        containerExitCode: containerResult.status,
        stderr: containerResult.stderr.trim().slice(0, 4_096),
      },
    );
  }
  if (containerResult.status !== 0) {
    throw diagnostic(
      "MH_CONTAINER_BAKE_FAILED",
      `strict container bake failed with exit code ${containerResult.status}`,
      {
        outputDirectory,
        report: path.join(
          outputDirectory,
          SUPERVISOR_BUNDLE_DIRECTORY,
          REPORT_NAME,
        ),
        state: supervisor.report.state ?? null,
        rustStatus: supervisor.report.backends?.rust?.status ?? null,
        pythonStatus:
          supervisor.report.backends?.python?.status ?? null,
        attestationBundleDiagnostic:
          supervisor.report.attestationBundleDiagnostic ?? null,
        stderr: containerResult.stderr.trim().slice(0, 4_096),
      },
    );
  }
  const attestation = writeAttestationBundle({
    outputDirectory,
    plan,
    engineDoctor,
    containerExitCode: containerResult.status,
    supervisor,
  });
  if (
    supervisor.report.state !== "dual-verified" ||
    supervisor.report.releaseEligible !== true
  ) {
    throw diagnostic(
      "MH_CONTAINER_ATTESTATION_NOT_RELEASE_ELIGIBLE",
      "strict supervisor report is not dual-verified and release-eligible",
      {
        state: supervisor.report.state ?? null,
        releaseEligible: supervisor.report.releaseEligible ?? false,
      },
    );
  }
  const committedReleaseEvidence = options.stageReleaseEvidence
    ? stageReleaseAttestationEvidence({
        projectRoot,
        outputDirectory,
        supervisor,
      })
    : null;
  return Object.freeze({
    schemaVersion: "mandelhowl.container-baker-run-result.v1",
    executed: true,
    releaseOnly: true,
    imageId: plan.imageId,
    outputDirectory,
    reportPath: path.join(
      outputDirectory,
      SUPERVISOR_BUNDLE_DIRECTORY,
      REPORT_NAME,
    ),
    runnerAttestationPath: path.join(
      outputDirectory,
      SUPERVISOR_BUNDLE_DIRECTORY,
      RUNNER_ATTESTATION_NAME,
    ),
    bundlePath: path.join(
      outputDirectory,
      SUPERVISOR_BUNDLE_DIRECTORY,
      CONTAINER_ENVELOPE_NAME,
    ),
    state: supervisor.report.state,
    releaseEligible: supervisor.report.releaseEligible,
    attestation: attestation.bundle,
    committedReleaseEvidence,
  });
}

export function runContainerRunnerCli(
  arguments_ = process.argv.slice(2),
  dependencies = {},
) {
  try {
    const options = parseContainerRunnerArguments(arguments_);
    const result =
      options.command === "doctor"
        ? diagnoseContainerEngine({
            engine: options.engine,
            projectRoot:
              dependencies.projectRoot ?? DEFAULT_PROJECT_ROOT,
            spawn: dependencies.spawn ?? spawnSync,
          })
        : runContainerBake({
            options,
            projectRoot:
              dependencies.projectRoot ?? DEFAULT_PROJECT_ROOT,
            spawn: dependencies.spawn ?? spawnSync,
          });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.available === false ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          schemaVersion: "mandelhowl.container-baker-diagnostic.v1",
          status: "failed",
          code: error.code ?? "MH_CONTAINER_RUNNER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          evidence: error.evidence ?? {},
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runContainerRunnerCli();
}
