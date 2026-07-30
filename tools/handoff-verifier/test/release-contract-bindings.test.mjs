import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertDatasetReleaseBindings,
  assertReleaseProvenanceBindings,
} from "../../release-packager/src/release-contract-bindings.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function yamlFor(spec) {
  return `schemaVersion: ${spec.schemaVersion}
canonicalOwner:
  path: ${spec.canonicalOwner.path}
  policy: ${spec.canonicalOwner.policy}

manifestUrl: ${spec.manifestUrl}
datasetId: ${spec.datasetId}
manifestSha256: ${spec.manifestSha256}
modalModelId: ${spec.modalModelId}
sourceDirectory: ${spec.sourceDirectory}
loadingPolicy: ${spec.loadingPolicy}
`;
}

function projectionFor(spec, yaml, sourceDigest = sha256(Buffer.from(yaml))) {
  return `/**
 * Test projection with the production generator's exact export grammar.
 */
import type { DatasetReleaseSpec } from "../runtime-config";

export const DATASET_RELEASE_SOURCE_SHA256 = "${sourceDigest}";

export const GENERATED_DATASET_RELEASE_SPEC = Object.freeze(${JSON.stringify(
    spec,
    null,
    2,
  )} as const) satisfies DatasetReleaseSpec;
`;
}

function datasetFixture() {
  const datasetHex = "a".repeat(64);
  const modesSha256 = "b".repeat(64);
  const manifest = {
    schemaVersion: "mandelhowl.resonance-manifest.v1",
    datasetId: `sha256:${datasetHex}`,
    plate: { specSha256: "c".repeat(64) },
    solverProvenance: {
      name: "finite-strip",
      version: "r2",
      executionKind: "oci-container",
      containerImageDigest: `sha256:${"d".repeat(64)}`,
    },
    files: {
      modes: {
        path: "modes.bin",
        sha256: modesSha256,
        byteLength: 16,
      },
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const spec = {
    schemaVersion: "mandelhowl.dataset-release.v1",
    canonicalOwner: {
      path: "specs/runtime/dataset-release.v1.yaml",
      policy: "edit-source-regenerate-derived",
    },
    manifestUrl: "/runtime/manifest.json",
    datasetId: manifest.datasetId,
    manifestSha256: sha256(manifestBytes),
    modalModelId: `sha256:${modesSha256}`,
    sourceDirectory: `assets/generated/${datasetHex}`,
    loadingPolicy:
      "verified-before-activation-with-analytical-fallback",
  };
  const lock = {
    schemaVersion: "mandelhowl.dataset-lock.v1",
    datasetId: spec.datasetId,
    datasetDirectory: spec.sourceDirectory,
    manifestSha256: spec.manifestSha256,
  };
  const releaseSpecSource = yamlFor(spec);
  return {
    spec,
    lock,
    manifest,
    manifestBytes,
    releaseSpecSource,
    generatedProjectionSource: projectionFor(spec, releaseSpecSource),
  };
}

function datasetArguments(fixture) {
  return {
    releaseSpecSource: fixture.releaseSpecSource,
    generatedProjectionSource: fixture.generatedProjectionSource,
    lock: fixture.lock,
    manifest: fixture.manifest,
    manifestBytes: fixture.manifestBytes,
  };
}

function synchronizePin(fixture) {
  fixture.releaseSpecSource = yamlFor(fixture.spec);
  fixture.generatedProjectionSource = projectionFor(
    fixture.spec,
    fixture.releaseSpecSource,
  );
}

test("release dataset pin binds YAML, generated projection, lock, manifest, and modal bytes", () => {
  const fixture = datasetFixture();
  const result = assertDatasetReleaseBindings(datasetArguments(fixture));
  assert.equal(result.datasetId, fixture.manifest.datasetId);
  assert.equal(result.manifestSha256, fixture.spec.manifestSha256);
  assert.equal(result.modalModelId, fixture.spec.modalModelId);
  assert.equal(result.sourceDirectory, fixture.spec.sourceDirectory);
});

test("dataset release schema requires the manifest digest owned by the canonical pin", () => {
  const schema = JSON.parse(
    readFileSync(
      "packages/contracts/schemas/dataset-release.schema.json",
      "utf8",
    ),
  );
  assert.ok(schema.required.includes("manifestSha256"));
  assert.deepEqual(schema.properties.manifestSha256, {
    type: "string",
    pattern: "^[a-f0-9]{64}$",
  });
});

for (const [field, mutation] of [
  ["datasetId", `sha256:${"1".repeat(64)}`],
  ["manifestSha256", `${"2".repeat(63)}a`],
  ["modalModelId", `sha256:${"3".repeat(64)}`],
  ["sourceDirectory", `assets/generated/${"4".repeat(64)}`],
]) {
  test(`release dataset pin rejects a mutually regenerated ${field} mutation`, () => {
    const fixture = datasetFixture();
    fixture.spec[field] = mutation;
    synchronizePin(fixture);
    assert.throws(
      () => assertDatasetReleaseBindings(datasetArguments(fixture)),
      /Dataset release binding mismatch/u,
    );
  });
}

test("release dataset pin rejects a stale generated projection object", () => {
  const fixture = datasetFixture();
  const stale = clone(fixture.spec);
  stale.modalModelId = `sha256:${"5".repeat(64)}`;
  fixture.generatedProjectionSource = projectionFor(
    stale,
    fixture.releaseSpecSource,
  );
  assert.throws(
    () => assertDatasetReleaseBindings(datasetArguments(fixture)),
    /differs from the canonical YAML/u,
  );
});

test("release dataset pin rejects a generated projection with a forged YAML digest", () => {
  const fixture = datasetFixture();
  fixture.generatedProjectionSource = projectionFor(
    fixture.spec,
    fixture.releaseSpecSource,
    "6".repeat(64),
  );
  assert.throws(
    () => assertDatasetReleaseBindings(datasetArguments(fixture)),
    /does not bind the canonical YAML bytes/u,
  );
});

for (const [field, mutation] of [
  ["datasetId", `sha256:${"7".repeat(64)}`],
  ["manifestSha256", "8".repeat(64)],
  ["datasetDirectory", `assets/generated/${"9".repeat(64)}`],
]) {
  test(`release dataset pin rejects a ${field} lock mutation`, () => {
    const fixture = datasetFixture();
    fixture.lock[field] = mutation;
    assert.throws(
      () => assertDatasetReleaseBindings(datasetArguments(fixture)),
      /Dataset release binding mismatch/u,
    );
  });
}

test("release dataset pin rejects a modal-model manifest mutation even with a refreshed manifest hash", () => {
  const fixture = datasetFixture();
  fixture.manifest.files.modes.sha256 = "e".repeat(64);
  fixture.manifestBytes = Buffer.from(
    `${JSON.stringify(fixture.manifest, null, 2)}\n`,
  );
  fixture.spec.manifestSha256 = sha256(fixture.manifestBytes);
  fixture.lock.manifestSha256 = fixture.spec.manifestSha256;
  synchronizePin(fixture);
  assert.throws(
    () => assertDatasetReleaseBindings(datasetArguments(fixture)),
    /canonical modalModelId/u,
  );
});

function provenanceFixture() {
  const dataset = datasetFixture();
  const manifestSha256 = sha256(dataset.manifestBytes);
  const headCommit = "f".repeat(40);
  const headCommitTimestamp = "2026-07-30T12:34:56+09:00";
  const currentNodeVersion = "v22.19.0";
  const nodeEngine = ">=22.13.0";
  return {
    manifest: dataset.manifest,
    manifestSha256,
    headCommit,
    headCommitTimestamp,
    currentNodeVersion,
    nodeEngine,
    releaseProvenance: {
      schemaVersion: "mandelhowl.release-provenance.v4",
      webCommit: headCommit,
      webCommitTimestamp: headCommitTimestamp,
      datasetId: dataset.manifest.datasetId,
      datasetManifestSha256: manifestSha256,
      plateSpecSha256: dataset.manifest.plate.specSha256,
      solver: clone(dataset.manifest.solverProvenance),
      buildContract: {
        packageManager: "npm",
        nodeVersion: currentNodeVersion,
        buildCommand: "npm run build",
        workerEntrypoint: "dist/server/index.js",
      },
    },
  };
}

test("release provenance binds plate, solver, commit timestamp, and build runtime", () => {
  const fixture = provenanceFixture();
  const result = assertReleaseProvenanceBindings(fixture);
  assert.equal(result.webCommit, fixture.headCommit);
  assert.equal(result.webCommitTimestamp, fixture.headCommitTimestamp);
  assert.equal(result.nodeVersion, fixture.currentNodeVersion);
});

for (const [label, mutate] of [
  [
    "plate spec",
    (fixture) => {
      fixture.releaseProvenance.plateSpecSha256 = "0".repeat(64);
    },
  ],
  [
    "solver evidence",
    (fixture) => {
      fixture.releaseProvenance.solver.version = "mutated";
    },
  ],
  [
    "web commit timestamp",
    (fixture) => {
      fixture.releaseProvenance.webCommitTimestamp =
        "2026-07-30T00:00:00+09:00";
    },
  ],
  [
    "package manager",
    (fixture) => {
      fixture.releaseProvenance.buildContract.packageManager = "pnpm";
    },
  ],
  [
    "build command",
    (fixture) => {
      fixture.releaseProvenance.buildContract.buildCommand =
        "npm run unverified-build";
    },
  ],
  [
    "worker entrypoint",
    (fixture) => {
      fixture.releaseProvenance.buildContract.workerEntrypoint =
        "dist/server/other.js";
    },
  ],
  [
    "builder Node version",
    (fixture) => {
      fixture.releaseProvenance.buildContract.nodeVersion = "v22.18.0";
    },
  ],
]) {
  test(`release provenance rejects a ${label} mutation`, () => {
    const fixture = provenanceFixture();
    mutate(fixture);
    assert.throws(() => assertReleaseProvenanceBindings(fixture));
  });
}

test("release provenance rejects a verifier Node version below package policy", () => {
  const fixture = provenanceFixture();
  fixture.currentNodeVersion = "v22.12.9";
  fixture.releaseProvenance.buildContract.nodeVersion =
    fixture.currentNodeVersion;
  assert.throws(
    () => assertReleaseProvenanceBindings(fixture),
    /does not satisfy/u,
  );
});
