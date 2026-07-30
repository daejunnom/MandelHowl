import path from "node:path";

const DATASET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const PINNED_ATTESTATION_ROOT = "release/attestations";
export const PINNED_ATTESTATION_REPORT = "attestation.json";

export function pinnedDatasetDirectoryName(datasetId) {
  if (
    typeof datasetId !== "string" ||
    !DATASET_ID_PATTERN.test(datasetId)
  ) {
    throw new Error(
      "Pinned OCI attestation requires a content-addressed dataset ID.",
    );
  }
  return datasetId.slice("sha256:".length);
}

export function resolvePinnedAttestation({
  projectRoot,
  lock,
}) {
  const directoryName = pinnedDatasetDirectoryName(lock?.datasetId);
  if (
    lock?.schemaVersion !== "mandelhowl.dataset-lock.v1" ||
    lock.datasetDirectory !== `assets/generated/${directoryName}` ||
    !SHA256_PATTERN.test(lock?.manifestSha256 ?? "")
  ) {
    throw new Error(
      "Pinned OCI attestation cannot be resolved from an invalid dataset lock.",
    );
  }
  const relativeDirectory = `${PINNED_ATTESTATION_ROOT}/${directoryName}`;
  const relativeReportPath =
    `${relativeDirectory}/${PINNED_ATTESTATION_REPORT}`;
  const root = path.resolve(projectRoot);
  const reportPath = path.resolve(
    root,
    ...relativeReportPath.split("/"),
  );
  const relativeToRoot = path.relative(root, reportPath);
  if (
    relativeToRoot.startsWith(`..${path.sep}`) ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Pinned OCI attestation path escaped the project root.");
  }
  return Object.freeze({
    datasetId: lock.datasetId,
    directoryName,
    relativeDirectory,
    relativeReportPath,
    directoryPath: path.dirname(reportPath),
    reportPath,
  });
}
