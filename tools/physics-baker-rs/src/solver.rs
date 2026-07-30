use std::cmp::Ordering;

use crate::algorithm::Algorithm;
use crate::field::MaterialField;
use crate::json;
use crate::json::Value;
use crate::linear_algebra::{
    Matrix, generalized_to_standard, jacobi_eigen_symmetric, mass_inner,
    solve_upper_from_lower_transpose,
};
use crate::spec::{MeshLevel, PlateSpec};

#[derive(Debug, Clone, PartialEq)]
pub enum Symmetry {
    Axisymmetric,
    Cosine,
    Sine,
}

impl Symmetry {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Axisymmetric => "axisymmetric",
            Self::Cosine => "cosine",
            Self::Sine => "sine",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RadialDof {
    Value,
    Slope,
}

impl RadialDof {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Value => "value",
            Self::Slope => "slope",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BasisFunction {
    pub radial_node_index: usize,
    pub radial_dof: RadialDof,
    pub angular_order: usize,
    pub symmetry: Symmetry,
    pub radial_element_count: usize,
}

#[derive(Debug, Clone)]
pub struct Mode {
    pub ordinal: usize,
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub damping_ratio: f64,
    pub coefficients: Vec<f64>,
    pub actuator_coupling_raw: f64,
    pub microphone_coupling_raw: f64,
    pub radiation_efficiency_raw: f64,
    pub sign_reference: &'static str,
    pub dominant_radial_node_index: usize,
    pub dominant_radial_dof: RadialDof,
    pub dominant_angular_order: usize,
    pub dominant_symmetry: Symmetry,
}

#[derive(Debug, Clone)]
pub struct Quadrature {
    pub radial_element_count: usize,
    pub maximum_fourier_order: usize,
    pub radial_gauss_order: usize,
    pub angular_samples: usize,
    pub dof_count: usize,
    pub point_count: usize,
    pub minimum_mapping_jacobian_m: f64,
}

#[derive(Debug, Clone)]
pub struct EigensolverEvidence {
    pub sweeps: usize,
    pub final_maximum_off_diagonal: f64,
}

#[derive(Debug, Clone)]
pub struct SolveResult {
    pub modes: Vec<Mode>,
    pub basis: Vec<BasisFunction>,
    pub mass_matrix: Matrix,
    pub stiffness_matrix: Matrix,
    pub all_frequencies_hz: Vec<f64>,
    pub quadrature: Quadrature,
    pub eigensolver: EigensolverEvidence,
}

fn angular_descriptors(maximum_fourier_order: usize) -> Result<Vec<(usize, Symmetry)>, String> {
    if maximum_fourier_order == 0 {
        return Err("finite-strip maximum Fourier order must be positive".to_owned());
    }
    let mut descriptors = Vec::with_capacity(1 + 2 * maximum_fourier_order);
    descriptors.push((0, Symmetry::Axisymmetric));
    for angular_order in 1..=maximum_fourier_order {
        descriptors.push((angular_order, Symmetry::Cosine));
        descriptors.push((angular_order, Symmetry::Sine));
    }
    Ok(descriptors)
}

pub fn build_basis(
    radial_element_count: usize,
    maximum_fourier_order: usize,
) -> Result<Vec<BasisFunction>, String> {
    if radial_element_count == 0 {
        return Err("finite-strip radial element count must be positive".to_owned());
    }
    let mut basis = Vec::with_capacity(2 * radial_element_count * (1 + 2 * maximum_fourier_order));
    for (angular_order, symmetry) in angular_descriptors(maximum_fourier_order)? {
        for radial_node_index in 1..=radial_element_count {
            basis.push(BasisFunction {
                radial_node_index,
                radial_dof: RadialDof::Value,
                angular_order,
                symmetry: symmetry.clone(),
                radial_element_count,
            });
            basis.push(BasisFunction {
                radial_node_index,
                radial_dof: RadialDof::Slope,
                angular_order,
                symmetry: symmetry.clone(),
                radial_element_count,
            });
        }
    }
    Ok(basis)
}

pub fn hermite_shapes(xi: f64, element_length_m: f64) -> Result<[[f64; 3]; 4], String> {
    if element_length_m <= 0.0 || !element_length_m.is_finite() {
        return Err("finite-strip element length must be finite and positive".to_owned());
    }
    let xi2 = xi * xi;
    let xi3 = xi2 * xi;
    let inverse_length = 1.0 / element_length_m;
    let inverse_length_squared = inverse_length * inverse_length;
    Ok([
        [
            1.0 - 3.0 * xi2 + 2.0 * xi3,
            (-6.0 * xi + 6.0 * xi2) * inverse_length,
            (-6.0 + 12.0 * xi) * inverse_length_squared,
        ],
        [
            element_length_m * (xi - 2.0 * xi2 + xi3),
            1.0 - 4.0 * xi + 3.0 * xi2,
            (-4.0 + 6.0 * xi) * inverse_length,
        ],
        [
            3.0 * xi2 - 2.0 * xi3,
            (6.0 * xi - 6.0 * xi2) * inverse_length,
            (6.0 - 12.0 * xi) * inverse_length_squared,
        ],
        [
            element_length_m * (-xi2 + xi3),
            -2.0 * xi + 3.0 * xi2,
            (-2.0 + 6.0 * xi) * inverse_length,
        ],
    ])
}

fn angular_shape(
    angular_order: usize,
    symmetry: &Symmetry,
    theta: f64,
) -> Result<[f64; 3], String> {
    if angular_order == 0 {
        if *symmetry != Symmetry::Axisymmetric {
            return Err("zero angular order must be axisymmetric".to_owned());
        }
        return Ok([1.0 / std::f64::consts::TAU.sqrt(), 0.0, 0.0]);
    }
    let phase = angular_order as f64 * theta;
    let normalization = 1.0 / std::f64::consts::PI.sqrt();
    let (value, first) = match symmetry {
        Symmetry::Cosine => (
            phase.cos() * normalization,
            -(angular_order as f64) * phase.sin() * normalization,
        ),
        Symmetry::Sine => (
            phase.sin() * normalization,
            angular_order as f64 * phase.cos() * normalization,
        ),
        Symmetry::Axisymmetric => {
            return Err("positive angular order must be cosine or sine".to_owned());
        }
    };
    Ok([
        value,
        first,
        -((angular_order * angular_order) as f64) * value,
    ])
}

fn radial_shape_for_descriptor(
    descriptor: &BasisFunction,
    radius_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> Result<f64, String> {
    if radius_m <= hub_radius_m || radius_m > outer_radius_m {
        return Ok(0.0);
    }
    let element_count = descriptor.radial_element_count;
    let element_length = (outer_radius_m - hub_radius_m) / element_count as f64;
    let element_index =
        (((radius_m - hub_radius_m) / element_length) as usize).min(element_count - 1);
    let xi = (radius_m - (hub_radius_m + element_index as f64 * element_length)) / element_length;
    let shapes = hermite_shapes(xi, element_length)?;
    let local_index = if descriptor.radial_node_index == element_index {
        match descriptor.radial_dof {
            RadialDof::Value => 0,
            RadialDof::Slope => 1,
        }
    } else if descriptor.radial_node_index == element_index + 1 {
        match descriptor.radial_dof {
            RadialDof::Value => 2,
            RadialDof::Slope => 3,
        }
    } else {
        return Ok(0.0);
    };
    Ok(shapes[local_index][0])
}

pub fn basis_value(
    descriptor: &BasisFunction,
    x_m: f64,
    y_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> Result<f64, String> {
    let radial =
        radial_shape_for_descriptor(descriptor, x_m.hypot(y_m), hub_radius_m, outer_radius_m)?;
    if radial == 0.0 {
        return Ok(0.0);
    }
    let angular = angular_shape(
        descriptor.angular_order,
        &descriptor.symmetry,
        y_m.atan2(x_m),
    )?[0];
    Ok(radial * angular)
}

pub fn evaluate_mode(
    coefficients: &[f64],
    basis: &[BasisFunction],
    x_m: f64,
    y_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> Result<f64, String> {
    if coefficients.len() != basis.len() {
        return Err("mode coefficient and finite-strip basis lengths differ".to_owned());
    }
    let mut total = 0.0;
    for (coefficient, descriptor) in coefficients.iter().zip(basis) {
        total += coefficient * basis_value(descriptor, x_m, y_m, hub_radius_m, outer_radius_m)?;
    }
    Ok(total)
}

#[derive(Clone, Copy)]
struct LocalRadialDof {
    node: usize,
    kind: RadialDof,
    value: f64,
    first: f64,
    second: f64,
}

fn local_radial_dofs(
    element_index: usize,
    radial_element_count: usize,
    xi: f64,
    element_length_m: f64,
) -> Result<Vec<LocalRadialDof>, String> {
    let shapes = hermite_shapes(xi, element_length_m)?;
    let candidates = [
        LocalRadialDof {
            node: element_index,
            kind: RadialDof::Value,
            value: shapes[0][0],
            first: shapes[0][1],
            second: shapes[0][2],
        },
        LocalRadialDof {
            node: element_index,
            kind: RadialDof::Slope,
            value: shapes[1][0],
            first: shapes[1][1],
            second: shapes[1][2],
        },
        LocalRadialDof {
            node: element_index + 1,
            kind: RadialDof::Value,
            value: shapes[2][0],
            first: shapes[2][1],
            second: shapes[2][2],
        },
        LocalRadialDof {
            node: element_index + 1,
            kind: RadialDof::Slope,
            value: shapes[3][0],
            first: shapes[3][1],
            second: shapes[3][2],
        },
    ];
    Ok(candidates
        .into_iter()
        .filter(|candidate| candidate.node > 0 && candidate.node <= radial_element_count)
        .collect())
}

#[derive(Clone, Copy)]
struct ActiveBasis {
    index: usize,
    value: f64,
    curvature_rr: f64,
    curvature_tt: f64,
    curvature_rt: f64,
}

fn assemble(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    radial_element_count: usize,
    maximum_fourier_order: usize,
    angular_samples: usize,
    basis: &[BasisFunction],
) -> Result<(Matrix, Matrix), String> {
    let count = basis.len();
    let expected_count = 2 * radial_element_count * (1 + 2 * maximum_fourier_order);
    if count != expected_count || angular_samples < 4 * maximum_fourier_order + 1 {
        return Err("finite-strip analysis dimensions are inconsistent".to_owned());
    }
    let mut mass = vec![vec![0.0; count]; count];
    let mut stiffness = vec![vec![0.0; count]; count];
    let outer_radius = spec.number(&["geometry", "radiusM"])?;
    let hub_radius = spec.number(&["geometry", "hub", "radiusM"])?;
    let element_length = (outer_radius - hub_radius) / radial_element_count as f64;
    let angular_step = std::f64::consts::TAU / angular_samples as f64;
    let density = spec.number(&["material", "densityKgPerM3"])?;
    let youngs_modulus = spec.number(&["material", "youngsModulusPa"])?;
    let poisson_ratio = spec.number(&["material", "poissonRatio"])?;
    let harmonics = angular_descriptors(maximum_fourier_order)?;
    let radial_dofs_per_harmonic = 2 * radial_element_count;

    for element_index in 0..radial_element_count {
        let element_start = hub_radius + element_index as f64 * element_length;
        for gauss_index in 0..algorithm.radial_gauss_nodes.len() {
            let gauss_node = algorithm.radial_gauss_nodes[gauss_index];
            let gauss_weight = algorithm.radial_gauss_weights[gauss_index];
            let xi = 0.5 * (gauss_node + 1.0);
            let radius_m = element_start + xi * element_length;
            let radial_weight = 0.5 * element_length * gauss_weight;
            let radial_dofs =
                local_radial_dofs(element_index, radial_element_count, xi, element_length)?;
            for angular_index in 0..angular_samples {
                let theta = (angular_index as f64 + 0.5) * angular_step;
                let x_m = radius_m * theta.cos();
                let y_m = radius_m * theta.sin();
                let thickness = field.at(x_m, y_m, true);
                let bending_rigidity = youngs_modulus * thickness.powi(3)
                    / (12.0 * (1.0 - poisson_ratio * poisson_ratio));
                let integration_weight = radius_m * radial_weight * angular_step;
                let mass_weight = density * thickness * integration_weight;
                let stiffness_weight = bending_rigidity * integration_weight;
                let mut active =
                    Vec::<ActiveBasis>::with_capacity(radial_dofs.len() * harmonics.len());
                for (harmonic_index, (angular_order, symmetry)) in harmonics.iter().enumerate() {
                    let angular = angular_shape(*angular_order, symmetry, theta)?;
                    let harmonic_offset = harmonic_index * radial_dofs_per_harmonic;
                    for radial in &radial_dofs {
                        let mut radial_offset = 2 * (radial.node - 1);
                        if radial.kind == RadialDof::Slope {
                            radial_offset += 1;
                        }
                        active.push(ActiveBasis {
                            index: harmonic_offset + radial_offset,
                            value: radial.value * angular[0],
                            curvature_rr: radial.second * angular[0],
                            curvature_tt: radial.first * angular[0] / radius_m
                                + radial.value * angular[2] / (radius_m * radius_m),
                            curvature_rt: angular[1]
                                * (radial.first / radius_m - radial.value / (radius_m * radius_m)),
                        });
                    }
                }
                active.sort_by_key(|row| row.index);
                for left_offset in 0..active.len() {
                    let left = active[left_offset];
                    for right in &active[left_offset..] {
                        mass[left.index][right.index] += mass_weight * left.value * right.value;
                        let curvature = left.curvature_rr * right.curvature_rr
                            + left.curvature_tt * right.curvature_tt
                            + poisson_ratio
                                * (left.curvature_rr * right.curvature_tt
                                    + left.curvature_tt * right.curvature_rr)
                            + 2.0 * (1.0 - poisson_ratio) * left.curvature_rt * right.curvature_rt;
                        stiffness[left.index][right.index] += stiffness_weight * curvature;
                    }
                }
            }
        }
    }
    for left in 0..count {
        for right in 0..left {
            mass[left][right] = mass[right][left];
            stiffness[left][right] = stiffness[right][left];
        }
    }
    Ok((stiffness, mass))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn probe_average(
    algorithm: &Algorithm,
    coefficients: &[f64],
    basis: &[BasisFunction],
    x_m: f64,
    y_m: f64,
    footprint_radius_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> Result<f64, String> {
    let mut total = evaluate_mode(coefficients, basis, x_m, y_m, hub_radius_m, outer_radius_m)?;
    for index in 0..algorithm.probe_ring_samples {
        let theta = std::f64::consts::TAU * index as f64 / algorithm.probe_ring_samples as f64;
        let offset_x = footprint_radius_m * algorithm.probe_ring_radius_ratio * theta.cos();
        let offset_y = footprint_radius_m * algorithm.probe_ring_radius_ratio * theta.sin();
        total += evaluate_mode(
            coefficients,
            basis,
            x_m + offset_x,
            y_m + offset_y,
            hub_radius_m,
            outer_radius_m,
        )?;
    }
    Ok(total / (algorithm.probe_ring_samples + 1) as f64)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn first_analysis_node_value(
    algorithm: &Algorithm,
    coefficients: &[f64],
    basis: &[BasisFunction],
    radial_element_count: usize,
    angular_samples: usize,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> Result<f64, String> {
    let radial_step = (outer_radius_m - hub_radius_m) / radial_element_count as f64;
    for radial_node in 1..=radial_element_count {
        let radius_m = hub_radius_m + radial_node as f64 * radial_step;
        for angular_index in 0..angular_samples {
            let theta =
                (angular_index as f64 + 0.5) * std::f64::consts::TAU / angular_samples as f64;
            let value = evaluate_mode(
                coefficients,
                basis,
                radius_m * theta.cos(),
                radius_m * theta.sin(),
                hub_radius_m,
                outer_radius_m,
            )?;
            if value.abs() > algorithm.sign_epsilon {
                return Ok(value);
            }
        }
    }
    Ok(1.0)
}

fn radiation_efficiency(
    algorithm: &Algorithm,
    coefficients: &[f64],
    basis: &[BasisFunction],
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> Result<f64, String> {
    let mut absolute_sum = 0.0;
    let mut signed_sum = 0.0;
    let mut count = 0;
    for radial_index in 0..algorithm.radiation_radial_samples {
        let radius = hub_radius_m
            + (radial_index as f64 + 0.5) / algorithm.radiation_radial_samples as f64
                * (outer_radius_m - hub_radius_m);
        for angular_index in 0..algorithm.radiation_angular_samples {
            let theta = (angular_index as f64 + 0.5) * std::f64::consts::TAU
                / algorithm.radiation_angular_samples as f64;
            let value = evaluate_mode(
                coefficients,
                basis,
                radius * theta.cos(),
                radius * theta.sin(),
                hub_radius_m,
                outer_radius_m,
            )?;
            absolute_sum += value.abs();
            signed_sum += value;
            count += 1;
        }
    }
    let coherence = signed_sum.abs() / absolute_sum.max(algorithm.normalization_floor);
    Ok(absolute_sum / count as f64
        * (algorithm.radiation_coherence_floor + algorithm.radiation_coherence_weight * coherence))
}

pub fn solve_modes(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    radial_element_count: usize,
    maximum_fourier_order: usize,
    angular_samples: usize,
) -> Result<SolveResult, String> {
    let basis = build_basis(radial_element_count, maximum_fourier_order)?;
    let (stiffness, mass) = assemble(
        spec,
        algorithm,
        field,
        radial_element_count,
        maximum_fourier_order,
        angular_samples,
        &basis,
    )?;
    let (standard, lower) = generalized_to_standard(&stiffness, &mass)?;
    let (values, vectors, sweeps, final_off_diagonal) = jacobi_eigen_symmetric(
        &standard,
        algorithm.jacobi_relative_tolerance,
        algorithm.jacobi_maximum_sweeps,
    )?;
    let mut eigenpairs = Vec::<(f64, Vec<f64>)>::new();
    for (index, eigenvalue) in values.into_iter().enumerate() {
        if eigenvalue <= 0.0 || !eigenvalue.is_finite() {
            continue;
        }
        let transformed = (0..basis.len())
            .map(|row| vectors[row][index])
            .collect::<Vec<_>>();
        let mut coefficients = solve_upper_from_lower_transpose(&lower, &transformed);
        let norm = mass_inner(&coefficients, &mass, &coefficients)
            .max(algorithm.normalization_floor)
            .sqrt();
        for value in &mut coefficients {
            *value /= norm;
        }
        eigenpairs.push((eigenvalue.sqrt() / std::f64::consts::TAU, coefficients));
    }
    eigenpairs.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal));
    let frequency_minimum = spec.number(&["frequencyRange", "minimumHz"])?;
    let frequency_maximum = spec.number(&["frequencyRange", "maximumHz"])?;
    let requested_count = spec.usize(&["solverRequest", "requestedModeCount"])?;
    let selected = eigenpairs
        .iter()
        .filter(|pair| frequency_minimum <= pair.0 && pair.0 <= frequency_maximum)
        .take(requested_count)
        .cloned()
        .collect::<Vec<_>>();
    if selected.len() < requested_count {
        return Err(format!(
            "finite-strip space yielded {} modes in {}..{} Hz; {} were requested",
            selected.len(),
            frequency_minimum,
            frequency_maximum,
            requested_count
        ));
    }

    let radius = spec.number(&["geometry", "radiusM"])?;
    let hub_radius = spec.number(&["geometry", "hub", "radiusM"])?;
    let actuator_x = spec.number(&["actuator", "positionM", "x"])?;
    let actuator_y = spec.number(&["actuator", "positionM", "y"])?;
    let actuator_radius = spec.number(&["actuator", "footprintRadiusM"])?;
    let microphone_x = spec.number(&["virtualMicrophone", "positionM", "x"])?;
    let microphone_y = spec.number(&["virtualMicrophone", "positionM", "y"])?;
    let microphone_radius = spec.number(&["virtualMicrophone", "apertureRadiusM"])?;
    let damping = spec.number(&["material", "nominalModalDampingRatio"])?;
    let mut modes = Vec::with_capacity(selected.len());
    for (index, (frequency, mut coefficients)) in selected.into_iter().enumerate() {
        let ordinal = index + 1;
        let mut actuator_raw = probe_average(
            algorithm,
            &coefficients,
            &basis,
            actuator_x,
            actuator_y,
            actuator_radius,
            hub_radius,
            radius,
        )?;
        let (sign, sign_reference) = if actuator_raw.abs() > algorithm.sign_epsilon {
            (
                if actuator_raw >= 0.0 { 1.0 } else { -1.0 },
                "actuator-positive",
            )
        } else {
            let first = first_analysis_node_value(
                algorithm,
                &coefficients,
                &basis,
                radial_element_count,
                angular_samples,
                hub_radius,
                radius,
            )?;
            (
                if first >= 0.0 { 1.0 } else { -1.0 },
                "first-nonzero-node-positive",
            )
        };
        for value in &mut coefficients {
            *value *= sign;
        }
        actuator_raw *= sign;
        let microphone_raw = probe_average(
            algorithm,
            &coefficients,
            &basis,
            microphone_x,
            microphone_y,
            microphone_radius,
            hub_radius,
            radius,
        )?;
        let radiation_raw =
            radiation_efficiency(algorithm, &coefficients, &basis, hub_radius, radius)?;
        let mut dominant_index = 0;
        for candidate in 1..coefficients.len() {
            if coefficients[candidate].abs() > coefficients[dominant_index].abs() {
                dominant_index = candidate;
            }
        }
        let dominant = &basis[dominant_index];
        modes.push(Mode {
            ordinal,
            frequency_hz: frequency,
            angular_frequency_rad_per_s: std::f64::consts::TAU * frequency,
            damping_ratio: damping * (1.0 + algorithm.damping_slope * index as f64),
            coefficients,
            actuator_coupling_raw: actuator_raw,
            microphone_coupling_raw: microphone_raw,
            radiation_efficiency_raw: radiation_raw,
            sign_reference,
            dominant_radial_node_index: dominant.radial_node_index,
            dominant_radial_dof: dominant.radial_dof,
            dominant_angular_order: dominant.angular_order,
            dominant_symmetry: dominant.symmetry.clone(),
        });
    }
    Ok(SolveResult {
        modes,
        basis,
        mass_matrix: mass,
        stiffness_matrix: stiffness,
        all_frequencies_hz: eigenpairs.into_iter().map(|pair| pair.0).collect(),
        quadrature: Quadrature {
            radial_element_count,
            maximum_fourier_order,
            radial_gauss_order: algorithm.radial_gauss_nodes.len(),
            angular_samples,
            dof_count: expected_dof_count(radial_element_count, maximum_fourier_order),
            point_count: radial_element_count
                * algorithm.radial_gauss_nodes.len()
                * angular_samples,
            minimum_mapping_jacobian_m: (radius - hub_radius) / radial_element_count as f64 / 2.0,
        },
        eigensolver: EigensolverEvidence {
            sweeps,
            final_maximum_off_diagonal: final_off_diagonal,
        },
    })
}

fn expected_dof_count(radial_element_count: usize, maximum_fourier_order: usize) -> usize {
    2 * radial_element_count * (1 + 2 * maximum_fourier_order)
}

fn physical_grid(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    radial_element_count: usize,
    angular_samples: usize,
) -> Result<Vec<(f64, f64, f64)>, String> {
    let radius = spec.number(&["geometry", "radiusM"])?;
    let hub = spec.number(&["geometry", "hub", "radiusM"])?;
    let density = spec.number(&["material", "densityKgPerM3"])?;
    let element_length = (radius - hub) / radial_element_count as f64;
    let angular_step = std::f64::consts::TAU / angular_samples as f64;
    let mut points = Vec::with_capacity(
        radial_element_count * algorithm.radial_gauss_nodes.len() * angular_samples,
    );
    for element_index in 0..radial_element_count {
        let start = hub + element_index as f64 * element_length;
        for gauss_index in 0..algorithm.radial_gauss_nodes.len() {
            let radial_position =
                start + 0.5 * (algorithm.radial_gauss_nodes[gauss_index] + 1.0) * element_length;
            let radial_weight = 0.5 * element_length * algorithm.radial_gauss_weights[gauss_index];
            for angular_index in 0..angular_samples {
                let theta = (angular_index as f64 + 0.5) * angular_step;
                let x_m = radial_position * theta.cos();
                let y_m = radial_position * theta.sin();
                let thickness = field.at(x_m, y_m, true);
                let weight = density * thickness * radial_position * radial_weight * angular_step;
                points.push((x_m, y_m, weight));
            }
        }
    }
    Ok(points)
}

fn sample_modes(
    result: &SolveResult,
    modes: &[Mode],
    points: &[(f64, f64, f64)],
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> Result<Vec<Vec<f64>>, String> {
    modes
        .iter()
        .map(|mode| {
            points
                .iter()
                .map(|(x_m, y_m, _)| {
                    evaluate_mode(
                        &mode.coefficients,
                        &result.basis,
                        *x_m,
                        *y_m,
                        hub_radius_m,
                        outer_radius_m,
                    )
                })
                .collect()
        })
        .collect()
}

fn physical_mac(
    left: &[f64],
    right: &[f64],
    points: &[(f64, f64, f64)],
    normalization_floor: f64,
) -> f64 {
    let mut cross = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for index in 0..left.len() {
        let weight = points[index].2;
        cross += weight * left[index] * right[index];
        left_norm += weight * left[index] * left[index];
        right_norm += weight * right[index] * right[index];
    }
    cross * cross / (left_norm * right_norm).max(normalization_floor)
}

fn match_modes_on_physical_grid(
    reference_modes: &[Mode],
    reference_values: &[Vec<f64>],
    candidate_modes: &[Mode],
    candidate_values: &[Vec<f64>],
    points: &[(f64, f64, f64)],
    required_reference_count: usize,
    normalization_floor: f64,
) -> Result<Vec<(usize, f64)>, String> {
    let mut pairs = Vec::<(f64, f64, usize, usize)>::new();
    for reference_index in 0..required_reference_count {
        let reference = &reference_modes[reference_index];
        for (candidate_index, candidate) in candidate_modes.iter().enumerate() {
            let mac = physical_mac(
                &reference_values[reference_index],
                &candidate_values[candidate_index],
                points,
                normalization_floor,
            );
            let relative_frequency = (reference.frequency_hz - candidate.frequency_hz).abs()
                / reference.frequency_hz.max(normalization_floor);
            pairs.push((-mac, relative_frequency, reference_index, candidate_index));
        }
    }
    pairs.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.1.partial_cmp(&right.1).unwrap_or(Ordering::Equal))
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| left.3.cmp(&right.3))
    });
    let mut assigned_reference = vec![false; required_reference_count];
    let mut assigned_candidate = vec![false; candidate_modes.len()];
    let mut matches = vec![None; required_reference_count];
    let mut assigned_count = 0;
    for (negative_mac, _, reference_index, candidate_index) in pairs {
        if assigned_reference[reference_index] || assigned_candidate[candidate_index] {
            continue;
        }
        matches[reference_index] = Some((candidate_index, -negative_mac));
        assigned_reference[reference_index] = true;
        assigned_candidate[candidate_index] = true;
        assigned_count += 1;
        if assigned_count == required_reference_count {
            break;
        }
    }
    matches
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "finite-strip physical-grid mode matching is incomplete".to_owned())
}

pub fn convergence_report(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    coarse: &SolveResult,
    medium: &SolveResult,
    fine: &SolveResult,
) -> Result<Value, String> {
    let maximum_change = spec.number(&[
        "solverRequest",
        "convergence",
        "maximumRelativeFrequencyChange",
    ])?;
    let minimum_mac = spec.number(&[
        "solverRequest",
        "convergence",
        "minimumModalAssuranceCriterion",
    ])?;
    let selected_count = fine.modes.len().min(16);
    let candidate_count = medium.modes.len().min(coarse.modes.len()).min(24);
    let radius = spec.number(&["geometry", "radiusM"])?;
    let hub = spec.number(&["geometry", "hub", "radiusM"])?;
    let points = physical_grid(
        spec,
        algorithm,
        field,
        fine.quadrature.radial_element_count,
        fine.quadrature.angular_samples,
    )?;
    let fine_modes = &fine.modes[..selected_count];
    let medium_modes = &medium.modes[..candidate_count];
    let coarse_modes = &coarse.modes[..candidate_count];
    let fine_values = sample_modes(fine, fine_modes, &points, hub, radius)?;
    let medium_values = sample_modes(medium, medium_modes, &points, hub, radius)?;
    let coarse_values = sample_modes(coarse, coarse_modes, &points, hub, radius)?;
    let medium_matches = match_modes_on_physical_grid(
        fine_modes,
        &fine_values,
        medium_modes,
        &medium_values,
        &points,
        selected_count,
        algorithm.normalization_floor,
    )?;
    let coarse_matches = match_modes_on_physical_grid(
        fine_modes,
        &fine_values,
        coarse_modes,
        &coarse_values,
        &points,
        selected_count,
        algorithm.normalization_floor,
    )?;
    let mut comparisons = Vec::with_capacity(selected_count);
    let mut accepted = true;
    for fine_index in 0..selected_count {
        let fine_mode = &fine_modes[fine_index];
        let (medium_index, medium_mac) = medium_matches[fine_index];
        let (coarse_index, coarse_mac) = coarse_matches[fine_index];
        let medium_mode = &medium_modes[medium_index];
        let coarse_mode = &coarse_modes[coarse_index];
        let relative_change = (fine_mode.frequency_hz - medium_mode.frequency_hz).abs()
            / fine_mode.frequency_hz.max(algorithm.normalization_floor);
        let frequency_converged = relative_change <= maximum_change;
        let shape_converged = medium_mac >= minimum_mac;
        accepted &= frequency_converged && shape_converged;
        comparisons.push(json!({
            "modeId": format!("mode-{:03}", fine_mode.ordinal),
            "coarseMatchedModeId": format!("mode-{:03}", coarse_mode.ordinal),
            "mediumMatchedModeId": format!("mode-{:03}", medium_mode.ordinal),
            "coarseFrequencyHz": coarse_mode.frequency_hz,
            "mediumFrequencyHz": medium_mode.frequency_hz,
            "fineFrequencyHz": fine_mode.frequency_hz,
            "coarseToFineModalAssuranceCriterion": coarse_mac,
            "mediumToFineRelativeChange": relative_change,
            "mediumToFineModalAssuranceCriterion": medium_mac,
            "frequencyConverged": frequency_converged,
            "shapeConverged": shape_converged,
        }));
    }
    let requested_element = spec.string(&["solverRequest", "elementFamily"])?;
    let mesh_levels = spec.mesh_levels()?;
    Ok(json!({
        "schemaVersion": "mandelhowl.convergence-report.v1",
        "method": "variable-thickness-kirchhoff-love-c1-finite-strip-fem",
        "methodConformance": {
            "canonicalRequestedElementFamily": requested_element,
            "executedElementFamily": "c1-cubic-hermite-annular-finite-strip",
            "matchesCanonicalElementFamily": requested_element == "kirchhoff-love-thin-plate",
            "handoffThinPlateMethodAllowed": true,
            "thinPlateEigenanalysisSupported": algorithm.handoff_thin_plate_supported,
            "surfaceMeshQualityValidated": algorithm.handoff_surface_mesh_validated,
            "finiteElementAssemblyUsed": algorithm.handoff_finite_element_assembly_used,
            "analysisSurfaceElementMeshCoupledToEigenproblem": algorithm.handoff_analysis_surface_mesh_coupled,
            "surfaceTriangleArchiveCoupledToEigenproblem": algorithm.handoff_surface_triangle_archive_coupled,
            "strictLiteralSection10_3Conformance": algorithm.handoff_strict_literal_conformance,
            "operationalDisposition": algorithm.handoff_operational_disposition.as_str(),
            "note": "C1 cubic-Hermite radial finite elements and normalized Fourier circumferential functions form the coupled Kirchhoff-Love finite-strip eigenproblem. The independent triangle archive remains manufacturing and coordinate evidence only.",
        },
        "analysisDiscretization": {
            "type": "c1-cubic-hermite-annular-finite-strip",
            "coupledToEigenproblemAssembly": true,
            "radialInterpolation": "cubic-hermite-c1",
            "angularInterpolation": "normalized-real-fourier",
            "innerBoundary": "value-and-radial-slope-dofs-eliminated",
            "outerBoundary": "natural-free-edge",
            "refinementOwner": "solverRequest.meshLevels[*].analysisFiniteStrip",
            "surfaceTriangleArchiveRole": "manufacturing, coordinate, and provenance evidence only",
        },
        "modeMatching": {
            "method": "deterministic-greedy-physical-mass-MAC-on-fine-grid",
            "referenceModeCount": selected_count,
            "candidateModeCountPerCoarserLevel": candidate_count,
            "physicalGridPointCount": points.len(),
            "tieBreakOrder": "descending-MAC-then-relative-frequency-then-ordinals",
        },
        "levels": [
            level_json(&mesh_levels[0], &coarse.quadrature),
            level_json(&mesh_levels[1], &medium.quadrature),
            level_json(&mesh_levels[2], &fine.quadrature),
        ],
        "criteria": {
            "maximumRelativeFrequencyChange": maximum_change,
            "minimumModalAssuranceCriterion": minimum_mac,
        },
        "comparisons": comparisons,
        "finiteElementMeshConvergenceAccepted": accepted,
        "accepted": accepted,
    }))
}

fn level_json(level: &MeshLevel, quadrature: &Quadrature) -> Value {
    json!({
        "name": level.name.as_str(),
        "targetElementSizeM": level.target_element_size_m,
        "analysisFiniteStrip": {
            "radialElementCount": level.analysis_radial_element_count,
            "maximumFourierOrder": level.analysis_maximum_fourier_order,
            "angularQuadratureSamples": level.analysis_angular_samples,
        },
        "radialElementCount": quadrature.radial_element_count,
        "maximumFourierOrder": quadrature.maximum_fourier_order,
        "radialGaussOrder": quadrature.radial_gauss_order,
        "angularSamples": quadrature.angular_samples,
        "dofCount": quadrature.dof_count,
        "pointCount": quadrature.point_count,
        "minimumMappingJacobianM": quadrature.minimum_mapping_jacobian_m,
        "boundaryConditions": "inner-value-and-slope-eliminated;outer-natural-free",
    })
}

pub fn solver_evidence_binary(result: &SolveResult) -> Result<Vec<u8>, String> {
    let basis_count = u32::try_from(result.basis.len())
        .map_err(|_| "basis count exceeds solver evidence v1".to_owned())?;
    let mode_count = u32::try_from(result.modes.len())
        .map_err(|_| "mode count exceeds solver evidence v1".to_owned())?;
    let mut output = Vec::new();
    output.extend_from_slice(b"MHEVID01");
    output.extend_from_slice(&1_u32.to_le_bytes());
    output.extend_from_slice(&basis_count.to_le_bytes());
    output.extend_from_slice(&mode_count.to_le_bytes());
    for row in &result.mass_matrix {
        for value in row {
            output.extend_from_slice(&value.to_le_bytes());
        }
    }
    for mode in &result.modes {
        for coefficient in &mode.coefficients {
            output.extend_from_slice(&coefficient.to_le_bytes());
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{build_basis, hermite_shapes};

    #[test]
    fn finite_strip_basis_dimensions_and_hermite_endpoints_are_exact() {
        assert_eq!(build_basis(3, 7).unwrap().len(), 90);
        assert_eq!(build_basis(4, 8).unwrap().len(), 136);
        assert_eq!(build_basis(5, 9).unwrap().len(), 190);
        let start = hermite_shapes(0.0, 0.03).unwrap();
        let end = hermite_shapes(1.0, 0.03).unwrap();
        assert_eq!(start.map(|row| row[0]), [1.0, 0.0, 0.0, 0.0]);
        assert_eq!(end.map(|row| row[0]), [0.0, 0.0, 1.0, 0.0]);
        assert_eq!(start.map(|row| row[1]), [0.0, 1.0, 0.0, 0.0]);
        assert_eq!(end.map(|row| row[1]), [0.0, 0.0, 0.0, 1.0]);
    }
}
