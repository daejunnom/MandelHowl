use std::cmp::Ordering;

use crate::algorithm::Algorithm;
use crate::field::MaterialField;
use crate::json;
use crate::json::Value;
use crate::linear_algebra::{
    Matrix, generalized_to_standard, jacobi_eigen_symmetric, mass_inner,
    solve_upper_from_lower_transpose,
};
use crate::spec::PlateSpec;

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

#[derive(Debug, Clone)]
pub struct BasisFunction {
    pub radial_order: usize,
    pub angular_order: usize,
    pub symmetry: Symmetry,
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
    pub dominant_radial_order: usize,
    pub dominant_angular_order: usize,
    pub dominant_symmetry: Symmetry,
}

#[derive(Debug, Clone)]
pub struct Quadrature {
    pub radial_samples: usize,
    pub angular_samples: usize,
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

pub fn build_basis(algorithm: &Algorithm) -> Vec<BasisFunction> {
    let mut basis = Vec::with_capacity(64);
    for radial in 0..algorithm.axisymmetric_radial_orders {
        basis.push(BasisFunction {
            radial_order: radial,
            angular_order: 0,
            symmetry: Symmetry::Axisymmetric,
        });
    }
    for angular in algorithm.low_angular_minimum..=algorithm.low_angular_maximum {
        for radial in 0..algorithm.low_angular_radial_orders {
            basis.push(BasisFunction {
                radial_order: radial,
                angular_order: angular,
                symmetry: Symmetry::Cosine,
            });
            basis.push(BasisFunction {
                radial_order: radial,
                angular_order: angular,
                symmetry: Symmetry::Sine,
            });
        }
    }
    for angular in algorithm.high_angular_minimum..=algorithm.high_angular_maximum {
        for radial in 0..algorithm.high_angular_radial_orders {
            basis.push(BasisFunction {
                radial_order: radial,
                angular_order: angular,
                symmetry: Symmetry::Cosine,
            });
            basis.push(BasisFunction {
                radial_order: radial,
                angular_order: angular,
                symmetry: Symmetry::Sine,
            });
        }
    }
    basis
}

fn legendre(order: usize, value: f64) -> f64 {
    match order {
        0 => 1.0,
        1 => value,
        _ => {
            let mut previous = 1.0;
            let mut current = value;
            for degree in 2..=order {
                let next_value = ((2 * degree - 1) as f64 * value * current
                    - (degree - 1) as f64 * previous)
                    / degree as f64;
                (previous, current) = (current, next_value);
            }
            current
        }
    }
}

pub fn basis_value(
    descriptor: &BasisFunction,
    x_m: f64,
    y_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> f64 {
    let radius = x_m.hypot(y_m);
    let normalized = (radius - hub_radius_m) / (outer_radius_m - hub_radius_m);
    let radial_shape =
        normalized * normalized * legendre(descriptor.radial_order, 2.0 * normalized - 1.0);
    if descriptor.angular_order == 0 {
        return radial_shape;
    }
    let phase = descriptor.angular_order as f64 * y_m.atan2(x_m);
    let angular_shape = match descriptor.symmetry {
        Symmetry::Cosine => phase.cos(),
        Symmetry::Sine => phase.sin(),
        Symmetry::Axisymmetric => 1.0,
    };
    radial_shape * angular_shape
}

pub fn evaluate_mode(
    coefficients: &[f64],
    basis: &[BasisFunction],
    x_m: f64,
    y_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> f64 {
    coefficients
        .iter()
        .zip(basis)
        .map(|(coefficient, descriptor)| {
            coefficient * basis_value(descriptor, x_m, y_m, hub_radius_m, outer_radius_m)
        })
        .sum()
}

fn basis_hessians(
    basis: &[BasisFunction],
    x_m: f64,
    y_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
    epsilon_m: f64,
) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut values = Vec::with_capacity(basis.len());
    let mut hxx = Vec::with_capacity(basis.len());
    let mut hyy = Vec::with_capacity(basis.len());
    let mut hxy = Vec::with_capacity(basis.len());
    let h2 = epsilon_m * epsilon_m;
    for descriptor in basis {
        let centre = basis_value(descriptor, x_m, y_m, hub_radius_m, outer_radius_m);
        let xp = basis_value(
            descriptor,
            x_m + epsilon_m,
            y_m,
            hub_radius_m,
            outer_radius_m,
        );
        let xm = basis_value(
            descriptor,
            x_m - epsilon_m,
            y_m,
            hub_radius_m,
            outer_radius_m,
        );
        let yp = basis_value(
            descriptor,
            x_m,
            y_m + epsilon_m,
            hub_radius_m,
            outer_radius_m,
        );
        let ym = basis_value(
            descriptor,
            x_m,
            y_m - epsilon_m,
            hub_radius_m,
            outer_radius_m,
        );
        let xpy = basis_value(
            descriptor,
            x_m + epsilon_m,
            y_m + epsilon_m,
            hub_radius_m,
            outer_radius_m,
        );
        let xmy = basis_value(
            descriptor,
            x_m - epsilon_m,
            y_m + epsilon_m,
            hub_radius_m,
            outer_radius_m,
        );
        let xpym = basis_value(
            descriptor,
            x_m + epsilon_m,
            y_m - epsilon_m,
            hub_radius_m,
            outer_radius_m,
        );
        let xmym = basis_value(
            descriptor,
            x_m - epsilon_m,
            y_m - epsilon_m,
            hub_radius_m,
            outer_radius_m,
        );
        values.push(centre);
        hxx.push((xp - 2.0 * centre + xm) / h2);
        hyy.push((yp - 2.0 * centre + ym) / h2);
        hxy.push((xpy - xmy - xpym + xmym) / (4.0 * h2));
    }
    (values, hxx, hyy, hxy)
}

fn assemble(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    radial_samples: usize,
    angular_samples: usize,
    basis: &[BasisFunction],
) -> Result<(Matrix, Matrix), String> {
    if radial_samples == 0 || angular_samples == 0 {
        return Err("quadrature dimensions must be positive".to_owned());
    }
    let count = basis.len();
    let mut mass = vec![vec![0.0; count]; count];
    let mut stiffness = vec![vec![0.0; count]; count];
    let radius = spec.number(&["geometry", "radiusM"])?;
    let hub_radius = spec.number(&["geometry", "hub", "radiusM"])?;
    let radial_step = (radius - hub_radius) / radial_samples as f64;
    let angular_step = std::f64::consts::TAU / angular_samples as f64;
    let density = spec.number(&["material", "densityKgPerM3"])?;
    let youngs_modulus = spec.number(&["material", "youngsModulusPa"])?;
    let poisson_ratio = spec.number(&["material", "poissonRatio"])?;
    let epsilon = radius * algorithm.hessian_step_ratio;

    for radial_index in 0..radial_samples {
        let radial_position = hub_radius + (radial_index as f64 + 0.5) * radial_step;
        for angular_index in 0..angular_samples {
            let theta = (angular_index as f64 + 0.5) * angular_step;
            let x_m = radial_position * theta.cos();
            let y_m = radial_position * theta.sin();
            let area_weight = radial_position * radial_step * angular_step;
            let thickness = field.at(x_m, y_m, true);
            let bending_rigidity =
                youngs_modulus * thickness.powi(3) / (12.0 * (1.0 - poisson_ratio * poisson_ratio));
            let (values, hxx, hyy, hxy) =
                basis_hessians(basis, x_m, y_m, hub_radius, radius, epsilon);
            let mass_weight = density * thickness * area_weight;
            let stiffness_weight = bending_rigidity * area_weight;
            for left in 0..count {
                let mass_left = mass_weight * values[left];
                for right in left..count {
                    let mass_value = mass_left * values[right];
                    let curvature = hxx[left] * hxx[right]
                        + hyy[left] * hyy[right]
                        + poisson_ratio * (hxx[left] * hyy[right] + hyy[left] * hxx[right])
                        + 2.0 * (1.0 - poisson_ratio) * hxy[left] * hxy[right];
                    mass[left][right] += mass_value;
                    stiffness[left][right] += stiffness_weight * curvature;
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
fn probe_average(
    algorithm: &Algorithm,
    coefficients: &[f64],
    basis: &[BasisFunction],
    x_m: f64,
    y_m: f64,
    footprint_radius_m: f64,
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> f64 {
    let mut total = evaluate_mode(coefficients, basis, x_m, y_m, hub_radius_m, outer_radius_m);
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
        );
    }
    total / (algorithm.probe_ring_samples + 1) as f64
}

fn radiation_efficiency(
    algorithm: &Algorithm,
    coefficients: &[f64],
    basis: &[BasisFunction],
    hub_radius_m: f64,
    outer_radius_m: f64,
) -> f64 {
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
            );
            absolute_sum += value.abs();
            signed_sum += value;
            count += 1;
        }
    }
    let coherence = signed_sum.abs() / absolute_sum.max(algorithm.normalization_floor);
    absolute_sum / count as f64
        * (algorithm.radiation_coherence_floor + algorithm.radiation_coherence_weight * coherence)
}

pub fn solve_modes(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    radial_samples: usize,
    angular_samples: usize,
) -> Result<SolveResult, String> {
    let basis = build_basis(algorithm);
    let (stiffness, mass) = assemble(
        spec,
        algorithm,
        field,
        radial_samples,
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
            "basis yielded {} modes in {}..{} Hz; {} were requested",
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
        );
        let (sign, sign_reference) = if actuator_raw.abs() > algorithm.sign_epsilon {
            (
                if actuator_raw >= 0.0 { 1.0 } else { -1.0 },
                "actuator-positive",
            )
        } else {
            let first = coefficients
                .iter()
                .copied()
                .find(|value| value.abs() > algorithm.sign_epsilon)
                .unwrap_or(1.0);
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
        );
        let radiation_raw =
            radiation_efficiency(algorithm, &coefficients, &basis, hub_radius, radius);
        // Python's max(enumerate(...), key=...) retains the first item on a
        // tie. Keep that tie rule explicit so both independent bakers choose
        // identical basis metadata.
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
            dominant_radial_order: dominant.radial_order,
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
            radial_samples,
            angular_samples,
        },
        eigensolver: EigensolverEvidence {
            sweeps,
            final_maximum_off_diagonal: final_off_diagonal,
        },
    })
}

fn modal_assurance(
    algorithm: &Algorithm,
    left: &Mode,
    right: &Mode,
    reference_mass: &Matrix,
) -> f64 {
    let numerator = mass_inner(&left.coefficients, reference_mass, &right.coefficients);
    let left_norm = mass_inner(&left.coefficients, reference_mass, &left.coefficients);
    let right_norm = mass_inner(&right.coefficients, reference_mass, &right.coefficients);
    numerator * numerator / (left_norm * right_norm).max(algorithm.normalization_floor)
}

pub fn convergence_report(
    spec: &PlateSpec,
    algorithm: &Algorithm,
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
    let mut comparisons = Vec::with_capacity(selected_count);
    let mut accepted = true;
    for index in 0..selected_count {
        let coarse_mode = &coarse.modes[index];
        let medium_mode = &medium.modes[index];
        let fine_mode = &fine.modes[index];
        let relative_change = (fine_mode.frequency_hz - medium_mode.frequency_hz).abs()
            / fine_mode.frequency_hz.max(algorithm.normalization_floor);
        let mac = modal_assurance(algorithm, medium_mode, fine_mode, &fine.mass_matrix);
        let frequency_converged = relative_change <= maximum_change;
        let shape_converged = mac >= minimum_mac;
        accepted &= frequency_converged && shape_converged;
        comparisons.push(json!({
            "modeId": format!("mode-{:03}", fine_mode.ordinal),
            "coarseFrequencyHz": coarse_mode.frequency_hz,
            "mediumFrequencyHz": medium_mode.frequency_hz,
            "fineFrequencyHz": fine_mode.frequency_hz,
            "mediumToFineRelativeChange": relative_change,
            "mediumToFineModalAssuranceCriterion": mac,
            "frequencyConverged": frequency_converged,
            "shapeConverged": shape_converged,
        }));
    }
    let requested_element = spec.string(&["solverRequest", "elementFamily"])?;
    Ok(json!({
        "schemaVersion": "mandelhowl.convergence-report.v1",
        "method": "variable-thickness-kirchhoff-love-rayleigh-ritz",
        "methodConformance": {
            "canonicalRequestedElementFamily": requested_element,
            "executedElementFamily": "global-rayleigh-ritz-thin-plate-basis",
            "matchesCanonicalElementFamily": requested_element == "kirchhoff-love-thin-plate",
            "handoffThinPlateMethodAllowed": true,
            "note": "The global Rayleigh-Ritz basis is the numerical adapter used for the canonical Kirchhoff-Love thin-plate family. It is not shell FEM."
        },
        "levels": [
            quadrature_json("coarse", &coarse.quadrature),
            quadrature_json("medium", &medium.quadrature),
            quadrature_json("fine", &fine.quadrature),
        ],
        "criteria": {
            "maximumRelativeFrequencyChange": maximum_change,
            "minimumModalAssuranceCriterion": minimum_mac,
        },
        "comparisons": comparisons,
        "accepted": accepted,
    }))
}

fn quadrature_json(name: &str, quadrature: &Quadrature) -> Value {
    json!({
        "name": name,
        "radialSamples": quadrature.radial_samples,
        "angularSamples": quadrature.angular_samples,
        "pointCount": quadrature.radial_samples * quadrature.angular_samples,
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
