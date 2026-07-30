export type DiagnosticEvidenceState =
  | "confirmed"
  | "needs_evidence"
  | "inconclusive";

export type DiagnosticSeverity = "info" | "warning" | "fatal";

export interface DiagnosticEvidence {
  readonly key: string;
  readonly value: string | number | boolean | null;
  readonly source: string;
}

export interface DiagnosticRecord {
  readonly code: string;
  readonly evidenceState: DiagnosticEvidenceState;
  readonly severity: DiagnosticSeverity;
  readonly messageKey: string;
  readonly evidence: readonly DiagnosticEvidence[];
}

export interface DiagnosticRecordInput {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly evidenceState?: DiagnosticEvidenceState;
  readonly messageKey: string;
  readonly evidence?: readonly DiagnosticEvidence[];
}

/**
 * Stable diagnostic identifiers use uppercase segments separated by `-` or
 * `_`. This accepts both product-facing `MH-*` codes and dataset validator
 * codes such as `DATASET_HASH_MISMATCH`.
 */
export const DIAGNOSTIC_CODE_PATTERN =
  /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*$/;

export function isDiagnosticCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DIAGNOSTIC_CODE_PATTERN.test(value)
  );
}

export function createDiagnosticRecord(
  input: DiagnosticRecordInput,
): DiagnosticRecord {
  if (!isDiagnosticCode(input.code)) {
    throw new TypeError(`Invalid diagnostic code ${JSON.stringify(input.code)}`);
  }
  if (input.messageKey.trim() === "") {
    throw new TypeError("Diagnostic messageKey must not be empty");
  }
  const evidence = (input.evidence ?? []).map((item) => {
    if (item.key.trim() === "" || item.source.trim() === "") {
      throw new TypeError("Diagnostic evidence key and source must not be empty");
    }
    return Object.freeze({ ...item });
  });
  return Object.freeze({
    code: input.code,
    severity: input.severity,
    evidenceState: input.evidenceState ?? "confirmed",
    messageKey: input.messageKey,
    evidence: Object.freeze(evidence),
  });
}
