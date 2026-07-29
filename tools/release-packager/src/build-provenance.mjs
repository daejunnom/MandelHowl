import { createHash } from "node:crypto";
import { copyFile, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(process.cwd());
const manifestPath = path.join(
  projectRoot,
  "public",
  "runtime",
  "manifest.json",
);
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const bakerNVersionPolicyPath = "specs/physics/baker-nversion.v1.json";
const bakerNVersionSourceRoots = [
  "specs/physics",
  "tools/baker-supervisor",
  "tools/physics-baker",
  "tools/physics-baker-rs",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".github/workflows",
];
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

function gitPathList(...args) {
  const output = execFileSync("git", args, {
    cwd: projectRoot,
  });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

async function collectBakerNVersionSourceTree() {
  const candidates = gitPathList(
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...bakerNVersionSourceRoots,
  );
  const files = [];
  for (const sourcePath of new Set(candidates)) {
    const normalizedPath = sourcePath.replaceAll("\\", "/");
    const absolutePath = path.join(projectRoot, normalizedPath);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        // A tracked deletion remains dirty evidence, but is not current source.
        continue;
      }
      throw error;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `Baker N-version source must be a regular file: ${normalizedPath}`,
      );
    }
    files.push({
      path: normalizedPath,
      sha256: digest(await readFile(absolutePath)),
    });
  }
  files.sort((left, right) => comparePath(left.path, right.path));

  for (const requiredPath of [
    "specs/physics/baker-algorithm.v1.json",
    bakerNVersionPolicyPath,
    "tools/baker-supervisor/src/supervisor.mjs",
    "tools/physics-baker/bake.py",
    "tools/physics-baker-rs/Cargo.toml",
    "tools/physics-baker-rs/src/lib.rs",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".github/workflows/verify.yml",
  ]) {
    if (!files.some((file) => file.path === requiredPath)) {
      throw new Error(
        `Required Baker N-version source is missing: ${requiredPath}`,
      );
    }
  }

  const canonicalInventory = files
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join("");
  return {
    schemaVersion: "mandelhowl.baker-source-tree.v1",
    digestAlgorithm: "sha256(path-nul-content-sha256-lf:v1)",
    sha256: digest(Buffer.from(canonicalInventory, "utf8")),
    fileCount: files.length,
    roots: bakerNVersionSourceRoots,
    files,
  };
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
const bakerNVersionSourceTree = await collectBakerNVersionSourceTree();
const algorithmContractSha256 = digest(algorithmContractBytes);
const pinnedDatasetCompatibility = await datasetAlgorithmCompatibility(
  manifest.algorithmRevision,
  algorithmContractSha256,
);

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

const provenance = {
  schemaVersion: "mandelhowl.release-provenance.v3",
  webCommit: git("rev-parse", "HEAD"),
  webCommitTimestamp: git("show", "-s", "--format=%cI", "HEAD"),
  sourceTreeDirty:
    git("status", "--porcelain=v1", "--untracked-files=all").length > 0,
  datasetId: manifest.datasetId,
  datasetManifestSha256: digest(manifestBytes),
  plateSpecSha256: manifest.plate?.specSha256 ?? null,
  solver: manifest.solverProvenance ?? null,
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
      verificationOption: "--nversion-attestation",
    },
  },
  uiNVersion: {
    schemaVersion: uiNVersionSpec.schemaVersion,
    primary: uiNVersionSpec.primary,
    standby: uiNVersionSpec.standby,
    inputs: uiNVersionInputs,
  },
  inputs: {
    packageLockSha256: digest(
      await readFile(path.join(projectRoot, "package-lock.json")),
    ),
    licenseSha256: digest(await readFile(path.join(projectRoot, "LICENSE"))),
    thirdPartyNoticesSha256: digest(
      await readFile(path.join(projectRoot, "THIRD_PARTY_NOTICES.md")),
    ),
    thirdPartyLicenseInventorySha256: digest(
      await readFile(
        path.join(projectRoot, "release", "third-party-license-inventory.json"),
      ),
    ),
    securityHeadersSha256: digest(
      await readFile(path.join(projectRoot, "public", "_headers")),
    ),
  },
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
