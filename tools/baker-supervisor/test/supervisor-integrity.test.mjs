import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyStrictGenerationPolicy,
  candidatePath,
  installCandidate,
  loadLastKnownGood,
  normalizeBackendDatasetPath,
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

test("Windows extended-length dataset paths normalize before containment checks", () => {
  assert.equal(
    normalizeBackendDatasetPath(
      "\\\\?\\C:\\workspace\\candidate",
      "win32",
    ),
    "C:\\workspace\\candidate",
  );
  assert.equal(
    normalizeBackendDatasetPath(
      "\\\\?\\UNC\\server\\share\\candidate",
      "win32",
    ),
    "\\\\server\\share\\candidate",
  );
  assert.equal(
    normalizeBackendDatasetPath("/tmp/candidate", "linux"),
    "/tmp/candidate",
  );
});

test("candidate path is package-validated before semantic comparison", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-candidate-path-"),
  );
  try {
    const staging = path.join(temporary, "staging");
    const incomplete = path.join(staging, "candidate");
    mkdirSync(incomplete, { recursive: true });
    const incompleteResult = {
      status: "success",
      output: { datasetPath: incomplete },
    };
    assert.equal(candidatePath(incompleteResult, staging), null);
    assert.equal(incompleteResult.status, "protocol-error");
    assert.equal(
      incompleteResult.code,
      "MH_BAKER_DATASET_PACKAGE_INVALID",
    );
    assert.equal(incompleteResult.scientificFailure, true);

    const outside = path.join(temporary, "outside");
    mkdirSync(outside);
    const linked = path.join(staging, "linked");
    try {
      symlinkSync(
        outside,
        linked,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM") return;
      throw error;
    }
    const linkedResult = {
      status: "success",
      output: { datasetPath: linked },
    };
    assert.equal(candidatePath(linkedResult, staging), null);
    assert.equal(linkedResult.status, "protocol-error");
    assert.equal(linkedResult.code, "MH_BAKER_DATASET_PATH_UNSAFE");
    assert.equal(linkedResult.scientificFailure, true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
const pinned = path.join(projectRoot, lock.datasetDirectory);

test("release lock resolves only after exact package and semantic validation", () => {
  const result = loadLastKnownGood(projectRoot);
  assert.equal(result.valid, true);
  assert.equal(result.datasetId, lock.datasetId);
  assert.equal(result.manifestSha256, lock.manifestSha256);
  assert.equal(
    result.lockSha256,
    createHash("sha256")
      .update(
        readFileSync(
          path.join(projectRoot, "release", "dataset-lock.json"),
        ),
      )
      .digest("hex"),
  );
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

test("requested bundle failure preserves a structured report without candidates", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-bundle-failure-"),
  );
  try {
    const bundle = path.join(temporary, "attestation");
    const reportPath = path.join(bundle, "attestation.json");
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          projectRoot,
          "tools",
          "baker-supervisor",
          "src",
          "supervisor.mjs",
        ),
        "generate",
        "--strict",
        "--output-root",
        path.join(temporary, "datasets"),
        "--attestation-bundle",
        bundle,
        "--report-file",
        reportPath,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          MANDELHOWL_MANAGED_INSTALL: "1",
          MANDELHOWL_NATIVE_BAKER: path.join(
            temporary,
            "missing-native-baker",
          ),
          MANDELHOWL_PYTHON: path.join(
            temporary,
            "missing-python",
          ),
        },
        shell: false,
        timeout: 20_000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(reportPath), true);
    assert.equal(existsSync(path.join(bundle, "candidates")), false);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.attestationBundle, null);
    assert.deepEqual(
      report.priorLastKnownGood,
      report.lastKnownGood,
    );
    assert.match(
      report.priorLastKnownGood.lockSha256,
      /^[a-f0-9]{64}$/,
    );
    assert.deepEqual(report.attestationBundleDiagnostic, {
      code: "MH_BAKER_ATTESTATION_DUAL_REQUIRED",
      message:
        "attestation bundle requires two valid, semantically equivalent candidates",
      state: "unavailable",
      rustStatus: "missing",
      pythonStatus: "missing",
      comparisonEquivalent: false,
    });
    assert.equal(
      JSON.parse(result.stdout).attestationBundleDiagnostic.code,
      "MH_BAKER_ATTESTATION_DUAL_REQUIRED",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
