"""Integrated validation for a packaged MandelHowl physics dataset."""

from __future__ import annotations

import copy
import json
import math
import re
import struct
from pathlib import Path
from typing import Any

from .algorithm import (
    MATERIAL_SECTION_AXIS,
    MATERIAL_SECTION_SAMPLE_COUNT,
    NODAL_ABSOLUTE_THRESHOLD,
    RUNTIME_COUPLING_QUANTUM,
    RUNTIME_FREQUENCY_QUANTUM_HZ,
    SAND_GAUSSIAN_SCALE,
    SIGN_EPSILON,
    TEXTURE_LAYERS_PER_SHARD,
)
from .canonical import canonical_json_bytes, sha256_bytes, sha256_file
from .ktx2 import Ktx2Info, validate_ktx2
from .packaging import IDENTITY_SCOPE, _expected_runtime_coverage_binding
from .postprocess import _quantize_runtime_scalar
from .schema_validation import validate as validate_schema
from .spec_validation import validate_plate_spec_contract
from .solver import (
    _first_analysis_node_value,
    _probe_average,
    build_basis,
    evaluate_mode,
)


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
        if (
            damping <= 0.0
            or damping > 0.2
            or abs(actuator) > 1.0
            or abs(microphone) > 1.0
            or not 0.0 <= radiation <= 1.0
        ):
            raise ValueError(f"mode {identifier} violates normalized modal bounds")
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
    if (
        len(response) < 2
        or frequencies != sorted(frequencies)
        or any(frequency <= 0.0 for frequency in frequencies)
        or len(set(frequencies)) != len(frequencies)
    ):
        raise ValueError("response frequencies must be positive and strictly ascending")
    return response


def _validate_provenance(
    *,
    dataset: Path,
    manifest: dict[str, Any],
    plate_spec: dict[str, Any],
    provenance: dict[str, Any],
    modes: list[dict[str, Any]],
) -> None:
    canonical = provenance.get("canonicalInput", {})
    generator = provenance.get("generator", {})
    solver = provenance.get("solver", {})
    if (
        provenance.get("schemaVersion") != "mandelhowl.provenance.v1"
        or canonical.get("plateId") != plate_spec["plateId"]
        or canonical.get("canonicalJsonSha256") != manifest["plate"]["specSha256"]
        or generator.get("name") != manifest["ownership"]["generator"]
        or generator.get("randomSource") != "forbidden"
        or solver.get("name") != manifest["solverProvenance"]["solverName"]
        or solver.get("version") != manifest["solverProvenance"]["solverVersion"]
        or solver.get("containerImageDigest")
        != manifest["solverProvenance"]["containerImageDigest"]
        or solver.get("optionsSha256")
        != manifest["solverProvenance"]["optionsSha256"]
        or solver.get("executionKind")
        != manifest["solverProvenance"]["executionKind"]
        or solver.get("normalization") != plate_spec["solverRequest"]["normalization"]
        or solver.get("signRule") != plate_spec["solverRequest"]["signReference"]
    ):
        raise ValueError("provenance identity or solver contract is inconsistent")
    execution_kind = solver.get("executionKind")
    container_digest = solver.get("containerImageDigest")
    if execution_kind == "native-process":
        if (
            solver.get("containerized") is not False
            or container_digest is not None
            or solver.get("containerRunnerAttestation")
            != "not-applicable-native-process"
        ):
            raise ValueError("native execution provenance claims a container image")
    elif execution_kind == "oci-container":
        if (
            solver.get("containerized") is not True
            or not isinstance(container_digest, str)
            or re.fullmatch(r"sha256:[a-f0-9]{64}", container_digest)
            is None
            or solver.get("containerRunnerAttestation")
            not in {
                "trusted-runner-attested",
                "environment-declared-development-only",
            }
        ):
            raise ValueError("container execution provenance is incomplete")
    else:
        raise ValueError("solver execution provenance kind is unsupported")
    if manifest["coordinateSystem"] != plate_spec["coordinateSystem"]:
        raise ValueError("manifest and plate coordinate systems differ")
    if manifest["units"] != plate_spec["units"]:
        raise ValueError("manifest and plate unit declarations differ")
    if manifest["frequencyRange"] != plate_spec["frequencyRange"]:
        raise ValueError("manifest and plate frequency ranges differ")
    if (
        plate_spec["solverRequest"]["frequencyRangeHz"]
        != [
            plate_spec["frequencyRange"]["minimumHz"],
            plate_spec["frequencyRange"]["maximumHz"],
        ]
        or plate_spec["solverRequest"]["requestedModeCount"] != len(modes)
    ):
        raise ValueError("plate solver request differs from packaged modal range")

    summaries = provenance.get("modes")
    if not isinstance(summaries, list) or len(summaries) != len(modes):
        raise ValueError("provenance mode inventory differs from modes.bin")
    versioned = manifest.get("algorithmRevision") is not None
    for index, (summary, mode) in enumerate(zip(summaries, modes)):
        for key in (
            "modeId",
            "ordinal",
            "naturalFrequencyHz",
            "dampingRatio",
            "actuatorCoupling",
            "microphoneCoupling",
            "radiationEfficiency",
            "textureLayer",
        ):
            if summary.get(key) != mode[key]:
                raise ValueError(f"provenance mode {index} differs at {key}")
        expected_sign = (
            "actuator-positive"
            if mode["signReference"] == 0
            else "first-nonzero-node-positive"
        )
        if summary.get("signReference") != expected_sign:
            raise ValueError(f"provenance mode {index} sign reference differs")
        if not versioned:
            continue
        angular = mode["angularFrequencyRadPerSecond"]
        previous = (
            None
            if index == 0
            else mode["naturalFrequencyHz"]
            - modes[index - 1]["naturalFrequencyHz"]
        )
        following = (
            None
            if index + 1 == len(modes)
            else modes[index + 1]["naturalFrequencyHz"]
            - mode["naturalFrequencyHz"]
        )
        finite_spacings = [
            spacing for spacing in (previous, following) if spacing is not None
        ]
        expected_spacing = {
            "previous": previous,
            "next": following,
            "nearest": min(finite_spacings) if finite_spacings else None,
        }
        kinematics = summary.get("surfaceKinematics", {})
        if (
            summary.get("angularFrequencyRadPerSecond") != angular
            or summary.get("adjacentFrequencySpacingHz") != expected_spacing
            or kinematics.get("signedDisplacementTextureLayer")
            != mode["textureLayer"]
            or kinematics.get("velocityScalePerUnitModalAmplitudePerSecond")
            != angular
            or kinematics.get("velocityPhaseOffsetRad") != math.pi / 2.0
            or kinematics.get(
                "accelerationScalePerUnitModalAmplitudePerSecondSquared"
            )
            != angular * angular
            or kinematics.get("accelerationPhaseOffsetRad") != math.pi
        ):
            raise ValueError(f"provenance mode {index} kinematics/spacing is invalid")

    if versioned:
        revision = manifest["algorithmRevision"]
        algorithm_path = dataset / "science" / "baker-algorithm.v1.json"
        if (
            generator.get("algorithmRevision") != revision
            or solver.get("options", {}).get("algorithmRevision") != revision
            or not algorithm_path.is_file()
        ):
            raise ValueError("versioned algorithm provenance is incomplete")
        algorithm_bytes = algorithm_path.read_bytes()
        algorithm = json.loads(algorithm_bytes)
        if (
            algorithm.get("algorithmRevision") != revision
            or generator.get("algorithmContractSha256")
            != sha256_bytes(algorithm_bytes)
            or solver.get("options", {}).get("algorithmContractSha256")
            != sha256_bytes(algorithm_bytes)
        ):
            raise ValueError("algorithm evidence does not match provenance")
        transform = provenance.get("renderingCoordinateTransform", {})
        if transform != {
            "sourceFrame": plate_spec["coordinateSystem"]["frame"],
            "uvOrigin": plate_spec["textureRequest"]["uvOrigin"],
            "uAxis": plate_spec["textureRequest"]["uvXAxis"],
            "vAxis": plate_spec["textureRequest"]["uvYAxis"],
            "plateXFromU": "x=(2*u-1)*radiusM",
            "plateYFromV": "y=(2*v-1)*radiusM",
            "validSurfaceDomain": "hubRadiusM<hypot(x,y)<=radiusM",
            "radiusM": plate_spec["geometry"]["radiusM"],
            "hubRadiusM": plate_spec["geometry"]["hub"]["radiusM"],
        }:
            raise ValueError("rendering coordinate transform is incomplete")
        derived = provenance.get("derivedRuntimeFields", {})
        surface = derived.get("surfaceKinematics", {})
        emissive = derived.get("emissiveTexture", {})
        if (
            surface.get("basisTextureKind") != "signed-displacement"
            or surface.get("displacementFormula")
            != "u(x,t)=sum_i(q_i(t)*D_i(x))"
            or surface.get("velocityFormula")
            != "v(x,t)=sum_i(qDot_i(t)*D_i(x))"
            or surface.get("accelerationFormula")
            != "a(x,t)=sum_i(qDoubleDot_i(t)*D_i(x))"
            or emissive.get("basisTextureKind") != "nodal-mask"
            or emissive.get("basisAliasPolicy") != "byte-identical-basis-reuse"
            or emissive.get("basisEquivalence")
            != "emissiveBasisUNorm8(x,mode)=nodalMaskUNorm8(x,mode)"
            or emissive.get("fullScreenFlashAllowed") is not False
            or emissive.get("scientificRole") != "visual-abstraction"
            or algorithm.get("texture", {}).get("supercompressionScheme") != 3
            or algorithm.get("texture", {}).get("emissiveBasisSource")
            != "nodal-mask"
            or algorithm.get("assembly", {}).get("analysisResolutionSource")
            != "plate-spec.solverRequest.meshLevels[*].analysisFiniteStrip"
        ):
            raise ValueError("derived runtime field provenance is incomplete")


def _validate_mesh_evidence(
    dataset: Path,
    plate_spec: dict[str, Any],
    convergence: dict[str, Any],
) -> None:
    evidence = _read_json(dataset / "mesh" / "mesh-evidence.json")
    quality = evidence.get("qualityPolicy", {})
    expected = plate_spec["solverRequest"]["meshQuality"]
    levels = evidence.get("levels")
    if (
        evidence.get("schemaVersion") != "mandelhowl.mesh-evidence.v1"
        or not isinstance(levels, list)
        or len(levels) != len(plate_spec["solverRequest"]["meshLevels"])
        or quality.get("minimumEdgeM") != float(expected["minimumEdgeM"])
        or quality.get("minimumSignedAreaM2")
        != float(expected["minimumSignedAreaM2"])
        or quality.get("maximumAspectRatio")
        != float(expected["maximumAspectRatio"])
        or quality.get("requiredConnectedComponentCount")
        != int(expected["requiredConnectedComponentCount"])
        or quality.get("maximumInvertedTriangleCount")
        != int(expected["maximumInvertedTriangleCount"])
        or quality.get("negativeAreaAllowed") is not False
        or quality.get("disconnectedComponentsAllowed") is not False
        or quality.get("accepted") is not True
        or convergence.get("meshEvidence") != levels
        or convergence.get("surfaceMeshQualityAccepted") is not True
    ):
        raise ValueError("mesh evidence does not bind canonical quality thresholds")
    for index, (level, request) in enumerate(
        zip(levels, plate_spec["solverRequest"]["meshLevels"])
    ):
        numeric = (
            level.get("minimumEdgeM"),
            level.get("minimumSignedAreaM2"),
            level.get("maximumAspectRatio"),
        )
        if (
            level.get("levelName") != request["name"]
            or not all(
                isinstance(value, (int, float)) and math.isfinite(value)
                for value in numeric
            )
            or float(level["minimumEdgeM"]) < float(expected["minimumEdgeM"])
            or float(level["minimumSignedAreaM2"])
            < float(expected["minimumSignedAreaM2"])
            or float(level["maximumAspectRatio"])
            > float(expected["maximumAspectRatio"])
            or level.get("connectedComponentCount")
            != int(expected["requiredConnectedComponentCount"])
            or level.get("invertedTriangleCount")
            > int(expected["maximumInvertedTriangleCount"])
        ):
            raise ValueError(
                f"mesh evidence level {index} failed canonical quality thresholds"
            )


def _validate_material_section_profile(
    *,
    dataset: Path,
    manifest: dict[str, Any],
    plate_spec: dict[str, Any],
) -> None:
    profile = manifest["plate"].get("materialSectionProfile")
    if not isinstance(profile, dict):
        raise ValueError("versioned manifest material section profile is missing")
    samples = profile.get("thicknessUnorm8")
    minimum = float(plate_spec["thicknessMapping"]["minimumThicknessM"])
    maximum = float(plate_spec["thicknessMapping"]["maximumThicknessM"])
    if (
        profile.get("schemaVersion")
        != "mandelhowl.material-section-profile.v1"
        or profile.get("axis") != MATERIAL_SECTION_AXIS
        or profile.get("sampleCount") != MATERIAL_SECTION_SAMPLE_COUNT
        or profile.get("minimumThicknessM") != minimum
        or profile.get("maximumThicknessM") != maximum
        or not isinstance(samples, list)
        or len(samples) != MATERIAL_SECTION_SAMPLE_COUNT
        or any(
            not isinstance(value, int) or isinstance(value, bool)
            or not 0 <= value <= 255
            for value in samples
        )
    ):
        raise ValueError("versioned material section profile is incompatible")
    if max(samples) - min(samples) < 8:
        raise ValueError("material section profile does not expose thickness variation")

    field_bytes = (dataset / "field" / "mandelbrot-field.bin").read_bytes()
    if len(field_bytes) < 24:
        raise ValueError("material field evidence is truncated")
    magic, version, size, _, _ = struct.unpack_from("<8sIIff", field_bytes, 0)
    if (
        magic != b"MHFIELD1"
        or version != 1
        or size < 2
        or len(field_bytes) != 24 + size * size
    ):
        raise ValueError("material field evidence is incompatible")
    pixels = field_bytes[24:]

    def field_at(u: float, v: float) -> float:
        x0 = min(size - 2, int(math.floor(u)))
        y0 = min(size - 2, int(math.floor(v)))
        tx = u - x0
        ty = v - y0
        i00 = y0 * size + x0
        a = pixels[i00] * (1.0 - tx) + pixels[i00 + 1] * tx
        b = (
            pixels[i00 + size] * (1.0 - tx)
            + pixels[i00 + size + 1] * tx
        )
        return (a * (1.0 - ty) + b * ty) / 255.0

    v = 0.5 * (size - 1)
    maximum_lsb_error = 0
    for index, actual in enumerate(samples):
        u = (index + 0.5) / MATERIAL_SECTION_SAMPLE_COUNT * (size - 1)
        normalized_field = max(0.0, min(1.0, field_at(u, v)))
        smooth = normalized_field * normalized_field * (
            3.0 - 2.0 * normalized_field
        )
        expected = round(smooth * 255.0)
        maximum_lsb_error = max(maximum_lsb_error, abs(actual - expected))
    if maximum_lsb_error > 2:
        raise ValueError(
            "material section profile is not derived from packaged field "
            f"evidence: maximumLsbError={maximum_lsb_error}"
        )


def _validate_modal_sign_and_texture_semantics(
    *,
    plate_spec: dict[str, Any],
    modes: list[dict[str, Any]],
    provenance: dict[str, Any],
    solver_evidence_path: Path,
    textures: dict[str, Any],
) -> dict[str, float]:
    mass, coefficients = decode_solver_evidence(solver_evidence_path)
    fine = plate_spec["solverRequest"]["meshLevels"][-1][
        "analysisFiniteStrip"
    ]
    radial_elements = int(fine["radialElementCount"])
    maximum_fourier_order = int(fine["maximumFourierOrder"])
    angular_samples = int(fine["angularQuadratureSamples"])
    basis = build_basis(radial_elements, maximum_fourier_order)
    if (
        len(mass) != len(basis)
        or len(coefficients) != len(modes)
        or any(len(row) != len(basis) for row in coefficients)
    ):
        raise ValueError("solver evidence does not match the fine FEM basis")

    radius = float(plate_spec["geometry"]["radiusM"])
    hub = float(plate_spec["geometry"]["hub"]["radiusM"])
    actuator = plate_spec["actuator"]
    actuator_raw = [
        _probe_average(
            row,
            basis,
            float(actuator["positionM"]["x"]),
            float(actuator["positionM"]["y"]),
            float(actuator["footprintRadiusM"]),
            hub,
            radius,
        )
        for row in coefficients
    ]
    actuator_scale = max(
        max(abs(value) for value in actuator_raw),
        1e-300,
    )
    summaries = provenance["modes"]
    for index, (mode, summary, row, raw) in enumerate(
        zip(modes, summaries, coefficients, actuator_raw)
    ):
        if mode["signReference"] == 0:
            sign_valid = raw > SIGN_EPSILON
            expected_sign = "actuator-positive"
        else:
            first_node = _first_analysis_node_value(
                row,
                basis,
                radial_element_count=radial_elements,
                angular_samples=angular_samples,
                hub_radius_m=hub,
                outer_radius_m=radius,
            )
            sign_valid = abs(raw) <= SIGN_EPSILON and first_node > SIGN_EPSILON
            expected_sign = "first-nonzero-node-positive"
        expected_coupling = _quantize_runtime_scalar(
            raw / actuator_scale,
            RUNTIME_COUPLING_QUANTUM,
        )
        if (
            not sign_valid
            or summary.get("signReference") != expected_sign
            or mode["actuatorCoupling"].hex() != expected_coupling.hex()
        ):
            raise ValueError(
                f"mode {index} sign/coupling does not match solver coefficients"
            )

    displacement = textures["signed-displacement"]
    nodal = textures["nodal-mask"]
    sand = textures["sand-density"]
    if (
        displacement.width != nodal.width
        or displacement.height != nodal.height
        or displacement.layers != len(modes)
        or nodal.layers != len(modes)
        or sand.layers != len(modes)
    ):
        raise ValueError("scientific texture layers are not mode-aligned")
    width = displacement.width
    height = displacement.height
    layer_pixels = width * height
    step_x = 2.0 * radius / width
    step_y = 2.0 * radius / height
    sample_stride = max(1, min(width, height) // 16)
    minimum_correlation = 1.0
    minimum_sand_contrast = math.inf
    nodal_quantization_margin = 1.0 / 127.5
    for layer, row in enumerate(coefficients):
        start = layer * layer_pixels
        end = start + layer_pixels
        displacement_layer = displacement.image_data[start:end]
        nodal_layer = nodal.image_data[start:end]
        sand_layer = sand.image_data[start:end]
        low_sum = 0.0
        low_count = 0
        high_sum = 0.0
        high_count = 0
        nodal_count = 0
        raw_samples: list[float] = []
        encoded_samples: list[float] = []
        extreme_index = max(
            range(layer_pixels),
            key=lambda pixel: abs(
                displacement_layer[pixel] / 127.5 - 1.0
            ),
        )
        for pixel in range(layer_pixels):
            y, x = divmod(pixel, width)
            x_m = -radius + (x + 0.5) * step_x
            y_m = -radius + (y + 0.5) * step_y
            radial = math.hypot(x_m, y_m)
            valid = hub < radial <= radius
            encoded = displacement_layer[pixel] / 127.5 - 1.0
            absolute = abs(encoded)
            nodal_value = nodal_layer[pixel]
            sand_value = sand_layer[pixel]
            if not valid:
                if (
                    displacement_layer[pixel] != 128
                    or nodal_value != 0
                    or sand_value != 0
                ):
                    raise ValueError(
                        f"texture layer {layer} leaks outside the plate domain"
                    )
                continue
            if nodal_value >= 250:
                nodal_count += 1
                if (
                    absolute
                    > NODAL_ABSOLUTE_THRESHOLD
                    + nodal_quantization_margin
                ):
                    raise ValueError(
                        f"texture layer {layer} nodal mask is displaced"
                    )
            elif (
                absolute
                < NODAL_ABSOLUTE_THRESHOLD
                - nodal_quantization_margin
            ):
                raise ValueError(
                    f"texture layer {layer} omits a resolved nodal pixel"
                )
            expected_sand = round(
                255.0
                * math.exp(
                    -((absolute / SAND_GAUSSIAN_SCALE) ** 2)
                )
            )
            if abs(sand_value - expected_sand) > 10:
                raise ValueError(
                    f"texture layer {layer} sand density is not displacement-derived"
                )
            if absolute <= 0.1 and nodal_value > 0:
                low_sum += sand_value
                low_count += 1
            elif absolute >= 0.5:
                high_sum += sand_value
                high_count += 1
            if (
                (x % sample_stride == 0 and y % sample_stride == 0)
                or pixel == extreme_index
            ):
                raw_samples.append(
                    evaluate_mode(
                        row,
                        basis,
                        x_m,
                        y_m,
                        hub,
                        radius,
                    )
                )
                encoded_samples.append(encoded)
        if nodal_count <= 5 or low_count == 0 or high_count == 0:
            raise ValueError(
                f"texture layer {layer} lacks nodal/sand semantic evidence"
            )
        contrast = low_sum / low_count - high_sum / high_count
        minimum_sand_contrast = min(minimum_sand_contrast, contrast)
        if contrast <= 0.0:
            raise ValueError(
                f"texture layer {layer} sand is not concentrated at nodes"
            )
        cross = sum(
            raw * encoded
            for raw, encoded in zip(raw_samples, encoded_samples)
        )
        raw_norm = sum(raw * raw for raw in raw_samples)
        encoded_norm = sum(value * value for value in encoded_samples)
        correlation = cross / math.sqrt(
            max(raw_norm * encoded_norm, 1e-300)
        )
        minimum_correlation = min(minimum_correlation, correlation)
        if correlation < 0.995:
            raise ValueError(
                f"texture layer {layer} displacement sign/shape differs "
                "from the FEM eigenvector"
            )
    return {
        "minimumEigenvectorTextureCorrelation": minimum_correlation,
        "minimumSandContrast": minimum_sand_contrast,
    }


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
    versioned = manifest.get("algorithmRevision") is not None
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
    if versioned:
        for mode in modes:
            frequency = mode["naturalFrequencyHz"]
            quantized_frequency = (
                round(frequency / RUNTIME_FREQUENCY_QUANTUM_HZ)
                * RUNTIME_FREQUENCY_QUANTUM_HZ
            )
            if (
                frequency.hex() != quantized_frequency.hex()
                or mode["angularFrequencyRadPerSecond"].hex()
                != (frequency * math.tau).hex()
            ):
                raise ValueError(
                    f"{mode['modeId']} frequency is outside the versioned "
                    "runtime modal output grid"
                )
            for key in (
                "actuatorCoupling",
                "microphoneCoupling",
                "radiationEfficiency",
            ):
                value = mode[key]
                quantized = (
                    round(value / RUNTIME_COUPLING_QUANTUM)
                    * RUNTIME_COUPLING_QUANTUM
                )
                if value.hex() != (0.0 if quantized == 0.0 else quantized).hex():
                    raise ValueError(
                        f"{mode['modeId']} {key} is outside the versioned "
                        "runtime modal output grid"
                    )
    response = decode_response(dataset / files["response"]["path"])
    if (
        abs(response[0][0] - frequency_range["minimumHz"]) > 1e-9
        or abs(response[-1][0] - frequency_range["maximumHz"]) > 1e-9
    ):
        raise ValueError("response endpoints differ from manifest frequency range")

    mode_ids = [mode["modeId"] for mode in modes]
    expected_texture_channels = {
        "signed-displacement": 1,
        "normal": 2,
        "nodal-mask": 1,
        "sand-density": 1,
    }
    decoded_textures: dict[str, Any] = {}
    for kind, expected_channels in expected_texture_channels.items():
        descriptors = [
            texture
            for texture in files["textures"]
            if texture.get("kind") == kind
        ]
        if not descriptors:
            raise ValueError(f"texture kind is missing: {kind}")
        covered_mode_ids: list[str] = []
        image_data = bytearray()
        encoded_level_length = 0
        first_info: Ktx2Info | None = None
        for descriptor in descriptors:
            first_layer = len(covered_mode_ids)
            last_layer = (
                first_layer + len(descriptor.get("modeIds", [])) - 1
            )
            expected_path = (
                f"textures/{kind}-{first_layer:02d}-{last_layer:02d}.ktx2"
            )
            if versioned and descriptor.get("path") != expected_path:
                raise ValueError(
                    f"texture shard path/order mismatch: {descriptor.get('path')}"
                )
            info = validate_ktx2(
                (dataset / descriptor["path"]).read_bytes()
            )
            if (
                info.width != descriptor["widthPx"]
                or info.height != descriptor["heightPx"]
                or info.layers != descriptor["layers"]
                or info.channels != expected_channels
                or info.orientation != "ru"
                or len(descriptor["modeIds"]) != info.layers
                or (
                    versioned
                    and (
                        info.supercompression_scheme != 3
                        or descriptor.get("supercompressionScheme") != 3
                        or info.layers != TEXTURE_LAYERS_PER_SHARD
                    )
                )
            ):
                raise ValueError(
                    f"texture metadata mismatch: {descriptor['path']}"
                )
            if first_info is not None and (
                info.width != first_info.width
                or info.height != first_info.height
                or info.channels != first_info.channels
            ):
                raise ValueError(f"texture shard dimensions differ: {kind}")
            first_info = first_info or info
            covered_mode_ids.extend(descriptor["modeIds"])
            image_data.extend(info.image_data)
            encoded_level_length += info.encoded_level_length
        if covered_mode_ids != mode_ids:
            raise ValueError(
                f"{kind} texture shards do not cover modes in global order"
            )
        assert first_info is not None
        decoded_textures[kind] = Ktx2Info(
            vk_format=first_info.vk_format,
            width=first_info.width,
            height=first_info.height,
            layers=len(mode_ids),
            channels=first_info.channels,
            orientation=first_info.orientation,
            supercompression_scheme=first_info.supercompression_scheme,
            encoded_level_length=encoded_level_length,
            level_offset=0,
            level_length=len(image_data),
            image_data=bytes(image_data),
        )

    convergence = _read_json(dataset / files["convergenceReport"]["path"])
    method_conformance = convergence.get("methodConformance", {})
    if (
        not convergence.get("accepted")
        or not convergence.get("finiteElementMeshConvergenceAccepted")
        or not convergence.get("surfaceMeshQualityAccepted")
        or not convergence.get("independentCrossValidation", {}).get("accepted")
        or not method_conformance.get("handoffThinPlateMethodAllowed")
        or not method_conformance.get("matchesCanonicalElementFamily")
    ):
        raise ValueError("numerical convergence report is not accepted")
    if versioned and (
        method_conformance.get("thinPlateEigenanalysisSupported") is not True
        or method_conformance.get("surfaceMeshQualityValidated") is not True
        or method_conformance.get("finiteElementAssemblyUsed") is not True
        or method_conformance.get(
            "analysisSurfaceElementMeshCoupledToEigenproblem"
        )
        is not True
        or method_conformance.get(
            "surfaceTriangleArchiveCoupledToEigenproblem"
        )
        is not False
        or method_conformance.get("strictLiteralSection10_3Conformance")
        is not True
        or method_conformance.get("operationalDisposition")
        != "strict-thin-plate-finite-element-adapter"
        or "deviationCode" in method_conformance
    ):
        raise ValueError(
            "versioned solver evidence does not prove strict Section 10.3/B1 "
            "finite-strip finite-element conformance"
        )
    provenance = _read_json(dataset / files["provenance"]["path"])
    manufacturing = provenance["manufacturing"]
    plate_spec = _read_json(dataset / files["plateSpec"]["path"])
    plate_schema = _read_json(
        repository
        / "packages"
        / "contracts"
        / "schemas"
        / "plate-spec.schema.json"
    )
    validate_schema(plate_spec, plate_schema)
    validate_plate_spec_contract(plate_spec)
    _validate_mesh_evidence(dataset, plate_spec, convergence)
    if versioned:
        _validate_material_section_profile(
            dataset=dataset,
            manifest=manifest,
            plate_spec=plate_spec,
        )
    _validate_provenance(
        dataset=dataset,
        manifest=manifest,
        plate_spec=plate_spec,
        provenance=provenance,
        modes=modes,
    )
    modal_texture_semantics = (
        _validate_modal_sign_and_texture_semantics(
            plate_spec=plate_spec,
            modes=modes,
            provenance=provenance,
            solver_evidence_path=dataset
            / "science"
            / "solver-evidence.bin",
            textures=decoded_textures,
        )
        if versioned
        else {}
    )
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
    expected_targets = list(range(101))
    static = coverage.get("staticDistribution", {})
    outputs = coverage.get("outputs", [])
    traces = coverage.get("traces", [])
    runtime_binding = _expected_runtime_coverage_binding()
    generated_by = coverage.get("generatedBy", {})
    exact_runtime_binding = (
        not versioned
        or (
            coverage.get("runtimeAlgorithmRevision")
            == runtime_binding["runtimeAlgorithmRevision"]
            and coverage.get("runtimeSpecSha256")
            == runtime_binding["runtimeSpecSha256"]
            and coverage.get("coverageContract")
            == runtime_binding["coverageContract"]
            and generated_by.get("algorithm")
            == "deterministic-global-trajectory-search-v2"
            and generated_by.get("feedbackAlgorithmRevision")
            == runtime_binding["runtimeAlgorithmRevision"]
            and generated_by.get("perValueRuntimeLookup") == "forbidden"
            and generated_by.get("randomSource") == "forbidden"
        )
    )
    common_coverage_invalid = (
        coverage.get("schemaVersion") != "mandelhowl.coverage-report.v2"
        or coverage.get("perValueRuntimeExceptionTable") is not False
        or targets != expected_targets
    )
    replay_verified = (
        coverage.get("modalModelId") == f"sha256:{files['modes']['sha256']}"
        and coverage.get("verificationStatus") == "runtime-replay-verified"
        and coverage.get("replayVerified") is True
        and coverage.get("coveredValues") == expected_targets
        and coverage.get("missingValues") == []
        and len(traces) == 101
        and exact_runtime_binding
    )
    # Keep the replay predicate explicit; a malformed trace or static
    # distribution cannot be promoted by the preceding scalar fields.
    replay_verified = replay_verified and not (
        len(traces) != 101
        or any(
            row.get("verification") != "runtime-replay-verified"
            or row.get("verified") is not True
            or row.get("trace") != traces[row["target"]]
            for row in outputs
        )
        or static.get("sampleCount")
        != static.get("zeroCount", 0)
        + static.get("hundredCount", 0)
        + static.get("intermediateCount", 0)
        or abs(
            static.get("extremeFraction", -1)
            - (
                static.get("zeroCount", 0) + static.get("hundredCount", 0)
            )
            / max(static.get("sampleCount", 0), 1)
        )
        > 1e-12
        or static.get("extremeFraction", 0)
        < static.get("requiredExtremeFraction", 1)
        or static.get("passed") is not True
    )
    generation = _read_json(dataset / "generation-report.json")
    if versioned:
        deviations = generation.get("knownContractDeviations")
        if (
            generation.get("handoffFullConformance") is not True
            or generation.get("handoffOperationalDisposition")
            != "strict-thin-plate-finite-element-adapter"
            or not isinstance(deviations, list)
            or deviations != []
        ):
            raise ValueError(
                "generation report does not prove strict Section 10.3/B1 "
                "finite-element conformance"
            )
    foundation_only = (
        generation.get("releaseBake") is False
        and generation.get("coverageSource") == "baker-physical-search-foundation"
        and coverage.get("verificationStatus") == "physics-foundation-only"
        and coverage.get("releaseEligible") is False
        and all(
            row.get("verification") == "candidate-requires-runtime-replay"
            and isinstance(row.get("physicalAnchor"), dict)
            for row in outputs
        )
    )
    if common_coverage_invalid or not (replay_verified or foundation_only):
        raise ValueError("coverage report does not prove deterministic 0..100 reachability")
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
        **modal_texture_semantics,
        "coverageVerificationStatus": coverage.get("verificationStatus"),
        "valid": True,
    }
