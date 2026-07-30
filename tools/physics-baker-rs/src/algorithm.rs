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
    pub radial_gauss_nodes: Vec<f64>,
    pub radial_gauss_weights: Vec<f64>,
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
    pub runtime_frequency_quantum_hz: f64,
    pub runtime_coupling_quantum: f64,
    pub texture_layers_per_shard: usize,
    pub nodal_threshold: f64,
    pub sand_scale: f64,
    pub low_velocity_threshold: f64,
    pub high_velocity_threshold: f64,
    pub normal_visual_scale: f64,
    pub fd_check_ordinals: Vec<usize>,
    pub cross_validation_tolerance: f64,
    pub material_section_sample_count: usize,
    pub material_section_axis: String,
    pub material_section_position_convention: String,
    pub material_section_resampling: String,
    pub coverage_capture_rate: f64,
    pub coverage_maximum_fraction: f64,
    pub coverage_minimum_log_argument: f64,
    pub coverage_base_detune: f64,
    pub coverage_detune_step: f64,
    pub coverage_detune_cycle: usize,
    pub handoff_thin_plate_supported: bool,
    pub handoff_surface_mesh_validated: bool,
    pub handoff_finite_element_assembly_used: bool,
    pub handoff_analysis_surface_mesh_coupled: bool,
    pub handoff_surface_triangle_archive_coupled: bool,
    pub handoff_strict_literal_conformance: bool,
    pub handoff_operational_disposition: String,
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
            || text(&value, &["assembly", "analysisDiscretization"])?
                != "c1-cubic-hermite-annular-finite-strip"
            || text(&value, &["assembly", "radialInterpolation"])? != "cubic-hermite-c1"
            || text(&value, &["assembly", "angularInterpolation"])? != "normalized-real-fourier"
            || text(&value, &["assembly", "radialMesh"])? != "uniform-annular-strips"
            || integer(&value, &["assembly", "radialGaussOrder"])? != 5
            || text(&value, &["assembly", "angularQuadrature"])? != "midpoint"
            || text(&value, &["assembly", "quadratureLoopOrder"])?
                != "element-then-radial-gauss-ascending-then-theta-ascending-then-active-global-index-ascending"
            || text(&value, &["assembly", "boundaryEnforcement"])?
                != "eliminate-inner-value-and-radial-slope-dofs"
            || text(&value, &["assembly", "analysisResolutionSource"])?
                != "plate-spec.solverRequest.meshLevels[*].analysisFiniteStrip"
            || text(&value, &["handoffConformance", "section"])? != "10.3/B1"
            || text(&value, &["handoffConformance", "executedMethod"])?
                != "c1-cubic-hermite-annular-finite-strip"
            || !boolean(
                &value,
                &["handoffConformance", "thinPlateEigenanalysisSupported"],
            )?
            || !boolean(
                &value,
                &["handoffConformance", "surfaceMeshQualityValidated"],
            )?
            || !boolean(&value, &["handoffConformance", "finiteElementAssemblyUsed"])?
            || !boolean(
                &value,
                &[
                    "handoffConformance",
                    "analysisSurfaceElementMeshCoupledToEigenproblem",
                ],
            )?
            || boolean(
                &value,
                &[
                    "handoffConformance",
                    "surfaceTriangleArchiveCoupledToEigenproblem",
                ],
            )?
            || !boolean(&value, &["handoffConformance", "strictLiteralConformance"])?
            || text(&value, &["handoffConformance", "operationalDisposition"])?
                != "strict-thin-plate-finite-element-adapter"
            || text(&value, &["runtimeModalOutput", "rounding"])? != "ties-to-even"
            || text(
                &value,
                &["runtimeModalOutput", "angularFrequencyDerivation"],
            )? != "quantized-frequency-times-ieee754-tau"
            || text(&value, &["runtimeModalOutput", "negativeZero"])?
                != "canonicalize-to-positive-zero"
            || number(&value, &["runtimeModalOutput", "frequencyQuantumHz"])? != 2.0_f64.powi(-20)
            || number(&value, &["runtimeModalOutput", "couplingQuantum"])? != 2.0_f64.powi(-27)
            || text(&value, &["texture", "container"])? != "KTX2"
            || integer(&value, &["texture", "supercompressionScheme"])? != 3
            || integer(&value, &["texture", "layersPerShard"])? != 4
            || text(&value, &["texture", "shardOrdering"])?
                != "kind-then-global-texture-layer-ascending"
            || text(&value, &["texture", "shardPathPattern"])?
                != "textures/{kind}-{firstLayer:02d}-{lastLayer:02d}.ktx2"
            || text(&value, &["texture", "emissiveBasisSource"])? != "nodal-mask"
            || text(&value, &["texture", "emissiveBasisAliasPolicy"])?
                != "byte-identical-basis-reuse"
            || integer(&value, &["materialSectionProfile", "sampleCount"])? != 64
            || text(&value, &["materialSectionProfile", "axis"])? != "x-at-y-zero"
            || text(
                &value,
                &["materialSectionProfile", "samplePositionConvention"],
            )? != "uniform-cell-centres"
            || text(&value, &["materialSectionProfile", "resampling"])?
                != "bilinear-binary64-thickness"
        {
            return Err("algorithm numeric policy is incompatible".to_owned());
        }
        if at(&value, &["handoffConformance", "deviationCode"]).is_ok() {
            return Err("strict finite-strip contract cannot contain a deviation code".to_owned());
        }
        let radial_gauss_nodes = finite_number_array(&value, &["assembly", "radialGaussNodes"])?;
        let radial_gauss_weights =
            finite_number_array(&value, &["assembly", "radialGaussWeights"])?;
        if radial_gauss_nodes.len() != 5
            || radial_gauss_weights.len() != 5
            || radial_gauss_nodes.windows(2).any(|pair| pair[0] >= pair[1])
            || radial_gauss_weights.iter().any(|weight| *weight <= 0.0)
            || (radial_gauss_weights.iter().sum::<f64>() - 2.0).abs() > 1e-15
        {
            return Err("finite-strip radial Gauss rule is incompatible".to_owned());
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
            radial_gauss_nodes,
            radial_gauss_weights,
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
            runtime_frequency_quantum_hz: number(
                &value,
                &["runtimeModalOutput", "frequencyQuantumHz"],
            )?,
            runtime_coupling_quantum: number(&value, &["runtimeModalOutput", "couplingQuantum"])?,
            texture_layers_per_shard: integer(&value, &["texture", "layersPerShard"])?,
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
            material_section_sample_count: integer(
                &value,
                &["materialSectionProfile", "sampleCount"],
            )?,
            material_section_axis: text(&value, &["materialSectionProfile", "axis"])?.to_owned(),
            material_section_position_convention: text(
                &value,
                &["materialSectionProfile", "samplePositionConvention"],
            )?
            .to_owned(),
            material_section_resampling: text(&value, &["materialSectionProfile", "resampling"])?
                .to_owned(),
            coverage_capture_rate: number(&value, &["foundationCoverage", "captureRate"])?,
            coverage_maximum_fraction: number(&value, &["foundationCoverage", "maximumFraction"])?,
            coverage_minimum_log_argument: number(
                &value,
                &["foundationCoverage", "minimumLogArgument"],
            )?,
            coverage_base_detune: number(&value, &["foundationCoverage", "baseDetuneRatio"])?,
            coverage_detune_step: number(&value, &["foundationCoverage", "detuneStep"])?,
            coverage_detune_cycle: integer(&value, &["foundationCoverage", "detuneCycle"])?,
            handoff_thin_plate_supported: boolean(
                &value,
                &["handoffConformance", "thinPlateEigenanalysisSupported"],
            )?,
            handoff_surface_mesh_validated: boolean(
                &value,
                &["handoffConformance", "surfaceMeshQualityValidated"],
            )?,
            handoff_finite_element_assembly_used: boolean(
                &value,
                &["handoffConformance", "finiteElementAssemblyUsed"],
            )?,
            handoff_analysis_surface_mesh_coupled: boolean(
                &value,
                &[
                    "handoffConformance",
                    "analysisSurfaceElementMeshCoupledToEigenproblem",
                ],
            )?,
            handoff_surface_triangle_archive_coupled: boolean(
                &value,
                &[
                    "handoffConformance",
                    "surfaceTriangleArchiveCoupledToEigenproblem",
                ],
            )?,
            handoff_strict_literal_conformance: boolean(
                &value,
                &["handoffConformance", "strictLiteralConformance"],
            )?,
            handoff_operational_disposition: text(
                &value,
                &["handoffConformance", "operationalDisposition"],
            )?
            .to_owned(),
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

fn finite_number_array(root: &Value, path: &[&str]) -> Result<Vec<f64>, String> {
    at(root, path)?
        .as_array()
        .ok_or_else(|| format!("$.{} must be an array", path.join(".")))?
        .iter()
        .map(|value| {
            value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("$.{} contains a non-finite number", path.join(".")))
        })
        .collect()
}

fn boolean(root: &Value, path: &[&str]) -> Result<bool, String> {
    at(root, path)?
        .as_bool()
        .ok_or_else(|| format!("$.{} must be a boolean", path.join(".")))
}

#[cfg(test)]
mod tests {
    use super::Algorithm;

    #[test]
    fn b1_finite_strip_contract_requires_strict_fem_conformance() {
        let algorithm = Algorithm::load().expect("algorithm contract");
        assert!(algorithm.handoff_thin_plate_supported);
        assert!(algorithm.handoff_surface_mesh_validated);
        assert!(algorithm.handoff_finite_element_assembly_used);
        assert!(algorithm.handoff_analysis_surface_mesh_coupled);
        assert!(!algorithm.handoff_surface_triangle_archive_coupled);
        assert!(algorithm.handoff_strict_literal_conformance);
        assert_eq!(algorithm.radial_gauss_nodes.len(), 5);
        assert_eq!(algorithm.texture_layers_per_shard, 4);
    }
}
