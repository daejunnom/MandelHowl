use crate::json::Value;
use crate::sha256::{digest, hex};

pub const ALGORITHM_CONTRACT_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../specs/physics/baker-algorithm.v1.json"
));

#[derive(Debug, Clone)]
pub struct Algorithm {
    pub revision: String,
    pub contract_sha256: String,
    pub field_minimum_resolution: usize,
    pub field_escape_radius: f64,
    pub field_box_passes: usize,
    pub field_bevel_passes: usize,
    pub conjugate_tolerance: f64,
    pub axisymmetric_radial_orders: usize,
    pub low_angular_minimum: usize,
    pub low_angular_maximum: usize,
    pub low_angular_radial_orders: usize,
    pub high_angular_minimum: usize,
    pub high_angular_maximum: usize,
    pub high_angular_radial_orders: usize,
    pub hessian_step_ratio: f64,
    pub jacobi_relative_tolerance: f64,
    pub jacobi_maximum_sweeps: usize,
    pub probe_ring_samples: usize,
    pub probe_ring_radius_ratio: f64,
    pub radiation_radial_samples: usize,
    pub radiation_angular_samples: usize,
    pub radiation_coherence_floor: f64,
    pub radiation_coherence_weight: f64,
    pub sign_epsilon: f64,
    pub damping_slope: f64,
    pub response_sample_count: usize,
    pub normalization_floor: f64,
    pub nodal_threshold: f64,
    pub sand_scale: f64,
    pub low_velocity_threshold: f64,
    pub high_velocity_threshold: f64,
    pub normal_visual_scale: f64,
    pub fd_check_ordinals: Vec<usize>,
    pub cross_validation_tolerance: f64,
    pub coverage_capture_rate: f64,
    pub coverage_maximum_fraction: f64,
    pub coverage_minimum_log_argument: f64,
    pub coverage_base_detune: f64,
    pub coverage_detune_step: f64,
    pub coverage_detune_cycle: usize,
}

impl Algorithm {
    pub fn load() -> Result<Self, String> {
        let value = crate::json::from_str(ALGORITHM_CONTRACT_JSON)
            .map_err(|error| format!("embedded algorithm contract is invalid: {error}"))?;
        if text(&value, &["schemaVersion"])? != "mandelhowl.baker-algorithm.v1" {
            return Err("algorithm contract schema version is unsupported".to_owned());
        }
        if text(&value, &["numericPolicy", "floatPrecision"])? != "binary64"
            || boolean(&value, &["numericPolicy", "fastMath"])?
            || text(&value, &["numericPolicy", "quantizationRounding"])? != "ties-to-even"
            || text(&value, &["numericPolicy", "summationOrder"])? != "source-loop-order"
            || text(&value, &["numericPolicy", "randomSource"])? != "forbidden"
            || text(&value, &["response", "spacing"])? != "logarithmic"
            || integer(&value, &["basis", "hubClampPower"])? != 2
        {
            return Err("algorithm numeric policy is incompatible".to_owned());
        }
        let ordinals = at(&value, &["texture", "finiteDifferenceCheckOrdinals"])?
            .as_array()
            .ok_or_else(|| "finiteDifferenceCheckOrdinals must be an array".to_owned())?
            .iter()
            .map(|item| {
                item.as_u64()
                    .and_then(|number| usize::try_from(number).ok())
                    .ok_or_else(|| "finite-difference ordinal is invalid".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            revision: text(&value, &["algorithmRevision"])?.to_owned(),
            contract_sha256: hex(&digest(ALGORITHM_CONTRACT_JSON.as_bytes())),
            field_minimum_resolution: integer(&value, &["field", "minimumResolutionPx"])?,
            field_escape_radius: number(&value, &["field", "escapeRadius"])?,
            field_box_passes: integer(&value, &["field", "gaussianApproximationBoxPasses"])?,
            field_bevel_passes: integer(&value, &["field", "manufacturingBevelBoxPasses"])?,
            conjugate_tolerance: number(&value, &["field", "conjugateSymmetryTolerance"])?,
            axisymmetric_radial_orders: integer(&value, &["basis", "axisymmetricRadialOrders"])?,
            low_angular_minimum: integer(&value, &["basis", "lowAngularOrderMinimum"])?,
            low_angular_maximum: integer(&value, &["basis", "lowAngularOrderMaximum"])?,
            low_angular_radial_orders: integer(&value, &["basis", "lowAngularRadialOrders"])?,
            high_angular_minimum: integer(&value, &["basis", "highAngularOrderMinimum"])?,
            high_angular_maximum: integer(&value, &["basis", "highAngularOrderMaximum"])?,
            high_angular_radial_orders: integer(&value, &["basis", "highAngularRadialOrders"])?,
            hessian_step_ratio: number(&value, &["assembly", "finiteDifferenceHessianStepRatio"])?,
            jacobi_relative_tolerance: number(&value, &["eigensolver", "relativeTolerance"])?,
            jacobi_maximum_sweeps: integer(&value, &["eigensolver", "maximumSweeps"])?,
            probe_ring_samples: integer(&value, &["coupling", "probeRingSamples"])?,
            probe_ring_radius_ratio: number(&value, &["coupling", "probeRingRadiusRatio"])?,
            radiation_radial_samples: integer(&value, &["coupling", "radiationRadialSamples"])?,
            radiation_angular_samples: integer(&value, &["coupling", "radiationAngularSamples"])?,
            radiation_coherence_floor: number(&value, &["coupling", "radiationCoherenceFloor"])?,
            radiation_coherence_weight: number(&value, &["coupling", "radiationCoherenceWeight"])?,
            sign_epsilon: number(&value, &["coupling", "signEpsilon"])?,
            damping_slope: number(&value, &["coupling", "ordinalDampingSlope"])?,
            response_sample_count: integer(&value, &["response", "sampleCount"])?,
            normalization_floor: number(&value, &["response", "normalizationFloor"])?,
            nodal_threshold: number(&value, &["texture", "nodalAbsoluteThreshold"])?,
            sand_scale: number(&value, &["texture", "sandGaussianScale"])?,
            low_velocity_threshold: number(&value, &["texture", "lowVelocityThreshold"])?,
            high_velocity_threshold: number(&value, &["texture", "highVelocityThreshold"])?,
            normal_visual_scale: number(&value, &["texture", "normalVisualScale"])?,
            fd_check_ordinals: ordinals,
            cross_validation_tolerance: number(
                &value,
                &["texture", "maximumCrossValidationRelativeDifference"],
            )?,
            coverage_capture_rate: number(&value, &["foundationCoverage", "captureRate"])?,
            coverage_maximum_fraction: number(&value, &["foundationCoverage", "maximumFraction"])?,
            coverage_minimum_log_argument: number(
                &value,
                &["foundationCoverage", "minimumLogArgument"],
            )?,
            coverage_base_detune: number(&value, &["foundationCoverage", "baseDetuneRatio"])?,
            coverage_detune_step: number(&value, &["foundationCoverage", "detuneStep"])?,
            coverage_detune_cycle: integer(&value, &["foundationCoverage", "detuneCycle"])?,
        })
    }
}

fn at<'a>(root: &'a Value, path: &[&str]) -> Result<&'a Value, String> {
    let mut current = root;
    for component in path {
        current = current
            .as_object()
            .and_then(|object| object.get(*component))
            .ok_or_else(|| format!("algorithm contract is missing $.{}", path.join(".")))?;
    }
    Ok(current)
}

fn text<'a>(root: &'a Value, path: &[&str]) -> Result<&'a str, String> {
    at(root, path)?
        .as_str()
        .ok_or_else(|| format!("$.{} must be a string", path.join(".")))
}

fn number(root: &Value, path: &[&str]) -> Result<f64, String> {
    at(root, path)?
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("$.{} must be a finite number", path.join(".")))
}

fn integer(root: &Value, path: &[&str]) -> Result<usize, String> {
    at(root, path)?
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("$.{} must be a non-negative integer", path.join(".")))
}

fn boolean(root: &Value, path: &[&str]) -> Result<bool, String> {
    at(root, path)?
        .as_bool()
        .ok_or_else(|| format!("$.{} must be a boolean", path.join(".")))
}
