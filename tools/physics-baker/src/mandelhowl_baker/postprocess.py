"""Modal coupling, response, nodal mask, sand, normal, and binary output."""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Any

from .algorithm import (
    FINITE_DIFFERENCE_CHECK_ORDINALS,
    HIGH_VELOCITY_THRESHOLD,
    LOW_VELOCITY_THRESHOLD,
    NODAL_ABSOLUTE_THRESHOLD,
    NORMAL_VISUAL_SCALE,
    NORMALIZATION_FLOOR,
    RESPONSE_SAMPLE_COUNT,
    SAND_GAUSSIAN_SCALE,
)
from .field import MaterialField
from .ktx2 import write_ktx2_array
from .solver import Mode, SolveResult, evaluate_mode


@dataclass(frozen=True)
class RuntimeMode:
    mode_id: str
    ordinal: int
    texture_layer: int
    natural_frequency_hz: float
    angular_frequency_rad_per_s: float
    damping_ratio: float
    actuator_coupling: float
    microphone_coupling: float
    radiation_efficiency: float
    phase_reference_rad: float
    sign_reference: str
    dominant_radial_order: int
    dominant_angular_order: int
    dominant_symmetry: str


@dataclass(frozen=True)
class PostprocessedDataset:
    modes: tuple[RuntimeMode, ...]
    modes_binary: bytes
    response_binary: bytes
    response_metadata: dict[str, Any]
    textures: dict[str, bytes]
    texture_metadata: dict[str, dict[str, Any]]
    cross_validation: dict[str, Any]


def _normalized_runtime_modes(modes: tuple[Mode, ...]) -> tuple[RuntimeMode, ...]:
    actuator_scale = max(abs(mode.actuator_coupling_raw) for mode in modes)
    microphone_scale = max(abs(mode.microphone_coupling_raw) for mode in modes)
    radiation_scale = max(mode.radiation_efficiency_raw for mode in modes)
    result = []
    for layer, mode in enumerate(modes):
        result.append(
            RuntimeMode(
                mode_id=f"mode-{mode.ordinal:03d}",
                ordinal=mode.ordinal,
                texture_layer=layer,
                natural_frequency_hz=mode.frequency_hz,
                angular_frequency_rad_per_s=mode.angular_frequency_rad_per_s,
                damping_ratio=mode.damping_ratio,
                actuator_coupling=mode.actuator_coupling_raw / actuator_scale,
                microphone_coupling=mode.microphone_coupling_raw / microphone_scale,
                radiation_efficiency=max(
                    0.0, min(1.0, mode.radiation_efficiency_raw / radiation_scale)
                ),
                phase_reference_rad=0.0,
                sign_reference=mode.sign_reference,
                dominant_radial_order=mode.dominant_radial_order,
                dominant_angular_order=mode.dominant_angular_order,
                dominant_symmetry=mode.dominant_symmetry,
            )
        )
    return tuple(result)


def write_modes_binary(modes: tuple[RuntimeMode, ...]) -> bytes:
    """Write the shared ``mandelhowl-modes-v1`` little-endian contract."""

    output = bytearray(struct.pack("<8sHHI", b"MHMODES1", 1, 16, len(modes)))
    for mode in modes:
        record = bytearray(96)
        identifier = mode.mode_id.encode("utf-8")
        if len(identifier) >= 24:
            raise ValueError("mode id is too long for modes-v1")
        record[: len(identifier)] = identifier
        struct.pack_into("<II", record, 24, mode.ordinal, mode.texture_layer)
        struct.pack_into(
            "<7d",
            record,
            32,
            mode.natural_frequency_hz,
            mode.angular_frequency_rad_per_s,
            mode.damping_ratio,
            mode.actuator_coupling,
            mode.microphone_coupling,
            mode.radiation_efficiency,
            mode.phase_reference_rad,
        )
        record[88] = 0 if mode.sign_reference == "actuator-positive" else 1
        output.extend(record)
    return bytes(output)


def _complex_response(mode: RuntimeMode, frequency_hz: float) -> complex:
    omega = 2.0 * math.pi * frequency_hz
    omega_i = mode.angular_frequency_rad_per_s
    numerator = (
        mode.actuator_coupling
        * mode.microphone_coupling
        * mode.radiation_efficiency
        * omega_i
        * omega_i
    )
    denominator = complex(
        omega_i * omega_i - omega * omega,
        2.0 * mode.damping_ratio * omega_i * omega,
    )
    return numerator / denominator


def write_response_binary(
    modes: tuple[RuntimeMode, ...],
    minimum_hz: float,
    maximum_hz: float,
    sample_count: int = RESPONSE_SAMPLE_COUNT,
) -> tuple[bytes, dict[str, Any]]:
    frequencies = [
        minimum_hz * (maximum_hz / minimum_hz) ** (index / (sample_count - 1))
        for index in range(sample_count)
    ]
    raw = [sum((_complex_response(mode, frequency) for mode in modes), 0j) for frequency in frequencies]
    normalization = max(max(abs(value) for value in raw), NORMALIZATION_FLOOR)
    values = [value / normalization for value in raw]
    output = bytearray(struct.pack("<8sHHI", b"MHRESPN1", 1, 16, sample_count))
    for frequency, value in zip(frequencies, values):
        output.extend(struct.pack("<ddd", frequency, value.real, value.imag))
    return bytes(output), {
        "sampleCount": sample_count,
        "spacing": "logarithmic",
        "minimumFrequencyHz": minimum_hz,
        "maximumFrequencyHz": maximum_hz,
        "normalizationDivisor": normalization,
        "definition": (
            "sum(g_i*m_i*r_i*omega_i^2/"
            "(omega_i^2-omega^2+j*2*zeta_i*omega_i*omega))"
        ),
    }


def _shape_grid(
    spec: dict[str, Any],
    result: SolveResult,
    mode: Mode,
    size: int,
) -> tuple[list[float], list[bool]]:
    radius = float(spec["geometry"]["radiusM"])
    hub = float(spec["geometry"]["hub"]["radiusM"])
    step = 2.0 * radius / size
    values: list[float] = []
    valid: list[bool] = []
    for y in range(size):
        y_m = -radius + (y + 0.5) * step
        for x in range(size):
            x_m = -radius + (x + 0.5) * step
            radial = math.hypot(x_m, y_m)
            is_valid = hub < radial <= radius
            valid.append(is_valid)
            values.append(
                evaluate_mode(
                    mode.coefficients, result.basis, x_m, y_m, hub, radius
                )
                if is_valid
                else 0.0
            )
    scale = max((abs(value) for value, flag in zip(values, valid) if flag), default=1.0)
    return [value / scale for value in values], valid


def _finite_difference_frequency(
    spec: dict[str, Any],
    field: MaterialField,
    values: list[float],
    valid: list[bool],
    size: int,
) -> float:
    radius = float(spec["geometry"]["radiusM"])
    step = 2.0 * radius / size
    density = float(spec["material"]["densityKgPerM3"])
    youngs = float(spec["material"]["youngsModulusPa"])
    poisson = float(spec["material"]["poissonRatio"])
    bending_energy = 0.0
    mass_energy = 0.0
    area = step * step
    for y in range(1, size - 1):
        y_m = -radius + (y + 0.5) * step
        for x in range(1, size - 1):
            index = y * size + x
            neighbours = (
                index,
                index - 1,
                index + 1,
                index - size,
                index + size,
                index - size - 1,
                index - size + 1,
                index + size - 1,
                index + size + 1,
            )
            if not all(valid[neighbour] for neighbour in neighbours):
                continue
            x_m = -radius + (x + 0.5) * step
            thickness = field.at(x_m, y_m, thickness=True)
            rigidity = youngs * thickness**3 / (12.0 * (1.0 - poisson * poisson))
            hxx = (
                values[index - 1]
                - 2.0 * values[index]
                + values[index + 1]
            ) / (step * step)
            hyy = (
                values[index - size]
                - 2.0 * values[index]
                + values[index + size]
            ) / (step * step)
            hxy = (
                values[index + size + 1]
                - values[index + size - 1]
                - values[index - size + 1]
                + values[index - size - 1]
            ) / (4.0 * step * step)
            curvature = (
                hxx * hxx
                + hyy * hyy
                + 2.0 * poisson * hxx * hyy
                + 2.0 * (1.0 - poisson) * hxy * hxy
            )
            bending_energy += rigidity * curvature * area
            mass_energy += density * thickness * values[index] ** 2 * area
    return math.sqrt(
        bending_energy / max(mass_energy, NORMALIZATION_FLOOR)
    ) / (2.0 * math.pi)


def build_textures(
    spec: dict[str, Any],
    field: MaterialField,
    result: SolveResult,
    *,
    size: int = 64,
) -> tuple[dict[str, bytes], dict[str, dict[str, Any]], dict[str, Any]]:
    displacement = bytearray()
    normal = bytearray()
    nodal = bytearray()
    sand = bytearray()
    fd_checks: list[dict[str, Any]] = []
    sand_alignment: list[float] = []
    radius = float(spec["geometry"]["radiusM"])
    step = 2.0 * radius / size
    check_ordinals = FINITE_DIFFERENCE_CHECK_ORDINALS

    for mode in result.modes:
        values, valid = _shape_grid(spec, result, mode, size)
        layer_displacement = bytearray(
            max(0, min(255, round(127.5 * (value + 1.0)))) for value in values
        )
        layer_nodal = bytearray(len(values))
        layer_sand = bytearray(len(values))
        layer_normal = bytearray()
        low_velocity_sand = []
        high_velocity_sand = []
        for y in range(size):
            for x in range(size):
                index = y * size + x
                if not valid[index]:
                    layer_nodal[index] = 0
                    layer_sand[index] = 0
                    layer_normal.extend((128, 128))
                    continue
                absolute = abs(values[index])
                layer_nodal[index] = (
                    255 if absolute <= NODAL_ABSOLUTE_THRESHOLD else 0
                )
                density = math.exp(-((absolute / SAND_GAUSSIAN_SCALE) ** 2))
                layer_sand[index] = max(0, min(255, round(255.0 * density)))
                if absolute <= LOW_VELOCITY_THRESHOLD:
                    low_velocity_sand.append(density)
                elif absolute >= HIGH_VELOCITY_THRESHOLD:
                    high_velocity_sand.append(density)
                left = values[index - 1] if x > 0 and valid[index - 1] else values[index]
                right = (
                    values[index + 1]
                    if x + 1 < size and valid[index + 1]
                    else values[index]
                )
                down = (
                    values[index - size]
                    if y > 0 and valid[index - size]
                    else values[index]
                )
                up = (
                    values[index + size]
                    if y + 1 < size and valid[index + size]
                    else values[index]
                )
                dx = (right - left) / (2.0 * step)
                dy = (up - down) / (2.0 * step)
                # Visual normal scale is a documented exaggeration; topology and
                # coordinate alignment remain data-derived.
                visual_scale = NORMAL_VISUAL_SCALE
                length = math.sqrt(
                    1.0 + (visual_scale * dx) ** 2 + (visual_scale * dy) ** 2
                )
                nx = -visual_scale * dx / length
                ny = -visual_scale * dy / length
                layer_normal.extend(
                    (
                        max(0, min(255, round(127.5 * (nx + 1.0)))),
                        max(0, min(255, round(127.5 * (ny + 1.0)))),
                    )
                )
        displacement.extend(layer_displacement)
        nodal.extend(layer_nodal)
        sand.extend(layer_sand)
        normal.extend(layer_normal)
        sand_alignment.append(
            (sum(low_velocity_sand) / max(len(low_velocity_sand), 1))
            - (sum(high_velocity_sand) / max(len(high_velocity_sand), 1))
        )
        if mode.ordinal in check_ordinals:
            reference = _finite_difference_frequency(
                spec, field, values, valid, size
            )
            fd_checks.append(
                {
                    "modeId": f"mode-{mode.ordinal:03d}",
                    "rayleighRitzFrequencyHz": mode.frequency_hz,
                    "finiteDifferenceRayleighFrequencyHz": reference,
                    "relativeDifference": abs(reference - mode.frequency_hz)
                    / mode.frequency_hz,
                }
            )

    layers = len(result.modes)
    textures = {
        "signed-displacement": write_ktx2_array(
            width=size,
            height=size,
            layers=layers,
            channels=1,
            image_data=bytes(displacement),
        ),
        "normal": write_ktx2_array(
            width=size,
            height=size,
            layers=layers,
            channels=2,
            image_data=bytes(normal),
        ),
        "nodal-mask": write_ktx2_array(
            width=size,
            height=size,
            layers=layers,
            channels=1,
            image_data=bytes(nodal),
        ),
        "sand-density": write_ktx2_array(
            width=size,
            height=size,
            layers=layers,
            channels=1,
            image_data=bytes(sand),
        ),
    }
    metadata = {
        kind: {
            "widthPx": size,
            "heightPx": size,
            "layers": layers,
            "channels": 2 if kind == "normal" else 1,
            "vkFormat": "VK_FORMAT_R8G8_UNORM"
            if kind == "normal"
            else "VK_FORMAT_R8_UNORM",
            "supercompression": "none",
            "orientation": "ru",
            "uvOrigin": "negative-x-negative-y",
            "quantization": (
                "signed [-1,1] mapped to [0,255]"
                if kind == "signed-displacement"
                else "linear UNORM"
            ),
        }
        for kind in textures
    }
    cross_validation = {
        "independentReferenceMethod": (
            "nine-point finite-difference Hessian Kirchhoff-Love Rayleigh "
            "quotient on the rasterized mode; independent spatial discretization, "
            "not a second certified solver"
        ),
        "frequencyChecks": fd_checks,
        "sandDensityMeanContrastLowMinusHighVelocity": min(sand_alignment),
        "textureCoordinateAlignment": {
            "allAtlasesShareDimensions": True,
            "allAtlasesShareLayerOrder": True,
            "physicalPixel00M": [-radius + step * 0.5, -radius + step * 0.5],
            "xDirection": "increasing-column",
            "yDirection": "increasing-row",
        },
    }
    return textures, metadata, cross_validation


def postprocess(
    spec: dict[str, Any],
    field: MaterialField,
    result: SolveResult,
    *,
    texture_size: int = 64,
) -> PostprocessedDataset:
    modes = _normalized_runtime_modes(result.modes)
    modes_binary = write_modes_binary(modes)
    response_binary, response_metadata = write_response_binary(
        modes,
        float(spec["frequencyRange"]["minimumHz"]),
        float(spec["frequencyRange"]["maximumHz"]),
    )
    textures, texture_metadata, cross_validation = build_textures(
        spec, field, result, size=texture_size
    )
    return PostprocessedDataset(
        modes=modes,
        modes_binary=modes_binary,
        response_binary=response_binary,
        response_metadata=response_metadata,
        textures=textures,
        texture_metadata=texture_metadata,
        cross_validation=cross_validation,
    )
