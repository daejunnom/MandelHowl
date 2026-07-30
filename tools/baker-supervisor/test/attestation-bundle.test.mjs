import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAttestationBundle,
  verifyAttestationBundle,
} from "../src/attestation-bundle.mjs";
import { compareDatasets } from "../src/semantic-diff.mjs";

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeVersionedCandidate(root, directoryName, generator) {
  const staging = path.join(root, `${generator.split("/").at(-1)}-staging`);
  cpSync(pinned, staging, { recursive: true });
  const algorithmBytes = readFileSync(
    path.join(
      projectRoot,
      "specs",
      "physics",
      "baker-algorithm.v1.json",
    ),
  );
  const algorithm = JSON.parse(algorithmBytes.toString("utf8"));
  const algorithmRelativePath = "science/baker-algorithm.v1.json";
  writeFileSync(
    path.join(staging, ...algorithmRelativePath.split("/")),
    algorithmBytes,
  );

  const checksumsPath = path.join(staging, "checksums.json");
  const checksums = JSON.parse(readFileSync(checksumsPath, "utf8"));
  const algorithmDescriptor = {
    path: algorithmRelativePath,
    byteLength: algorithmBytes.length,
    sha256: sha256(algorithmBytes),
  };
  checksums.files = checksums.files.filter(
    ({ path: filePath }) => filePath !== algorithmRelativePath,
  );
  checksums.files.push(algorithmDescriptor);
  checksums.files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const checksumsBytes = Buffer.from(
    `${JSON.stringify(checksums, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(checksumsPath, checksumsBytes);

  const manifestPath = path.join(staging, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.datasetId = `sha256:${directoryName}`;
  manifest.contentAddressing.directoryName = directoryName;
  manifest.algorithmRevision = algorithm.algorithmRevision;
  manifest.ownership.generator = generator;
  manifest.plate.materialSectionProfile = {
    schemaVersion: "mandelhowl.material-section-profile.v1",
    axis: "x-at-y-zero",
    sampleCount: 64,
    minimumThicknessM: 0.0018,
    maximumThicknessM: 0.0042,
    thicknessUnorm8: Array.from(
      { length: 64 },
      (_, index) => index * 4,
    ),
  };
  manifest.files.checksums.byteLength = checksumsBytes.length;
  manifest.files.checksums.sha256 = sha256(checksumsBytes);
  manifest.files.algorithmContract = {
    ...algorithmDescriptor,
    mediaType: "application/json",
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const destination = path.join(root, directoryName);
  renameSync(staging, destination);
  return destination;
}

function makeDualCandidates(temporary) {
  return {
    rust: makeVersionedCandidate(
      temporary,
      "a".repeat(64),
      "tools/physics-baker-rs",
    ),
    python: makeVersionedCandidate(
      temporary,
      "b".repeat(64),
      "tools/physics-baker",
    ),
  };
}

test("attestation bundle preserves and independently rechecks both candidates", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-attestation-test-"),
  );
  try {
    const candidates = makeDualCandidates(temporary);
    const bundleRoot = path.join(temporary, "bundle");
    const metadata = createAttestationBundle({
      bundleRoot,
      rustCandidate: candidates.rust,
      pythonCandidate: candidates.python,
    });
    const comparison = compareDatasets({
      projectRoot,
      leftRoot: candidates.rust,
      rightRoot: candidates.python,
      expectedLeftGenerator: "tools/physics-baker-rs",
      expectedRightGenerator: "tools/physics-baker",
    });
    assert.equal(comparison.equivalent, true);
    const report = {
      attestationBundle: metadata,
      backends: {
        rust: {
          output: {
            datasetId: metadata.candidates.rust.datasetId,
            manifestSha256: metadata.candidates.rust.manifestSha256,
          },
        },
        python: {
          output: {
            datasetId: metadata.candidates.python.datasetId,
            manifestSha256: metadata.candidates.python.manifestSha256,
          },
        },
      },
      comparison,
    };
    const result = verifyAttestationBundle({
      reportPath: path.join(bundleRoot, "attestation.json"),
      report,
      projectRoot,
    });
    assert.equal(
      result.rust.exactPackageFingerprintSha256,
      metadata.candidates.rust.exactPackageFingerprintSha256,
    );
    assert.equal(
      result.python.exactPackageFingerprintSha256,
      metadata.candidates.python.exactPackageFingerprintSha256,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("attestation bundle rejects path rewriting and candidate tampering", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-attestation-tamper-"),
  );
  try {
    const candidates = makeDualCandidates(temporary);
    const bundleRoot = path.join(temporary, "bundle");
    const metadata = createAttestationBundle({
      bundleRoot,
      rustCandidate: candidates.rust,
      pythonCandidate: candidates.python,
    });
    const comparison = compareDatasets({
      projectRoot,
      leftRoot: candidates.rust,
      rightRoot: candidates.python,
      expectedLeftGenerator: "tools/physics-baker-rs",
      expectedRightGenerator: "tools/physics-baker",
    });
    const report = {
      attestationBundle: metadata,
      backends: {
        rust: {
          output: {
            datasetId: metadata.candidates.rust.datasetId,
            manifestSha256: metadata.candidates.rust.manifestSha256,
          },
        },
        python: {
          output: {
            datasetId: metadata.candidates.python.datasetId,
            manifestSha256: metadata.candidates.python.manifestSha256,
          },
        },
      },
      comparison,
    };
    const reportPath = path.join(bundleRoot, "attestation.json");
    report.attestationBundle.candidates.rust.relativePath =
      "../outside/candidate";
    assert.throws(
      () =>
        verifyAttestationBundle({
          reportPath,
          report,
          projectRoot,
        }),
      /candidate path must be/,
    );

    report.attestationBundle.candidates.rust.relativePath =
      `candidates/rust/${"a".repeat(64)}`;
    const modesPath = path.join(
      bundleRoot,
      "candidates",
      "rust",
      "a".repeat(64),
      "modes.bin",
    );
    const modes = readFileSync(modesPath);
    modes[20] ^= 1;
    writeFileSync(modesPath, modes);
    assert.throws(
      () =>
        verifyAttestationBundle({
          reportPath,
          report,
          projectRoot,
        }),
      /byte length or SHA-256 does not match/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
