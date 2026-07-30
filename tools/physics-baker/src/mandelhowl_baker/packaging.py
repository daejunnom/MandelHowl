"""Content-addressed runtime dataset packaging."""

from __future__ import annotations

import copy
import json
import math
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from . import __version__
from .algorithm import (
    ALGORITHM_CONTRACT_BYTES,
    ALGORITHM_CONTRACT_SHA256,
    ALGORITHM_REVISION,
    COVERAGE_BASE_DETUNE,
    COVERAGE_CAPTURE_RATE,
    COVERAGE_DETUNE_CYCLE,
    COVERAGE_DETUNE_STEP,
    COVERAGE_MAXIMUM_FRACTION,
    COVERAGE_MINIMUM_LOG_ARGUMENT,
    CROSS_VALIDATION_TOLERANCE,
    HANDOFF_CONFORMANCE,
    MATERIAL_SECTION_AXIS,
    MATERIAL_SECTION_SAMPLE_COUNT,
    RUNTIME_COUPLING_QUANTUM,
    RUNTIME_FREQUENCY_QUANTUM_HZ,
    TEXTURE_LAYERS_PER_SHARD,
)
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
from .yaml_min import load as load_yaml

IDENTITY_SCOPE = (
    "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests"
)
REPOSITORY = Path(__file__).resolve().parents[4]
CONTAINER_DIGEST_PATTERN = re.compile(r"^sha256:[a-f0-9]{64}$")


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


def material_section_profile(
    spec: dict[str, Any],
    field: MaterialField,
) -> dict[str, Any]:
    """Return the small, data-backed rear/edge thickness presentation profile."""

    minimum = float(spec["thicknessMapping"]["minimumThicknessM"])
    maximum = float(spec["thicknessMapping"]["maximumThicknessM"])
    span = maximum - minimum
    if not math.isfinite(span) or span <= 0.0:
        raise ValueError("material section thickness range is invalid")
    samples = []
    for index in range(MATERIAL_SECTION_SAMPLE_COUNT):
        x_m = (
            -field.radius_m
            + (index + 0.5)
            * (2.0 * field.radius_m / MATERIAL_SECTION_SAMPLE_COUNT)
        )
        thickness = field.at(x_m, 0.0, thickness=True)
        normalized = max(0.0, min(1.0, (thickness - minimum) / span))
        samples.append(round(normalized * 255.0))
    return {
        "schemaVersion": "mandelhowl.material-section-profile.v1",
        "axis": MATERIAL_SECTION_AXIS,
        "sampleCount": MATERIAL_SECTION_SAMPLE_COUNT,
        "minimumThicknessM": minimum,
        "maximumThicknessM": maximum,
        "thicknessUnorm8": samples,
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
        dwell = (
            0.0
            if target == 0
            else -math.log(
                max(
                    COVERAGE_MINIMUM_LOG_ARGUMENT,
                    1.0 - COVERAGE_MAXIMUM_FRACTION * fraction,
                )
            )
            / COVERAGE_CAPTURE_RATE
        )
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
                    "detuneRatio": (
                        COVERAGE_BASE_DETUNE
                        + COVERAGE_DETUNE_STEP * (target % COVERAGE_DETUNE_CYCLE)
                    )
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


def _expected_runtime_coverage_binding() -> dict[str, Any]:
    source_paths = {
        "dial": "specs/runtime/dial.v1.yaml",
        "feedback": "specs/runtime/feedback.v1.yaml",
        "volumeMap": "specs/runtime/volume-map.v1.yaml",
        "audioSafety": "specs/runtime/audio-safety.v1.yaml",
        "uiNVersion": "specs/runtime/ui-nversion.v1.json",
    }
    feedback = load_yaml(REPOSITORY / source_paths["feedback"])
    coverage_schema_path = (
        REPOSITORY
        / "packages"
        / "contracts"
        / "schemas"
        / "coverage-report.schema.json"
    )
    return {
        "runtimeAlgorithmRevision": feedback["algorithmRevision"],
        "runtimeSpecSha256": {
            key: sha256_file(REPOSITORY / relative)
            for key, relative in source_paths.items()
        },
        "coverageContract": {
            "schemaVersion": "mandelhowl.coverage-report.v1",
            "schemaSha256": sha256_file(coverage_schema_path),
        },
    }


def _validate_external_coverage(
    report: dict[str, Any],
    release: bool,
    expected_modal_model_id: str,
) -> None:
    outputs = report.get("outputs")
    if not isinstance(outputs, list):
        raise ValueError("coverage report must contain an outputs array")
    targets = sorted(row.get("target") for row in outputs if isinstance(row, dict))
    if targets != list(range(101)):
        raise ValueError("coverage report must contain exactly one entry for every target 0..100")
    if report.get("perValueRuntimeExceptionTable") is not False:
        raise ValueError("coverage report must explicitly deny per-value runtime exceptions")
    if release:
        binding = _expected_runtime_coverage_binding()
        generated_by = report.get("generatedBy", {})
        if (
            report.get("schemaVersion") != "mandelhowl.coverage-report.v1"
            or report.get("modalModelId") != expected_modal_model_id
            or report.get("verificationStatus") != "runtime-replay-verified"
            or report.get("runtimeAlgorithmRevision")
            != binding["runtimeAlgorithmRevision"]
            or report.get("runtimeSpecSha256") != binding["runtimeSpecSha256"]
            or report.get("coverageContract") != binding["coverageContract"]
            or generated_by.get("algorithm")
            != "deterministic-global-trajectory-search-v1"
            or generated_by.get("feedbackAlgorithmRevision")
            != binding["runtimeAlgorithmRevision"]
            or generated_by.get("perValueRuntimeLookup") != "forbidden"
            or generated_by.get("randomSource") != "forbidden"
            or report.get("replayVerified") is not True
            or report.get("coveredValues") != list(range(101))
            or report.get("missingValues") != []
        ):
            raise ValueError(
                "release coverage is not exactly bound to the generated modal model, "
                "runtime specs, runtime algorithm, and coverage schema"
            )
        traces = report.get("traces")
        if (
            not isinstance(traces, list)
            or len(traces) != 101
            or any(
                not isinstance(trace, dict)
                or trace.get("modalModelId") != expected_modal_model_id
                for trace in traces
            )
        ):
            raise ValueError("release coverage traces do not bind the generated modal model")
        unverified = [
            row["target"]
            for row in outputs
            if row.get("verification") != "runtime-replay-verified"
            or row.get("verified") is not True
            or row.get("trace") != traces[row["target"]]
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


def _execution_environment(release: bool) -> dict[str, Any]:
    container_digest = os.environ.get("MANDELHOWL_CONTAINER_IMAGE_DIGEST")
    runner_attested = (
        os.environ.get("MANDELHOWL_CONTAINER_RUNNER_ATTESTED") == "1"
    )
    if container_digest is None:
        return {
            "executionKind": "native-process",
            "containerized": False,
            "containerImageDigest": None,
            "containerDigestMeaning": (
                "Not applicable: this dataset was generated by a native "
                "CPython standard-library process, not a container image."
            ),
            "containerRunnerAttestation": "not-applicable-native-process",
        }
    if CONTAINER_DIGEST_PATTERN.fullmatch(container_digest) is None:
        raise ValueError(
            "MANDELHOWL_CONTAINER_IMAGE_DIGEST must be sha256:<64 lowercase hex>"
        )
    if release and not runner_attested:
        raise ValueError(
            "release container provenance requires "
            "MANDELHOWL_CONTAINER_RUNNER_ATTESTED=1 from the trusted runner"
        )
    return {
        "executionKind": "oci-container",
        "containerized": True,
        "containerImageDigest": container_digest,
        "containerDigestMeaning": (
            "OCI image content digest supplied by the executing container "
            "runner; it identifies the image used for this bake."
        ),
        "containerRunnerAttestation": (
            "trusted-runner-attested"
            if runner_attested
            else "environment-declared-development-only"
        ),
    }


def _mesh_quality_policy(
    spec: dict[str, Any],
    meshes: list[MeshEvidence],
) -> dict[str, Any]:
    requested = spec["solverRequest"]["meshQuality"]
    accepted = all(
        mesh.minimum_edge_m >= float(requested["minimumEdgeM"])
        and mesh.minimum_signed_area_m2
        >= float(requested["minimumSignedAreaM2"])
        and mesh.maximum_aspect_ratio
        <= float(requested["maximumAspectRatio"])
        and mesh.connected_component_count
        == int(requested["requiredConnectedComponentCount"])
        and mesh.inverted_triangle_count
        <= int(requested["maximumInvertedTriangleCount"])
        for mesh in meshes
    )
    policy = {
        "minimumEdgeM": float(requested["minimumEdgeM"]),
        "minimumSignedAreaM2": float(
            requested["minimumSignedAreaM2"]
        ),
        "maximumAspectRatio": float(requested["maximumAspectRatio"]),
        "requiredConnectedComponentCount": int(
            requested["requiredConnectedComponentCount"]
        ),
        "maximumInvertedTriangleCount": int(
            requested["maximumInvertedTriangleCount"]
        ),
        "negativeAreaAllowed": False,
        "disconnectedComponentsAllowed": False,
        "fingerprint": (
            "sha256 over float64 node positions and uint32 triangle indices"
        ),
        "accepted": accepted,
    }
    if not accepted:
        raise ValueError(
            "surface triangle archive failed canonical mesh-quality thresholds"
        )
    return policy


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
        _write(
            temporary / "science" / "baker-algorithm.v1.json",
            ALGORITHM_CONTRACT_BYTES,
        )
        mesh_quality_policy = _mesh_quality_policy(spec, meshes)
        mesh_report = {
            "schemaVersion": "mandelhowl.mesh-evidence.v1",
            "domain": "annulus from clamped hub radius to free outer rim",
            "levels": [mesh.as_dict() for mesh in meshes],
            "qualityPolicy": mesh_quality_policy,
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
            _validate_external_coverage(
                coverage,
                release,
                f"sha256:{sha256_bytes(postprocessed.modes_binary)}",
            )
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
        cross_tolerance = CROSS_VALIDATION_TOLERANCE
        cross_validation["criterion"] = {
            "maximumRelativeFrequencyDifference": cross_tolerance
        }
        cross_validation["accepted"] = all(
            row["relativeDifference"] <= cross_tolerance
            for row in cross_validation["frequencyChecks"]
        )
        convergence["independentCrossValidation"] = cross_validation
        convergence["finiteElementMeshConvergenceAccepted"] = bool(
            convergence["accepted"]
        )
        convergence["surfaceMeshQualityAccepted"] = bool(
            mesh_quality_policy["accepted"]
        )
        convergence["accepted"] = bool(
            convergence["accepted"]
            and cross_validation["accepted"]
            and mesh_quality_policy["accepted"]
        )
        if not convergence["accepted"]:
            raise ValueError(
                "physics convergence failed: finite-element mesh convergence, "
                "surface mesh quality, and independent finite-difference "
                "cross-validation must all pass"
            )
        _write(
            temporary / "convergence-report.json",
            pretty_json_bytes(convergence),
        )

        solver_options = {
            "method": (
                "variable-thickness-kirchhoff-love-c1-finite-strip-fem"
            ),
            "algorithmRevision": ALGORITHM_REVISION,
            "algorithmContractSha256": ALGORITHM_CONTRACT_SHA256,
            "basisCount": len(fine_result.basis),
            "quadrature": fine_result.quadrature,
            "finiteElementAssembly": {
                "radialInterpolation": "cubic-hermite-c1",
                "angularInterpolation": "normalized-real-fourier",
                "innerBoundary": "value-and-radial-slope-dofs-eliminated",
                "outerBoundary": "natural-free-edge",
            },
            "runtimeModalOutputQuantization": {
                "frequencyQuantumHz": RUNTIME_FREQUENCY_QUANTUM_HZ,
                "couplingQuantum": RUNTIME_COUPLING_QUANTUM,
                "rounding": "ties-to-even",
                "negativeZero": "canonicalize-to-positive-zero",
            },
            "floatPrecision": "binary64",
            "fastMath": False,
            "randomSource": "forbidden",
        }
        options_sha256 = sha256_bytes(canonical_json_bytes(solver_options))
        execution_environment = _execution_environment(release)
        mode_summaries = []
        for index, mode in enumerate(postprocessed.modes):
            previous_spacing = (
                None
                if index == 0
                else mode.natural_frequency_hz
                - postprocessed.modes[index - 1].natural_frequency_hz
            )
            next_spacing = (
                None
                if index + 1 == len(postprocessed.modes)
                else postprocessed.modes[index + 1].natural_frequency_hz
                - mode.natural_frequency_hz
            )
            finite_spacings = [
                spacing
                for spacing in (previous_spacing, next_spacing)
                if spacing is not None
            ]
            mode_summaries.append(
                {
                "modeId": mode.mode_id,
                "ordinal": mode.ordinal,
                "naturalFrequencyHz": mode.natural_frequency_hz,
                "angularFrequencyRadPerSecond": mode.angular_frequency_rad_per_s,
                "dampingRatio": mode.damping_ratio,
                "actuatorCoupling": mode.actuator_coupling,
                "microphoneCoupling": mode.microphone_coupling,
                "radiationEfficiency": mode.radiation_efficiency,
                "adjacentFrequencySpacingHz": {
                    "previous": previous_spacing,
                    "next": next_spacing,
                    "nearest": min(finite_spacings) if finite_spacings else None,
                },
                "surfaceKinematics": {
                    "signedDisplacementTextureLayer": mode.texture_layer,
                    "velocityScalePerUnitModalAmplitudePerSecond": (
                        mode.angular_frequency_rad_per_s
                    ),
                    "velocityPhaseOffsetRad": math.pi / 2.0,
                    "accelerationScalePerUnitModalAmplitudePerSecondSquared": (
                        mode.angular_frequency_rad_per_s
                        * mode.angular_frequency_rad_per_s
                    ),
                    "accelerationPhaseOffsetRad": math.pi,
                },
                "dominantBasis": {
                    "radialNodeIndex": mode.dominant_radial_node_index,
                    "radialDof": mode.dominant_radial_dof,
                    "angularOrder": mode.dominant_angular_order,
                    "symmetry": mode.dominant_symmetry,
                },
                "signReference": mode.sign_reference,
                "textureLayer": mode.texture_layer,
                }
            )
        provenance = {
            "schemaVersion": "mandelhowl.provenance.v1",
            "generator": {
                "name": "tools/physics-baker",
                "version": __version__,
                "dependencies": "Python 3.10+ standard library only",
                "algorithmRevision": ALGORITHM_REVISION,
                "algorithmContractSha256": ALGORITHM_CONTRACT_SHA256,
                "randomSource": "forbidden",
            },
            "canonicalInput": {
                "plateId": spec["plateId"],
                "path": "specs/plate/mandelbrot-plate.v1.yaml",
                "canonicalJsonSha256": spec_sha256,
            },
            "solver": {
                "name": "mandelhowl-kirchhoff-love-finite-strip",
                "version": __version__,
                "options": solver_options,
                "optionsSha256": options_sha256,
                **execution_environment,
                "canonicalRequest": {
                    "elementFamily": spec["solverRequest"]["elementFamily"],
                    "requestedModeCount": spec["solverRequest"]["requestedModeCount"],
                },
                "executedMethod": (
                    "c1-cubic-hermite-annular-finite-strip"
                ),
                "methodRequestMismatchRecorded": False,
                "strictLiteralSection10_3Conformance": HANDOFF_CONFORMANCE[
                    "strictLiteralConformance"
                ],
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
                    "The emitted ZLIB-supercompressed R8/RG8 KTX2 arrays match "
                    "the canonical runtime request and are derived from float64 "
                    "solver modes. The browser inflates the standard scheme-3 "
                    "payload before portable upload; no Basis/UASTC block "
                    "compression is claimed."
                ),
            },
            "derivedRuntimeFields": {
                "surfaceKinematics": {
                    "basisTextureKind": "signed-displacement",
                    "displacementFormula": "u(x,t)=sum_i(q_i(t)*D_i(x))",
                    "velocityFormula": "v(x,t)=sum_i(qDot_i(t)*D_i(x))",
                    "accelerationFormula": (
                        "a(x,t)=sum_i(qDoubleDot_i(t)*D_i(x))"
                    ),
                    "harmonicDerivativeConvention": (
                        "q=A*cos(omega*t+phase); "
                        "qDot=A*omega*cos(omega*t+phase+pi/2); "
                        "qDoubleDot=A*omega^2*cos(omega*t+phase+pi)"
                    ),
                },
                "emissiveTexture": {
                    "basisTextureKind": "nodal-mask",
                    "basisAliasPolicy": "byte-identical-basis-reuse",
                    "basisEquivalence": (
                        "emissiveBasisUNorm8(x,mode)=nodalMaskUNorm8(x,mode)"
                    ),
                    "runtimeFormula": (
                        "localEmissive(x)=modalEnergyWeightedNodalMask(x)"
                        "*localSaturationEnvelope"
                    ),
                    "fullScreenFlashAllowed": False,
                    "scientificRole": "visual-abstraction",
                },
            },
            "renderingCoordinateTransform": {
                "sourceFrame": spec["coordinateSystem"]["frame"],
                "uvOrigin": spec["textureRequest"]["uvOrigin"],
                "uAxis": spec["textureRequest"]["uvXAxis"],
                "vAxis": spec["textureRequest"]["uvYAxis"],
                "plateXFromU": "x=(2*u-1)*radiusM",
                "plateYFromV": "y=(2*v-1)*radiusM",
                "validSurfaceDomain": "hubRadiusM<hypot(x,y)<=radiusM",
                "radiusM": spec["geometry"]["radiusM"],
                "hubRadiusM": spec["geometry"]["hub"]["radiusM"],
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
                    (
                        "the finite-strip discretization is semi-analytical "
                        "rather than a triangle shell mesh"
                    ),
                    "the clamped hub is represented as an annular essential boundary",
                    "air loading, nonlinear material response, and grain dynamics are omitted",
                    "the independent finite-difference check is a reduced cross-check, not certification",
                    "runtime textures are a quantized LOD of float64 solver fields",
                    "runtime modal scalars are quantized only at the serialization boundary for cross-implementation identity",
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
                "science/baker-algorithm.v1.json",
                "science/solver-evidence.bin",
            ],
        }
        _write(temporary / "provenance.json", pretty_json_bytes(provenance))

        generation_report = {
            "schemaVersion": "mandelhowl.generation-report.v1",
            "deterministic": True,
            "releaseBake": release,
            "backend": "python-stdlib",
            "algorithmRevision": ALGORITHM_REVISION,
            "executionEnvironment": execution_environment,
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
            "meshChecksPassed": bool(mesh_quality_policy["accepted"]),
            "convergenceChecksPassed": bool(convergence["accepted"]),
            "coverageSource": coverage_source,
            "handoffFullConformance": True,
            "handoffOperationalDisposition": HANDOFF_CONFORMANCE[
                "operationalDisposition"
            ],
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
            for first_layer in range(
                0,
                len(mode_ids),
                TEXTURE_LAYERS_PER_SHARD,
            ):
                shard_mode_ids = mode_ids[
                    first_layer : first_layer + TEXTURE_LAYERS_PER_SHARD
                ]
                last_layer = first_layer + len(shard_mode_ids) - 1
                shard_key = f"{kind}-{first_layer:02d}-{last_layer:02d}"
                metadata = postprocessed.texture_metadata[shard_key]
                descriptor = _asset(
                    texture_paths[shard_key],
                    temporary,
                    "image/ktx2",
                )
                descriptor.update(
                    {
                        "kind": kind,
                        "modeIds": shard_mode_ids,
                        "widthPx": metadata["widthPx"],
                        "heightPx": metadata["heightPx"],
                        "layers": len(shard_mode_ids),
                        "supercompressionScheme": 3,
                        "uvOrigin": "negative-x-negative-y",
                    }
                )
                texture_descriptors.append(descriptor)

        manifest: dict[str, Any] = {
            "schemaVersion": "mandelhowl.resonance-manifest.v1",
            "algorithmRevision": ALGORITHM_REVISION,
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
                "materialSectionProfile": material_section_profile(
                    spec,
                    field,
                ),
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
                "solverName": "mandelhowl-kirchhoff-love-finite-strip",
                "solverVersion": __version__,
                "executionKind": execution_environment["executionKind"],
                "containerImageDigest": execution_environment[
                    "containerImageDigest"
                ],
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
