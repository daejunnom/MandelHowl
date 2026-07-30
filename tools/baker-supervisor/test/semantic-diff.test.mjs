import assert from "node:assert/strict";
import {
  cpSync,
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
  compareDatasets,
  compareDatasetsSafely,
} from "../src/semantic-diff.mjs";

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

test("pinned dataset is semantically identical to itself", () => {
  const result = compareDatasets({
    projectRoot,
    leftRoot: pinned,
    rightRoot: pinned,
  });
  assert.equal(result.equivalent, true);
  assert.equal(result.metrics.modeCount, 48);
  assert.equal(result.metrics.responseSampleCount, 512);
  assert.equal(result.metrics.maximumSolverEvidenceAbsolute, 0);
  assert.equal(
    result.metrics.maximumSolverModeCoefficientL2Relative,
    0,
  );
  assert.equal(
    result.metrics.minimumSolverModeModalAssuranceCriterion,
    1,
  );
});

test("response tampering is reported as scientific mismatch", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "mandelhowl-diff-test-"));
  const candidate = path.join(temporary, path.basename(pinned));
  try {
    cpSync(pinned, candidate, { recursive: true });
    const responsePath = path.join(candidate, "response.bin");
    const response = readFileSync(responsePath);
    response.writeDoubleLE(response.readDoubleLE(24) + 0.01, 24);
    writeFileSync(responsePath, response);
    const result = compareDatasets({
      projectRoot,
      leftRoot: pinned,
      rightRoot: candidate,
    });
    assert.equal(result.equivalent, false);
    assert.ok(
      result.mismatches.some((row) =>
        row.path.startsWith("response[0]."),
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("versioned runtime modal output requires byte-identical modes", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-modal-identity-test-"),
  );
  const left = path.join(temporary, "left");
  const right = path.join(temporary, "right");
  try {
    cpSync(pinned, left, { recursive: true });
    cpSync(pinned, right, { recursive: true });
    const algorithm = JSON.parse(
      readFileSync(
        path.join(
          projectRoot,
          "specs",
          "physics",
          "baker-algorithm.v1.json",
        ),
        "utf8",
      ),
    );
    for (const root of [left, right]) {
      const manifestPath = path.join(root, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.algorithmRevision = algorithm.algorithmRevision;
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    }
    const modesPath = path.join(right, "modes.bin");
    const modes = readFileSync(modesPath);
    modes.writeDoubleLE(modes.readDoubleLE(48) + 1e-12, 48);
    writeFileSync(modesPath, modes);
    const result = compareDatasets({
      projectRoot,
      leftRoot: left,
      rightRoot: right,
    });
    assert.equal(result.equivalent, false);
    assert.equal(result.metrics.modesByteIdentical, false);
    assert.ok(
      result.mismatches.some((row) => row.path === "modes.binarySha256"),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("scientific provenance tampering is reported as disagreement", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-provenance-test-"),
  );
  const candidate = path.join(temporary, path.basename(pinned));
  try {
    cpSync(pinned, candidate, { recursive: true });
    const provenancePath = path.join(candidate, "provenance.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    provenance.modes[0].naturalFrequencyHz += 1;
    writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
    const result = compareDatasets({
      projectRoot,
      leftRoot: pinned,
      rightRoot: candidate,
    });
    assert.equal(result.equivalent, false);
    assert.ok(
      result.mismatches.some((row) =>
        row.path.startsWith("provenance.scientific.modes[0]"),
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("mode-shape perturbation is rejected by aggregate L2 and MAC gates", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-mode-shape-test-"),
  );
  const candidate = path.join(temporary, path.basename(pinned));
  try {
    cpSync(pinned, candidate, { recursive: true });
    const evidencePath = path.join(
      candidate,
      "science",
      "solver-evidence.bin",
    );
    const evidence = readFileSync(evidencePath);
    const basisCount = evidence.readUInt32LE(12);
    const firstCoefficientOffset = 20 + basisCount * basisCount * 8;
    evidence.writeDoubleLE(
      evidence.readDoubleLE(firstCoefficientOffset) + 0.01,
      firstCoefficientOffset,
    );
    writeFileSync(evidencePath, evidence);
    const result = compareDatasets({
      projectRoot,
      leftRoot: pinned,
      rightRoot: candidate,
    });
    assert.equal(result.equivalent, false);
    assert.ok(
      result.metrics.maximumSolverModeCoefficientL2Relative >
        1e-8,
    );
    assert.ok(
      result.metrics.minimumSolverModeModalAssuranceCriterion <
        0.999999999,
    );
    assert.ok(
      result.mismatches.some(
        (row) =>
          row.path ===
          "solverEvidence.modes[0].coefficientL2Relative",
      ),
    );
    assert.ok(
      result.mismatches.some(
        (row) =>
          row.path ===
          "solverEvidence.modes[0].modalAssuranceCriterion",
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("independent generation requires explicit revision and algorithm evidence", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-algorithm-evidence-test-"),
  );
  const left = path.join(temporary, "left");
  const right = path.join(temporary, "right");
  try {
    for (const candidate of [left, right]) {
      cpSync(pinned, candidate, { recursive: true });
      const manifestPath = path.join(candidate, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.algorithmRevision;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(
        path.join(candidate, "science", "baker-algorithm.v1.json"),
      );
    }
    const result = compareDatasets({
      projectRoot,
      leftRoot: left,
      rightRoot: right,
      expectedLeftGenerator: "tools/physics-baker-rs",
      expectedRightGenerator: "tools/physics-baker-rs",
    });
    assert.equal(result.equivalent, false);
    assert.ok(
      result.mismatches.some((row) =>
        row.path.endsWith("manifest.algorithmRevision"),
      ),
    );
    assert.ok(
      result.mismatches.some((row) =>
        row.path.endsWith("algorithmContractSha256"),
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("independent generation reports and enforces both generator identities", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-generator-test-"),
  );
  const rustCandidate = path.join(temporary, "rust");
  const pythonCandidate = path.join(temporary, "python");
  const algorithmPath = path.join(
    projectRoot,
    "specs",
    "physics",
    "baker-algorithm.v1.json",
  );
  const algorithmBytes = readFileSync(algorithmPath);
  const algorithm = JSON.parse(algorithmBytes.toString("utf8"));
  try {
    for (const [candidate, generator] of [
      [rustCandidate, "tools/physics-baker-rs"],
      [pythonCandidate, "tools/physics-baker"],
    ]) {
      cpSync(pinned, candidate, { recursive: true });
      const manifestPath = path.join(candidate, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
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
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(
        path.join(candidate, "science", "baker-algorithm.v1.json"),
        algorithmBytes,
      );
    }
    const result = compareDatasets({
      projectRoot,
      leftRoot: rustCandidate,
      rightRoot: pythonCandidate,
      expectedLeftGenerator: "tools/physics-baker-rs",
      expectedRightGenerator: "tools/physics-baker",
    });
    assert.equal(result.equivalent, true);
    assert.equal(
      result.compatibility.leftGenerator,
      "tools/physics-baker-rs",
    );
    assert.equal(
      result.compatibility.rightGenerator,
      "tools/physics-baker",
    );
    assert.match(
      result.compatibility.leftDatasetId,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(
      result.compatibility.leftDatasetId,
      result.compatibility.rightDatasetId,
    );
    assert.match(
      result.compatibility.leftManifestSha256,
      /^[a-f0-9]{64}$/,
    );
    assert.notEqual(
      result.compatibility.leftManifestSha256,
      result.compatibility.rightManifestSha256,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("versioned Mandelbrot material section profiles require exact N-version identity", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-material-section-test-"),
  );
  const left = path.join(temporary, "left");
  const right = path.join(temporary, "right");
  try {
    cpSync(pinned, left, { recursive: true });
    cpSync(pinned, right, { recursive: true });
    const profile = {
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
    for (const root of [left, right]) {
      const manifestPath = path.join(root, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.plate.materialSectionProfile = structuredClone(profile);
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    }
    const rightManifestPath = path.join(right, "manifest.json");
    const rightManifest = JSON.parse(
      readFileSync(rightManifestPath, "utf8"),
    );
    rightManifest.plate.materialSectionProfile.thicknessUnorm8[31] += 1;
    writeFileSync(
      rightManifestPath,
      `${JSON.stringify(rightManifest)}\n`,
    );

    const result = compareDatasets({
      projectRoot,
      leftRoot: left,
      rightRoot: right,
    });
    assert.equal(result.equivalent, false);
    assert.ok(
      result.mismatches.some(
        (row) =>
          row.path ===
          "manifest.plate.materialSectionProfile.thicknessUnorm8[31]",
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("non-finite mode, response, solver, and field scalars are rejected", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "mandelhowl-finite-test-"));
  const candidate = path.join(temporary, path.basename(pinned));
  try {
    cpSync(pinned, candidate, { recursive: true });
    for (const [relative, offset, width, writeInvalid] of [
      [
        "modes.bin",
        16 + 32,
        8,
        (buffer) => buffer.writeDoubleLE(Number.NaN, 16 + 32),
      ],
      [
        "response.bin",
        16,
        8,
        (buffer) => buffer.writeDoubleLE(Number.POSITIVE_INFINITY, 16),
      ],
      [
        path.join("science", "solver-evidence.bin"),
        20,
        8,
        (buffer) => buffer.writeDoubleLE(Number.NaN, 20),
      ],
      [
        path.join("field", "mandelbrot-field.bin"),
        16,
        4,
        (buffer) => buffer.writeFloatLE(Number.NEGATIVE_INFINITY, 16),
      ],
    ]) {
      const target = path.join(candidate, relative);
      const buffer = readFileSync(target);
      const original = Buffer.from(buffer.subarray(offset, offset + width));
      writeInvalid(buffer);
      writeFileSync(target, buffer);
      const result = compareDatasetsSafely({
        projectRoot,
        leftRoot: pinned,
        rightRoot: candidate,
      });
      assert.equal(result.equivalent, false, relative);
      assert.match(result.comparatorError, /must be finite/, relative);
      original.copy(buffer, offset);
      writeFileSync(target, buffer);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
