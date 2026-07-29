"""Content-addressed runtime dataset packaging."""

from __future__ import annotations

import copy
import json
import math
import shutil
import tempfile
from pathlib import Path
from typing import Any

from . import __version__
from .canonical import (
    canonical_json_bytes,
    pretty_json_bytes,
    sha256_bytes,
    sha256_file,
)
from .field import MaterialField
from .mesh import MeshEvidence, build_mesh_archive
from .postprocess import PostprocessedDataset
from .solver import SolveResult, solver_evidence_binary

IDENTITY_SCOPE = (
    "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests"
)


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _asset(path: Path, root: Path, media_type: str) -> dict[str, Any]:
    return {
        "path": path.relative_to(root).as_posix(),
        "byteLength": path.stat().st_size,
        "sha256": sha256_file(path),
        "mediaType": media_type,
    }


def _foundation_coverage(modes: PostprocessedDataset) -> dict[str, Any]:
    """Create deterministic physical anchors, not runtime reachability proof."""

    strongest = sorted(
        modes.modes,
        key=lambda mode: abs(mode.actuator_coupling * mode.microphone_coupling),
        reverse=True,
    )
    outputs = []
    for target in range(101):
        anchor = strongest[target % len(strongest)]
        fraction = target / 100.0
        # This globally-defined exponential capture estimate seeds the runtime
        # trajectory search; it is not a per-value branch in the runtime engine.
        dwell = 0.0 if target == 0 else -math.log(max(1e-6, 1.0 - 0.985 * fraction)) / 1.85
        approach = -1 if target % 2 else 1
        outputs.append(
            {
                "target": target,
                "verification": "candidate-requires-runtime-replay",
                "physicalAnchor": {
                    "modeId": anchor.mode_id,
                    "naturalFrequencyHz": anchor.natural_frequency_hz,
                    "approachDirection": approach,
                    "estimatedDwellSeconds": dwell,
                    "detuneRatio": (0.00035 + 0.000015 * (target % 11))
                    * approach,
                },
            }
        )
    return {
        "schemaVersion": "mandelhowl.coverage-report.v1",
        "verificationStatus": "physics-foundation-only",
        "model": "global-exponential-modal-capture-seed-v1",
        "perValueRuntimeExceptionTable": False,
        "targetRange": [0, 100],
        "outputs": outputs,
        "releaseEligible": False,
        "note": (
            "These are deterministic search seeds derived from baked mode coupling. "
            "A release bake must inject the runtime engine's replay-verified report "
            "with --coverage-report and --release."
        ),
    }


def _validate_external_coverage(report: dict[str, Any], release: bool) -> None:
    outputs = report.get("outputs")
    if not isinstance(outputs, list):
        raise ValueError("coverage report must contain an outputs array")
    targets = sorted(row.get("target") for row in outputs if isinstance(row, dict))
    if targets != list(range(101)):
        raise ValueError("coverage report must contain exactly one entry for every target 0..100")
    if report.get("perValueRuntimeExceptionTable") is not False:
        raise ValueError("coverage report must explicitly deny per-value runtime exceptions")
    if release:
        status = report.get("verificationStatus")
        if status not in {"runtime-replay-verified", "verified", "complete"}:
            raise ValueError(
                "release bake requires a runtime-replay-verified coverage report"
            )
        unverified = [
            row["target"]
            for row in outputs
            if row.get("verification") not in {"verified", "runtime-replay-verified"}
            and row.get("verified") is not True
        ]
        if unverified:
            raise ValueError(
                f"release coverage has unverified targets: {unverified[:8]}"
            )


def _manifest_identity_view(manifest: dict[str, Any]) -> dict[str, Any]:
    identity = copy.deepcopy(manifest)
    identity.pop("datasetId", None)
    identity["contentAddressing"].pop("directoryName", None)
    return identity


def package_dataset(
    *,
    output_root: Path,
    spec: dict[str, Any],
    spec_sha256: str,
    field: MaterialField,
    meshes: list[MeshEvidence],
    fine_result: SolveResult,
    convergence: dict[str, Any],
    postprocessed: PostprocessedDataset,
    external_coverage_path: Path | None,
    release: bool,
) -> Path:
    output_root = output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".mandelhowl-bake-", dir=output_root))
    try:
        # The runtime contract intentionally requires plate.specSha256 to equal
        # the byte hash of files.plateSpec. Store the canonical source bytes
        # themselves so provenance identity and asset integrity are identical.
        _write(temporary / "plate-spec.json", canonical_json_bytes(spec))
        _write(temporary / "field" / "mandelbrot-field.bin", field.to_binary())
        mesh_report = {
            "schemaVersion": "mandelhowl.mesh-evidence.v1",
            "domain": "annulus from clamped hub radius to free outer rim",
            "levels": [mesh.as_dict() for mesh in meshes],
            "qualityPolicy": {
                "negativeAreaAllowed": False,
                "disconnectedComponentsAllowed": False,
                "fingerprint": "sha256 over float64 node positions and uint32 triangle indices",
            },
        }
        _write(
            temporary / "mesh" / "mesh-evidence.json",
            pretty_json_bytes(mesh_report),
        )
        _write(
            temporary / "mesh" / "fine-polar-mesh.mhmz",
            build_mesh_archive(spec, spec["solverRequest"]["meshLevels"][-1]),
        )
        _write(temporary / "modes.bin", postprocessed.modes_binary)
        _write(temporary / "response.bin", postprocessed.response_binary)
        _write(
            temporary / "science" / "solver-evidence.bin",
            solver_evidence_binary(fine_result),
        )
        texture_paths: dict[str, Path] = {}
        for kind, data in postprocessed.textures.items():
            texture_path = temporary / "textures" / f"{kind}.ktx2"
            _write(texture_path, data)
            texture_paths[kind] = texture_path

        if external_coverage_path is not None:
            coverage = json.loads(external_coverage_path.read_text(encoding="utf-8"))
            _validate_external_coverage(coverage, release)
            coverage_source = "external-runtime-replay-report"
        else:
            if release:
                raise ValueError("--release requires --coverage-report")
            coverage = _foundation_coverage(postprocessed)
            coverage_source = "baker-physical-search-foundation"
        _write(temporary / "coverage-report.json", pretty_json_bytes(coverage))

        convergence = copy.deepcopy(convergence)
        convergence["meshEvidence"] = [mesh.as_dict() for mesh in meshes]
        cross_validation = copy.deepcopy(postprocessed.cross_validation)
        cross_tolerance = 0.15
        cross_validation["criterion"] = {
            "maximumRelativeFrequencyDifference": cross_tolerance
        }
        cross_validation["accepted"] = all(
            row["relativeDifference"] <= cross_tolerance
            for row in cross_validation["frequencyChecks"]
        )
        convergence["independentCrossValidation"] = cross_validation
        convergence["quadratureConvergenceAccepted"] = bool(convergence["accepted"])
        convergence["accepted"] = bool(
            convergence["accepted"] and cross_validation["accepted"]
        )
        if not convergence["accepted"]:
            raise ValueError(
                "physics convergence failed: quadrature and independent finite-"
                "difference cross-validation must both pass"
            )
        _write(
            temporary / "convergence-report.json",
            pretty_json_bytes(convergence),
        )

        solver_options = {
            "method": "variable-thickness-kirchhoff-love-rayleigh-ritz",
            "basisCount": len(fine_result.basis),
            "quadrature": fine_result.quadrature,
            "finiteDifferenceHessianStepRatio": 0.0005,
            "floatPrecision": "binary64",
            "randomSource": "forbidden",
        }
        options_sha256 = sha256_bytes(canonical_json_bytes(solver_options))
        environment_sentinel = sha256_bytes(
            b"not-containerized:cpython-stdlib:mandelhowl-physics-baker-1"
        )
        mode_summaries = [
            {
                "modeId": mode.mode_id,
                "ordinal": mode.ordinal,
                "naturalFrequencyHz": mode.natural_frequency_hz,
                "dampingRatio": mode.damping_ratio,
                "actuatorCoupling": mode.actuator_coupling,
                "microphoneCoupling": mode.microphone_coupling,
                "radiationEfficiency": mode.radiation_efficiency,
                "dominantBasis": {
                    "radialOrder": mode.dominant_radial_order,
                    "angularOrder": mode.dominant_angular_order,
                    "symmetry": mode.dominant_symmetry,
                },
                "signReference": mode.sign_reference,
                "textureLayer": mode.texture_layer,
            }
            for mode in postprocessed.modes
        ]
        provenance = {
            "schemaVersion": "mandelhowl.provenance.v1",
            "generator": {
                "name": "tools/physics-baker",
                "version": __version__,
                "dependencies": "Python 3.10+ standard library only",
                "randomSource": "forbidden",
            },
            "canonicalInput": {
                "plateId": spec["plateId"],
                "path": "specs/plate/mandelbrot-plate.v1.yaml",
                "canonicalJsonSha256": spec_sha256,
            },
            "solver": {
                "name": "mandelhowl-kirchhoff-love-rayleigh-ritz",
                "version": __version__,
                "options": solver_options,
                "optionsSha256": options_sha256,
                "containerized": False,
                "containerImageDigest": f"sha256:{environment_sentinel}",
                "containerDigestMeaning": (
                    "Explicit deterministic sentinel for an uncontainerized stdlib "
                    "run; it is not evidence that a container image was executed."
                ),
                "canonicalRequest": {
                    "elementFamily": spec["solverRequest"]["elementFamily"],
                    "requestedModeCount": spec["solverRequest"]["requestedModeCount"],
                },
                "executedMethod": "global-rayleigh-ritz-thin-plate-basis",
                "methodRequestMismatchRecorded": (
                    spec["solverRequest"]["elementFamily"]
                    != "kirchhoff-love-thin-plate"
                ),
                "normalization": "unit-modal-mass",
                "signRule": "positive-at-actuator-or-first-nonzero-node",
            },
            "manufacturing": field.statistics,
            "mesh": mesh_report,
            "convergenceReport": "convergence-report.json",
            "coverage": {
                "path": "coverage-report.json",
                "source": coverage_source,
                "releaseBake": release,
            },
            "response": postprocessed.response_metadata,
            "textures": {
                "requested": spec["textureRequest"],
                "emittedRuntimeLod": postprocessed.texture_metadata,
                "precisionStatement": (
                    "The emitted uncompressed R8/RG8 KTX2 arrays match the canonical "
                    "runtime request and are derived from float64 solver modes. "
                    "No Basis/UASTC block compression is claimed."
                ),
            },
            "modes": mode_summaries,
            "scientificScope": {
                "established": [
                    "finite-resolution Mandelbrot field mapped into thickness",
                    "variable-thickness Kirchhoff-Love bending energy",
                    "generalized eigenproblem with unit-modal-mass normalization",
                    "nodal/low-velocity sand-density postprocessing",
                ],
                "limitations": [
                    "Rayleigh-Ritz global basis is not a shell finite-element solve",
                    "the clamped hub is represented as an annular essential boundary",
                    "air loading, nonlinear material response, and grain dynamics are omitted",
                    "the independent finite-difference check is a reduced cross-check, not certification",
                    "runtime textures are a quantized LOD of float64 solver fields",
                ],
                "claimPolicy": (
                    "The Mandelbrot iteration defines a finite material field; it "
                    "does not directly generate sound or guarantee Mandelbrot-shaped sand."
                ),
            },
            "extraEvidenceFiles": [
                "field/mandelbrot-field.bin",
                "mesh/mesh-evidence.json",
                "mesh/fine-polar-mesh.mhmz",
                "science/solver-evidence.bin",
            ],
        }
        _write(temporary / "provenance.json", pretty_json_bytes(provenance))

        generation_report = {
            "schemaVersion": "mandelhowl.generation-report.v1",
            "deterministic": True,
            "releaseBake": release,
            "manufacturingChecksPassed": all(
                bool(field.statistics[key])
                for key in (
                    "massWithinLimits",
                    "centreOfMassWithinLimit",
                    "gradientWithinLimit",
                    "minimumThicknessWithinLimit",
                    "minimumFeatureWithinLimit",
                )
            ),
            "meshChecksPassed": all(
                mesh.inverted_triangle_count == 0
                and mesh.connected_component_count == 1
                and mesh.minimum_signed_area_m2 > 0.0
                for mesh in meshes
            ),
            "convergenceChecksPassed": bool(convergence["accepted"]),
            "coverageSource": coverage_source,
            "knownContractDeviations": [],
        }
        _write(
            temporary / "generation-report.json",
            pretty_json_bytes(generation_report),
        )

        inventory_paths = sorted(
            path
            for path in temporary.rglob("*")
            if path.is_file() and path.name not in {"manifest.json", "checksums.json"}
        )
        checksums = {
            "schemaVersion": "mandelhowl.checksums.v1",
            "algorithm": "sha256",
            "files": [
                {
                    "path": path.relative_to(temporary).as_posix(),
                    "byteLength": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
                for path in inventory_paths
            ],
        }
        _write(temporary / "checksums.json", pretty_json_bytes(checksums))

        texture_descriptors = []
        mode_ids = [mode.mode_id for mode in postprocessed.modes]
        for kind in (
            "signed-displacement",
            "normal",
            "nodal-mask",
            "sand-density",
        ):
            descriptor = _asset(texture_paths[kind], temporary, "image/ktx2")
            descriptor.update(
                {
                    "kind": kind,
                    "modeIds": mode_ids,
                    "widthPx": postprocessed.texture_metadata[kind]["widthPx"],
                    "heightPx": postprocessed.texture_metadata[kind]["heightPx"],
                    "layers": len(mode_ids),
                    "uvOrigin": "negative-x-negative-y",
                }
            )
            texture_descriptors.append(descriptor)

        manifest: dict[str, Any] = {
            "schemaVersion": "mandelhowl.resonance-manifest.v1",
            "ownership": {
                "kind": "generated",
                "generator": "tools/physics-baker",
                "policy": "immutable-regenerate",
            },
            "contentAddressing": {
                "algorithm": "sha256",
                "canonicalization": "RFC8785",
                "identityScope": IDENTITY_SCOPE,
            },
            "plate": {
                "plateId": spec["plateId"],
                "specSha256": spec_sha256,
            },
            "runtimeCompatibility": {
                "minimumRuntimeVersion": "0.1.0",
                "maximumRuntimeVersionExclusive": "1.0.0",
                "modeBinaryFormat": "mandelhowl-modes-v1",
                "responseBinaryFormat": "mandelhowl-response-v1",
            },
            "units": spec["units"],
            "coordinateSystem": spec["coordinateSystem"],
            "modeCount": len(postprocessed.modes),
            "frequencyRange": {
                # Preserve canonical integer representation. RFC 8785 / JS emits
                # 45 rather than Python's 45.0 for an integral Number.
                "minimumHz": spec["frequencyRange"]["minimumHz"],
                "maximumHz": spec["frequencyRange"]["maximumHz"],
            },
            "solverProvenance": {
                "solverName": "mandelhowl-kirchhoff-love-rayleigh-ritz",
                "solverVersion": __version__,
                "containerImageDigest": f"sha256:{environment_sentinel}",
                "optionsSha256": options_sha256,
            },
            "files": {
                "plateSpec": _asset(
                    temporary / "plate-spec.json", temporary, "application/json"
                ),
                "modes": _asset(
                    temporary / "modes.bin",
                    temporary,
                    "application/vnd.mandelhowl.modes-v1",
                ),
                "response": _asset(
                    temporary / "response.bin",
                    temporary,
                    "application/vnd.mandelhowl.response-v1",
                ),
                "textures": texture_descriptors,
                "provenance": _asset(
                    temporary / "provenance.json", temporary, "application/json"
                ),
                "convergenceReport": _asset(
                    temporary / "convergence-report.json",
                    temporary,
                    "application/json",
                ),
                "coverageReport": _asset(
                    temporary / "coverage-report.json",
                    temporary,
                    "application/json",
                ),
                "checksums": _asset(
                    temporary / "checksums.json", temporary, "application/json"
                ),
            },
        }
        identity_digest = sha256_bytes(
            canonical_json_bytes(_manifest_identity_view(manifest))
        )
        manifest["datasetId"] = f"sha256:{identity_digest}"
        manifest["contentAddressing"]["directoryName"] = identity_digest
        _write(temporary / "manifest.json", pretty_json_bytes(manifest))

        destination = output_root / identity_digest
        if destination.exists():
            existing_manifest = destination / "manifest.json"
            if not existing_manifest.exists() or existing_manifest.read_bytes() != (
                temporary / "manifest.json"
            ).read_bytes():
                raise ValueError(
                    f"content-addressed destination exists with different content: {destination}"
                )
            shutil.rmtree(temporary)
            return destination
        # ``os.replace`` cannot move a populated directory on all supported
        # Windows filesystems. ``shutil.move`` uses an atomic rename on the
        # same volume and a safe copy/remove fallback otherwise.
        shutil.move(str(temporary), str(destination))
        return destination
    except BaseException:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise
