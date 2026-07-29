const SUCCESS = "success";

function unavailable(result) {
  return Boolean(result?.availabilityFailure);
}

function scientificFailure(result) {
  return result?.scientificFailure === true || result?.status === "rejected";
}

function lastKnownGood(lkg) {
  return lkg
    ? {
        selectedSource: "last-known-good",
        selectedDataset: lkg,
        failOperational: true,
      }
    : {
        selectedSource: null,
        selectedDataset: null,
        failOperational: false,
      };
}

/**
 * Two independent implementations cannot vote through a scientific
 * disagreement. Availability failures may degrade to the surviving version;
 * scientific rejection or semantic mismatch preserves the LKG.
 */
export function decideNVersion({
  rust,
  python,
  comparison = null,
  rustCandidate = null,
  pythonCandidate = null,
  lastKnownGoodDataset = null,
}) {
  if (
    rust?.status === SUCCESS &&
    python?.status === SUCCESS &&
    comparison?.equivalent === true
  ) {
    return {
      state: "dual-verified",
      selectedSource: "rust-native",
      selectedDataset: rustCandidate,
      failOperational: true,
      degraded: false,
      splitBrain: false,
      promotionAllowed: true,
      releaseEligible: true,
      reason: "both implementations accepted semantically equivalent output",
    };
  }

  if (
    rust?.status === SUCCESS &&
    python?.status === SUCCESS &&
    comparison?.equivalent !== true
  ) {
    return {
      state: "split-brain",
      ...lastKnownGood(lastKnownGoodDataset),
      degraded: true,
      splitBrain: true,
      promotionAllowed: false,
      releaseEligible: false,
      reason: "independent implementations produced different scientific output",
    };
  }

  if (unavailable(rust) && python?.status === SUCCESS) {
    return {
      state: "degraded-python",
      selectedSource: "python-stdlib",
      selectedDataset: pythonCandidate,
      failOperational: true,
      degraded: true,
      splitBrain: false,
      promotionAllowed: false,
      releaseEligible: false,
      reason: `Rust availability failure: ${rust.code}`,
    };
  }

  if (rust?.status === SUCCESS && unavailable(python)) {
    return {
      state: "degraded-rust",
      selectedSource: "rust-native",
      selectedDataset: rustCandidate,
      failOperational: true,
      degraded: true,
      splitBrain: false,
      promotionAllowed: false,
      releaseEligible: false,
      reason: `Python availability failure: ${python.code}`,
    };
  }

  if (
    (rust?.status === SUCCESS && python?.status !== SUCCESS) ||
    (python?.status === SUCCESS && rust?.status !== SUCCESS)
  ) {
    return {
      state: "split-brain",
      ...lastKnownGood(lastKnownGoodDataset),
      degraded: true,
      splitBrain: true,
      promotionAllowed: false,
      releaseEligible: false,
      reason: "one implementation scientifically rejected or crashed",
    };
  }

  if (scientificFailure(rust) || scientificFailure(python)) {
    return {
      state: "split-brain",
      ...lastKnownGood(lastKnownGoodDataset),
      degraded: true,
      splitBrain: true,
      promotionAllowed: false,
      releaseEligible: false,
      reason:
        "at least one implementation scientifically rejected while no two-version agreement was possible",
    };
  }

  return {
    state: "unavailable",
    ...lastKnownGood(lastKnownGoodDataset),
    degraded: true,
    splitBrain: false,
    promotionAllowed: false,
    releaseEligible: false,
    reason: "neither implementation produced an accepted candidate",
  };
}
