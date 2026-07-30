import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BAKER_REQUIRED_PATHS,
  BAKER_SOURCE_EXCLUDED_PATHS,
  BAKER_SOURCE_ROOTS,
  collectBakerSourceInventory,
  collectBakerSourceTree,
  digestBakerSourceInventory,
  isSensitiveBakerSourcePath,
} from "../src/source-tree.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

test("source-tree digest is deterministic and order independent", () => {
  const first = digestBakerSourceInventory([
    { path: "b", sha256: "2".repeat(64) },
    { path: "a", sha256: "1".repeat(64) },
  ]);
  const second = digestBakerSourceInventory([
    { path: "a", sha256: "1".repeat(64) },
    { path: "b", sha256: "2".repeat(64) },
  ]);
  assert.deepEqual(first, second);
  assert.match(first.sourceTreeSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sourceTreeFileCount, 2);
  assert.notEqual(
    first.sourceTreeSha256,
    digestBakerSourceInventory([
      { path: "a", sha256: "1".repeat(64) },
      { path: "b", sha256: "3".repeat(64) },
    ]).sourceTreeSha256,
  );
});

test("source-tree identity rejects sensitive paths before content hashing", () => {
  for (const candidate of [
    "tools/physics-baker/.env.local",
    "tools/physics-baker/.env.production",
    "tools/baker-supervisor/.ssh/id_ed25519",
    "tools/baker-supervisor/id_rsa",
    "tools/container-baker-runner/.aws/credentials",
    "specs/physics/service-account-test.json",
    "specs/physics/service_account_test.json",
    "packages/contracts/src/credential-backup.json",
    "packages/contracts/src/build-credentials-copy.json",
    "tools/release-packager/private-signing.key",
    "tools/release-packager/private-chain.pem",
    "tests/runtime/example_api-key_notes.txt",
    "tests/runtime/example_api_key_notes.txt",
  ]) {
    assert.equal(isSensitiveBakerSourcePath(candidate), true, candidate);
    assert.throws(
      () =>
        digestBakerSourceInventory([
          { path: candidate, sha256: "1".repeat(64) },
        ]),
      (error) =>
        error?.code === "MH_BAKER_SOURCE_SENSITIVE_PATH" &&
        !error.message.includes(candidate),
      candidate,
    );
  }
  for (const candidate of [
    "tools/physics-baker/algorithm.py",
    "specs/physics/baker-algorithm.v1.json",
    "packages/contracts/src/key-signature.ts",
  ]) {
    assert.equal(isSensitiveBakerSourcePath(candidate), false, candidate);
  }
});

test("promotion-only projections are exact exclusions from scientific source identity", () => {
  assert.deepEqual(BAKER_SOURCE_EXCLUDED_PATHS, [
    "specs/runtime/dataset-release.v1.yaml",
    "packages/contracts/src/generated/dataset-release.generated.ts",
  ]);
  const scientificFile = {
    path: "packages/contracts/src/generated/runtime-specs.generated.ts",
    sha256: "1".repeat(64),
  };
  const before = digestBakerSourceInventory([
    scientificFile,
    {
      path: "specs/runtime/dataset-release.v1.yaml",
      sha256: "2".repeat(64),
    },
    {
      path: "packages/contracts/src/generated/dataset-release.generated.ts",
      sha256: "3".repeat(64),
    },
  ]);
  const promoted = digestBakerSourceInventory([
    scientificFile,
    {
      path: "specs/runtime/dataset-release.v1.yaml",
      sha256: "4".repeat(64),
    },
    {
      path: "packages/contracts/src/generated/dataset-release.generated.ts",
      sha256: "5".repeat(64),
    },
  ]);
  assert.deepEqual(promoted, before);
  assert.notDeepEqual(
    digestBakerSourceInventory([
      {
        ...scientificFile,
        sha256: "6".repeat(64),
      },
    ]),
    before,
  );
  assert.notDeepEqual(
    digestBakerSourceInventory([
      scientificFile,
      {
        path: "specs/runtime/feedback.v1.yaml",
        sha256: "7".repeat(64),
      },
    ]),
    before,
  );
});

test("promotion-only pin regeneration leaves the attested runtime projection byte-identical", () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-promotion-projection-"),
  );
  const generatorPath = path.join(
    projectRoot,
    "packages/contracts/scripts/generate-runtime-specs.mjs",
  );
  const generatorInputs = [
    "packages/contracts/schemas/coverage-report.schema.json",
    "specs/physics/baker-algorithm.v1.json",
    "specs/runtime/audio-safety.v1.yaml",
    "specs/runtime/dataset-release.v1.yaml",
    "specs/runtime/dial.v1.yaml",
    "specs/runtime/feedback.v1.yaml",
    "specs/runtime/ui-nversion.v1.json",
    "specs/runtime/volume-map.v1.yaml",
    "specs/visual/motion-safety.v1.yaml",
    "specs/visual/performance-budget.v1.yaml",
    "specs/visual/quality-tiers.v1.yaml",
    "specs/visual/scene.v1.yaml",
  ];
  const runtimeProjectionPath =
    "packages/contracts/src/generated/runtime-specs.generated.ts";
  const releaseProjectionPath =
    "packages/contracts/src/generated/dataset-release.generated.ts";
  const releaseLockPath = "release/dataset-lock.json";

  try {
    for (const relativePath of generatorInputs) {
      const destination = path.join(temporaryRoot, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(projectRoot, relativePath), destination);
    }
    for (const output of [
      runtimeProjectionPath,
      releaseProjectionPath,
      releaseLockPath,
    ]) {
      mkdirSync(path.dirname(path.join(temporaryRoot, output)), {
        recursive: true,
      });
    }

    execFileSync(process.execPath, [generatorPath], {
      cwd: temporaryRoot,
      stdio: "pipe",
    });
    const baselineRuntimeProjection = readFileSync(
      path.join(temporaryRoot, runtimeProjectionPath),
    );
    const baselineReleaseProjection = readFileSync(
      path.join(temporaryRoot, releaseProjectionPath),
    );
    const baselineReleaseLock = readFileSync(
      path.join(temporaryRoot, releaseLockPath),
    );

    const releaseSpecPath = path.join(
      temporaryRoot,
      "specs/runtime/dataset-release.v1.yaml",
    );
    const originalReleaseSpec = readFileSync(releaseSpecPath, "utf8");
    const promotedDatasetHex = "a".repeat(64);
    const promotedManifestHex = "b".repeat(64);
    const promotedModalHex = "c".repeat(64);
    const promotedReleaseSpec = originalReleaseSpec
      .replace(
        /^datasetId: sha256:[a-f0-9]{64}$/mu,
        `datasetId: sha256:${promotedDatasetHex}`,
      )
      .replace(
        /^manifestSha256: [a-f0-9]{64}$/mu,
        `manifestSha256: ${promotedManifestHex}`,
      )
      .replace(
        /^modalModelId: sha256:[a-f0-9]{64}$/mu,
        `modalModelId: sha256:${promotedModalHex}`,
      )
      .replace(
        /^sourceDirectory: assets\/generated\/[a-f0-9]{64}$/mu,
        `sourceDirectory: assets/generated/${promotedDatasetHex}`,
      );
    assert.notEqual(promotedReleaseSpec, originalReleaseSpec);
    writeFileSync(releaseSpecPath, promotedReleaseSpec, "utf8");

    execFileSync(process.execPath, [generatorPath], {
      cwd: temporaryRoot,
      stdio: "pipe",
    });
    assert.deepEqual(
      readFileSync(path.join(temporaryRoot, runtimeProjectionPath)),
      baselineRuntimeProjection,
    );
    assert.notDeepEqual(
      readFileSync(path.join(temporaryRoot, releaseProjectionPath)),
      baselineReleaseProjection,
    );
    assert.notDeepEqual(
      readFileSync(path.join(temporaryRoot, releaseLockPath)),
      baselineReleaseLock,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("supervisor source-tree evidence covers the release provenance roots", () => {
  const inventory = collectBakerSourceInventory(projectRoot);
  const sourceTree = collectBakerSourceTree(projectRoot);
  assert.equal(sourceTree.schemaVersion, "mandelhowl.baker-source-tree.v1");
  assert.equal(
    sourceTree.digestAlgorithm,
    "sha256(path-nul-content-sha256-lf:v1)",
  );
  assert.equal(inventory.schemaVersion, sourceTree.schemaVersion);
  assert.equal(inventory.digestAlgorithm, sourceTree.digestAlgorithm);
  assert.equal(inventory.sha256, sourceTree.sourceTreeSha256);
  assert.equal(inventory.fileCount, sourceTree.sourceTreeFileCount);
  assert.deepEqual(sourceTree.roots, BAKER_SOURCE_ROOTS);
  assert.deepEqual(sourceTree.excludedPaths, BAKER_SOURCE_EXCLUDED_PATHS);
  assert.deepEqual(inventory.roots, BAKER_SOURCE_ROOTS);
  assert.deepEqual(
    inventory.excludedPaths,
    BAKER_SOURCE_EXCLUDED_PATHS,
  );
  assert.ok(Object.isFrozen(inventory));
  assert.ok(Object.isFrozen(inventory.files));
  assert.ok(inventory.files.every((file) => Object.isFrozen(file)));
  assert.deepEqual(
    inventory.files.map((file) => file.path),
    inventory.files.map((file) => file.path).toSorted(),
  );
  assert.ok(
    inventory.files.some(
      (file) =>
        file.path ===
        "packages/contracts/src/generated/runtime-specs.generated.ts",
    ),
  );
  for (const excludedPath of BAKER_SOURCE_EXCLUDED_PATHS) {
    assert.equal(
      inventory.files.some((file) => file.path === excludedPath),
      false,
      excludedPath,
    );
  }
  for (const requiredPath of BAKER_REQUIRED_PATHS) {
    assert.ok(
      inventory.files.some((file) => file.path === requiredPath),
      requiredPath,
    );
  }
  for (const requiredRoot of [
    ".dockerignore",
    "package.json",
    "packages/asset-runtime/src",
    "packages/contracts/schemas",
    "packages/contracts/src",
    "packages/render-engine/src",
    "packages/resonance-engine/src",
    "specs/acceptance",
    "specs/plate",
    "specs/runtime",
    "specs/visual",
    "tests/runtime",
    "tools/container-baker-runner",
    "tools/handoff-verifier",
    "tools/reachability-generator",
    "tools/release-packager",
  ]) {
    assert.ok(sourceTree.roots.includes(requiredRoot), requiredRoot);
  }
  assert.match(sourceTree.sourceTreeSha256, /^[a-f0-9]{64}$/);
  assert.ok(sourceTree.sourceTreeFileCount > 10);
  assert.equal(
    inventory.files.some((file) =>
      file.path.startsWith("release/attestations/"),
    ),
    false,
    "committed evidence cannot hash itself into its source identity",
  );
});

test("release provenance and verification use the canonical source collector", () => {
  for (const relativePath of [
    "tools/release-packager/src/build-provenance.mjs",
    "tools/release-packager/src/verify-release.mjs",
  ]) {
    const source = readFileSync(
      path.join(projectRoot, relativePath),
      "utf8",
    );
    assert.match(
      source,
      /import \{ collectBakerSourceInventory \} from "\.\.\/\.\.\/baker-supervisor\/src\/source-tree\.mjs";/,
      relativePath,
    );
    assert.match(
      source,
      /collectBakerSourceInventory\(projectRoot\)/,
      relativePath,
    );
    assert.doesNotMatch(
      source,
      /bakerNVersionSource(?:Roots|ExcludedPaths)/,
      relativePath,
    );
    assert.doesNotMatch(
      source,
      /function collectBakerNVersionSourceTree/,
      relativePath,
    );
    assert.doesNotMatch(source, /function gitPathList/, relativePath);
  }
  const verifier = readFileSync(
    path.join(
      projectRoot,
      "tools/release-packager/src/verify-release.mjs",
    ),
    "utf8",
  );
  assert.match(verifier, /report\?\.sourceTreeExcludedPaths/);
  assert.match(verifier, /currentSourceTree\.excludedPaths/);
});
