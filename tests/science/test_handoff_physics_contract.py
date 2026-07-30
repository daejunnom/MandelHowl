from __future__ import annotations

import copy
import json
import math
import struct
import unittest
import zlib
from types import SimpleNamespace

try:
    from .common import REPOSITORY, datasets
except ImportError:
    from common import REPOSITORY, datasets
from mandelhowl_baker.algorithm import TEXTURE_LAYERS_PER_SHARD
from mandelhowl_baker.ktx2 import validate_ktx2, write_ktx2_array
from mandelhowl_baker.packaging import (
    _validate_external_coverage,
    material_section_profile,
)
from mandelhowl_baker.cli import _validate_release_overrides
from mandelhowl_baker.diagnostics import from_exception
from mandelhowl_baker.field import generate_material_field
from mandelhowl_baker.linear_algebra import cholesky
from mandelhowl_baker.postprocess import _quantize_runtime_scalar
from mandelhowl_baker.solver import (
    _assemble,
    basis_value,
    build_basis,
    hermite_shapes,
    solve_modes,
)
from mandelhowl_baker.spec_validation import validate_plate_spec_contract
from mandelhowl_baker.validation import decode_modes, decode_response
from mandelhowl_baker.yaml_min import load


class HandoffPhysicsContractTests(unittest.TestCase):
    def test_solver_failures_become_structured_evidence_diagnostics(self) -> None:
        diagnostic = from_exception(
            RuntimeError("mass matrix eigensolver failed"),
            "generate",
        ).as_dict()
        self.assertEqual(
            diagnostic,
            {
                "schemaVersion": "mandelhowl.baker-diagnostic.v1",
                "code": "PHYSICS_SOLVER_FAILED",
                "status": "confirmed",
                "severity": "error",
                "message": "mass matrix eigensolver failed",
                "evidence": {
                    "exceptionType": "RuntimeError",
                    "command": "generate",
                },
            },
        )

    def test_runtime_modal_quantization_uses_shared_ties_to_even_grid(self) -> None:
        quantum = 2.0**-20
        self.assertEqual(_quantize_runtime_scalar(2.5 * quantum, quantum), 2 * quantum)
        self.assertEqual(_quantize_runtime_scalar(3.5 * quantum, quantum), 4 * quantum)
        self.assertEqual(_quantize_runtime_scalar(-2.5 * quantum, quantum), -2 * quantum)
        zero = _quantize_runtime_scalar(-0.25 * quantum, quantum)
        self.assertEqual(zero, 0.0)
        self.assertGreater(math.copysign(1.0, zero), 0.0)

    def test_b1_uses_strict_c1_finite_element_assembly(self) -> None:
        contract = json.loads(
            (
                REPOSITORY
                / "specs"
                / "physics"
                / "baker-algorithm.v1.json"
            ).read_text(encoding="utf-8")
        )
        conformance = contract["handoffConformance"]
        self.assertEqual(conformance["section"], "10.3/B1")
        self.assertTrue(conformance["thinPlateEigenanalysisSupported"])
        self.assertTrue(conformance["surfaceMeshQualityValidated"])
        self.assertTrue(conformance["finiteElementAssemblyUsed"])
        self.assertTrue(
            conformance["analysisSurfaceElementMeshCoupledToEigenproblem"]
        )
        self.assertFalse(
            conformance["surfaceTriangleArchiveCoupledToEigenproblem"]
        )
        self.assertTrue(conformance["strictLiteralConformance"])
        self.assertEqual(
            conformance["operationalDisposition"],
            "strict-thin-plate-finite-element-adapter",
        )
        self.assertNotIn("deviationCode", conformance)
        self.assertEqual(
            contract["assembly"]["analysisDiscretization"],
            "c1-cubic-hermite-annular-finite-strip",
        )

    def test_release_coverage_is_exactly_bound_to_runtime_and_modes(self) -> None:
        report = json.loads(
            (
                REPOSITORY
                / "tests"
                / "runtime"
                / "fixtures"
                / "reachability-report.json"
            ).read_text(encoding="utf-8")
        )
        model_id = report["modalModelId"]
        _validate_external_coverage(report, True, model_id)
        mutations = [
            lambda value: value.update(
                {"modalModelId": f"sha256:{'0' * 64}"}
            ),
            lambda value: value.update(
                {"runtimeAlgorithmRevision": "fixed-step-modal-feedback-stale"}
            ),
            lambda value: value["runtimeSpecSha256"].update(
                {"audioSafety": "0" * 64}
            ),
            lambda value: value["runtimeSpecSha256"].update(
                {"uiNVersion": "0" * 64}
            ),
            lambda value: value["coverageContract"].update(
                {"schemaSha256": "0" * 64}
            ),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(report)
            mutate(invalid)
            with self.assertRaisesRegex(ValueError, "exactly bound"):
                _validate_external_coverage(invalid, True, model_id)

    def test_versioned_ktx2_rejects_dynamic_huffman_profile(self) -> None:
        pixels = bytes(range(256)) * 64
        fixed = bytearray(
            write_ktx2_array(
                width=128,
                height=128,
                layers=1,
                channels=1,
                image_data=pixels,
            )
        )
        level_offset, _, raw_length = struct.unpack_from("<3Q", fixed, 80)
        dynamic = zlib.compress(pixels, level=9)
        self.assertEqual((dynamic[2] >> 1) & 0b11, 2)
        struct.pack_into("<3Q", fixed, 80, level_offset, len(dynamic), raw_length)
        mutated = bytes(fixed[:level_offset]) + dynamic
        with self.assertRaisesRegex(ValueError, "dynamic-Huffman"):
            validate_ktx2(mutated)

    def test_release_generation_rejects_unversioned_cli_overrides(self) -> None:
        spec = load(REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml")
        options = SimpleNamespace(
            release=True,
            field_resolution=spec["mandelbrotField"]["sampleResolution"][
                "widthPx"
            ]
            + 1,
            texture_size=None,
        )
        with self.assertRaisesRegex(ValueError, "--field-resolution"):
            _validate_release_overrides(options, spec)
        options.field_resolution = spec["mandelbrotField"]["sampleResolution"][
            "widthPx"
        ]
        _validate_release_overrides(options, spec)

    def test_canonical_plate_cross_field_contract(self) -> None:
        spec = load(REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml")
        validate_plate_spec_contract(spec)
        self.assertTrue(spec["thicknessMapping"]["frontSurfaceRemainsPlanar"])
        self.assertEqual(spec["boundaryCondition"], {
            "hub": "clamped",
            "outerEdge": "free",
            "description": spec["boundaryCondition"]["description"],
        })
        self.assertEqual(
            [level["name"] for level in spec["solverRequest"]["meshLevels"]],
            ["coarse", "medium", "fine"],
        )
        self.assertEqual(
            [
                (
                    level["analysisFiniteStrip"]["radialElementCount"],
                    level["analysisFiniteStrip"]["maximumFourierOrder"],
                    level["analysisFiniteStrip"][
                        "angularQuadratureSamples"
                    ],
                )
                for level in spec["solverRequest"]["meshLevels"]
            ],
            [(3, 7, 64), (4, 8, 80), (5, 9, 96)],
        )
        self.assertEqual(
            spec["solverRequest"]["meshQuality"],
            {
                "minimumEdgeM": 0.00014,
                "minimumSignedAreaM2": 0.00000001,
                "maximumAspectRatio": 2.1,
                "requiredConnectedComponentCount": 1,
                "maximumInvertedTriangleCount": 0,
            },
        )

    def test_c1_hermite_strip_basis_enforces_clamped_hub(self) -> None:
        length = 0.027
        left = hermite_shapes(0.0, length)
        right = hermite_shapes(1.0, length)
        self.assertEqual(
            tuple((shape[0], shape[1]) for shape in left),
            ((1.0, 0.0), (0.0, 1.0), (0.0, 0.0), (0.0, 0.0)),
        )
        self.assertEqual(
            tuple((shape[0], shape[1]) for shape in right),
            ((0.0, 0.0), (0.0, 0.0), (1.0, 0.0), (0.0, 1.0)),
        )
        basis = build_basis(3, 2)
        self.assertEqual(len(basis), 2 * 3 * (1 + 2 * 2))
        self.assertTrue(
            all(descriptor.radial_node_index >= 1 for descriptor in basis)
        )
        for descriptor in basis:
            self.assertEqual(
                basis_value(
                    descriptor,
                    0.018,
                    0.0,
                    0.018,
                    0.18,
                ),
                0.0,
            )

    def test_finite_strip_assembles_symmetric_positive_mass_and_stiffness(self) -> None:
        spec = load(REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml")
        field = generate_material_field(spec, size=32)
        basis = build_basis(1, 1)
        stiffness, mass = _assemble(
            spec,
            field,
            radial_element_count=1,
            maximum_fourier_order=1,
            angular_samples=16,
            basis=basis,
        )
        self.assertEqual(len(mass), 6)
        for row in range(len(mass)):
            self.assertGreater(mass[row][row], 0.0)
            self.assertGreater(stiffness[row][row], 0.0)
            for column in range(len(mass)):
                self.assertEqual(mass[row][column], mass[column][row])
                self.assertEqual(
                    stiffness[row][column],
                    stiffness[column][row],
                )
        cholesky(mass)

    def test_material_section_profile_is_data_backed_and_bounded(self) -> None:
        spec = load(REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml")
        field = generate_material_field(spec, size=32)
        profile = material_section_profile(spec, field)
        self.assertEqual(
            profile["schemaVersion"],
            "mandelhowl.material-section-profile.v1",
        )
        self.assertEqual(profile["axis"], "x-at-y-zero")
        self.assertEqual(profile["sampleCount"], 64)
        self.assertEqual(len(profile["thicknessUnorm8"]), 64)
        self.assertGreater(
            max(profile["thicknessUnorm8"])
            - min(profile["thicknessUnorm8"]),
            8,
        )
        self.assertTrue(
            all(
                isinstance(value, int) and 0 <= value <= 255
                for value in profile["thicknessUnorm8"]
            )
        )

    def test_mandelbrot_field_causally_changes_the_eigenproblem(self) -> None:
        canonical = load(
            REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml"
        )
        canonical["solverRequest"]["requestedModeCount"] = 8
        perturbed = copy.deepcopy(canonical)
        perturbed["mandelbrotField"]["complexBounds"].update(
            {"realMin": -1.8, "realMax": 1.2}
        )

        canonical_field = generate_material_field(canonical, size=32)
        perturbed_field = generate_material_field(perturbed, size=32)
        mean_thickness_delta = sum(
            abs(left - right)
            for left, right in zip(
                canonical_field.thickness_m,
                perturbed_field.thickness_m,
            )
        ) / len(canonical_field.thickness_m)
        self.assertGreater(mean_thickness_delta, 1e-5)

        canonical_modes = solve_modes(
            canonical,
            canonical_field,
            radial_element_count=2,
            maximum_fourier_order=3,
            angular_samples=32,
        )
        perturbed_modes = solve_modes(
            perturbed,
            perturbed_field,
            radial_element_count=2,
            maximum_fourier_order=3,
            angular_samples=32,
        )
        maximum_relative_change = max(
            abs(left.frequency_hz - right.frequency_hz) / left.frequency_hz
            for left, right in zip(
                canonical_modes.modes,
                perturbed_modes.modes,
            )
        )
        self.assertGreater(
            maximum_relative_change,
            0.01,
            "changing the Mandelbrot-derived thickness field must alter "
            "the eigenfrequencies",
        )

    def test_cross_field_validator_rejects_semantic_invalidity(self) -> None:
        source = load(
            REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml"
        )
        mutations = [
            lambda spec: spec["geometry"]["hub"].update({"radiusM": 0.2}),
            lambda spec: spec["actuator"]["direction"].update({"z": 0.5}),
            lambda spec: spec["solverRequest"].update(
                {"frequencyRangeHz": [46, 6000]}
            ),
            lambda spec: spec["solverRequest"]["meshLevels"][1].update(
                {
                    "analysisFiniteStrip": {
                        "radialElementCount": 2,
                        "maximumFourierOrder": 8,
                        "angularQuadratureSamples": 80,
                    }
                }
            ),
            lambda spec: spec["solverRequest"]["meshQuality"].update(
                {"maximumInvertedTriangleCount": 1}
            ),
            lambda spec: spec["textureRequest"].update(
                {"channels": ["sand-density-r8"]}
            ),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(source)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate_plate_spec_contract(invalid)

    def test_packaged_science_assets_cover_the_handoff_contract(self) -> None:
        self.assertTrue(datasets(), "no generated physics dataset found")
        for dataset in datasets():
            manifest = json.loads(
                (dataset / "manifest.json").read_text(encoding="utf-8")
            )
            versioned = "algorithmRevision" in manifest
            plate = json.loads(
                (dataset / manifest["files"]["plateSpec"]["path"]).read_text(
                    encoding="utf-8"
                )
            )
            provenance = json.loads(
                (dataset / manifest["files"]["provenance"]["path"]).read_text(
                    encoding="utf-8"
                )
            )
            convergence = json.loads(
                (
                    dataset / manifest["files"]["convergenceReport"]["path"]
                ).read_text(encoding="utf-8")
            )
            modes = decode_modes(dataset / manifest["files"]["modes"]["path"])
            response = decode_response(
                dataset / manifest["files"]["response"]["path"]
            )

            self.assertEqual(manifest["plate"]["plateId"], plate["plateId"])
            if versioned:
                section = manifest["plate"]["materialSectionProfile"]
                self.assertEqual(
                    section["schemaVersion"],
                    "mandelhowl.material-section-profile.v1",
                )
                self.assertEqual(section["axis"], "x-at-y-zero")
                self.assertEqual(section["sampleCount"], 64)
                self.assertEqual(len(section["thicknessUnorm8"]), 64)
                self.assertGreater(
                    max(section["thicknessUnorm8"])
                    - min(section["thicknessUnorm8"]),
                    8,
                )
            self.assertEqual(manifest["units"], plate["units"])
            self.assertEqual(
                manifest["coordinateSystem"], plate["coordinateSystem"]
            )
            self.assertEqual(manifest["frequencyRange"], plate["frequencyRange"])
            self.assertEqual(len(modes), plate["solverRequest"]["requestedModeCount"])
            self.assertEqual(response[0][0], plate["frequencyRange"]["minimumHz"])
            self.assertEqual(response[-1][0], plate["frequencyRange"]["maximumHz"])
            self.assertEqual(
                provenance["canonicalInput"]["canonicalJsonSha256"],
                manifest["plate"]["specSha256"],
            )
            self.assertEqual(
                provenance["solver"]["optionsSha256"],
                manifest["solverProvenance"]["optionsSha256"],
            )
            if versioned:
                self.assertEqual(
                    provenance["solver"]["executionKind"],
                    manifest["solverProvenance"]["executionKind"],
                )
                if (
                    provenance["solver"]["executionKind"]
                    == "native-process"
                ):
                    self.assertFalse(
                        provenance["solver"]["containerized"]
                    )
                    self.assertIsNone(
                        provenance["solver"]["containerImageDigest"]
                    )
                    self.assertEqual(
                        provenance["solver"][
                            "containerRunnerAttestation"
                        ],
                        "not-applicable-native-process",
                    )
                else:
                    self.assertTrue(
                        provenance["solver"]["containerized"]
                    )
                    self.assertRegex(
                        provenance["solver"]["containerImageDigest"],
                        r"^sha256:[0-9a-f]{64}$",
                    )
                    self.assertEqual(
                        provenance["solver"][
                            "containerRunnerAttestation"
                        ],
                        "trusted-runner-attested",
                    )
            else:
                self.assertTrue(
                    manifest["solverProvenance"][
                        "containerImageDigest"
                    ].startswith("sha256:")
                )
            self.assertIn("finite material field", provenance["scientificScope"]["claimPolicy"])
            self.assertIn(
                "does not directly generate sound",
                provenance["scientificScope"]["claimPolicy"],
            )

            self.assertTrue(convergence["accepted"])
            if versioned:
                self.assertTrue(
                    convergence["finiteElementMeshConvergenceAccepted"]
                )
                self.assertTrue(convergence["surfaceMeshQualityAccepted"])
            else:
                self.assertTrue(
                    convergence["quadratureConvergenceAccepted"]
                )
            self.assertTrue(convergence["independentCrossValidation"]["accepted"])
            for row in convergence["comparisons"]:
                self.assertLessEqual(
                    row["mediumToFineRelativeChange"],
                    convergence["criteria"]["maximumRelativeFrequencyChange"],
                )
                self.assertGreaterEqual(
                    row["mediumToFineModalAssuranceCriterion"],
                    convergence["criteria"]["minimumModalAssuranceCriterion"],
                )

            if versioned:
                derived = provenance["derivedRuntimeFields"]
                self.assertEqual(
                    derived["surfaceKinematics"]["basisTextureKind"],
                    "signed-displacement",
                )
                self.assertEqual(
                    derived["surfaceKinematics"]["velocityFormula"],
                    "v(x,t)=sum_i(qDot_i(t)*D_i(x))",
                )
                emissive = derived["emissiveTexture"]
                self.assertEqual(emissive["basisTextureKind"], "nodal-mask")
                self.assertEqual(
                    emissive["basisAliasPolicy"],
                    "byte-identical-basis-reuse",
                )
                self.assertFalse(emissive["fullScreenFlashAllowed"])
                expected_mode_ids = [
                    f"mode-{ordinal:03d}"
                    for ordinal in range(1, manifest["modeCount"] + 1)
                ]
                for kind in (
                    "signed-displacement",
                    "normal",
                    "nodal-mask",
                    "sand-density",
                ):
                    descriptors = [
                        row
                        for row in manifest["files"]["textures"]
                        if row["kind"] == kind
                    ]
                    self.assertEqual(
                        len(descriptors),
                        manifest["modeCount"]
                        // TEXTURE_LAYERS_PER_SHARD,
                    )
                    self.assertEqual(
                        [
                            mode_id
                            for descriptor in descriptors
                            for mode_id in descriptor["modeIds"]
                        ],
                        expected_mode_ids,
                    )
                    for shard_index, descriptor in enumerate(descriptors):
                        first_layer = (
                            shard_index * TEXTURE_LAYERS_PER_SHARD
                        )
                        last_layer = (
                            first_layer
                            + TEXTURE_LAYERS_PER_SHARD
                            - 1
                        )
                        self.assertEqual(
                            descriptor["path"],
                            (
                                f"textures/{kind}-{first_layer:02d}-"
                                f"{last_layer:02d}.ktx2"
                            ),
                        )
                        self.assertEqual(
                            descriptor["layers"],
                            TEXTURE_LAYERS_PER_SHARD,
                        )
                for texture in manifest["files"]["textures"]:
                    self.assertEqual(texture["supercompressionScheme"], 3)
                    info = validate_ktx2(
                        (dataset / texture["path"]).read_bytes()
                    )
                    self.assertEqual(info.supercompression_scheme, 3)
                    self.assertLess(
                        info.encoded_level_length,
                        len(info.image_data),
                    )
                discretization = convergence["analysisDiscretization"]
                self.assertTrue(discretization["coupledToEigenproblemAssembly"])
                self.assertEqual(
                    discretization["type"],
                    "c1-cubic-hermite-annular-finite-strip",
                )
                conformance = convergence["methodConformance"]
                self.assertTrue(conformance["finiteElementAssemblyUsed"])
                self.assertTrue(
                    conformance[
                        "analysisSurfaceElementMeshCoupledToEigenproblem"
                    ]
                )
                self.assertFalse(
                    conformance[
                        "surfaceTriangleArchiveCoupledToEigenproblem"
                    ]
                )
                self.assertTrue(
                    conformance["strictLiteralSection10_3Conformance"]
                )
                self.assertNotIn("deviationCode", conformance)
                for level, requested in zip(
                    convergence["levels"],
                    plate["solverRequest"]["meshLevels"],
                ):
                    self.assertEqual(
                        level["radialElementCount"],
                        requested["analysisFiniteStrip"][
                            "radialElementCount"
                        ],
                    )
                    self.assertEqual(
                        level["angularSamples"],
                        requested["analysisFiniteStrip"][
                            "angularQuadratureSamples"
                        ],
                    )
                    self.assertEqual(
                        level["maximumFourierOrder"],
                        requested["analysisFiniteStrip"][
                            "maximumFourierOrder"
                        ],
                    )
                    self.assertEqual(
                        level["targetElementSizeM"],
                        requested["targetElementSizeM"],
                    )
                transform = provenance["renderingCoordinateTransform"]
                self.assertEqual(
                    transform["sourceFrame"], plate["coordinateSystem"]["frame"]
                )
                self.assertEqual(
                    transform["uvOrigin"], plate["textureRequest"]["uvOrigin"]
                )
                for index, (summary, mode) in enumerate(
                    zip(provenance["modes"], modes)
                ):
                    omega = mode["angularFrequencyRadPerSecond"]
                    lower = (
                        None
                        if index == 0
                        else mode["naturalFrequencyHz"]
                        - modes[index - 1]["naturalFrequencyHz"]
                    )
                    upper = (
                        None
                        if index + 1 == len(modes)
                        else modes[index + 1]["naturalFrequencyHz"]
                        - mode["naturalFrequencyHz"]
                    )
                    finite = [value for value in (lower, upper) if value is not None]
                    self.assertEqual(
                        summary["adjacentFrequencySpacingHz"],
                        {
                            "previous": lower,
                            "next": upper,
                            "nearest": min(finite) if finite else None,
                        },
                    )
                    kinematics = summary["surfaceKinematics"]
                    self.assertEqual(
                        kinematics[
                            "velocityScalePerUnitModalAmplitudePerSecond"
                        ],
                        omega,
                    )
                    self.assertEqual(
                        kinematics[
                            "accelerationScalePerUnitModalAmplitudePerSecondSquared"
                        ],
                        omega * omega,
                    )
                    self.assertEqual(
                        kinematics["velocityPhaseOffsetRad"], math.pi / 2
                    )
                    self.assertEqual(
                        kinematics["accelerationPhaseOffsetRad"], math.pi
                    )

    def test_sand_is_absent_outside_the_plate_and_fixed_hub(self) -> None:
        for dataset in datasets():
            manifest = json.loads(
                (dataset / "manifest.json").read_text(encoding="utf-8")
            )
            plate = json.loads(
                (dataset / manifest["files"]["plateSpec"]["path"]).read_text(
                    encoding="utf-8"
                )
            )
            descriptors = [
                row
                for row in manifest["files"]["textures"]
                if row["kind"] == "sand-density"
            ]
            radius = float(plate["geometry"]["radiusM"])
            hub = float(plate["geometry"]["hub"]["radiusM"])
            global_layer = 0
            for descriptor in descriptors:
                sand = validate_ktx2(
                    (dataset / descriptor["path"]).read_bytes()
                )
                layer_stride = sand.width * sand.height
                for local_layer in range(sand.layers):
                    offset = local_layer * layer_stride
                    for y in range(sand.height):
                        plate_y = (
                            (y + 0.5) / sand.height * 2.0 - 1.0
                        ) * radius
                        for x in range(sand.width):
                            plate_x = (
                                (x + 0.5) / sand.width * 2.0 - 1.0
                            ) * radius
                            radial = math.hypot(plate_x, plate_y)
                            if radial <= hub or radial > radius:
                                self.assertEqual(
                                    sand.image_data[
                                        offset + y * sand.width + x
                                    ],
                                    0,
                                    (
                                        "sand outside valid surface at "
                                        f"layer={global_layer}, x={x}, y={y}"
                                    ),
                                )
                    global_layer += 1
            self.assertEqual(global_layer, manifest["modeCount"])


if __name__ == "__main__":
    unittest.main()
