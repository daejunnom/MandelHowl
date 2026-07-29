import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyStrictGenerationPolicy,
  installCandidate,
  loadLastKnownGood,
} from "../src/supervisor.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const lock = JSON.parse(
  readFileSync(
    path.join(projectRoot, "release", "dataset-lock.json"),
    "utf8",
  ),
);
const pinned = path.join(projectRoot, lock.datasetDirectory);

test("release lock resolves only after exact package and semantic validation", () => {
  const result = loadLastKnownGood(projectRoot);
  assert.equal(result.valid, true);
  assert.equal(result.datasetId, lock.datasetId);
  assert.equal(result.manifestSha256, lock.manifestSha256);
  assert.match(result.exactPackageFingerprintSha256, /^[a-f0-9]{64}$/);
});

test("release lock rejects changed manifest bytes", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "mandelhowl-lkg-test-"));
  try {
    const dataset = path.join(temporary, lock.datasetDirectory);
    mkdirSync(path.dirname(dataset), { recursive: true });
    mkdirSync(path.join(temporary, "release"), { recursive: true });
    mkdirSync(path.join(temporary, "specs", "physics"), {
      recursive: true,
    });
    cpSync(pinned, dataset, { recursive: true });
    cpSync(
      path.join(
        projectRoot,
        "specs",
        "physics",
        "baker-algorithm.v1.json",
      ),
      path.join(
        temporary,
        "specs",
        "physics",
        "baker-algorithm.v1.json",
      ),
    );
    writeFileSync(
      path.join(temporary, "release", "dataset-lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
    const manifestPath = path.join(dataset, "manifest.json");
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, "utf8")}\n`,
    );
    const result = loadLastKnownGood(temporary);
    assert.equal(result.valid, false);
    assert.equal(result.code, "MH_BAKER_LKG_LOCK_MISMATCH");
    assert.equal(result.absolute, null);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("candidate installation is atomic and exact-package idempotent", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-install-test-"),
  );
  try {
    const destination = installCandidate(pinned, temporary);
    assert.equal(
      path.basename(destination),
      lock.datasetId.slice("sha256:".length),
    );
    assert.deepEqual(readdirSync(temporary), [path.basename(destination)]);
    assert.equal(installCandidate(pinned, temporary), destination);

    const manifestPath = path.join(destination, "manifest.json");
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, "utf8")}\n`,
    );
    assert.throws(
      () => installCandidate(pinned, temporary),
      /exact manifest\/checksum identity/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("strict degradation reports only a durable verified LKG", () => {
  const decision = {
    state: "degraded-python",
    selectedSource: "python-stdlib",
    selectedDataset: "temporary-staging-candidate",
    failOperational: true,
    reason: "Rust unavailable",
  };
  const withLkg = applyStrictGenerationPolicy(
    decision,
    { valid: true, absolute: "durable-lkg" },
    true,
  );
  assert.equal(withLkg.selectedSource, "last-known-good");
  assert.equal(withLkg.selectedDataset, "durable-lkg");
  assert.equal(withLkg.failOperational, true);

  const withoutLkg = applyStrictGenerationPolicy(
    decision,
    { valid: false, absolute: null },
    true,
  );
  assert.equal(withoutLkg.selectedSource, null);
  assert.equal(withoutLkg.selectedDataset, null);
  assert.equal(withoutLkg.failOperational, false);
});
