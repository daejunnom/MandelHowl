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
