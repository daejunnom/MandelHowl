"""Structured, evidence-bearing diagnostics for offline baker failures."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .schema_validation import SchemaValidationError


@dataclass(frozen=True)
class BakerDiagnostic:
    code: str
    status: str
    severity: str
    message: str
    evidence: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": "mandelhowl.baker-diagnostic.v1",
            "code": self.code,
            "status": self.status,
            "severity": self.severity,
            "message": self.message,
            "evidence": self.evidence,
        }


def from_exception(error: BaseException, command: str | None) -> BakerDiagnostic:
    message = str(error)
    lower = message.lower()
    if isinstance(error, SchemaValidationError):
        code = "PHYSICS_SCHEMA_INVALID"
    elif isinstance(error, FileNotFoundError):
        code = "PHYSICS_INPUT_MISSING"
    elif "convergence" in lower or "cross-validation" in lower:
        code = "PHYSICS_CONVERGENCE_FAILED"
    elif "mass matrix" in lower or "eigensolver" in lower or "modes in" in lower:
        code = "PHYSICS_SOLVER_FAILED"
    elif "manufacturing" in lower:
        code = "PHYSICS_MANUFACTURING_FAILED"
    elif any(token in lower for token in ("sha-256", "checksum", "content-address")):
        code = "PHYSICS_DATASET_INTEGRITY_FAILED"
    elif isinstance(error, OSError):
        code = "PHYSICS_IO_FAILED"
    else:
        code = "PHYSICS_VALIDATION_FAILED"
    return BakerDiagnostic(
        code=code,
        status="confirmed",
        severity="error",
        message=message or error.__class__.__name__,
        evidence={
            "exceptionType": error.__class__.__name__,
            "command": command,
        },
    )
