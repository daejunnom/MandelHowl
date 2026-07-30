import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { collectBakerSourceInventory } from "../../baker-supervisor/src/source-tree.mjs";
import { collectReleaseInputDigests } from "./release-input-bindings.mjs";
import { verifyWebglShaderIntegrity } from "./webgl-shader-integrity.mjs";

const projectRoot = path.resolve(process.cwd());
const manifestPath = path.join(
  projectRoot,
  "public",
  "runtime",
  "manifest.json",
);
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const releaseInputDigests =
  await collectReleaseInputDigests(projectRoot);
const bakerNVersionPolicyPath = "specs/physics/baker-nversion.v1.json";
const handoffVerificationContractPath =
  "specs/acceptance/handoff-verification.v1.json";
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

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
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
  const algorithmEvidenceSha256 = digest(
    await readFile(
      path.join(
        projectRoot,
        "public",
        "runtime",
        "science",
        "baker-algorithm.v1.json",
      ),
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
if (
  manifest.algorithmRevision !== undefined &&
  manifest.algorithmRevision !== algorithmContract.algorithmRevision
) {
  throw new Error(
    "The staged dataset uses a different Baker algorithm revision.",
  );
}
const bakerNVersionSourceTree = collectBakerSourceInventory(projectRoot);
const algorithmContractSha256 = digest(algorithmContractBytes);
const pinnedDatasetCompatibility = await datasetAlgorithmCompatibility(
  manifest.algorithmRevision,
  algorithmContractSha256,
);
const webglShaderIntegrity = verifyWebglShaderIntegrity(projectRoot);

const uiNVersionSpec = JSON.parse(
  await readFile(
    path.join(projectRoot, "specs", "runtime", "ui-nversion.v1.json"),
    "utf8",
  ),
);
if (
  uiNVersionSpec.schemaVersion !== "mandelhowl.ui-nversion.v1" ||
  uiNVersionSpec.primary !== "svelte5" ||
  uiNVersionSpec.standby !== "react"
) {
  throw new Error("Unsupported UI N-version release policy.");
}
const uiNVersionInputs = Object.fromEntries(
  await Promise.all(
    uiNVersionSourceInputs.map(async ([key, file]) => [
      key,
      digest(await readFile(path.join(projectRoot, file))),
    ]),
  ),
);
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
const handoffSourceBytes = await readFile(
  path.join(projectRoot, handoffVerificationContract.handoff.path),
);
if (
  digest(handoffSourceBytes) !== handoffVerificationContract.handoff.sha256
) {
  throw new Error(
    "The whole-handoff verification contract does not bind the current handoff source.",
  );
}
const architectureReferenceBytes = await readFile(
  path.join(
    projectRoot,
    handoffVerificationContract.architectureReference.path,
  ),
);
if (
  digest(architectureReferenceBytes) !==
  handoffVerificationContract.architectureReference.sha256
) {
  throw new Error(
    "The whole-handoff verification contract does not bind the current architecture reference.",
  );
}

const provenance = {
  schemaVersion: "mandelhowl.release-provenance.v4",
  webCommit: git("rev-parse", "HEAD"),
  webCommitTimestamp: git("show", "-s", "--format=%cI", "HEAD"),
  sourceTreeDirty:
    git("status", "--porcelain=v1", "--untracked-files=all").length > 0,
  datasetId: manifest.datasetId,
  datasetManifestSha256: digest(manifestBytes),
  plateSpecSha256: manifest.plate?.specSha256 ?? null,
  solver: manifest.solverProvenance ?? null,
  webglShaderIntegrity,
  bakerNVersion: {
    policy: {
      ...bakerNVersionPolicy,
      rawSha256: digest(bakerNVersionPolicyBytes),
    },
    algorithm: {
      schemaVersion: algorithmContract.schemaVersion,
      revision: algorithmContract.algorithmRevision,
      rawSha256: algorithmContractSha256,
    },
    sourceTree: bakerNVersionSourceTree,
    pinnedDatasetCompatibility,
    attestation: {
      status: "not-embedded",
      claim: "none",
      attestationScope: pinnedDatasetCompatibility.contractBound
        ? "dataset-bound"
        : "implementation-only-legacy",
      verificationOption: "--pinned-nversion-attestation",
    },
  },
  uiNVersion: {
    schemaVersion: uiNVersionSpec.schemaVersion,
    primary: uiNVersionSpec.primary,
    standby: uiNVersionSpec.standby,
    inputs: uiNVersionInputs,
  },
  acceptance: {
    schemaVersion: handoffVerificationContract.schemaVersion,
    verificationContractPath: handoffVerificationContractPath,
    verificationContractSha256: digest(handoffVerificationContractBytes),
    handoffPath: handoffVerificationContract.handoff.path,
    handoffSha256: handoffVerificationContract.handoff.sha256,
    architectureReferencePath:
      handoffVerificationContract.architectureReference.path,
    architectureReferenceSha256:
      handoffVerificationContract.architectureReference.sha256,
  },
  inputs: releaseInputDigests,
  buildContract: {
    packageManager: "npm",
    nodeVersion: process.version,
    buildCommand: "npm run build",
    workerEntrypoint: "dist/server/index.js",
  },
};

await Promise.all([
  copyFile(
    path.join(projectRoot, "LICENSE"),
    path.join(projectRoot, "public", "runtime", "LICENSE.txt"),
  ),
  copyFile(
    path.join(projectRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(projectRoot, "public", "runtime", "THIRD_PARTY_NOTICES.md"),
  ),
]);

const serialized = `${JSON.stringify(provenance, null, 2)}\n`;
await writeFile(
  path.join(projectRoot, "public", "runtime", "release-provenance.json"),
  serialized,
  "utf8",
);
process.stdout.write(serialized);
