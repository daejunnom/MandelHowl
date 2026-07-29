import assert from "node:assert/strict";
import test from "node:test";

import { decideNVersion } from "../src/policy.mjs";

const success = (backend) => ({
  backend,
  status: "success",
  availabilityFailure: false,
  code: "MH_BAKER_OK",
});
const missing = {
  backend: "rust-native",
  status: "missing",
  availabilityFailure: true,
  code: "MH_BAKER_EXECUTABLE_MISSING",
};

test("semantic agreement promotes the Rust primary candidate", () => {
  const result = decideNVersion({
    rust: success("rust-native"),
    python: success("python-stdlib"),
    comparison: { equivalent: true },
    rustCandidate: "rust-dataset",
    pythonCandidate: "python-dataset",
    lastKnownGoodDataset: "lkg",
  });
  assert.equal(result.state, "dual-verified");
  assert.equal(result.selectedDataset, "rust-dataset");
  assert.equal(result.promotionAllowed, true);
  assert.equal(result.releaseEligible, true);
});

test("Rust availability failure degrades to Python without promotion", () => {
  const result = decideNVersion({
    rust: missing,
    python: success("python-stdlib"),
    pythonCandidate: "python-dataset",
    lastKnownGoodDataset: "lkg",
  });
  assert.equal(result.state, "degraded-python");
  assert.equal(result.selectedDataset, "python-dataset");
  assert.equal(result.failOperational, true);
  assert.equal(result.promotionAllowed, false);
});

test("semantic mismatch is split-brain and retains last-known-good", () => {
  const result = decideNVersion({
    rust: success("rust-native"),
    python: success("python-stdlib"),
    comparison: { equivalent: false },
    rustCandidate: "rust-dataset",
    pythonCandidate: "python-dataset",
    lastKnownGoodDataset: "lkg",
  });
  assert.equal(result.state, "split-brain");
  assert.equal(result.selectedSource, "last-known-good");
  assert.equal(result.selectedDataset, "lkg");
  assert.equal(result.promotionAllowed, false);
});

test("split-brain cannot claim fail-operational without a verified LKG", () => {
  const result = decideNVersion({
    rust: success("rust-native"),
    python: success("python-stdlib"),
    comparison: { equivalent: false },
    rustCandidate: "rust-dataset",
    pythonCandidate: "python-dataset",
    lastKnownGoodDataset: null,
  });
  assert.equal(result.state, "split-brain");
  assert.equal(result.selectedSource, null);
  assert.equal(result.selectedDataset, null);
  assert.equal(result.failOperational, false);
});

test("scientific rejection is not treated as an availability fallback", () => {
  const result = decideNVersion({
    rust: {
      backend: "rust-native",
      status: "rejected",
      availabilityFailure: false,
      code: "MH_BAKER_SCIENTIFIC_REJECTION",
    },
    python: success("python-stdlib"),
    pythonCandidate: "python-dataset",
    lastKnownGoodDataset: "lkg",
  });
  assert.equal(result.state, "split-brain");
  assert.equal(result.selectedDataset, "lkg");
});

test("scientific rejection plus unavailable peer remains split-brain", () => {
  const result = decideNVersion({
    rust: {
      backend: "rust-native",
      status: "rejected",
      availabilityFailure: false,
      scientificFailure: true,
      code: "MH_BAKER_SCIENTIFIC_REJECTION",
    },
    python: {
      backend: "python-stdlib",
      status: "missing",
      availabilityFailure: true,
      scientificFailure: false,
      code: "MH_BAKER_EXECUTABLE_MISSING",
    },
    lastKnownGoodDataset: "lkg",
  });
  assert.equal(result.state, "split-brain");
  assert.equal(result.selectedDataset, "lkg");
});

test("two scientific rejections retain LKG as split-brain", () => {
  const rejected = {
    status: "rejected",
    availabilityFailure: false,
    scientificFailure: true,
    code: "MH_BAKER_SCIENTIFIC_REJECTION",
  };
  const result = decideNVersion({
    rust: { ...rejected, backend: "rust-native" },
    python: { ...rejected, backend: "python-stdlib" },
    lastKnownGoodDataset: "lkg",
  });
  assert.equal(result.state, "split-brain");
  assert.equal(result.failOperational, true);
});
