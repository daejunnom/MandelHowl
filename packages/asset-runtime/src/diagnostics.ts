import type {
  DiagnosticEvidence,
  DiagnosticEvidenceState,
  DiagnosticRecord,
  DiagnosticSeverity,
} from "../../contracts/src";

export const ASSET_DIAGNOSTIC_CODES = Object.freeze({
  manifestFetchFailed: "DATASET_MANIFEST_FETCH_FAILED",
  manifestJsonInvalid: "DATASET_MANIFEST_JSON_INVALID",
  manifestSchemaInvalid: "DATASET_MANIFEST_SCHEMA_INVALID",
  datasetIdentityMismatch: "DATASET_IDENTITY_MISMATCH",
  expectedDatasetMismatch: "DATASET_EXPECTED_ID_MISMATCH",
  runtimeIncompatible: "DATASET_RUNTIME_INCOMPATIBLE",
  assetPathUnsafe: "DATASET_ASSET_PATH_UNSAFE",
  assetFetchFailed: "DATASET_ASSET_FETCH_FAILED",
  assetByteLengthMismatch: "DATASET_ASSET_BYTE_LENGTH_MISMATCH",
  assetHashMismatch: "DATASET_ASSET_HASH_MISMATCH",
  checksumsInvalid: "DATASET_CHECKSUMS_INVALID",
  binaryInvalid: "DATASET_BINARY_INVALID",
  dataInvalid: "DATASET_CONTENT_INVALID",
  ready: "DATASET_READY",
} as const);

export function createDiagnostic(
  code: string,
  severity: DiagnosticSeverity,
  evidenceState: DiagnosticEvidenceState,
  messageKey: string,
  evidence: readonly DiagnosticEvidence[] = [],
): DiagnosticRecord {
  return Object.freeze({
    code,
    severity,
    evidenceState,
    messageKey,
    evidence: Object.freeze([...evidence]),
  });
}
export function evidence(
  key: string,
  value: string | number | boolean | null,
  source: string,
): DiagnosticEvidence {
  return Object.freeze({ key, value, source });
}
