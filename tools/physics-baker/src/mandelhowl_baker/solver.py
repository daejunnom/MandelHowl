"""Variable-thickness Kirchhoff-Love Rayleigh-Ritz eigenmode solver.

This is a genuine numerical thin-plate eigenanalysis, but it is intentionally
not labelled as shell FEM. A deterministic global trial basis is integrated on
three polar quadrature levels. The generated provenance records this method
deviation from the canonical spec's currently requested ``elementFamily:
shell`` so the distinction cannot be hidden by packaging.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Any, Iterable

from .algorithm import (
    AXISYMMETRIC_RADIAL_ORDERS,
    HIGH_ANGULAR_MAXIMUM,
    HIGH_ANGULAR_MINIMUM,
    HIGH_ANGULAR_RADIAL_ORDERS,
    HESSIAN_STEP_RATIO,
    JACOBI_MAXIMUM_SWEEPS,
    JACOBI_RELATIVE_TOLERANCE,
    LOW_ANGULAR_MAXIMUM,
    LOW_ANGULAR_MINIMUM,
    LOW_ANGULAR_RADIAL_ORDERS,
    NORMALIZATION_FLOOR,
    ORDINAL_DAMPING_SLOPE,
    PROBE_RING_RADIUS_RATIO,
    PROBE_RING_SAMPLES,
    RADIATION_ANGULAR_SAMPLES,
    RADIATION_COHERENCE_FLOOR,
    RADIATION_COHERENCE_WEIGHT,
    RADIATION_RADIAL_SAMPLES,
    SIGN_EPSILON,
)
from .field import MaterialField
from .linear_algebra import (
    Matrix,
    generalized_to_standard,
    jacobi_eigen_symmetric,
    mass_inner,
    solve_upper_from_lower_transpose,
)


@dataclass(frozen=True)
class BasisFunction:
    radial_order: int
    angular_order: int
    symmetry: str


@dataclass(frozen=True)
class Mode:
    ordinal: int
    frequency_hz: float
    angular_frequency_rad_per_s: float
    damping_ratio: float
    coefficients: tuple[float, ...]
    actuator_coupling_raw: float
    microphone_coupling_raw: float
    radiation_efficiency_raw: float
    sign_reference: str
    dominant_radial_order: int
    dominant_angular_order: int
    dominant_symmetry: str


@dataclass(frozen=True)
class SolveResult:
    modes: tuple[Mode, ...]
    basis: tuple[BasisFunction, ...]
    mass_matrix: tuple[tuple[float, ...], ...]
    stiffness_matrix: tuple[tuple[float, ...], ...]
    all_frequencies_hz: tuple[float, ...]
    quadrature: dict[str, int | float]
    eigensolver: dict[str, int | float | str]


def build_basis() -> tuple[BasisFunction, ...]:
    basis: list[BasisFunction] = []
    for radial in range(AXISYMMETRIC_RADIAL_ORDERS):
        basis.append(BasisFunction(radial, 0, "axisymmetric"))
    for angular in range(LOW_ANGULAR_MINIMUM, LOW_ANGULAR_MAXIMUM + 1):
        for radial in range(LOW_ANGULAR_RADIAL_ORDERS):
            basis.append(BasisFunction(radial, angular, "cosine"))
            basis.append(BasisFunction(radial, angular, "sine"))
    for angular in range(HIGH_ANGULAR_MINIMUM, HIGH_ANGULAR_MAXIMUM + 1):
        for radial in range(HIGH_ANGULAR_RADIAL_ORDERS):
            basis.append(BasisFunction(radial, angular, "cosine"))
            basis.append(BasisFunction(radial, angular, "sine"))
    return tuple(basis)


def _legendre(order: int, value: float) -> float:
    if order == 0:
        return 1.0
    if order == 1:
        return value
    previous = 1.0
    current = value
    for degree in range(2, order + 1):
        next_value = (
            (2.0 * degree - 1.0) * value * current - (degree - 1.0) * previous
        ) / degree
        previous, current = current, next_value
    return current


def basis_value(
    descriptor: BasisFunction,
    x_m: float,
    y_m: float,
    hub_radius_m: float,
    outer_radius_m: float,
) -> float:
    radius = math.hypot(x_m, y_m)
    span = outer_radius_m - hub_radius_m
    normalized = (radius - hub_radius_m) / span
    # s² enforces both displacement and radial slope = 0 at the clamped hub.
    radial_shape = normalized * normalized * _legendre(
        descriptor.radial_order, 2.0 * normalized - 1.0
    )
    if descriptor.angular_order == 0:
        return radial_shape
    theta = math.atan2(y_m, x_m)
    phase = descriptor.angular_order * theta
    angular_shape = (
        math.cos(phase) if descriptor.symmetry == "cosine" else math.sin(phase)
    )
    return radial_shape * angular_shape


def evaluate_mode(
    coefficients: Iterable[float],
    basis: tuple[BasisFunction, ...],
    x_m: float,
    y_m: float,
    hub_radius_m: float,
    outer_radius_m: float,
) -> float:
    return sum(
        coefficient
        * basis_value(descriptor, x_m, y_m, hub_radius_m, outer_radius_m)
        for coefficient, descriptor in zip(coefficients, basis)
    )


def _basis_hessians(
    basis: tuple[BasisFunction, ...],
    x_m: float,
    y_m: float,
    hub_radius_m: float,
    outer_radius_m: float,
    epsilon_m: float,
) -> tuple[list[float], list[float], list[float], list[float]]:
    values: list[float] = []
    hxx: list[float] = []
    hyy: list[float] = []
    hxy: list[float] = []
    h2 = epsilon_m * epsilon_m
    for descriptor in basis:
        centre = basis_value(descriptor, x_m, y_m, hub_radius_m, outer_radius_m)
        xp = basis_value(
            descriptor, x_m + epsilon_m, y_m, hub_radius_m, outer_radius_m
        )
        xm = basis_value(
            descriptor, x_m - epsilon_m, y_m, hub_radius_m, outer_radius_m
        )
        yp = basis_value(
            descriptor, x_m, y_m + epsilon_m, hub_radius_m, outer_radius_m
        )
        ym = basis_value(
            descriptor, x_m, y_m - epsilon_m, hub_radius_m, outer_radius_m
        )
        xpy = basis_value(
            descriptor,
            x_m + epsilon_m,
            y_m + epsilon_m,
            hub_radius_m,
            outer_radius_m,
        )
        xmy = basis_value(
            descriptor,
            x_m - epsilon_m,
            y_m + epsilon_m,
            hub_radius_m,
            outer_radius_m,
        )
        xpym = basis_value(
            descriptor,
            x_m + epsilon_m,
            y_m - epsilon_m,
            hub_radius_m,
            outer_radius_m,
        )
        xmym = basis_value(
            descriptor,
            x_m - epsilon_m,
            y_m - epsilon_m,
            hub_radius_m,
            outer_radius_m,
        )
        values.append(centre)
        hxx.append((xp - 2.0 * centre + xm) / h2)
        hyy.append((yp - 2.0 * centre + ym) / h2)
        hxy.append((xpy - xmy - xpym + xmym) / (4.0 * h2))
    return values, hxx, hyy, hxy


def _assemble(
    spec: dict[str, Any],
    field: MaterialField,
    radial_samples: int,
    angular_samples: int,
    basis: tuple[BasisFunction, ...],
) -> tuple[Matrix, Matrix]:
    count = len(basis)
    mass = [[0.0] * count for _ in range(count)]
    stiffness = [[0.0] * count for _ in range(count)]
    radius = float(spec["geometry"]["radiusM"])
    hub_radius = float(spec["geometry"]["hub"]["radiusM"])
    radial_step = (radius - hub_radius) / radial_samples
    angular_step = 2.0 * math.pi / angular_samples
    material = spec["material"]
    density = float(material["densityKgPerM3"])
    youngs_modulus = float(material["youngsModulusPa"])
    poisson_ratio = float(material["poissonRatio"])
    epsilon = radius * HESSIAN_STEP_RATIO

    for radial_index in range(radial_samples):
        radial_position = hub_radius + (radial_index + 0.5) * radial_step
        for angular_index in range(angular_samples):
            theta = (angular_index + 0.5) * angular_step
            x_m = radial_position * math.cos(theta)
            y_m = radial_position * math.sin(theta)
            area_weight = radial_position * radial_step * angular_step
            thickness = field.at(x_m, y_m, thickness=True)
            bending_rigidity = youngs_modulus * thickness**3 / (
                12.0 * (1.0 - poisson_ratio * poisson_ratio)
            )
            values, hxx, hyy, hxy = _basis_hessians(
                basis, x_m, y_m, hub_radius, radius, epsilon
            )
            mass_weight = density * thickness * area_weight
            stiffness_weight = bending_rigidity * area_weight
            for left in range(count):
                mass_left = mass_weight * values[left]
                for right in range(left, count):
                    mass_value = mass_left * values[right]
                    curvature = (
                        hxx[left] * hxx[right]
                        + hyy[left] * hyy[right]
                        + poisson_ratio
                        * (hxx[left] * hyy[right] + hyy[left] * hxx[right])
                        + 2.0
                        * (1.0 - poisson_ratio)
                        * hxy[left]
                        * hxy[right]
                    )
                    stiffness_value = stiffness_weight * curvature
                    mass[left][right] += mass_value
                    stiffness[left][right] += stiffness_value
    for left in range(count):
        for right in range(left):
            mass[left][right] = mass[right][left]
            stiffness[left][right] = stiffness[right][left]
    return stiffness, mass


def _probe_average(
    coefficients: list[float],
    basis: tuple[BasisFunction, ...],
    x_m: float,
    y_m: float,
    footprint_radius_m: float,
    hub_radius_m: float,
    outer_radius_m: float,
) -> float:
    samples = [(0.0, 0.0)]
    for index in range(PROBE_RING_SAMPLES):
        theta = 2.0 * math.pi * index / PROBE_RING_SAMPLES
        samples.append(
            (
                footprint_radius_m * PROBE_RING_RADIUS_RATIO * math.cos(theta),
                footprint_radius_m * PROBE_RING_RADIUS_RATIO * math.sin(theta),
            )
        )
    return sum(
        evaluate_mode(
            coefficients,
            basis,
            x_m + offset_x,
            y_m + offset_y,
            hub_radius_m,
            outer_radius_m,
        )
        for offset_x, offset_y in samples
    ) / len(samples)


def _radiation_efficiency(
    coefficients: list[float],
    basis: tuple[BasisFunction, ...],
    hub_radius_m: float,
    outer_radius_m: float,
) -> float:
    absolute_sum = 0.0
    signed_sum = 0.0
    count = 0
    for radial_index in range(RADIATION_RADIAL_SAMPLES):
        radius = hub_radius_m + (radial_index + 0.5) / RADIATION_RADIAL_SAMPLES * (
            outer_radius_m - hub_radius_m
        )
        for angular_index in range(RADIATION_ANGULAR_SAMPLES):
            theta = (
                (angular_index + 0.5)
                * 2.0
                * math.pi
                / RADIATION_ANGULAR_SAMPLES
            )
            value = evaluate_mode(
                coefficients,
                basis,
                radius * math.cos(theta),
                radius * math.sin(theta),
                hub_radius_m,
                outer_radius_m,
            )
            absolute_sum += abs(value)
            signed_sum += value
            count += 1
    coherence = abs(signed_sum) / max(absolute_sum, NORMALIZATION_FLOOR)
    return (absolute_sum / count) * (
        RADIATION_COHERENCE_FLOOR + RADIATION_COHERENCE_WEIGHT * coherence
    )


def solve_modes(
    spec: dict[str, Any],
    field: MaterialField,
    *,
    radial_samples: int,
    angular_samples: int,
) -> SolveResult:
    basis = build_basis()
    stiffness, mass = _assemble(
        spec, field, radial_samples, angular_samples, basis
    )
    standard, lower = generalized_to_standard(stiffness, mass)
    values, vectors, sweeps, final_off_diagonal = jacobi_eigen_symmetric(
        standard,
        relative_tolerance=JACOBI_RELATIVE_TOLERANCE,
        maximum_sweeps=JACOBI_MAXIMUM_SWEEPS,
    )
    eigenpairs: list[tuple[float, list[float]]] = []
    for index, eigenvalue in enumerate(values):
        if eigenvalue <= 0.0 or not math.isfinite(eigenvalue):
            continue
        transformed = [vectors[row][index] for row in range(len(basis))]
        coefficients = solve_upper_from_lower_transpose(lower, transformed)
        norm = math.sqrt(
            max(
                mass_inner(coefficients, mass, coefficients),
                NORMALIZATION_FLOOR,
            )
        )
        coefficients = [value / norm for value in coefficients]
        eigenpairs.append((math.sqrt(eigenvalue) / (2.0 * math.pi), coefficients))
    eigenpairs.sort(key=lambda pair: pair[0])

    frequency_minimum = float(spec["frequencyRange"]["minimumHz"])
    frequency_maximum = float(spec["frequencyRange"]["maximumHz"])
    requested_count = int(spec["solverRequest"]["requestedModeCount"])
    selected = [
        pair
        for pair in eigenpairs
        if frequency_minimum <= pair[0] <= frequency_maximum
    ][:requested_count]
    if len(selected) < requested_count:
        raise ValueError(
            f"basis yielded {len(selected)} modes in {frequency_minimum}.."
            f"{frequency_maximum} Hz; {requested_count} were requested"
        )

    radius = float(spec["geometry"]["radiusM"])
    hub_radius = float(spec["geometry"]["hub"]["radiusM"])
    actuator = spec["actuator"]
    microphone = spec["virtualMicrophone"]
    damping = float(spec["material"]["nominalModalDampingRatio"])
    modes: list[Mode] = []
    for ordinal, (frequency, coefficients) in enumerate(selected, start=1):
        actuator_raw = _probe_average(
            coefficients,
            basis,
            float(actuator["positionM"]["x"]),
            float(actuator["positionM"]["y"]),
            float(actuator["footprintRadiusM"]),
            hub_radius,
            radius,
        )
        sign_reference = "actuator-positive"
        if abs(actuator_raw) > SIGN_EPSILON:
            sign = 1.0 if actuator_raw >= 0.0 else -1.0
        else:
            sign_reference = "first-nonzero-node-positive"
            first = next(
                (value for value in coefficients if abs(value) > SIGN_EPSILON),
                1.0,
            )
            sign = 1.0 if first >= 0.0 else -1.0
        coefficients = [value * sign for value in coefficients]
        actuator_raw *= sign
        microphone_raw = _probe_average(
            coefficients,
            basis,
            float(microphone["positionM"]["x"]),
            float(microphone["positionM"]["y"]),
            float(microphone["apertureRadiusM"]),
            hub_radius,
            radius,
        )
        radiation_raw = _radiation_efficiency(
            coefficients, basis, hub_radius, radius
        )
        dominant_index = max(
            range(len(coefficients)), key=lambda index: abs(coefficients[index])
        )
        dominant = basis[dominant_index]
        modes.append(
            Mode(
                ordinal=ordinal,
                frequency_hz=frequency,
                angular_frequency_rad_per_s=2.0 * math.pi * frequency,
                damping_ratio=damping
                * (1.0 + ORDINAL_DAMPING_SLOPE * (ordinal - 1)),
                coefficients=tuple(coefficients),
                actuator_coupling_raw=actuator_raw,
                microphone_coupling_raw=microphone_raw,
                radiation_efficiency_raw=radiation_raw,
                sign_reference=sign_reference,
                dominant_radial_order=dominant.radial_order,
                dominant_angular_order=dominant.angular_order,
                dominant_symmetry=dominant.symmetry,
            )
        )

    return SolveResult(
        modes=tuple(modes),
        basis=basis,
        mass_matrix=tuple(tuple(row) for row in mass),
        stiffness_matrix=tuple(tuple(row) for row in stiffness),
        all_frequencies_hz=tuple(pair[0] for pair in eigenpairs),
        quadrature={
            "radialSamples": radial_samples,
            "angularSamples": angular_samples,
            "pointCount": radial_samples * angular_samples,
        },
        eigensolver={
            "name": "cyclic-jacobi-generalized-symmetric",
            "sweeps": sweeps,
            "finalMaximumOffDiagonal": final_off_diagonal,
        },
    )


def modal_assurance(
    left: Mode,
    right: Mode,
    reference_mass: tuple[tuple[float, ...], ...],
) -> float:
    matrix = [list(row) for row in reference_mass]
    numerator = mass_inner(
        list(left.coefficients), matrix, list(right.coefficients)
    )
    left_norm = mass_inner(list(left.coefficients), matrix, list(left.coefficients))
    right_norm = mass_inner(list(right.coefficients), matrix, list(right.coefficients))
    return numerator * numerator / max(
        left_norm * right_norm, NORMALIZATION_FLOOR
    )


def convergence_report(
    spec: dict[str, Any],
    coarse: SolveResult,
    medium: SolveResult,
    fine: SolveResult,
) -> dict[str, Any]:
    maximum_change = float(
        spec["solverRequest"]["convergence"]["maximumRelativeFrequencyChange"]
    )
    minimum_mac = float(
        spec["solverRequest"]["convergence"]["minimumModalAssuranceCriterion"]
    )
    comparisons: list[dict[str, Any]] = []
    selected_count = min(16, len(fine.modes))
    for index in range(selected_count):
        coarse_mode = coarse.modes[index]
        medium_mode = medium.modes[index]
        fine_mode = fine.modes[index]
        relative_change = abs(fine_mode.frequency_hz - medium_mode.frequency_hz) / max(
            fine_mode.frequency_hz, NORMALIZATION_FLOOR
        )
        mac = modal_assurance(medium_mode, fine_mode, fine.mass_matrix)
        comparisons.append(
            {
                "modeId": f"mode-{fine_mode.ordinal:03d}",
                "coarseFrequencyHz": coarse_mode.frequency_hz,
                "mediumFrequencyHz": medium_mode.frequency_hz,
                "fineFrequencyHz": fine_mode.frequency_hz,
                "mediumToFineRelativeChange": relative_change,
                "mediumToFineModalAssuranceCriterion": mac,
                "frequencyConverged": relative_change <= maximum_change,
                "shapeConverged": mac >= minimum_mac,
            }
        )
    return {
        "schemaVersion": "mandelhowl.convergence-report.v1",
        "method": "variable-thickness-kirchhoff-love-rayleigh-ritz",
        "methodConformance": {
            "canonicalRequestedElementFamily": spec["solverRequest"]["elementFamily"],
            "executedElementFamily": "global-rayleigh-ritz-thin-plate-basis",
            "matchesCanonicalElementFamily": (
                spec["solverRequest"]["elementFamily"]
                == "kirchhoff-love-thin-plate"
            ),
            "handoffThinPlateMethodAllowed": True,
            "note": (
                "The global Rayleigh-Ritz basis is the numerical adapter used for "
                "the canonical Kirchhoff-Love thin-plate family. It is not shell FEM."
            ),
        },
        "levels": [
            {"name": "coarse", **coarse.quadrature},
            {"name": "medium", **medium.quadrature},
            {"name": "fine", **fine.quadrature},
        ],
        "criteria": {
            "maximumRelativeFrequencyChange": maximum_change,
            "minimumModalAssuranceCriterion": minimum_mac,
        },
        "comparisons": comparisons,
        "accepted": all(
            row["frequencyConverged"] and row["shapeConverged"]
            for row in comparisons
        ),
    }


def solver_evidence_binary(result: SolveResult) -> bytes:
    """Serialize the actual mass matrix and mass-normalized mode coefficients."""

    basis_count = len(result.basis)
    mode_count = len(result.modes)
    output = bytearray(struct.pack("<8sIII", b"MHEVID01", 1, basis_count, mode_count))
    for row in result.mass_matrix:
        output.extend(struct.pack(f"<{basis_count}d", *row))
    for mode in result.modes:
        output.extend(struct.pack(f"<{basis_count}d", *mode.coefficients))
    return bytes(output)
