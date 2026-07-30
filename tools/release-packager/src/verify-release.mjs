import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  lstat,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { verifyAttestationBundle } from "../../baker-supervisor/src/attestation-bundle.mjs";
import { collectBakerSourceInventory } from "../../baker-supervisor/src/source-tree.mjs";
import { verifyContainerAttestationEnvelope } from "../../container-baker-runner/src/attestation-envelope.mjs";
import { resolvePinnedAttestation } from "./pinned-attestation.mjs";
import {
  assertDatasetReleaseBindings,
  assertReleaseProvenanceBindings,
} from "./release-contract-bindings.mjs";
import {
  assertReleaseInputBindings,
  collectReleaseInputDigests,
} from "./release-input-bindings.mjs";
import { assertSecurityHeadersPolicy } from "./security-headers-policy.mjs";
import { verifyWebglShaderIntegrity } from "./webgl-shader-integrity.mjs";

const projectRoot = path.resolve(process.cwd());
const runtimeRoot = path.join(projectRoot, "public", "runtime");
const manifestPath = path.join(runtimeRoot, "manifest.json");
const bakerNVersionPolicyPath = "specs/physics/baker-nversion.v1.json";
const handoffVerificationContractPath =
  "specs/acceptance/handoff-verification.v1.json";
const datasetReleaseSpecPath = "specs/runtime/dataset-release.v1.yaml";
const datasetReleaseProjectionPath =
  "packages/contracts/src/generated/dataset-release.generated.ts";
const uiNVersionSourceInputs = [
  ["specSha256", "specs/runtime/ui-nversion.v1.json"],
  ["svelteEntrySha256", "apps/svelte-ui/src/entry.ts"],
  ["svelteSourceSha256", "apps/svelte-ui/src/MandelHowlApp.svelte"],
  ["reactEntrySha256", "apps/react-ui/src/entry.tsx"],
  ["reactSourceSha256", "apps/react-ui/src/MandelHowlReactApp.tsx"],
  [
    "supervisorSourceSha256",
    "packages/browser-runtime/src/ui-nversion-supervisor.ts",
  ],
  ["hostSourceSha256", "app/mandelhowl-ui-host.tsx"],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertBakerNVersionPolicy(policy) {
  if (
    policy?.schemaVersion !== "mandelhowl.baker-nversion-policy.v1" ||
    policy?.primary !== "rust-native" ||
    policy?.standby !== "python-stdlib" ||
    policy?.promotionRequiresDualAgreement !== true ||
    policy?.releaseRequiresDualAgreement !== true ||
    policy?.availabilityFailureSelection !== "surviving-version-degraded" ||
    policy?.scientificDisagreementSelection !== "last-known-good" ||
    policy?.degradedPromotionAllowed !== false ||
    policy?.degradedReleaseEligible !== false
  ) {
    throw new Error("Unsupported Baker N-version release policy.");
  }
}

function parseArguments(arguments_) {
  let requireClean = false;
  let pinnedNVersionAttestation = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--require-clean") {
      requireClean = true;
    } else if (argument === "--pinned-nversion-attestation") {
      if (pinnedNVersionAttestation) {
        throw new Error(
          "--pinned-nversion-attestation may be specified only once.",
        );
      }
      pinnedNVersionAttestation = true;
    } else if (argument === "--nversion-attestation") {
      throw new Error(
        "External N-version attestation paths are forbidden; use the committed pinned attestation.",
      );
    } else {
      throw new Error(`Unknown release verification option: ${argument}`);
    }
  }
  return { requireClean, pinnedNVersionAttestation };
}

async function datasetAlgorithmCompatibility(
  algorithmRevision,
  algorithmContractSha256,
) {
  if (algorithmRevision === undefined || algorithmRevision === null) {
    return {
      status: "legacy-unversioned-pinned-dataset",
      manifestAlgorithmRevision: null,
      contractBound: false,
      algorithmEvidenceSha256: null,
    };
  }
  const algorithmEvidenceSha256 = sha256(
    await readFile(
      path.join(runtimeRoot, "science", "baker-algorithm.v1.json"),
    ),
  );
  if (algorithmEvidenceSha256 !== algorithmContractSha256) {
    throw new Error(
      "The staged dataset algorithm evidence does not match the source contract.",
    );
  }
  return {
    status: "current-versioned-dataset",
    manifestAlgorithmRevision: algorithmRevision,
    contractBound: true,
    algorithmEvidenceSha256,
  };
}

function assertNVersionAttestation(
  report,
  algorithmRevision,
  algorithmContractSha256,
  manifest,
  manifestSha256,
  currentSourceTree,
) {
  const expected = [
    [
      "schemaVersion",
      report?.schemaVersion,
      "mandelhowl.baker-supervisor-result.v1",
    ],
    ["command", report?.command, "generate"],
    ["state", report?.state, "dual-verified"],
    ["failOperational", report?.failOperational, true],
    ["degraded", report?.degraded, false],
    ["splitBrain", report?.splitBrain, false],
    ["promotionAllowed", report?.promotionAllowed, true],
    ["releaseEligible", report?.releaseEligible, true],
    ["selectedSource", report?.selectedSource, "rust-native"],
    [
      "sourceTreeSha256",
      report?.sourceTreeSha256,
      currentSourceTree.sha256,
    ],
    [
      "sourceTreeFileCount",
      report?.sourceTreeFileCount,
      currentSourceTree.fileCount,
    ],
    [
      "sourceTreeDigestAlgorithm",
      report?.sourceTreeDigestAlgorithm,
      currentSourceTree.digestAlgorithm,
    ],
    ["backends.rust.backend", report?.backends?.rust?.backend, "rust-native"],
    [
      "backends.python.backend",
      report?.backends?.python?.backend,
      "python-stdlib",
    ],
    ["backends.rust.status", report?.backends?.rust?.status, "success"],
    ["backends.python.status", report?.backends?.python?.status, "success"],
    [
      "backends.rust.output.backend",
      report?.backends?.rust?.output?.backend,
      "rust-native",
    ],
    [
      "backends.python.output.backend",
      report?.backends?.python?.output?.backend,
      "python-stdlib",
    ],
    [
      "backends.rust.output.algorithmRevision",
      report?.backends?.rust?.output?.algorithmRevision,
      algorithmRevision,
    ],
    [
      "backends.python.output.algorithmRevision",
      report?.backends?.python?.output?.algorithmRevision,
      algorithmRevision,
    ],
    [
      "backends.rust.output.algorithmContractSha256",
      report?.backends?.rust?.output?.algorithmContractSha256,
      algorithmContractSha256,
    ],
    [
      "backends.python.output.algorithmContractSha256",
      report?.backends?.python?.output?.algorithmContractSha256,
      algorithmContractSha256,
    ],
    [
      "comparison.schemaVersion",
      report?.comparison?.schemaVersion,
      "mandelhowl.baker-semantic-diff.v1",
    ],
    ["comparison.equivalent", report?.comparison?.equivalent, true],
    ["comparison.mismatchCount", report?.comparison?.mismatchCount, 0],
    [
      "comparison.algorithmRevision",
      report?.comparison?.algorithmRevision,
      algorithmRevision,
    ],
    [
      "comparison.algorithmContractSha256",
      report?.comparison?.algorithmContractSha256,
      algorithmContractSha256,
    ],
    [
      "comparison.compatibility.leftGenerator",
      report?.comparison?.compatibility?.leftGenerator,
      "tools/physics-baker-rs",
    ],
    [
      "comparison.compatibility.rightGenerator",
      report?.comparison?.compatibility?.rightGenerator,
      "tools/physics-baker",
    ],
    [
      "comparison.compatibility.legacyManifestRevisionAssumed",
      report?.comparison?.compatibility?.legacyManifestRevisionAssumed,
      false,
    ],
  ];
  for (const [label, actual, required] of expected) {
    if (actual !== required) {
      throw new Error(`Baker N-version attestation mismatch: ${label}`);
    }
  }
  if (!sameJson(report?.sourceTreeRoots, currentSourceTree.roots)) {
    throw new Error(
      "Baker N-version attestation mismatch: sourceTreeRoots",
    );
  }
  if (
    !sameJson(
      report?.sourceTreeExcludedPaths,
      currentSourceTree.excludedPaths,
    )
  ) {
    throw new Error(
      "Baker N-version attestation mismatch: sourceTreeExcludedPaths",
    );
  }
  const priorLkg = report?.priorLastKnownGood;
  const priorDatasetId = priorLkg?.datasetId;
  const priorDirectoryName =
    typeof priorDatasetId === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(priorDatasetId)
      ? priorDatasetId.slice("sha256:".length)
      : null;
  if (
    report?.lastKnownGoodPreserved !== true ||
    !sameJson(priorLkg, report?.lastKnownGood) ||
    priorLkg?.valid !== true ||
    priorLkg?.code !== "MH_BAKER_LKG_VERIFIED" ||
    !/^[a-f0-9]{64}$/.test(priorLkg?.lockSha256 ?? "") ||
    priorDirectoryName === null ||
    typeof priorLkg?.datasetDirectory !== "string" ||
    priorLkg.datasetDirectory.replaceAll("\\", "/") !==
      `assets/generated/${priorDirectoryName}` ||
    !/^[a-f0-9]{64}$/.test(priorLkg?.manifestSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(
      priorLkg?.exactPackageFingerprintSha256 ?? "",
    )
  ) {
    throw new Error(
      "Baker N-version attestation prior LKG evidence is missing or invalid.",
    );
  }

  const rustExecutableSha256 = report?.backends?.rust?.executableSha256;
  const rustPreRunSha256 = report?.backends?.rust?.preRunExecutableSha256;
  const rustPostRunSha256 = report?.backends?.rust?.postRunExecutableSha256;
  if (
    !/^[a-f0-9]{64}$/.test(rustExecutableSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(rustPreRunSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(rustPostRunSha256 ?? "") ||
    rustPreRunSha256 !== rustExecutableSha256 ||
    rustPostRunSha256 !== rustExecutableSha256
  ) {
    throw new Error(
      "Baker N-version attestation native executable digests are missing or inconsistent.",
    );
  }
  const pythonInterpreterSha256 =
    report?.backends?.python?.interpreterIdentity?.executableSha256;
  const pythonOutputSha256 =
    report?.backends?.python?.output?.pythonExecutableSha256;
  if (
    !/^[a-f0-9]{64}$/.test(pythonInterpreterSha256 ?? "") ||
    pythonOutputSha256 !== pythonInterpreterSha256
  ) {
    throw new Error(
      "Baker N-version attestation Python interpreter digests are missing or inconsistent.",
    );
  }
  const basename = (value) =>
    typeof value === "string"
      ? value.replaceAll("\\", "/").split("/").at(-1)
      : null;
  for (const [backend, side] of [
    ["rust", "left"],
    ["python", "right"],
  ]) {
    const output = report?.backends?.[backend]?.output;
    const datasetId = output?.datasetId;
    const directoryName =
      typeof datasetId === "string" && /^sha256:[a-f0-9]{64}$/.test(datasetId)
        ? datasetId.slice("sha256:".length)
        : null;
    if (
      directoryName === null ||
      basename(output?.datasetPath) !== directoryName ||
      !/^[a-f0-9]{64}$/.test(output?.manifestSha256 ?? "") ||
      report?.comparison?.compatibility?.[`${side}DatasetId`] !== datasetId ||
      report?.comparison?.compatibility?.[`${side}ManifestSha256`] !==
        output.manifestSha256
    ) {
      throw new Error(
        `Baker N-version attestation does not bind the ${backend} candidate identity.`,
      );
    }
  }
  if (manifest.algorithmRevision === undefined) {
    return "implementation-only-legacy";
  }

  const expectedDatasetId = manifest.datasetId;
  const expectedDirectoryName = expectedDatasetId.slice("sha256:".length);
  const pythonDatasetId = report?.backends?.python?.output?.datasetId;
  const pythonDirectoryName =
    typeof pythonDatasetId === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(pythonDatasetId)
      ? pythonDatasetId.slice("sha256:".length)
      : null;
  const pythonManifestSha256 = report?.backends?.python?.output?.manifestSha256;
  const datasetExpected = [
    [
      "selectedDataset",
      basename(report?.selectedDataset),
      expectedDirectoryName,
    ],
    [
      "backends.rust.output.datasetId",
      report?.backends?.rust?.output?.datasetId,
      expectedDatasetId,
    ],
    [
      "backends.rust.output.datasetPath",
      basename(report?.backends?.rust?.output?.datasetPath),
      expectedDirectoryName,
    ],
    [
      "backends.rust.output.manifestSha256",
      report?.backends?.rust?.output?.manifestSha256,
      manifestSha256,
    ],
    [
      "comparison.compatibility.leftDatasetId",
      report?.comparison?.compatibility?.leftDatasetId,
      expectedDatasetId,
    ],
    [
      "comparison.compatibility.leftManifestSha256",
      report?.comparison?.compatibility?.leftManifestSha256,
      manifestSha256,
    ],
  ];
  for (const [label, actual, required] of datasetExpected) {
    if (actual !== required) {
      throw new Error(`Baker dataset-bound attestation mismatch: ${label}`);
    }
  }
  if (
    pythonDirectoryName === null ||
    basename(report?.backends?.python?.output?.datasetPath) !==
      pythonDirectoryName ||
    report?.comparison?.compatibility?.rightDatasetId !== pythonDatasetId ||
    !/^[a-f0-9]{64}$/.test(pythonManifestSha256 ?? "") ||
    report?.comparison?.compatibility?.rightManifestSha256 !==
      pythonManifestSha256
  ) {
    throw new Error(
      "Baker dataset-bound attestation does not bind the Python comparison candidate.",
    );
  }
  return "dataset-bound";
}

async function collectRuntimePayloadPaths(directory, prefix = "") {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePath(left.name, right.name));
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Runtime payload must not contain symlinks: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      output.push(
        ...(await collectRuntimePayloadPaths(absolutePath, relativePath)),
      );
    } else if (entry.isFile()) {
      output.push(relativePath);
    } else {
      throw new Error(`Unsupported runtime payload entry: ${relativePath}`);
    }
  }
  return output;
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

const options = parseArguments(process.argv.slice(2));

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
    path.join(projectRoot, "release", "third-party-license-inventory.json"),
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
  await readFile(path.join(runtimeRoot, "release-provenance.json"), "utf8"),
);
const [datasetReleaseSpecSource, datasetReleaseProjectionSource, packageJson] =
  await Promise.all([
    readFile(path.join(projectRoot, datasetReleaseSpecPath), "utf8"),
    readFile(path.join(projectRoot, datasetReleaseProjectionPath), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8").then((source) =>
      JSON.parse(source),
    ),
  ]);

if (manifest.schemaVersion !== "mandelhowl.resonance-manifest.v1") {
  throw new Error(`Unsupported manifest: ${manifest.schemaVersion}`);
}
if (!/^sha256:[a-f0-9]{64}$/.test(manifest.datasetId ?? "")) {
  throw new Error("Dataset ID is not content-addressed.");
}
assertDatasetReleaseBindings({
  releaseSpecSource: datasetReleaseSpecSource,
  generatedProjectionSource: datasetReleaseProjectionSource,
  lock,
  manifest,
  manifestBytes,
});
assertReleaseProvenanceBindings({
  releaseProvenance,
  manifest,
  manifestSha256: sha256(manifestBytes),
  headCommit: git("rev-parse", "HEAD"),
  headCommitTimestamp: git("show", "-s", "--format=%cI", "HEAD"),
  currentNodeVersion: process.version,
  nodeEngine: packageJson.engines?.node,
});

const algorithmContractBytes = await readFile(
  path.join(projectRoot, "specs", "physics", "baker-algorithm.v1.json"),
);
const algorithmContract = JSON.parse(algorithmContractBytes.toString("utf8"));
const bakerNVersionPolicyBytes = await readFile(
  path.join(projectRoot, bakerNVersionPolicyPath),
);
const bakerNVersionPolicy = JSON.parse(
  bakerNVersionPolicyBytes.toString("utf8"),
);
assertBakerNVersionPolicy(bakerNVersionPolicy);
if (
  algorithmContract.schemaVersion !== "mandelhowl.baker-algorithm.v1" ||
  typeof algorithmContract.algorithmRevision !== "string"
) {
  throw new Error("Unsupported Baker algorithm contract.");
}
const algorithmContractSha256 = sha256(algorithmContractBytes);
const pinnedDatasetCompatibility = await datasetAlgorithmCompatibility(
  manifest.algorithmRevision,
  algorithmContractSha256,
);
const webglShaderIntegrity = verifyWebglShaderIntegrity(projectRoot);
if (
  manifest.algorithmRevision !== undefined &&
  manifest.algorithmRevision !== algorithmContract.algorithmRevision
) {
  throw new Error(
    "The staged dataset uses a different Baker algorithm revision.",
  );
}
if (
  !sameJson(releaseProvenance.bakerNVersion?.policy, {
    ...bakerNVersionPolicy,
    rawSha256: sha256(bakerNVersionPolicyBytes),
  }) ||
  releaseProvenance.bakerNVersion?.algorithm?.schemaVersion !==
    algorithmContract.schemaVersion ||
  releaseProvenance.bakerNVersion?.algorithm?.revision !==
    algorithmContract.algorithmRevision ||
  releaseProvenance.bakerNVersion?.algorithm?.rawSha256 !==
    algorithmContractSha256 ||
  !sameJson(
    releaseProvenance.bakerNVersion?.pinnedDatasetCompatibility,
    pinnedDatasetCompatibility,
  ) ||
  !sameJson(releaseProvenance.bakerNVersion?.attestation, {
    status: "not-embedded",
    claim: "none",
    attestationScope: pinnedDatasetCompatibility.contractBound
      ? "dataset-bound"
      : "implementation-only-legacy",
    verificationOption: "--pinned-nversion-attestation",
  })
) {
  throw new Error("Release provenance Baker N-version policy mismatch.");
}
if (
  !sameJson(
    releaseProvenance.webglShaderIntegrity,
    webglShaderIntegrity,
  )
) {
  throw new Error(
    "Release provenance WebGL shader allowlist binding mismatch.",
  );
}
const bakerNVersionSourceTree = collectBakerSourceInventory(projectRoot);
if (
  !sameJson(
    releaseProvenance.bakerNVersion?.sourceTree,
    bakerNVersionSourceTree,
  )
) {
  throw new Error(
    "Release provenance Baker N-version source-tree digest mismatch.",
  );
}

const uiNVersionSpec = JSON.parse(
  await readFile(
    path.join(projectRoot, "specs", "runtime", "ui-nversion.v1.json"),
    "utf8",
  ),
);
if (
  uiNVersionSpec.schemaVersion !== "mandelhowl.ui-nversion.v1" ||
  uiNVersionSpec.primary !== "svelte5" ||
  uiNVersionSpec.standby !== "react" ||
  releaseProvenance.uiNVersion?.schemaVersion !==
    uiNVersionSpec.schemaVersion ||
  releaseProvenance.uiNVersion?.primary !== uiNVersionSpec.primary ||
  releaseProvenance.uiNVersion?.standby !== uiNVersionSpec.standby
) {
  throw new Error("Release provenance UI N-version policy mismatch.");
}
for (const [key, file] of uiNVersionSourceInputs) {
  const actual = sha256(await readFile(path.join(projectRoot, file)));
  if (releaseProvenance.uiNVersion?.inputs?.[key] !== actual) {
    throw new Error(`Release provenance UI source mismatch: ${file}`);
  }
}

const handoffVerificationContractBytes = await readFile(
  path.join(projectRoot, handoffVerificationContractPath),
);
const handoffVerificationContract = JSON.parse(
  handoffVerificationContractBytes.toString("utf8"),
);
if (
  handoffVerificationContract.schemaVersion !==
    "mandelhowl.handoff-verification.v1" ||
  handoffVerificationContract.handoff?.path !== "MandelHowl_핸드오프.md" ||
  !/^[a-f0-9]{64}$/.test(
    handoffVerificationContract.handoff?.sha256 ?? "",
  ) ||
  handoffVerificationContract.architectureReference?.path !==
    "MandelHowl_파일_구조.md" ||
  !/^[a-f0-9]{64}$/.test(
    handoffVerificationContract.architectureReference?.sha256 ?? "",
  )
) {
  throw new Error("Unsupported whole-handoff verification contract.");
}
const handoffSourceSha256 = sha256(
  await readFile(
    path.join(projectRoot, handoffVerificationContract.handoff.path),
  ),
);
const architectureReferenceSha256 = sha256(
  await readFile(
    path.join(
      projectRoot,
      handoffVerificationContract.architectureReference.path,
    ),
  ),
);
if (
  handoffSourceSha256 !== handoffVerificationContract.handoff.sha256 ||
  architectureReferenceSha256 !==
    handoffVerificationContract.architectureReference.sha256 ||
  !sameJson(releaseProvenance.acceptance, {
    schemaVersion: handoffVerificationContract.schemaVersion,
    verificationContractPath: handoffVerificationContractPath,
    verificationContractSha256: sha256(handoffVerificationContractBytes),
    handoffPath: handoffVerificationContract.handoff.path,
    handoffSha256: handoffVerificationContract.handoff.sha256,
    architectureReferencePath:
      handoffVerificationContract.architectureReference.path,
    architectureReferenceSha256:
      handoffVerificationContract.architectureReference.sha256,
  })
) {
  throw new Error(
    "Release provenance whole-handoff acceptance binding mismatch.",
  );
}

assertReleaseInputBindings({
  provenanceInputs: releaseProvenance.inputs,
  actualDigests: await collectReleaseInputDigests(projectRoot),
});

if (options.requireClean) {
  if (
    releaseProvenance.sourceTreeDirty ||
    git("status", "--porcelain=v1", "--untracked-files=all").length > 0
  ) {
    throw new Error(
      "A clean source tree, including non-ignored untracked files, is required for release.",
    );
  }
}

let nVersionAttestation = null;
let nVersionAttestationScope = null;
if (options.pinnedNVersionAttestation) {
  const pinnedAttestation = resolvePinnedAttestation({
    projectRoot,
    lock,
  });
  const attestationPath = pinnedAttestation.reportPath;
  const attestationMetadata = await lstat(attestationPath);
  if (
    !attestationMetadata.isFile() ||
    attestationMetadata.isSymbolicLink()
  ) {
    throw new Error(
      "Committed pinned OCI attestation report is not a regular file.",
    );
  }
  const attestationBytes = await readFile(attestationPath);
  nVersionAttestation = JSON.parse(attestationBytes.toString("utf8"));
  nVersionAttestationScope = assertNVersionAttestation(
    nVersionAttestation,
    algorithmContract.algorithmRevision,
    algorithmContractSha256,
    manifest,
    sha256(manifestBytes),
    bakerNVersionSourceTree,
  );
  if (nVersionAttestationScope !== "dataset-bound") {
    throw new Error(
      "Committed OCI release evidence must be bound to the pinned dataset.",
    );
  }
  verifyAttestationBundle({
    reportPath: attestationPath,
    report: nVersionAttestation,
    projectRoot,
  });
  verifyContainerAttestationEnvelope({
    reportPath: attestationPath,
    reportBytes: attestationBytes,
    report: nVersionAttestation,
    expectedManifest: manifest,
  });
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

const checksums = JSON.parse(
  await readFile(path.join(runtimeRoot, "checksums.json"), "utf8"),
);
if (
  checksums?.schemaVersion !== "mandelhowl.checksums.v1" ||
  checksums?.algorithm !== "sha256" ||
  !Array.isArray(checksums?.files)
) {
  throw new Error("Runtime checksums inventory contract is invalid.");
}
const checksumRows = new Map();
for (const [index, row] of checksums.files.entries()) {
  if (
    typeof row?.path !== "string" ||
    !Number.isInteger(row?.byteLength) ||
    row.byteLength < 0 ||
    !/^[a-f0-9]{64}$/.test(row?.sha256 ?? "") ||
    checksumRows.has(row.path)
  ) {
    throw new Error(`Invalid or duplicate checksum row ${index}.`);
  }
  const absolutePath = path.resolve(runtimeRoot, row.path);
  const relativePath = path.relative(runtimeRoot, absolutePath);
  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    relativePath.replaceAll("\\", "/") !== row.path
  ) {
    throw new Error(`Unsafe checksum path: ${row.path}`);
  }
  const bytes = await readFile(absolutePath);
  if (bytes.byteLength !== row.byteLength || sha256(bytes) !== row.sha256) {
    throw new Error(`Checksum inventory mismatch: ${row.path}`);
  }
  checksumRows.set(row.path, row);
}
for (const reference of references) {
  if (reference.path === "checksums.json") {
    continue;
  }
  const checksumRow = checksumRows.get(reference.path);
  if (
    checksumRow?.byteLength !== reference.byteLength ||
    checksumRow?.sha256 !== reference.sha256
  ) {
    throw new Error(`Manifest/checksums inventory mismatch: ${reference.path}`);
  }
}
const releaseWrapperFiles = new Set([
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.md",
  "checksums.json",
  "manifest.json",
  "release-provenance.json",
]);
const stagedPayloadPaths = (await collectRuntimePayloadPaths(runtimeRoot))
  .filter((file) => !releaseWrapperFiles.has(file))
  .sort(comparePath);
const checksumPaths = [...checksumRows.keys()].sort(comparePath);
if (!sameJson(stagedPayloadPaths, checksumPaths)) {
  throw new Error("Staged runtime payload and checksums inventory differ.");
}

const headers = await readFile(
  path.join(projectRoot, "public", "_headers"),
  "utf8",
);
assertSecurityHeadersPolicy(headers);

process.stdout.write(
  `Verified ${references.length} content-addressed assets for ${manifest.datasetId}.\n`,
);
if (nVersionAttestation === null) {
  process.stdout.write(
    "Baker N-version attestation was not provided; no attested-release claim was made.\n",
  );
} else {
  if (nVersionAttestationScope === "implementation-only-legacy") {
    process.stdout.write(
      `Verified Baker implementation attestation for ${algorithmContract.algorithmRevision}; scope=implementation-only-legacy.\n`,
    );
    process.stdout.write(
      "The pinned dataset remains legacy-unversioned and is not covered by this implementation attestation.\n",
    );
  } else {
    process.stdout.write(
      `Verified dataset-bound dual-implementation Baker N-version attestation for ${manifest.datasetId}.\n`,
    );
  }
}
