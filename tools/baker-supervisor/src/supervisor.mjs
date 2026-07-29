import {
  cpSync,
  existsSync,
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
import { decideNVersion } from "./policy.mjs";
import {
  inspectDatasetPackage,
  packagesAreExactlyIdentical,
} from "./package-integrity.mjs";
import { compareDatasetsSafely } from "./semantic-diff.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, "..", "..", "..");
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 30 * 60_000;

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
  let lock;
  try {
    lock = JSON.parse(
      readFileSync(path.join(root, "release", "dataset-lock.json"), "utf8"),
    );
  } catch (error) {
    return invalidLastKnownGood(
      "MH_BAKER_LKG_LOCK_INVALID",
      `unable to read release/dataset-lock.json: ${error.message}`,
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
  const { strict, timeoutMs, reportFile } = stripSupervisorOptions(args);
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
  const { backendArguments, strict, timeoutMs, reportFile } =
    stripSupervisorOptions(args);
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

function candidatePath(result, stagingRoot) {
  if (result.status !== "success") return null;
  const candidate = result.output?.datasetPath;
  if (typeof candidate !== "string") {
    result.status = "protocol-error";
    result.availabilityFailure = false;
    result.code = "MH_BAKER_DATASET_PATH_MISSING";
    return null;
  }
  const absolute = path.resolve(projectRoot, candidate);
  const relative = path.relative(stagingRoot, absolute);
  if (
    path.isAbsolute(relative) ||
    relative.startsWith("..") ||
    !existsSync(absolute)
  ) {
    result.status = "protocol-error";
    result.availabilityFailure = false;
    result.code = "MH_BAKER_DATASET_PATH_UNSAFE";
    return null;
  }
  return absolute;
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
    report = emit(
      "generate",
      rust,
      python,
      comparison,
      decision,
      {
        stagingRetained: parsed.keepStaging,
        stagingDirectory: parsed.keepStaging ? staging : null,
        lastKnownGoodPreserved: lkg.valid,
        lastKnownGood: publicLastKnownGood(lkg),
      },
      parsed.reportFile,
    );
    return exitFor(decision, strict);
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
