"""C1 cubic-Hermite annular finite-strip Kirchhoff-Love eigenanalysis.

The analysis space is a genuine semi-analytical finite-element space:

* cubic Hermite finite elements interpolate displacement and radial slope;
* a normalized real Fourier basis spans the circumferential direction;
* the clamped inner value/slope degrees of freedom are eliminated; and
* the outer value/slope degrees of freedom remain, producing the natural
  free-edge moment and Kirchhoff-shear conditions.

The rendering triangle archive remains independent manufacturing and
coordinate evidence.  Only the finite-strip element mesh below contributes
degrees of freedom to the assembled stiffness and mass matrices.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Any, Iterable

from .algorithm import (
    HANDOFF_CONFORMANCE,
    JACOBI_MAXIMUM_SWEEPS,
    JACOBI_RELATIVE_TOLERANCE,
    NORMALIZATION_FLOOR,
    ORDINAL_DAMPING_SLOPE,
    PROBE_RING_RADIUS_RATIO,
    PROBE_RING_SAMPLES,
    RADIAL_GAUSS_NODES,
    RADIAL_GAUSS_WEIGHTS,
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
    radial_node_index: int
    radial_dof: str
    angular_order: int
    symmetry: str
    radial_element_count: int


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
    dominant_radial_node_index: int
    dominant_radial_dof: str
    dominant_angular_order: int
    dominant_symmetry: str


@dataclass(frozen=True)
class SolveResult:
    modes: tuple[Mode, ...]
    basis: tuple[BasisFunction, ...]
    mass_matrix: tuple[tuple[float, ...], ...]
    stiffness_matrix: tuple[tuple[float, ...], ...]
    all_frequencies_hz: tuple[float, ...]
    quadrature: dict[str, int | float | str]
    eigensolver: dict[str, int | float | str]


def _angular_descriptors(maximum_fourier_order: int) -> tuple[tuple[int, str], ...]:
    if maximum_fourier_order < 1:
        raise ValueError("finite-strip maximum Fourier order must be positive")
    descriptors: list[tuple[int, str]] = [(0, "axisymmetric")]
    for angular_order in range(1, maximum_fourier_order + 1):
        descriptors.append((angular_order, "cosine"))
        descriptors.append((angular_order, "sine"))
    return tuple(descriptors)


def build_basis(
    radial_element_count: int,
    maximum_fourier_order: int,
) -> tuple[BasisFunction, ...]:
    """Return harmonic-major free finite-strip DOFs in contract order."""

    if radial_element_count < 1:
        raise ValueError("finite-strip radial element count must be positive")
    basis: list[BasisFunction] = []
    for angular_order, symmetry in _angular_descriptors(maximum_fourier_order):
        for radial_node_index in range(1, radial_element_count + 1):
            basis.append(
                BasisFunction(
                    radial_node_index=radial_node_index,
                    radial_dof="value",
                    angular_order=angular_order,
                    symmetry=symmetry,
                    radial_element_count=radial_element_count,
                )
            )
            basis.append(
                BasisFunction(
                    radial_node_index=radial_node_index,
                    radial_dof="slope",
                    angular_order=angular_order,
                    symmetry=symmetry,
                    radial_element_count=radial_element_count,
                )
            )
    return tuple(basis)


def hermite_shapes(
    xi: float,
    element_length_m: float,
) -> tuple[
    tuple[float, float, float],
    tuple[float, float, float],
    tuple[float, float, float],
    tuple[float, float, float],
]:
    """Return ``(H, dH/dr, d²H/dr²)`` for [wa, w'a, wb, w'b]."""

    if element_length_m <= 0.0 or not math.isfinite(element_length_m):
        raise ValueError("finite-strip element length must be finite and positive")
    xi2 = xi * xi
    xi3 = xi2 * xi
    inverse_length = 1.0 / element_length_m
    inverse_length_squared = inverse_length * inverse_length
    return (
        (
            1.0 - 3.0 * xi2 + 2.0 * xi3,
            (-6.0 * xi + 6.0 * xi2) * inverse_length,
            (-6.0 + 12.0 * xi) * inverse_length_squared,
        ),
        (
            element_length_m * (xi - 2.0 * xi2 + xi3),
            1.0 - 4.0 * xi + 3.0 * xi2,
            (-4.0 + 6.0 * xi) * inverse_length,
        ),
        (
            3.0 * xi2 - 2.0 * xi3,
            (6.0 * xi - 6.0 * xi2) * inverse_length,
            (6.0 - 12.0 * xi) * inverse_length_squared,
        ),
        (
            element_length_m * (-xi2 + xi3),
            -2.0 * xi + 3.0 * xi2,
            (-2.0 + 6.0 * xi) * inverse_length,
        ),
    )


def angular_shape(
    angular_order: int,
    symmetry: str,
    theta: float,
) -> tuple[float, float, float]:
    """Return normalized Fourier ``(A, dA/dtheta, d²A/dtheta²)``."""

    if angular_order == 0:
        if symmetry != "axisymmetric":
            raise ValueError("zero angular order must be axisymmetric")
        value = 1.0 / math.sqrt(math.tau)
        return value, 0.0, 0.0
    phase = angular_order * theta
    normalization = 1.0 / math.sqrt(math.pi)
    if symmetry == "cosine":
        value = math.cos(phase) * normalization
        first = -angular_order * math.sin(phase) * normalization
    elif symmetry == "sine":
        value = math.sin(phase) * normalization
        first = angular_order * math.cos(phase) * normalization
    else:
        raise ValueError("positive angular order must be cosine or sine")
    return value, first, -(angular_order * angular_order) * value


def _radial_shape_for_descriptor(
    descriptor: BasisFunction,
    radius_m: float,
    hub_radius_m: float,
    outer_radius_m: float,
) -> float:
    if radius_m <= hub_radius_m or radius_m > outer_radius_m:
        return 0.0
    element_count = descriptor.radial_element_count
    element_length = (outer_radius_m - hub_radius_m) / element_count
    element_index = min(
        int((radius_m - hub_radius_m) / element_length),
        element_count - 1,
    )
    xi = (
        radius_m - (hub_radius_m + element_index * element_length)
    ) / element_length
    local_shapes = hermite_shapes(xi, element_length)
    if descriptor.radial_node_index == element_index:
        local_index = 0 if descriptor.radial_dof == "value" else 1
    elif descriptor.radial_node_index == element_index + 1:
        local_index = 2 if descriptor.radial_dof == "value" else 3
    else:
        return 0.0
    return local_shapes[local_index][0]


def basis_value(
    descriptor: BasisFunction,
    x_m: float,
    y_m: float,
    hub_radius_m: float,
    outer_radius_m: float,
) -> float:
    radius_m = math.hypot(x_m, y_m)
    radial = _radial_shape_for_descriptor(
        descriptor,
        radius_m,
        hub_radius_m,
        outer_radius_m,
    )
    if radial == 0.0:
        return 0.0
    angular, _, _ = angular_shape(
        descriptor.angular_order,
        descriptor.symmetry,
        math.atan2(y_m, x_m),
    )
    return radial * angular


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


def _local_radial_dofs(
    element_index: int,
    radial_element_count: int,
    xi: float,
    element_length_m: float,
) -> tuple[tuple[int, str, float, float, float], ...]:
    shapes = hermite_shapes(xi, element_length_m)
    candidates = (
        (element_index, "value", *shapes[0]),
        (element_index, "slope", *shapes[1]),
        (element_index + 1, "value", *shapes[2]),
        (element_index + 1, "slope", *shapes[3]),
    )
    return tuple(
        candidate
        for candidate in candidates
        if candidate[0] > 0 and candidate[0] <= radial_element_count
    )


def _assemble(
    spec: dict[str, Any],
    field: MaterialField,
    radial_element_count: int,
    maximum_fourier_order: int,
    angular_samples: int,
    basis: tuple[BasisFunction, ...],
) -> tuple[Matrix, Matrix]:
    count = len(basis)
    expected_count = (
        2 * radial_element_count * (1 + 2 * maximum_fourier_order)
    )
    if count != expected_count or angular_samples < 4 * maximum_fourier_order + 1:
        raise ValueError("finite-strip analysis dimensions are inconsistent")
    mass = [[0.0] * count for _ in range(count)]
    stiffness = [[0.0] * count for _ in range(count)]
    outer_radius = float(spec["geometry"]["radiusM"])
    hub_radius = float(spec["geometry"]["hub"]["radiusM"])
    element_length = (outer_radius - hub_radius) / radial_element_count
    angular_step = math.tau / angular_samples
    density = float(spec["material"]["densityKgPerM3"])
    youngs_modulus = float(spec["material"]["youngsModulusPa"])
    poisson_ratio = float(spec["material"]["poissonRatio"])
    harmonics = _angular_descriptors(maximum_fourier_order)
    radial_dofs_per_harmonic = 2 * radial_element_count

    for element_index in range(radial_element_count):
        element_start = hub_radius + element_index * element_length
        for gauss_node, gauss_weight in zip(
            RADIAL_GAUSS_NODES,
            RADIAL_GAUSS_WEIGHTS,
        ):
            xi = 0.5 * (gauss_node + 1.0)
            radius_m = element_start + xi * element_length
            radial_weight = 0.5 * element_length * gauss_weight
            radial_dofs = _local_radial_dofs(
                element_index,
                radial_element_count,
                xi,
                element_length,
            )
            for angular_index in range(angular_samples):
                theta = (angular_index + 0.5) * angular_step
                x_m = radius_m * math.cos(theta)
                y_m = radius_m * math.sin(theta)
                thickness = field.at(x_m, y_m, thickness=True)
                bending_rigidity = youngs_modulus * thickness**3 / (
                    12.0 * (1.0 - poisson_ratio * poisson_ratio)
                )
                integration_weight = radius_m * radial_weight * angular_step
                mass_weight = density * thickness * integration_weight
                stiffness_weight = bending_rigidity * integration_weight
                active: list[
                    tuple[int, float, float, float, float]
                ] = []
                for harmonic_index, (angular_order, symmetry) in enumerate(
                    harmonics
                ):
                    angular, angular_first, angular_second = angular_shape(
                        angular_order,
                        symmetry,
                        theta,
                    )
                    harmonic_offset = (
                        harmonic_index * radial_dofs_per_harmonic
                    )
                    for (
                        radial_node,
                        radial_dof,
                        radial,
                        radial_first,
                        radial_second,
                    ) in radial_dofs:
                        radial_offset = 2 * (radial_node - 1)
                        if radial_dof == "slope":
                            radial_offset += 1
                        global_index = harmonic_offset + radial_offset
                        value = radial * angular
                        curvature_rr = radial_second * angular
                        curvature_tt = (
                            radial_first * angular / radius_m
                            + radial * angular_second / (radius_m * radius_m)
                        )
                        curvature_rt = angular_first * (
                            radial_first / radius_m
                            - radial / (radius_m * radius_m)
                        )
                        active.append(
                            (
                                global_index,
                                value,
                                curvature_rr,
                                curvature_tt,
                                curvature_rt,
                            )
                        )
                active.sort(key=lambda row: row[0])
                for left_offset, left in enumerate(active):
                    (
                        left_index,
                        left_value,
                        left_rr,
                        left_tt,
                        left_rt,
                    ) = left
                    for right in active[left_offset:]:
                        (
                            right_index,
                            right_value,
                            right_rr,
                            right_tt,
                            right_rt,
                        ) = right
                        mass[left_index][right_index] += (
                            mass_weight * left_value * right_value
                        )
                        curvature = (
                            left_rr * right_rr
                            + left_tt * right_tt
                            + poisson_ratio
                            * (left_rr * right_tt + left_tt * right_rr)
                            + 2.0
                            * (1.0 - poisson_ratio)
                            * left_rt
                            * right_rt
                        )
                        stiffness[left_index][right_index] += (
                            stiffness_weight * curvature
                        )
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
        theta = math.tau * index / PROBE_RING_SAMPLES
        samples.append(
            (
                footprint_radius_m
                * PROBE_RING_RADIUS_RATIO
                * math.cos(theta),
                footprint_radius_m
                * PROBE_RING_RADIUS_RATIO
                * math.sin(theta),
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


def _first_analysis_node_value(
    coefficients: list[float],
    basis: tuple[BasisFunction, ...],
    *,
    radial_element_count: int,
    angular_samples: int,
    hub_radius_m: float,
    outer_radius_m: float,
) -> float:
    radial_step = (outer_radius_m - hub_radius_m) / radial_element_count
    for radial_node in range(1, radial_element_count + 1):
        radius_m = hub_radius_m + radial_node * radial_step
        for angular_index in range(angular_samples):
            theta = (angular_index + 0.5) * math.tau / angular_samples
            value = evaluate_mode(
                coefficients,
                basis,
                radius_m * math.cos(theta),
                radius_m * math.sin(theta),
                hub_radius_m,
                outer_radius_m,
            )
            if abs(value) > SIGN_EPSILON:
                return value
    return 1.0


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
        radius = hub_radius_m + (
            (radial_index + 0.5)
            / RADIATION_RADIAL_SAMPLES
            * (outer_radius_m - hub_radius_m)
        )
        for angular_index in range(RADIATION_ANGULAR_SAMPLES):
            theta = (
                (angular_index + 0.5)
                * math.tau
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
        RADIATION_COHERENCE_FLOOR
        + RADIATION_COHERENCE_WEIGHT * coherence
    )


def solve_modes(
    spec: dict[str, Any],
    field: MaterialField,
    *,
    radial_element_count: int,
    maximum_fourier_order: int,
    angular_samples: int,
) -> SolveResult:
    basis = build_basis(radial_element_count, maximum_fourier_order)
    stiffness, mass = _assemble(
        spec,
        field,
        radial_element_count,
        maximum_fourier_order,
        angular_samples,
        basis,
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
        eigenpairs.append(
            (math.sqrt(eigenvalue) / math.tau, coefficients)
        )
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
            f"finite-strip space yielded {len(selected)} modes in "
            f"{frequency_minimum}..{frequency_maximum} Hz; "
            f"{requested_count} were requested"
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
            first = _first_analysis_node_value(
                coefficients,
                basis,
                radial_element_count=radial_element_count,
                angular_samples=angular_samples,
                hub_radius_m=hub_radius,
                outer_radius_m=radius,
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
            coefficients,
            basis,
            hub_radius,
            radius,
        )
        dominant_index = max(
            range(len(coefficients)),
            key=lambda candidate: abs(coefficients[candidate]),
        )
        dominant = basis[dominant_index]
        modes.append(
            Mode(
                ordinal=ordinal,
                frequency_hz=frequency,
                angular_frequency_rad_per_s=math.tau * frequency,
                damping_ratio=damping
                * (1.0 + ORDINAL_DAMPING_SLOPE * (ordinal - 1)),
                coefficients=tuple(coefficients),
                actuator_coupling_raw=actuator_raw,
                microphone_coupling_raw=microphone_raw,
                radiation_efficiency_raw=radiation_raw,
                sign_reference=sign_reference,
                dominant_radial_node_index=(
                    dominant.radial_node_index
                ),
                dominant_radial_dof=dominant.radial_dof,
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
            "radialElementCount": radial_element_count,
            "maximumFourierOrder": maximum_fourier_order,
            "radialGaussOrder": len(RADIAL_GAUSS_NODES),
            "angularSamples": angular_samples,
            "dofCount": len(basis),
            "pointCount": (
                radial_element_count
                * len(RADIAL_GAUSS_NODES)
                * angular_samples
            ),
            "minimumMappingJacobianM": (
                (radius - hub_radius) / radial_element_count / 2.0
            ),
            "boundaryConditions": (
                "inner-value-and-slope-eliminated;outer-natural-free"
            ),
        },
        eigensolver={
            "name": "cyclic-jacobi-generalized-symmetric",
            "sweeps": sweeps,
            "finalMaximumOffDiagonal": final_off_diagonal,
        },
    )


def _physical_grid(
    spec: dict[str, Any],
    field: MaterialField,
    *,
    radial_element_count: int,
    angular_samples: int,
) -> tuple[tuple[float, float, float], ...]:
    radius = float(spec["geometry"]["radiusM"])
    hub = float(spec["geometry"]["hub"]["radiusM"])
    density = float(spec["material"]["densityKgPerM3"])
    element_length = (radius - hub) / radial_element_count
    angular_step = math.tau / angular_samples
    points: list[tuple[float, float, float]] = []
    for element_index in range(radial_element_count):
        start = hub + element_index * element_length
        for gauss_node, gauss_weight in zip(
            RADIAL_GAUSS_NODES,
            RADIAL_GAUSS_WEIGHTS,
        ):
            radial_position = (
                start + 0.5 * (gauss_node + 1.0) * element_length
            )
            radial_weight = 0.5 * element_length * gauss_weight
            for angular_index in range(angular_samples):
                theta = (angular_index + 0.5) * angular_step
                x_m = radial_position * math.cos(theta)
                y_m = radial_position * math.sin(theta)
                thickness = field.at(x_m, y_m, thickness=True)
                weight = (
                    density
                    * thickness
                    * radial_position
                    * radial_weight
                    * angular_step
                )
                points.append((x_m, y_m, weight))
    return tuple(points)


def _sample_modes(
    result: SolveResult,
    modes: tuple[Mode, ...],
    points: tuple[tuple[float, float, float], ...],
    hub_radius_m: float,
    outer_radius_m: float,
) -> tuple[tuple[float, ...], ...]:
    return tuple(
        tuple(
            evaluate_mode(
                mode.coefficients,
                result.basis,
                x_m,
                y_m,
                hub_radius_m,
                outer_radius_m,
            )
            for x_m, y_m, _ in points
        )
        for mode in modes
    )


def _physical_mac(
    left: tuple[float, ...],
    right: tuple[float, ...],
    points: tuple[tuple[float, float, float], ...],
) -> float:
    cross = 0.0
    left_norm = 0.0
    right_norm = 0.0
    for left_value, right_value, (_, _, weight) in zip(
        left,
        right,
        points,
    ):
        cross += weight * left_value * right_value
        left_norm += weight * left_value * left_value
        right_norm += weight * right_value * right_value
    return cross * cross / max(
        left_norm * right_norm,
        NORMALIZATION_FLOOR,
    )


def _match_modes_on_physical_grid(
    reference_modes: tuple[Mode, ...],
    reference_values: tuple[tuple[float, ...], ...],
    candidate_modes: tuple[Mode, ...],
    candidate_values: tuple[tuple[float, ...], ...],
    points: tuple[tuple[float, float, float], ...],
    required_reference_count: int,
) -> dict[int, tuple[int, float]]:
    pairs: list[tuple[float, float, int, int]] = []
    for reference_index in range(required_reference_count):
        reference = reference_modes[reference_index]
        for candidate_index, candidate in enumerate(candidate_modes):
            mac = _physical_mac(
                reference_values[reference_index],
                candidate_values[candidate_index],
                points,
            )
            relative_frequency = abs(
                reference.frequency_hz - candidate.frequency_hz
            ) / max(reference.frequency_hz, NORMALIZATION_FLOOR)
            pairs.append(
                (
                    -mac,
                    relative_frequency,
                    reference_index,
                    candidate_index,
                )
            )
    pairs.sort()
    assigned_reference: set[int] = set()
    assigned_candidate: set[int] = set()
    matches: dict[int, tuple[int, float]] = {}
    for negative_mac, _, reference_index, candidate_index in pairs:
        if (
            reference_index in assigned_reference
            or candidate_index in assigned_candidate
        ):
            continue
        matches[reference_index] = (candidate_index, -negative_mac)
        assigned_reference.add(reference_index)
        assigned_candidate.add(candidate_index)
        if len(matches) == required_reference_count:
            break
    if len(matches) != required_reference_count:
        raise ValueError("finite-strip physical-grid mode matching is incomplete")
    return matches


def convergence_report(
    spec: dict[str, Any],
    field: MaterialField,
    coarse: SolveResult,
    medium: SolveResult,
    fine: SolveResult,
) -> dict[str, Any]:
    maximum_change = float(
        spec["solverRequest"]["convergence"]["maximumRelativeFrequencyChange"]
    )
    minimum_mac = float(
        spec["solverRequest"]["convergence"][
            "minimumModalAssuranceCriterion"
        ]
    )
    selected_count = min(16, len(fine.modes))
    candidate_count = min(24, len(medium.modes), len(coarse.modes))
    radius = float(spec["geometry"]["radiusM"])
    hub = float(spec["geometry"]["hub"]["radiusM"])
    points = _physical_grid(
        spec,
        field,
        radial_element_count=int(fine.quadrature["radialElementCount"]),
        angular_samples=int(fine.quadrature["angularSamples"]),
    )
    fine_modes = fine.modes[:selected_count]
    medium_modes = medium.modes[:candidate_count]
    coarse_modes = coarse.modes[:candidate_count]
    fine_values = _sample_modes(fine, fine_modes, points, hub, radius)
    medium_values = _sample_modes(
        medium,
        medium_modes,
        points,
        hub,
        radius,
    )
    coarse_values = _sample_modes(
        coarse,
        coarse_modes,
        points,
        hub,
        radius,
    )
    medium_matches = _match_modes_on_physical_grid(
        fine_modes,
        fine_values,
        medium_modes,
        medium_values,
        points,
        selected_count,
    )
    coarse_matches = _match_modes_on_physical_grid(
        fine_modes,
        fine_values,
        coarse_modes,
        coarse_values,
        points,
        selected_count,
    )
    comparisons: list[dict[str, Any]] = []
    for fine_index, fine_mode in enumerate(fine_modes):
        medium_index, medium_mac = medium_matches[fine_index]
        coarse_index, coarse_mac = coarse_matches[fine_index]
        medium_mode = medium_modes[medium_index]
        coarse_mode = coarse_modes[coarse_index]
        relative_change = abs(
            fine_mode.frequency_hz - medium_mode.frequency_hz
        ) / max(fine_mode.frequency_hz, NORMALIZATION_FLOOR)
        comparisons.append(
            {
                "modeId": f"mode-{fine_mode.ordinal:03d}",
                "coarseMatchedModeId": (
                    f"mode-{coarse_mode.ordinal:03d}"
                ),
                "mediumMatchedModeId": (
                    f"mode-{medium_mode.ordinal:03d}"
                ),
                "coarseFrequencyHz": coarse_mode.frequency_hz,
                "mediumFrequencyHz": medium_mode.frequency_hz,
                "fineFrequencyHz": fine_mode.frequency_hz,
                "coarseToFineModalAssuranceCriterion": coarse_mac,
                "mediumToFineRelativeChange": relative_change,
                "mediumToFineModalAssuranceCriterion": medium_mac,
                "frequencyConverged": relative_change <= maximum_change,
                "shapeConverged": medium_mac >= minimum_mac,
            }
        )
    accepted = all(
        row["frequencyConverged"] and row["shapeConverged"]
        for row in comparisons
    )
    levels = spec["solverRequest"]["meshLevels"]
    return {
        "schemaVersion": "mandelhowl.convergence-report.v1",
        "method": "variable-thickness-kirchhoff-love-c1-finite-strip-fem",
        "methodConformance": {
            "canonicalRequestedElementFamily": spec["solverRequest"][
                "elementFamily"
            ],
            "executedElementFamily": (
                "c1-cubic-hermite-annular-finite-strip"
            ),
            "matchesCanonicalElementFamily": (
                spec["solverRequest"]["elementFamily"]
                == "kirchhoff-love-thin-plate"
            ),
            "handoffThinPlateMethodAllowed": True,
            "thinPlateEigenanalysisSupported": HANDOFF_CONFORMANCE[
                "thinPlateEigenanalysisSupported"
            ],
            "surfaceMeshQualityValidated": HANDOFF_CONFORMANCE[
                "surfaceMeshQualityValidated"
            ],
            "finiteElementAssemblyUsed": HANDOFF_CONFORMANCE[
                "finiteElementAssemblyUsed"
            ],
            "analysisSurfaceElementMeshCoupledToEigenproblem": (
                HANDOFF_CONFORMANCE[
                    "analysisSurfaceElementMeshCoupledToEigenproblem"
                ]
            ),
            "surfaceTriangleArchiveCoupledToEigenproblem": (
                HANDOFF_CONFORMANCE[
                    "surfaceTriangleArchiveCoupledToEigenproblem"
                ]
            ),
            "strictLiteralSection10_3Conformance": HANDOFF_CONFORMANCE[
                "strictLiteralConformance"
            ],
            "operationalDisposition": HANDOFF_CONFORMANCE[
                "operationalDisposition"
            ],
            "note": (
                "C1 cubic-Hermite radial finite elements and normalized "
                "Fourier circumferential functions form the coupled "
                "Kirchhoff-Love finite-strip eigenproblem. The independent "
                "triangle archive remains manufacturing and coordinate "
                "evidence only."
            ),
        },
        "analysisDiscretization": {
            "type": "c1-cubic-hermite-annular-finite-strip",
            "coupledToEigenproblemAssembly": True,
            "radialInterpolation": "cubic-hermite-c1",
            "angularInterpolation": "normalized-real-fourier",
            "innerBoundary": "value-and-radial-slope-dofs-eliminated",
            "outerBoundary": "natural-free-edge",
            "refinementOwner": (
                "solverRequest.meshLevels[*].analysisFiniteStrip"
            ),
            "surfaceTriangleArchiveRole": (
                "manufacturing, coordinate, and provenance evidence only"
            ),
        },
        "modeMatching": {
            "method": (
                "deterministic-greedy-physical-mass-MAC-on-fine-grid"
            ),
            "referenceModeCount": selected_count,
            "candidateModeCountPerCoarserLevel": candidate_count,
            "physicalGridPointCount": len(points),
            "tieBreakOrder": (
                "descending-MAC-then-relative-frequency-then-ordinals"
            ),
        },
        "levels": [
            {**level, **result.quadrature}
            for level, result in zip(
                levels,
                (coarse, medium, fine),
            )
        ],
        "criteria": {
            "maximumRelativeFrequencyChange": maximum_change,
            "minimumModalAssuranceCriterion": minimum_mac,
        },
        "comparisons": comparisons,
        "finiteElementMeshConvergenceAccepted": accepted,
        "accepted": accepted,
    }


def solver_evidence_binary(result: SolveResult) -> bytes:
    """Serialize the assembled mass matrix and mass-normalized FEM vectors."""

    basis_count = len(result.basis)
    mode_count = len(result.modes)
    output = bytearray(
        struct.pack(
            "<8sIII",
            b"MHEVID01",
            1,
            basis_count,
            mode_count,
        )
    )
    for row in result.mass_matrix:
        output.extend(struct.pack(f"<{basis_count}d", *row))
    for mode in result.modes:
        output.extend(
            struct.pack(f"<{basis_count}d", *mode.coefficients)
        )
    return bytes(output)
