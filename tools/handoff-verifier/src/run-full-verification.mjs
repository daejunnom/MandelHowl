import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  HandoffVerificationError,
  verifyReleaseBlockingAssertions,
} from "./verification-core.mjs";
import {
  DELEGATED_NATIVE_EVIDENCE,
  TEST_RUNNER_POLICY_PATHS,
  WINDOWS_EVIDENCE_ONLY_ENVIRONMENT_VARIABLE,
  WINDOWS_NATIVE_PROHIBITED_SCRIPTS,
  bindAcceptanceSuitesToStages,
  bindExactTestAnchorsToStages,
  collectWholeHandoffClaims,
  createFullVerificationStages,
  verifyTestRunnerPolicy,
} from "./full-verification-plan.mjs";
import { resolvePinnedAttestation } from "../../release-packager/src/pinned-attestation.mjs";

function usageError(message) {
  throw new Error(
    `${message}\nUsage: npm run handoff:verify -- [--allow-dirty] [--no-archive] [--report <path>]`,
  );
}

function parseArguments(arguments_) {
  const options = {
    allowDirty: false,
    archive: true,
    report: null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-dirty") {
      options.allowDirty = true;
    } else if (argument === "--no-archive") {
      options.archive = false;
    } else if (argument === "--report") {
      if (options.report !== null || index + 1 >= arguments_.length) {
        usageError("--report requires exactly one path");
      }
      options.report = arguments_[index + 1];
      index += 1;
    } else {
      usageError(`unknown option ${argument}`);
    }
  }
  return options;
}

function writeReport(reportPath, report) {
  if (reportPath === null) {
    return;
  }
  const absoluteReportPath = path.resolve(reportPath);
  mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
  writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(...arguments_) {
  return execFileSync("git", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

const options = parseArguments(process.argv.slice(2));
const datasetLock = JSON.parse(
  readFileSync(path.resolve("release", "dataset-lock.json"), "utf8"),
);
const pinnedAttestation = resolvePinnedAttestation({
  projectRoot: process.cwd(),
  lock: datasetLock,
});
const attestationPath = pinnedAttestation.reportPath;
if (!existsSync(attestationPath)) {
  usageError(
    `committed pinned OCI attestation does not exist: ${pinnedAttestation.relativeReportPath}`,
  );
}
const handoffContractPath = path.resolve(
  "specs",
  "acceptance",
  "handoff-verification.v1.json",
);
const handoffContractBytes = readFileSync(handoffContractPath);
const handoffContract = JSON.parse(handoffContractBytes.toString("utf8"));
const packageJson = JSON.parse(
  readFileSync(path.resolve("package.json"), "utf8"),
);
if (
  handoffContract.schemaVersion !== "mandelhowl.handoff-verification.v1" ||
  handoffContract.handoff?.path !== "MandelHowl_핸드오프.md" ||
  !/^[a-f0-9]{64}$/.test(handoffContract.handoff?.sha256 ?? "") ||
  handoffContract.architectureReference?.path !==
    "MandelHowl_파일_구조.md" ||
  !/^[a-f0-9]{64}$/.test(
    handoffContract.architectureReference?.sha256 ?? "",
  )
) {
  usageError("the whole-handoff verification contract is invalid");
}
const handoffSourcePath = path.resolve(handoffContract.handoff.path);
const architectureReferencePath = path.resolve(
  handoffContract.architectureReference.path,
);
const attestationSha256 = sha256(readFileSync(attestationPath));
let releaseBlockingAssertionResults;
try {
  releaseBlockingAssertionResults = verifyReleaseBlockingAssertions({
    projectRoot: process.cwd(),
    assertions: handoffContract.releaseBlockingAssertions,
  });
} catch (error) {
  if (error instanceof HandoffVerificationError) {
    throw new Error(
      `MH-HANDOFF-VERIFY: release-blocking conformance failed: ${error.message}`,
    );
  }
  throw error;
}
const obligationLedgerPath = path.resolve(
  "work",
  "handoff",
  "obligation-ledger.json",
);

const stages = createFullVerificationStages({
  allowDirty: options.allowDirty,
  archive: options.archive,
  nativeExecutionPolicy: handoffContract.nativeExecutionDelegation,
  packageScripts: packageJson.scripts,
  platform: process.platform,
  suiteRegistry: handoffContract.suites,
});
const testRunnerPolicy = verifyTestRunnerPolicy(
  Object.fromEntries(
    TEST_RUNNER_POLICY_PATHS.map((configPath) => [
      configPath,
      readFileSync(path.resolve(configPath), "utf8"),
    ]),
  ),
);
const fullReleaseVerification = !options.allowDirty && options.archive;
const suiteBindings = fullReleaseVerification
  ? bindAcceptanceSuitesToStages({
      suiteRegistry: handoffContract.suites,
      stages,
    })
  : [];
const acceptanceCollections =
  collectWholeHandoffClaims(handoffContract);
const exactTestExecution = bindExactTestAnchorsToStages({
  claims: acceptanceCollections,
  stages,
  packageScripts: packageJson.scripts,
}).map((binding) => ({ ...binding, executed: false }));
const acceptanceSuiteExecution = suiteBindings.map((binding) => {
  const claims = acceptanceCollections.filter((claim) =>
    claim.suites?.includes(binding.suiteId),
  );
  return {
    suiteId: binding.suiteId,
    scripts: binding.scripts,
    stageIds: stages
      .filter((stage) => binding.scripts.includes(stage.script))
      .map(({ id }) => id),
    claimIds: [...new Set(claims.map(({ id }) => id))].sort(),
    exactAnchorIds: [
      ...new Set(
        claims.flatMap((claim) =>
          (claim.claimAnchors ?? []).map(({ id }) => id),
        ),
      ),
    ].sort(),
    exactTests: [
      ...new Map(
        claims
          .flatMap((claim) => claim.claimAnchors ?? [])
          .filter(({ kind }) => kind === "test")
          .map(({ path: testPath, testId }) => [
            `${testPath}\0${testId}`,
            { path: testPath, testId },
          ]),
      ).values(),
    ].sort((left, right) =>
      `${left.path}\0${left.testId}`.localeCompare(
        `${right.path}\0${right.testId}`,
      ),
    ),
  };
});
const verificationEnvironment = {
  ...process.env,
  [WINDOWS_EVIDENCE_ONLY_ENVIRONMENT_VARIABLE]: "1",
};
delete verificationEnvironment.MANDELHOWL_NATIVE_BAKER;
delete verificationEnvironment.MANDELHOWL_MANAGED_INSTALL;

const startedAt = new Date();
const report = {
  schemaVersion: "mandelhowl.handoff-verification-report.v1",
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  status: "running",
  verificationMode: fullReleaseVerification
    ? "clean-release"
    : "diagnostic-only",
  releaseEligible: false,
  attestationPath,
  attestationRelativePath: pinnedAttestation.relativeReportPath,
  attestationSha256,
  sourceCommit: git("rev-parse", "HEAD"),
  sourceTreeDirty:
    git("status", "--porcelain=v1", "--untracked-files=all").length > 0,
  handoff: {
    sourcePath: handoffContract.handoff.path,
    sourceSha256: sha256(readFileSync(handoffSourcePath)),
    architectureReferencePath:
      handoffContract.architectureReference.path,
    architectureReferenceSha256: sha256(
      readFileSync(architectureReferencePath),
    ),
    verificationContractPath: path.relative(
      process.cwd(),
      handoffContractPath,
    ).replaceAll("\\", "/"),
    verificationContractSha256: sha256(handoffContractBytes),
    releaseBlockingAssertions: releaseBlockingAssertionResults,
    obligationLedger: null,
  },
  requireClean: !options.allowDirty,
  archiveChecked: options.archive,
  delegatedNativeEvidence: {
    ...DELEGATED_NATIVE_EVIDENCE,
    committedEvidence: pinnedAttestation.relativeReportPath,
    prohibitedLocalStages: WINDOWS_NATIVE_PROHIBITED_SCRIPTS,
    evidenceOnlyEnvironmentVariable:
      WINDOWS_EVIDENCE_ONLY_ENVIRONMENT_VARIABLE,
    windowsScriptDagSha256:
      handoffContract.nativeExecutionDelegation
        .windowsFullVerification.scriptDagSha256,
  },
  acceptanceSuiteExecution,
  exactTestExecution,
  testRunnerPolicy,
  stages: [],
};

for (const stage of stages) {
  const stageStarted = performance.now();
  process.stdout.write(`\n[handoff] ${stage.id}\n`);
  const result = spawnSync(stage.command, stage.arguments, {
    cwd: process.cwd(),
    env: verificationEnvironment,
    stdio: "inherit",
  });
  const durationMs = Math.round(performance.now() - stageStarted);
  const stageReport = {
    id: stage.id,
    script: stage.script,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
  };
  report.stages.push(stageReport);
  if (result.error || result.status !== 0) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.failure = {
      stage: stage.id,
      message: result.error?.message ?? `exit code ${String(result.status)}`,
    };
    writeReport(options.report, report);
    process.stderr.write(
      `\nMH-HANDOFF-VERIFY: ${stage.id} failed after ${durationMs} ms.\n`,
    );
    process.exit(result.status ?? 1);
  }
  if (
    stage.id === "handoff-obligation-and-conformance-contract"
  ) {
    if (!existsSync(obligationLedgerPath)) {
      throw new Error(
        "MH-HANDOFF-VERIFY: handoff check did not emit the obligation ledger",
      );
    }
    const ledgerBytes = readFileSync(obligationLedgerPath);
    const ledger = JSON.parse(ledgerBytes.toString("utf8"));
    if (
      ledger.schemaVersion !==
        "mandelhowl.handoff-obligation-ledger.v1" ||
      ledger.sourceObligationCount !==
        handoffContract.handoff.obligations.expectedCount ||
      ledger.mappedObligationCount !==
        handoffContract.handoff.obligations.expectedCount ||
      ledger.ledgerSha256 !==
        handoffContract.handoff.obligations.expectedLedgerSha256
    ) {
      throw new Error(
        "MH-HANDOFF-VERIFY: emitted obligation ledger does not match the pinned ownership contract",
      );
    }
    report.handoff.obligationLedger = {
      path: path
        .relative(process.cwd(), obligationLedgerPath)
        .replaceAll("\\", "/"),
      fileSha256: sha256(ledgerBytes),
      ledgerSha256: ledger.ledgerSha256,
      sourceObligationCount: ledger.sourceObligationCount,
      mappedObligationCount: ledger.mappedObligationCount,
    };
  }
}

for (const binding of report.exactTestExecution) {
  const stageReports = binding.stageIds.map((stageId) =>
    report.stages.find(({ id }) => id === stageId),
  );
  if (
    stageReports.length !== binding.stageIds.length ||
    stageReports.some((stage) => stage?.exitCode !== 0)
  ) {
    throw new Error(
      `MH-HANDOFF-VERIFY: exact test ${binding.anchorId} lacks a successful owning stage`,
    );
  }
  binding.executed = true;
}

for (const binding of report.acceptanceSuiteExecution) {
  const stageReports = binding.stageIds.map((stageId) =>
    report.stages.find(({ id }) => id === stageId),
  );
  if (
    stageReports.length !== binding.stageIds.length ||
    stageReports.some((stage) => stage?.exitCode !== 0)
  ) {
    throw new Error(
      `MH-HANDOFF-VERIFY: acceptance suite ${binding.suiteId} lacks a successful dedicated stage`,
    );
  }
  binding.verifiedExactAnchorCount = binding.exactAnchorIds.length;
  binding.executedExactTestCount =
    report.exactTestExecution.filter((execution) =>
      binding.exactAnchorIds.includes(execution.anchorId),
    ).length;
}

report.status = "passed";
report.releaseEligible = fullReleaseVerification;
report.finishedAt = new Date().toISOString();
report.durationMs = Date.parse(report.finishedAt) - startedAt.getTime();
writeReport(options.report, report);
process.stdout.write(
  fullReleaseVerification
    ? `\nMandelHowl whole-handoff verification passed in ${report.durationMs} ms.\n`
    : `\nMandelHowl diagnostic-only handoff checks passed in ${report.durationMs} ms; no release claim was made.\n`,
);
