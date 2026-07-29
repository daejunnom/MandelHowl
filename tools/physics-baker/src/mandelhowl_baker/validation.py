"""Integrated validation for a packaged MandelHowl physics dataset."""

from __future__ import annotations

import copy
import json
import math
import struct
from pathlib import Path
from typing import Any

from .canonical import canonical_json_bytes, sha256_bytes, sha256_file
from .ktx2 import validate_ktx2
from .packaging import IDENTITY_SCOPE
from .schema_validation import validate as validate_schema


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _identity(manifest: dict[str, Any]) -> str:
    identity = copy.deepcopy(manifest)
    identity.pop("datasetId", None)
    identity["contentAddressing"].pop("directoryName", None)
    return sha256_bytes(canonical_json_bytes(identity))


def decode_modes(path: Path) -> list[dict[str, Any]]:
    data = path.read_bytes()
    if len(data) < 16:
        raise ValueError("modes.bin is truncated")
    magic, version, header_bytes, count = struct.unpack_from("<8sHHI", data, 0)
    if magic != b"MHMODES1" or version != 1 or header_bytes != 16:
        raise ValueError("modes.bin header is incompatible")
    if len(data) != 16 + count * 96:
        raise ValueError("modes.bin length does not match its count")
    modes = []
    for index in range(count):
        offset = 16 + index * 96
        identifier = data[offset : offset + 24].split(b"\0", 1)[0].decode("utf-8")
        ordinal, texture_layer = struct.unpack_from("<II", data, offset + 24)
        (
            frequency,
            angular_frequency,
            damping,
            actuator,
            microphone,
            radiation,
            phase,
        ) = struct.unpack_from("<7d", data, offset + 32)
        sign = data[offset + 88]
        values = (
            frequency,
            angular_frequency,
            damping,
            actuator,
            microphone,
            radiation,
            phase,
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError(f"mode {identifier} contains a non-finite number")
        if ordinal != index + 1 or texture_layer != index:
            raise ValueError("mode ordinal/layer ordering is not canonical")
        if identifier != f"mode-{ordinal:03d}" or sign not in {0, 1}:
            raise ValueError("mode id or sign reference is invalid")
        if abs(angular_frequency - 2.0 * math.pi * frequency) > 1e-9 * angular_frequency:
            raise ValueError("angular and ordinary frequencies disagree")
        modes.append(
            {
                "modeId": identifier,
                "ordinal": ordinal,
                "textureLayer": texture_layer,
                "naturalFrequencyHz": frequency,
                "angularFrequencyRadPerSecond": angular_frequency,
                "dampingRatio": damping,
                "actuatorCoupling": actuator,
                "microphoneCoupling": microphone,
                "radiationEfficiency": radiation,
                "phaseReferenceRad": phase,
                "signReference": sign,
            }
        )
    frequencies = [mode["naturalFrequencyHz"] for mode in modes]
    if frequencies != sorted(frequencies) or any(frequency <= 0.0 for frequency in frequencies):
        raise ValueError("mode frequencies must be positive and ascending")
    return modes


def decode_response(path: Path) -> list[tuple[float, float, float]]:
    data = path.read_bytes()
    if len(data) < 16:
        raise ValueError("response.bin is truncated")
    magic, version, header_bytes, count = struct.unpack_from("<8sHHI", data, 0)
    if magic != b"MHRESPN1" or version != 1 or header_bytes != 16:
        raise ValueError("response.bin header is incompatible")
    if len(data) != 16 + count * 24:
        raise ValueError("response.bin length does not match its count")
    response = [
        struct.unpack_from("<ddd", data, 16 + index * 24) for index in range(count)
    ]
    if not all(all(math.isfinite(value) for value in row) for row in response):
        raise ValueError("response.bin contains a non-finite number")
    frequencies = [row[0] for row in response]
    if frequencies != sorted(frequencies):
        raise ValueError("response frequencies are not ascending")
    return response


def decode_solver_evidence(
    path: Path,
) -> tuple[list[list[float]], list[list[float]]]:
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError("solver evidence is truncated")
    magic, version, basis_count, mode_count = struct.unpack_from("<8sIII", data, 0)
    if magic != b"MHEVID01" or version != 1:
        raise ValueError("solver evidence header is invalid")
    expected = 20 + 8 * (basis_count * basis_count + basis_count * mode_count)
    if len(data) != expected:
        raise ValueError("solver evidence length is invalid")
    offset = 20
    mass = []
    for _ in range(basis_count):
        mass.append(list(struct.unpack_from(f"<{basis_count}d", data, offset)))
        offset += basis_count * 8
    coefficients = []
    for _ in range(mode_count):
        coefficients.append(list(struct.unpack_from(f"<{basis_count}d", data, offset)))
        offset += basis_count * 8
    return mass, coefficients


def modal_orthogonality_error(path: Path) -> tuple[float, float]:
    mass, coefficients = decode_solver_evidence(path)
    maximum_diagonal_error = 0.0
    maximum_off_diagonal = 0.0
    for left_index, left in enumerate(coefficients):
        weighted = [
            sum(mass[row][column] * left[column] for column in range(len(left)))
            for row in range(len(left))
        ]
        for right_index, right in enumerate(coefficients):
            inner = sum(right[index] * weighted[index] for index in range(len(left)))
            if left_index == right_index:
                maximum_diagonal_error = max(maximum_diagonal_error, abs(inner - 1.0))
            else:
                maximum_off_diagonal = max(maximum_off_diagonal, abs(inner))
    return maximum_diagonal_error, maximum_off_diagonal


def validate_dataset(dataset: Path) -> dict[str, Any]:
    dataset = dataset.resolve()
    manifest = _read_json(dataset / "manifest.json")
    repository = Path(__file__).resolve().parents[4]
    manifest_schema = _read_json(
        repository
        / "packages"
        / "contracts"
        / "schemas"
        / "resonance-manifest.schema.json"
    )
    validate_schema(manifest, manifest_schema)
    digest = _identity(manifest)
    if manifest.get("datasetId") != f"sha256:{digest}":
        raise ValueError("manifest datasetId does not match its canonical identity")
    addressing = manifest.get("contentAddressing", {})
    if addressing.get("directoryName") != digest or dataset.name != digest:
        raise ValueError("content-addressed directory name does not match manifest")
    if addressing.get("identityScope") != IDENTITY_SCOPE:
        raise ValueError("manifest identity scope is incompatible")

    descriptors: list[dict[str, Any]] = []
    files = manifest["files"]
    for key in (
        "plateSpec",
        "modes",
        "response",
        "provenance",
        "convergenceReport",
        "coverageReport",
        "checksums",
    ):
        descriptors.append(files[key])
    descriptors.extend(files["textures"])
    for descriptor in descriptors:
        path = dataset / descriptor["path"]
        if not path.is_file():
            raise ValueError(f"manifest asset is missing: {descriptor['path']}")
        if path.stat().st_size != descriptor["byteLength"]:
            raise ValueError(f"byte length mismatch: {descriptor['path']}")
        if sha256_file(path) != descriptor["sha256"]:
            raise ValueError(f"SHA-256 mismatch: {descriptor['path']}")
    if manifest["plate"]["specSha256"] != files["plateSpec"]["sha256"]:
        raise ValueError(
            "plate.specSha256 does not match files.plateSpec byte hash"
        )

    checksums = _read_json(dataset / files["checksums"]["path"])
    if checksums.get("schemaVersion") != "mandelhowl.checksums.v1":
        raise ValueError("checksums schema version is incompatible")
    if checksums.get("algorithm") != "sha256":
        raise ValueError("checksums algorithm must be sha256")
    checksum_paths = set()
    for row in checksums.get("files", []):
        relative = row["path"]
        if relative in checksum_paths or relative in {"manifest.json", "checksums.json"}:
            raise ValueError("checksums contains a duplicate or circular entry")
        checksum_paths.add(relative)
        path = dataset / relative
        if (
            not path.is_file()
            or path.stat().st_size != row["byteLength"]
            or sha256_file(path) != row["sha256"]
        ):
            raise ValueError(f"checksums inventory mismatch: {relative}")
    actual_inventory = {
        path.relative_to(dataset).as_posix()
        for path in dataset.rglob("*")
        if path.is_file() and path.name not in {"manifest.json", "checksums.json"}
    }
    if checksum_paths != actual_inventory:
        raise ValueError("checksums inventory is not a complete bidirectional match")

    modes = decode_modes(dataset / files["modes"]["path"])
    if len(modes) != manifest["modeCount"]:
        raise ValueError("mode count differs between manifest and modes binary")
    frequency_range = manifest["frequencyRange"]
    if modes[0]["naturalFrequencyHz"] < frequency_range["minimumHz"]:
        raise ValueError("first mode is below manifest frequency range")
    if modes[-1]["naturalFrequencyHz"] > frequency_range["maximumHz"]:
        raise ValueError("last mode is above manifest frequency range")
    response = decode_response(dataset / files["response"]["path"])
    if (
        abs(response[0][0] - frequency_range["minimumHz"]) > 1e-9
        or abs(response[-1][0] - frequency_range["maximumHz"]) > 1e-9
    ):
        raise ValueError("response endpoints differ from manifest frequency range")

    mode_ids = [mode["modeId"] for mode in modes]
    for texture in files["textures"]:
        info = validate_ktx2((dataset / texture["path"]).read_bytes())
        if (
            info.width != texture["widthPx"]
            or info.height != texture["heightPx"]
            or info.layers != texture["layers"]
            or texture["modeIds"] != mode_ids
        ):
            raise ValueError(f"texture metadata mismatch: {texture['path']}")

    convergence = _read_json(dataset / files["convergenceReport"]["path"])
    if not convergence.get("accepted"):
        raise ValueError("numerical convergence report is not accepted")
    manufacturing = _read_json(dataset / files["provenance"]["path"])["manufacturing"]
    plate_spec = _read_json(dataset / files["plateSpec"]["path"])
    plate_schema = _read_json(
        repository
        / "packages"
        / "contracts"
        / "schemas"
        / "plate-spec.schema.json"
    )
    validate_schema(plate_spec, plate_schema)
    for check in (
        "massWithinLimits",
        "centreOfMassWithinLimit",
        "gradientWithinLimit",
        "minimumThicknessWithinLimit",
        "minimumFeatureWithinLimit",
    ):
        if manufacturing.get(check) is not True:
            raise ValueError(f"manufacturing check failed: {check}")
    coverage = _read_json(dataset / files["coverageReport"]["path"])
    targets = sorted(row.get("target") for row in coverage.get("outputs", []))
    if targets != list(range(101)):
        raise ValueError("coverage report does not inventory every output 0..100")
    diagonal_error, off_diagonal = modal_orthogonality_error(
        dataset / "science" / "solver-evidence.bin"
    )
    if diagonal_error > 5e-8 or off_diagonal > 5e-7:
        raise ValueError(
            "unit-modal-mass orthogonality failed: "
            f"diagonal={diagonal_error}, offDiagonal={off_diagonal}"
        )
    return {
        "datasetId": manifest["datasetId"],
        "manifestSha256": sha256_file(dataset / "manifest.json"),
        "modeCount": len(modes),
        "responseSampleCount": len(response),
        "textureCount": len(files["textures"]),
        "maximumModalMassDiagonalError": diagonal_error,
        "maximumModalMassOffDiagonal": off_diagonal,
        "coverageVerificationStatus": coverage.get("verificationStatus"),
        "valid": True,
    }
