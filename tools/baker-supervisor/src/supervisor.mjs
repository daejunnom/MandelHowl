import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  publicBackendResult,
  runPythonBackend,
  runRustBackend,
} from "./backend-process.mjs";
import { createAttestationBundle } from "./attestation-bundle.mjs";
import { decideNVersion } from "./policy.mjs";
import {
  inspectDatasetPackage,
  packagesAreExactlyIdentical,
} from "./package-integrity.mjs";
import { compareDatasetsSafely } from "./semantic-diff.mjs";
import { collectBakerSourceTree } from "./source-tree.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, "..", "..", "..");
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 30 * 60_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} requires a positive integer`);
  }
  return parsed;
}

function stripSupervisorOptions(arguments_) {
  const backendArguments = [];
  let strict = false;
  let keepStaging = false;
  let timeoutMs = null;
  let reportFile = null;
  let attestationBundle = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === "--strict" || value === "--require-rust") {
      strict = true;
    } else if (value === "--keep-staging") {
      keepStaging = true;
    } else if (value === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(
        arguments_[index + 1],
        "--timeout-ms",
      );
      index += 1;
    } else if (value === "--report-file") {
      if (index + 1 >= arguments_.length) {
        throw new Error("--report-file requires a path");
      }
      reportFile = arguments_[index + 1];
      index += 1;
    } else if (value === "--attestation-bundle") {
      if (index + 1 >= arguments_.length) {
        throw new Error("--attestation-bundle requires a path");
      }
      attestationBundle = arguments_[index + 1];
      index += 1;
    } else {
      backendArguments.push(value);
    }
  }
  return {
    backendArguments,
    strict,
    keepStaging,
    timeoutMs,
    reportFile,
    attestationBundle,
  };
}

function takeOption(arguments_, name, fallback) {
  const output = [];
  let selected = fallback;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === name) {
      if (index + 1 >= arguments_.length) {
        throw new Error(`${name} requires a value`);
      }
      selected = arguments_[index + 1];
      index += 1;
    } else {
      output.push(arguments_[index]);
    }
  }
  return { arguments: output, value: selected };
}

function invalidLastKnownGood(code, reason, lock = {}) {
  return {
    ...lock,
    valid: false,
    code,
    reason,
    absolute: null,
  };
}

export function loadLastKnownGood(root = projectRoot) {
  let lockBytes;
  try {
    lockBytes = readFileSync(
      path.join(root, "release", "dataset-lock.json"),
    );
  } catch (error) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_LOCK_INVALID",
      `unable to read release/dataset-lock.json: ${error.message}`,
    );
  }
  const lockSha256 = sha256(lockBytes);
  let lock;
  try {
    lock = {
      ...JSON.parse(lockBytes.toString("utf8")),
      lockSha256,
    };
  } catch (error) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_LOCK_INVALID",
      `unable to parse release/dataset-lock.json: ${error.message}`,
      { lockSha256 },
    );
  }
  if (
    lock?.schemaVersion !== "mandelhowl.dataset-lock.v1" ||
    typeof lock.datasetDirectory !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(lock.datasetId ?? "") ||
    !/^[a-f0-9]{64}$/.test(lock.manifestSha256 ?? "")
  ) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_LOCK_INVALID",
      "release/dataset-lock.json has an invalid schema or identity",
      lock,
    );
  }
  const expectedDirectory = lock.datasetId.slice("sha256:".length);
  const absolute = path.resolve(root, lock.datasetDirectory);
  const generatedRoot = path.join(root, "assets", "generated");
  const relative = path.relative(generatedRoot, absolute);
  if (
    path.isAbsolute(relative) ||
    relative.startsWith("..") ||
    relative !== expectedDirectory
  ) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_PATH_INVALID",
      "last-known-good directory is outside assets/generated or disagrees with datasetId",
      lock,
    );
  }
  let canonicalDataset;
  try {
    const canonicalGeneratedRoot = realpathSync(generatedRoot);
    canonicalDataset = realpathSync(absolute);
    const canonicalRelative = path.relative(
      canonicalGeneratedRoot,
      canonicalDataset,
    );
    if (
      path.isAbsolute(canonicalRelative) ||
      canonicalRelative.startsWith("..") ||
      canonicalRelative !== expectedDirectory
    ) {
      return invalidLastKnownGood(
        "MH_BAKER_LKG_PATH_INVALID",
        "last-known-good directory resolves outside assets/generated",
        lock,
      );
    }
  } catch (error) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_DATASET_MISSING",
      `last-known-good dataset directory is unavailable: ${error.message}`,
      lock,
    );
  }

  let packageIdentity;
  try {
    packageIdentity = inspectDatasetPackage(canonicalDataset);
  } catch (error) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_PACKAGE_INVALID",
      `last-known-good package integrity failed: ${error.message}`,
      lock,
    );
  }
  if (
    packageIdentity.datasetId !== lock.datasetId ||
    packageIdentity.manifestSha256 !== lock.manifestSha256
  ) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_LOCK_MISMATCH",
      "last-known-good manifest bytes or dataset ID disagree with the release lock",
      lock,
    );
  }
  const semanticCheck = compareDatasetsSafely({
    projectRoot: root,
    leftRoot: canonicalDataset,
    rightRoot: canonicalDataset,
  });
  if (!semanticCheck.equivalent) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_SEMANTIC_INVALID",
      "last-known-good dataset failed the in-process semantic self-check",
      lock,
    );
  }
  return {
    ...lock,
    valid: true,
    code: "MH_BAKER_LKG_VERIFIED",
    reason: "release lock, exact package inventory, and semantic self-check agree",
    absolute: canonicalDataset,
    exactPackageFingerprintSha256:
      packageIdentity.exactPackageFingerprintSha256,
  };
}

function publicLastKnownGood(lkg) {
  return {
    valid: lkg.valid,
    code: lkg.code,
    reason: lkg.reason,
    datasetId: lkg.datasetId ?? null,
    datasetDirectory: lkg.datasetDirectory ?? null,
    lockSha256: lkg.lockSha256 ?? null,
    manifestSha256: lkg.manifestSha256 ?? null,
    exactPackageFingerprintSha256:
      lkg.exactPackageFingerprintSha256 ?? null,
  };
}

export function applyStrictGenerationPolicy(decision, lkg, strict) {
  if (
    !strict ||
    decision.state === "dual-verified" ||
    decision.selectedSource === "last-known-good"
  ) {
    return decision;
  }
  return {
    ...decision,
    selectedSource: lkg.valid ? "last-known-good" : null,
    selectedDataset: lkg.valid ? lkg.absolute : null,
    failOperational: lkg.valid,
    reason: `${decision.reason}; strict mode refused the unverified staged candidate`,
  };
}

function backendComparison(rust, python) {
  if (rust.status !== "success" || python.status !== "success") {
    return null;
  }
  const rustRevision = rust.output?.algorithmRevision;
  const pythonRevision = python.output?.algorithmRevision;
  const rustDigest = rust.output?.algorithmContractSha256;
  const pythonDigest = python.output?.algorithmContractSha256;
  const validDigest = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  return {
    equivalent:
      typeof rustRevision === "string" &&
      rustRevision === pythonRevision &&
      validDigest(rustDigest) &&
      validDigest(pythonDigest) &&
      rustDigest === pythonDigest,
    rustRevision,
    pythonRevision,
    rustDigest,
    pythonDigest,
  };
}

function emit(
  command,
  rust,
  python,
  comparison,
  decision,
  extra = {},
  reportFile = null,
) {
  const report = {
    schemaVersion: "mandelhowl.baker-supervisor-result.v1",
    command,
    state: decision.state,
    failOperational: decision.failOperational,
    degraded: decision.degraded,
    splitBrain: decision.splitBrain,
    promotionAllowed: decision.promotionAllowed,
    releaseEligible: decision.releaseEligible,
    selectedSource: decision.selectedSource,
    selectedDataset: decision.selectedDataset,
    reason: decision.reason,
    backends: {
      rust: publicBackendResult(rust),
      python: publicBackendResult(python),
    },
    comparison,
    ...extra,
  };
  if (reportFile) {
    const destination = path.resolve(projectRoot, reportFile);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function exitFor(decision, strict) {
  if (decision.splitBrain) return 2;
  if (decision.state === "unavailable") return 1;
  if (!decision.failOperational) return 1;
  if (strict && decision.state !== "dual-verified") return 1;
  return 0;
}

function capabilityCommand(command, args) {
  const {
    strict,
    timeoutMs,
    reportFile,
    attestationBundle,
  } = stripSupervisorOptions(args);
  if (attestationBundle !== null) {
    throw new Error("--attestation-bundle is valid only for generate");
  }
  const timeout = timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const rust = runRustBackend({
    projectRoot,
    args: [command],
    timeoutMs: timeout,
  });
  const python = runPythonBackend({
    projectRoot,
    args: [command],
    timeoutMs: timeout,
  });
  const comparison = backendComparison(rust, python);
  const lkg = loadLastKnownGood();
  const decision = decideNVersion({
    rust,
    python,
    comparison,
    lastKnownGoodDataset: lkg.valid ? lkg.absolute : null,
  });
  emit(
    command,
    rust,
    python,
    comparison,
    decision,
    { lastKnownGood: publicLastKnownGood(lkg) },
    reportFile,
  );
  return exitFor(decision, strict);
}

function validateCommand(args) {
  const {
    backendArguments,
    strict,
    timeoutMs,
    reportFile,
    attestationBundle,
  } = stripSupervisorOptions(args);
  if (attestationBundle !== null) {
    throw new Error("--attestation-bundle is valid only for generate");
  }
  const lkg = loadLastKnownGood();
  if (backendArguments.length > 1) {
    throw new Error("validate accepts at most one dataset directory");
  }
  const requestedDataset = backendArguments[0] ?? lkg.datasetDirectory;
  if (typeof requestedDataset !== "string") {
    throw new Error(
      "validate requires a dataset because last-known-good is unavailable",
    );
  }
  const dataset = path.resolve(projectRoot, requestedDataset);
  const timeout = timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const rust = runRustBackend({
    projectRoot,
    args: ["validate", dataset],
    timeoutMs: timeout,
  });
  const python = runPythonBackend({
    projectRoot,
    args: ["validate", dataset],
    timeoutMs: timeout,
  });
  let comparison = null;
  if (rust.status === "success" && python.status === "success") {
    comparison = compareDatasetsSafely({
      projectRoot,
      leftRoot: dataset,
      rightRoot: dataset,
    });
  }
  const decision = decideNVersion({
    rust,
    python,
    comparison,
    rustCandidate: dataset,
    pythonCandidate: dataset,
    lastKnownGoodDataset: lkg.valid ? lkg.absolute : null,
  });
  emit(
    "validate",
    rust,
    python,
    comparison,
    decision,
    {
      requestedDataset: dataset,
      lastKnownGood: publicLastKnownGood(lkg),
    },
    reportFile,
  );
  return exitFor(decision, strict);
}

export function normalizeBackendDatasetPath(
  candidate,
  platform = process.platform,
) {
  if (platform !== "win32") return candidate;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(candidate)) {
    return candidate.slice(4);
  }
  if (candidate.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${candidate.slice(8)}`;
  }
  return candidate;
}

export function candidatePath(result, stagingRoot) {
  if (result.status !== "success") return null;
  const candidate = result.output?.datasetPath;
  if (typeof candidate !== "string") {
    result.status = "protocol-error";
    result.availabilityFailure = false;
    result.code = "MH_BAKER_DATASET_PATH_MISSING";
    return null;
  }
  const absolute = path.resolve(
    projectRoot,
    normalizeBackendDatasetPath(candidate),
  );
  const stagingAbsolute = path.resolve(stagingRoot);
  const relative = path.relative(stagingAbsolute, absolute);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.startsWith("..") ||
    !existsSync(absolute)
  ) {
    result.status = "protocol-error";
    result.availabilityFailure = false;
    result.code = "MH_BAKER_DATASET_PATH_UNSAFE";
    return null;
  }
  let canonicalCandidate;
  try {
    const metadata = lstatSync(absolute);
    const canonicalStaging = realpathSync(stagingAbsolute);
    canonicalCandidate = realpathSync(absolute);
    const canonicalRelative = path.relative(
      canonicalStaging,
      canonicalCandidate,
    );
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      canonicalRelative === "" ||
      path.isAbsolute(canonicalRelative) ||
      canonicalRelative.startsWith("..")
    ) {
      throw new Error("candidate does not resolve to a contained directory");
    }
  } catch {
    result.status = "protocol-error";
    result.availabilityFailure = false;
    result.scientificFailure = true;
    result.code = "MH_BAKER_DATASET_PATH_UNSAFE";
    result.error =
      "backend dataset path did not resolve to a contained real directory";
    return null;
  }
  try {
    const identity = inspectDatasetPackage(canonicalCandidate);
    if (
      result.output?.datasetId !== identity.datasetId ||
      result.output?.manifestSha256 !== identity.manifestSha256
    ) {
      throw new Error("backend output identity disagrees with its package");
    }
  } catch {
    result.status = "protocol-error";
    result.availabilityFailure = false;
    result.scientificFailure = true;
    result.code = "MH_BAKER_DATASET_PACKAGE_INVALID";
    result.error =
      "backend candidate failed exact package inventory or identity validation";
    return null;
  }
  return canonicalCandidate;
}

export function installCandidate(source, requestedOutputRoot) {
  const directoryName = path.basename(source);
  if (!/^[a-f0-9]{64}$/.test(directoryName)) {
    throw new Error("selected dataset is not content-addressed");
  }
  const outputRoot = path.resolve(projectRoot, requestedOutputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const destination = path.join(outputRoot, directoryName);
  const sourceIdentity = inspectDatasetPackage(source);
  if (existsSync(destination)) {
    const destinationIdentity = inspectDatasetPackage(destination);
    if (!packagesAreExactlyIdentical(sourceIdentity, destinationIdentity)) {
      throw new Error(
        "existing content-addressed destination differs in exact manifest/checksum identity",
      );
    }
    return destination;
  }
  const installStaging = mkdtempSync(
    path.join(outputRoot, `.${directoryName}.install-`),
  );
  const stagedCandidate = path.join(installStaging, directoryName);
  try {
    cpSync(source, stagedCandidate, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const stagedIdentity = inspectDatasetPackage(stagedCandidate);
    if (!packagesAreExactlyIdentical(sourceIdentity, stagedIdentity)) {
      throw new Error(
        "staged dataset copy differs in exact manifest/checksum identity",
      );
    }
    renameSync(stagedCandidate, destination);
    return destination;
  } catch (error) {
    if (existsSync(destination)) {
      const destinationIdentity = inspectDatasetPackage(destination);
      if (packagesAreExactlyIdentical(sourceIdentity, destinationIdentity)) {
        return destination;
      }
    }
    throw error;
  } finally {
    rmSync(installStaging, { recursive: true, force: true });
  }
}

function generateCommand(args) {
  const parsed = stripSupervisorOptions(args);
  const outputOption = takeOption(
    parsed.backendArguments,
    "--output-root",
    path.join("assets", "generated"),
  );
  const backendArguments = outputOption.arguments;
  const release = backendArguments.includes("--release");
  const strict = parsed.strict || release;
  const timeout = parsed.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const lkg = loadLastKnownGood();
  const sourceTreeBefore = collectBakerSourceTree(projectRoot);
  const attestationBundleRoot =
    parsed.attestationBundle === null
      ? null
      : path.resolve(projectRoot, parsed.attestationBundle);
  const attestationReportFile =
    attestationBundleRoot === null
      ? parsed.reportFile
      : path.join(attestationBundleRoot, "attestation.json");
  if (
    attestationBundleRoot !== null &&
    parsed.reportFile !== null &&
    path.resolve(projectRoot, parsed.reportFile) !== attestationReportFile
  ) {
    throw new Error(
      "--report-file must name <attestation-bundle>/attestation.json",
    );
  }
  const staging = mkdtempSync(path.join(tmpdir(), "mandelhowl-nversion-"));
  const rustOutput = path.join(staging, "rust");
  const pythonOutput = path.join(staging, "python");
  let report;
  try {
    const rust = runRustBackend({
      projectRoot,
      args: [
        "generate",
        ...backendArguments,
        "--output-root",
        rustOutput,
      ],
      timeoutMs: timeout,
    });
    const python = runPythonBackend({
      projectRoot,
      args: [
        "generate",
        ...backendArguments,
        "--output-root",
        pythonOutput,
      ],
      timeoutMs: timeout,
    });
    const rustCandidate = candidatePath(rust, rustOutput);
    const pythonCandidate = candidatePath(python, pythonOutput);
    let comparison = null;
    if (
      rust.status === "success" &&
      python.status === "success" &&
      rustCandidate &&
      pythonCandidate
    ) {
      comparison = compareDatasetsSafely({
        projectRoot,
        leftRoot: rustCandidate,
        rightRoot: pythonCandidate,
        expectedLeftGenerator: "tools/physics-baker-rs",
        expectedRightGenerator: "tools/physics-baker",
      });
    }
    const sourceTreeAfter = collectBakerSourceTree(projectRoot);
    if (
      sourceTreeAfter.sourceTreeSha256 !==
        sourceTreeBefore.sourceTreeSha256 ||
      sourceTreeAfter.sourceTreeFileCount !==
        sourceTreeBefore.sourceTreeFileCount ||
      JSON.stringify(sourceTreeAfter.excludedPaths) !==
        JSON.stringify(sourceTreeBefore.excludedPaths)
    ) {
      throw new Error(
        "Baker N-version source tree changed during generation; candidate attestation was refused.",
      );
    }
    let decision = decideNVersion({
      rust,
      python,
      comparison,
      rustCandidate,
      pythonCandidate,
      lastKnownGoodDataset: lkg.valid ? lkg.absolute : null,
    });
    decision = applyStrictGenerationPolicy(decision, lkg, strict);
    if (
      decision.selectedSource !== "last-known-good" &&
      decision.selectedDataset &&
      !(strict && decision.state !== "dual-verified")
    ) {
      const installed = installCandidate(
        decision.selectedDataset,
        outputOption.value,
      );
      decision = { ...decision, selectedDataset: installed };
    }
    let attestationBundle = null;
    let attestationBundleDiagnostic = null;
    if (attestationBundleRoot !== null) {
      if (
        decision.state !== "dual-verified" ||
        !comparison?.equivalent ||
        rustCandidate === null ||
        pythonCandidate === null
      ) {
        attestationBundleDiagnostic = {
          code: "MH_BAKER_ATTESTATION_DUAL_REQUIRED",
          message:
            "attestation bundle requires two valid, semantically equivalent candidates",
          state: decision.state,
          rustStatus: rust.status,
          pythonStatus: python.status,
          comparisonEquivalent: comparison?.equivalent ?? false,
        };
      } else {
        attestationBundle = createAttestationBundle({
          bundleRoot: attestationBundleRoot,
          rustCandidate,
          pythonCandidate,
        });
      }
    }
    report = emit(
      "generate",
      rust,
      python,
      comparison,
      decision,
      {
        stagingRetained: parsed.keepStaging,
        stagingDirectory: parsed.keepStaging ? staging : null,
        sourceTreeSha256: sourceTreeAfter.sourceTreeSha256,
        sourceTreeFileCount: sourceTreeAfter.sourceTreeFileCount,
        sourceTreeDigestAlgorithm: sourceTreeAfter.digestAlgorithm,
        sourceTreeRoots: sourceTreeAfter.roots,
        sourceTreeExcludedPaths: sourceTreeAfter.excludedPaths,
        lastKnownGoodPreserved: lkg.valid,
        lastKnownGood: publicLastKnownGood(lkg),
        priorLastKnownGood: publicLastKnownGood(lkg),
        attestationBundle,
        attestationBundleDiagnostic,
      },
      attestationReportFile,
    );
    const decisionExitCode = exitFor(decision, strict);
    return attestationBundleDiagnostic !== null && decisionExitCode === 0
      ? 1
      : decisionExitCode;
  } finally {
    if (!parsed.keepStaging) {
      // `staging` is an explicit directory returned by mkdtempSync above.
      rmSync(staging, { recursive: true, force: true });
    }
    void report;
  }
}

function compareCommand(args) {
  const parsed = stripSupervisorOptions(args);
  if (parsed.attestationBundle !== null) {
    throw new Error("--attestation-bundle is valid only for generate");
  }
  if (parsed.backendArguments.length !== 2) {
    throw new Error("compare requires left and right dataset directories");
  }
  const comparison = compareDatasetsSafely({
    projectRoot,
    leftRoot: path.resolve(projectRoot, parsed.backendArguments[0]),
    rightRoot: path.resolve(projectRoot, parsed.backendArguments[1]),
  });
  if (parsed.reportFile) {
    const destination = path.resolve(projectRoot, parsed.reportFile);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(comparison, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  return comparison.equivalent ? 0 : 2;
}

function main(arguments_) {
  const [command, ...args] = arguments_;
  switch (command) {
    case "contract":
    case "self-test":
      return capabilityCommand(command, args);
    case "validate":
      return validateCommand(args);
    case "generate":
      return generateCommand(args);
    case "compare":
      return compareCommand(args);
    default:
      throw new Error(
        "usage: supervisor.mjs <contract|self-test|validate|generate|compare>",
      );
  }
}

export function runSupervisorCli(arguments_ = process.argv.slice(2)) {
  try {
    return main(arguments_);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          schemaVersion: "mandelhowl.baker-supervisor-diagnostic.v1",
          status: "failed",
          code: "MH_BAKER_SUPERVISOR_FAILED",
          message: error instanceof Error ? error.message : String(error),
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
  process.exitCode = runSupervisorCli();
}
