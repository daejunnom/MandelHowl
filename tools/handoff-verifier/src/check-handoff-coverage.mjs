import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  HandoffVerificationError,
  buildObligationLedger,
  parseHandoff,
  verifyExecutableSuiteRegistry,
  verifyObligationLedgerPin,
  verifyNativeExecutionDelegation,
  verifyReleaseBlockingAssertions,
  verifyStandaloneClaims,
  verifyValidationSuiteRequirements,
} from "./verification-core.mjs";

const projectRoot = process.cwd();
const contractPath = path.join(
  projectRoot,
  "specs",
  "acceptance",
  "handoff-verification.v1.json",
);

function parseArguments(arguments_) {
  const options = { ledger: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--ledger") {
      if (options.ledger !== null || index + 1 >= arguments_.length) {
        fail("--ledger requires exactly one project-relative path");
      }
      options.ledger = arguments_[index + 1];
      index += 1;
    } else {
      fail(`unknown option ${argument}`);
    }
  }
  return options;
}

function fail(message) {
  throw new Error(`MH-HANDOFF-COVERAGE: ${message}`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${path.relative(projectRoot, filePath)}: ${error.message}`);
  }
}

function assertSafeRelativePath(relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    fail(`${label} must be a non-empty path`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    path.isAbsolute(relativePath) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    fail(`${label} escapes the project root: ${relativePath}`);
  }
  const secretSegments = normalized.toLowerCase().split("/");
  if (
    secretSegments.some(
      (segment) =>
        segment === ".env" ||
        segment.startsWith(".env.") ||
        segment.includes("credential") ||
        segment.includes("private-key") ||
        segment.includes("service-account"),
    )
  ) {
    fail(`${label} points at a forbidden secret path: ${relativePath}`);
  }
  return path.join(projectRoot, relativePath);
}

function assertExactSequence(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(
      `${label} mismatch; expected ${expected.join(", ")}, received ${actual.join(", ")}`,
    );
  }
}

function collectCanonicalSpecPaths(directory, relativeDirectory = "specs") {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...collectCanonicalSpecPaths(absolutePath, relativePath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".json") || entry.name.endsWith(".yaml"))
    ) {
      paths.push(relativePath);
    }
  }
  return paths.sort();
}

function runCore(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HandoffVerificationError) {
      fail(error.message);
    }
    throw error;
  }
}

const options = parseArguments(process.argv.slice(2));

if (!existsSync(contractPath)) {
  fail("verification contract is missing");
}

const contract = readJson(contractPath);
if (contract.schemaVersion !== "mandelhowl.handoff-verification.v1") {
  fail(`unsupported verification contract ${String(contract.schemaVersion)}`);
}

const handoffPath = assertSafeRelativePath(contract.handoff?.path, "handoff.path");
if (!existsSync(handoffPath) || !statSync(handoffPath).isFile()) {
  fail(`handoff source is missing: ${contract.handoff?.path}`);
}
const handoffBytes = readFileSync(handoffPath);
const actualHandoffSha = sha256(handoffBytes);
if (actualHandoffSha !== contract.handoff.sha256) {
  fail(
    `handoff source changed (${actualHandoffSha}); re-audit the full document before updating the pinned digest`,
  );
}

const architectureReferencePath = assertSafeRelativePath(
  contract.architectureReference?.path,
  "architectureReference.path",
);
if (
  !existsSync(architectureReferencePath) ||
  !statSync(architectureReferencePath).isFile()
) {
  fail(
    `architecture reference is missing: ${contract.architectureReference?.path}`,
  );
}
const actualArchitectureReferenceSha = sha256(
  readFileSync(architectureReferencePath),
);
if (
  actualArchitectureReferenceSha !==
  contract.architectureReference.sha256
) {
  fail(
    `architecture reference changed (${actualArchitectureReferenceSha}); re-audit the file structure and dependency boundaries before updating the pinned digest`,
  );
}

const parsed = parseHandoff(handoffBytes.toString("utf8"));
const headingIds = parsed.headings.map(({ id }) => id);
const duplicateSourceHeadings = headingIds.filter(
  (id, index) => headingIds.indexOf(id) !== index,
);
if (duplicateSourceHeadings.length > 0) {
  fail(`duplicate source heading IDs: ${[...new Set(duplicateSourceHeadings)].join(", ")}`);
}

const topLevelIds = parsed.headings
  .filter(({ level, id }) => level === 2 && /^\d+$/u.test(id))
  .map(({ id }) => id);
const expectedTopLevelIds = Array.from(
  { length: contract.handoff.topLevelSections },
  (_, index) => String(index + 1),
);
assertExactSequence(topLevelIds, expectedTopLevelIds, "top-level section sequence");

const sourceHeadingSet = new Set(headingIds);
for (const validationId of contract.handoff.validationSubsections) {
  if (!sourceHeadingSet.has(validationId)) {
    fail(`validation subsection ${validationId} is missing`);
  }
}
for (const gateId of contract.handoff.implementationGates) {
  if (!sourceHeadingSet.has(gateId)) {
    fail(`implementation gate ${gateId} is missing`);
  }
}

const section19Start = parsed.headings.find(({ id }) => id === "19")?.line;
const section20Start = parsed.headings.find(({ id }) => id === "20")?.line;
if (!section19Start || !section20Start || section20Start <= section19Start) {
  fail("cannot isolate completion quality section");
}
const qualityIdsFromSource = parsed.lines
  .slice(section19Start, section20Start - 1)
  .map((line) => /^(\d+)\.\s+\S/u.exec(line)?.[1])
  .filter(Boolean);
const expectedQualityIds = Array.from(
  { length: contract.handoff.qualityCriteria },
  (_, index) => String(index + 1),
);
assertExactSequence(
  qualityIdsFromSource,
  expectedQualityIds,
  "completion quality criteria",
);

const actualCanonicalSpecs = collectCanonicalSpecPaths(
  path.join(projectRoot, "specs"),
);
const declaredCanonicalSpecs = (contract.canonicalSpecs ?? [])
  .map(({ source }) => source)
  .sort();
assertExactSequence(
  declaredCanonicalSpecs,
  actualCanonicalSpecs,
  "canonical spec inventory",
);
for (const canonicalSpec of contract.canonicalSpecs) {
  const sourcePath = assertSafeRelativePath(
    canonicalSpec.source,
    "canonicalSpecs.source",
  );
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    fail(`canonical spec is missing: ${canonicalSpec.source}`);
  }
  if (
    !Array.isArray(canonicalSpec.consumers) ||
    canonicalSpec.consumers.length === 0
  ) {
    fail(`canonical spec has no consumer: ${canonicalSpec.source}`);
  }
  const sourceName = path.basename(canonicalSpec.source);
  let sourceNameReferenced = false;
  for (const consumer of canonicalSpec.consumers) {
    const consumerPath = assertSafeRelativePath(
      consumer,
      `${canonicalSpec.source}.consumer`,
    );
    if (!existsSync(consumerPath) || !statSync(consumerPath).isFile()) {
      fail(`canonical spec consumer is missing: ${consumer}`);
    }
    if (readFileSync(consumerPath, "utf8").includes(sourceName)) {
      sourceNameReferenced = true;
    }
  }
  if (!sourceNameReferenced) {
    fail(
      `canonical spec ${canonicalSpec.source} is not named by any declared consumer`,
    );
  }
}

if (!contract.suites || typeof contract.suites !== "object") {
  fail("suite registry is missing");
}
const packageJson = readJson(path.join(projectRoot, "package.json"));
const packageScripts = packageJson.scripts ?? {};
runCore(() =>
  verifyExecutableSuiteRegistry({
    suiteRegistry: contract.suites,
    packageScripts,
  }),
);
const nativeExecutionDelegation = runCore(() =>
  verifyNativeExecutionDelegation({
    projectRoot,
    policy: contract.nativeExecutionDelegation,
    suiteRegistry: contract.suites,
  }),
);

const releaseBlockingAssertionResults = runCore(() =>
  verifyReleaseBlockingAssertions({
    projectRoot,
    assertions: contract.releaseBlockingAssertions,
  }),
);

const mappedHeadingIds = [];
const seenGroupIds = new Set();
for (const group of contract.coverageGroups ?? []) {
  if (!group.id || seenGroupIds.has(group.id)) {
    fail(`coverage group ID is missing or duplicated: ${String(group.id)}`);
  }
  seenGroupIds.add(group.id);
  if (!Array.isArray(group.headings) || group.headings.length === 0) {
    fail(`coverage group ${group.id} has no source headings`);
  }
  if (!Array.isArray(group.suites) || group.suites.length === 0) {
    fail(`coverage group ${group.id} has no executable suites`);
  }
  for (const suiteId of group.suites) {
    if (contract.suites[suiteId] === undefined) {
      fail(`coverage group ${group.id} references unknown suite ${suiteId}`);
    }
  }
  if (!Array.isArray(group.evidence) || group.evidence.length === 0) {
    fail(`coverage group ${group.id} has no evidence paths`);
  }
  for (const evidencePath of group.evidence) {
    const absoluteEvidencePath = assertSafeRelativePath(
      evidencePath,
      `${group.id}.evidence`,
    );
    if (
      !existsSync(absoluteEvidencePath) ||
      !statSync(absoluteEvidencePath).isFile()
    ) {
      fail(
        `coverage group ${group.id} evidence must be a concrete file: ${evidencePath}`,
      );
    }
  }
  mappedHeadingIds.push(...group.headings);
}

const duplicateMappedHeadings = mappedHeadingIds.filter(
  (id, index) => mappedHeadingIds.indexOf(id) !== index,
);
if (duplicateMappedHeadings.length > 0) {
  fail(
    `source headings mapped more than once: ${[
      ...new Set(duplicateMappedHeadings),
    ].join(", ")}`,
  );
}
assertExactSequence(
  [...mappedHeadingIds].sort((left, right) => {
    const leftIndex = headingIds.indexOf(left);
    const rightIndex = headingIds.indexOf(right);
    return leftIndex - rightIndex;
  }),
  headingIds,
  "source heading coverage",
);

const criticalClaims = contract.criticalClaims ?? [];
const qualityCriteria = contract.qualityCriteria ?? [];
assertExactSequence(
  criticalClaims.map(({ heading }) => heading),
  [
    ...contract.handoff.validationSubsections,
    ...contract.handoff.implementationGates,
  ],
  "critical validation/gate claim sequence",
);
runCore(() =>
  verifyValidationSuiteRequirements({
    validationSubsections: contract.handoff.validationSubsections,
    requirements: contract.validationSuiteRequirements,
    criticalClaims,
  }),
);
const obligationLedger = runCore(() =>
  buildObligationLedger({
    projectRoot,
    parsed,
    coverageGroups: contract.coverageGroups,
    criticalClaims,
    acceptanceCases: [
      ...qualityCriteria.map((quality) => ({
        ...quality,
        id: `QUALITY-${quality.id}`,
      })),
      ...(contract.acceptanceCases ?? []),
    ],
    obligationClaims: contract.obligationClaims,
    suiteRegistry: contract.suites,
  }),
);
runCore(() =>
  verifyObligationLedgerPin(
    obligationLedger,
    contract.handoff.obligations,
  ),
);

const qualityIds = qualityCriteria.map(({ id }) => String(id));
assertExactSequence(qualityIds, expectedQualityIds, "quality evidence map");
for (const quality of qualityCriteria) {
  if (!Array.isArray(quality.suites) || quality.suites.length === 0) {
    fail(`quality criterion ${quality.id} has no executable suites`);
  }
  for (const suiteId of quality.suites) {
    if (contract.suites[suiteId] === undefined) {
      fail(`quality criterion ${quality.id} references unknown suite ${suiteId}`);
    }
  }
  if (!Array.isArray(quality.evidence) || quality.evidence.length === 0) {
    fail(`quality criterion ${quality.id} has no evidence`);
  }
  for (const evidencePath of quality.evidence) {
    const absoluteEvidencePath = assertSafeRelativePath(
      evidencePath,
      `quality.${quality.id}.evidence`,
    );
    if (
      !existsSync(absoluteEvidencePath) ||
      !statSync(absoluteEvidencePath).isFile()
    ) {
      fail(
        `quality criterion ${quality.id} evidence must be a concrete file: ${evidencePath}`,
      );
    }
  }
}
const qualityClaimResults = runCore(() =>
  verifyStandaloneClaims({
    projectRoot,
    claims: qualityCriteria,
    suiteRegistry: contract.suites,
    label: "quality criterion",
  }),
);

const extensionGates = contract.extensionGates ?? [];
assertExactSequence(
  extensionGates.map(({ id }) => id),
  contract.handoff.extensionGates,
  "post-handoff extension gates",
);
for (const extension of extensionGates) {
  const sourcePath = assertSafeRelativePath(
    extension.source,
    `extension.${extension.id}.source`,
  );
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    fail(`extension gate ${extension.id} source is missing: ${extension.source}`);
  }
  if (!Array.isArray(extension.suites) || extension.suites.length === 0) {
    fail(`extension gate ${extension.id} has no executable suites`);
  }
  for (const suiteId of extension.suites) {
    if (contract.suites[suiteId] === undefined) {
      fail(`extension gate ${extension.id} references unknown suite ${suiteId}`);
    }
  }
  if (!Array.isArray(extension.evidence) || extension.evidence.length === 0) {
    fail(`extension gate ${extension.id} has no evidence`);
  }
  for (const evidencePath of extension.evidence) {
    const absoluteEvidencePath = assertSafeRelativePath(
      evidencePath,
      `extension.${extension.id}.evidence`,
    );
    if (
      !existsSync(absoluteEvidencePath) ||
      !statSync(absoluteEvidencePath).isFile()
    ) {
      fail(
        `extension gate ${extension.id} evidence must be a concrete file: ${evidencePath}`,
      );
    }
  }
}
const extensionClaimResults = runCore(() =>
  verifyStandaloneClaims({
    projectRoot,
    claims: extensionGates,
    suiteRegistry: contract.suites,
    label: "extension gate",
  }),
);

for (const auditDocument of contract.auditPolicy?.documents ?? []) {
  const absoluteAuditPath = assertSafeRelativePath(
    auditDocument,
    "auditPolicy.documents",
  );
  if (!existsSync(absoluteAuditPath)) {
    fail(`audit document is missing: ${auditDocument}`);
  }
  const auditText = readFileSync(absoluteAuditPath, "utf8");
  for (const phrase of contract.auditPolicy.forbiddenOpenGapPhrases ?? []) {
    if (auditText.includes(phrase)) {
      fail(
        `${auditDocument} still records an open normative gap using "${phrase}"`,
      );
    }
  }
}

if (options.ledger !== null) {
  const ledgerPath = assertSafeRelativePath(
    options.ledger,
    "ledger output",
  );
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(
    ledgerPath,
    `${JSON.stringify(
      {
        ...obligationLedger,
        handoff: {
          path: contract.handoff.path,
          sha256: actualHandoffSha,
        },
        nativeExecutionDelegation,
        generatedBy: "tools/handoff-verifier/src/check-handoff-coverage.mjs",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const headingsWithObligations = [
  ...parsed.obligationsByHeading.values(),
].filter((obligations) => obligations.length > 0).length;
process.stdout.write(
  [
    "MandelHowl handoff coverage contract verified.",
    `source: ${contract.handoff.path} (${actualHandoffSha})`,
    `architecture: ${contract.architectureReference.path} (${actualArchitectureReferenceSha})`,
    `headings: ${headingIds.length}/${headingIds.length}`,
    `normative obligations: ${obligationLedger.mappedObligationCount}/${obligationLedger.sourceObligationCount} across ${headingsWithObligations} headings`,
    `obligation ownership ledger: ${obligationLedger.ledgerSha256}`,
    `release-blocking semantic assertions: ${releaseBlockingAssertionResults.length}`,
    `implementation gates: ${contract.handoff.implementationGates.length}`,
    `completion quality criteria: ${qualityCriteria.length}`,
    `quality semantic claims: ${qualityClaimResults.length}`,
    `post-handoff extension gates: ${extensionGates.length}`,
    `extension semantic claims: ${extensionClaimResults.length}`,
    `canonical specs with live consumers: ${contract.canonicalSpecs.length}`,
    `evidence-backed coverage groups: ${contract.coverageGroups.length}`,
  ].join("\n") + "\n",
);
