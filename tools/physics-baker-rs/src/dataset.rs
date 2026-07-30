//! Independent semantic validation for a packaged MandelHowl dataset.
//!
//! This module deliberately does not call the Python baker and does not share
//! its decoders. It validates the runtime payload and solver evidence directly
//! from the documented binary contracts.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::algorithm::Algorithm;
use crate::json::Value;
use crate::mesh::zlib_decompress;
use crate::sha256::{Sha256, digest, hex};
use crate::solver::{build_basis, evaluate_mode, first_analysis_node_value, probe_average};
use crate::{ModeRecord, ResponseSample, decode_modes_v1, decode_response_v1};

const KTX2_IDENTIFIER: [u8; 12] = [
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
];
const VK_FORMAT_R8_UNORM: u32 = 9;
const VK_FORMAT_R8G8_UNORM: u32 = 16;
const RESPONSE_COMPONENT_TOLERANCE: f64 = 2e-12;
const MODAL_MASS_DIAGONAL_TOLERANCE: f64 = 5e-8;
const MODAL_MASS_OFF_DIAGONAL_TOLERANCE: f64 = 5e-7;

#[derive(Debug, Clone)]
pub struct PayloadDigest {
    pub path: String,
    pub byte_length: usize,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct DatasetSemanticReport {
    pub dataset_root: PathBuf,
    pub algorithm_revision: String,
    pub algorithm_contract_sha256: String,
    pub dataset_id: String,
    pub manifest_sha256: String,
    pub mode_count: usize,
    pub response_sample_count: usize,
    pub texture_count: usize,
    pub first_mode_id: String,
    pub last_mode_id: String,
    pub minimum_mode_frequency_hz: f64,
    pub maximum_mode_frequency_hz: f64,
    pub minimum_response_frequency_hz: f64,
    pub maximum_response_frequency_hz: f64,
    pub response_normalization_divisor: f64,
    pub maximum_response_component_error: f64,
    pub maximum_modal_mass_diagonal_error: f64,
    pub maximum_modal_mass_off_diagonal: f64,
    pub minimum_eigenvector_texture_correlation: f64,
    pub minimum_sand_low_minus_high_mean: f64,
    pub field_resolution: usize,
    pub texture_width: usize,
    pub texture_height: usize,
    pub exact_scientific_payload_sha256: String,
    pub payloads: Vec<PayloadDigest>,
}

impl DatasetSemanticReport {
    pub fn to_json(&self) -> String {
        let payloads = self
            .payloads
            .iter()
            .map(|payload| {
                format!(
                    "{{\"path\":{},\"byteLength\":{},\"sha256\":{}}}",
                    json_string(&payload.path),
                    payload.byte_length,
                    json_string(&payload.sha256)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            concat!(
                "{{",
                "\"schemaVersion\":\"mandelhowl.native-semantic-report.v1\",",
                "\"backend\":\"rust-native\",",
                "\"status\":\"valid\",",
                "\"algorithmRevision\":{},",
                "\"algorithmContractSha256\":{},",
                "\"datasetRoot\":{},",
                "\"datasetId\":{},",
                "\"manifestSha256\":{},",
                "\"modeCount\":{},",
                "\"responseSampleCount\":{},",
                "\"textureCount\":{},",
                "\"firstModeId\":{},",
                "\"lastModeId\":{},",
                "\"minimumModeFrequencyHz\":{},",
                "\"maximumModeFrequencyHz\":{},",
                "\"minimumResponseFrequencyHz\":{},",
                "\"maximumResponseFrequencyHz\":{},",
                "\"responseNormalizationDivisor\":{},",
                "\"maximumResponseComponentError\":{},",
                "\"maximumModalMassDiagonalError\":{},",
                "\"maximumModalMassOffDiagonal\":{},",
                "\"minimumEigenvectorTextureCorrelation\":{},",
                "\"minimumSandLowMinusHighMean\":{},",
                "\"fieldResolution\":{},",
                "\"textureWidth\":{},",
                "\"textureHeight\":{},",
                "\"exactScientificPayloadSha256\":{},",
                "\"payloads\":[{}],",
                "\"validationCoverage\":[",
                "\"modes-v1-all-records\",",
                "\"response-v1-all-samples-recomputed\",",
                "\"ktx2-four-atlases-and-layer-alignment\",",
                "\"all-modal-sign-coupling-eigenvector-texture-semantics\",",
                "\"sand-displacement-semantic-alignment\",",
                "\"solver-evidence-unit-modal-mass\",",
                "\"material-field-v1\",",
                "\"material-section-profile-from-field-evidence\",",
                "\"manifest-assets-checksums-and-content-identity\"",
                "]",
                "}}"
            ),
            json_string(&self.algorithm_revision),
            json_string(&self.algorithm_contract_sha256),
            json_string(&self.dataset_root.to_string_lossy()),
            json_string(&self.dataset_id),
            json_string(&self.manifest_sha256),
            self.mode_count,
            self.response_sample_count,
            self.texture_count,
            json_string(&self.first_mode_id),
            json_string(&self.last_mode_id),
            json_number(self.minimum_mode_frequency_hz),
            json_number(self.maximum_mode_frequency_hz),
            json_number(self.minimum_response_frequency_hz),
            json_number(self.maximum_response_frequency_hz),
            json_number(self.response_normalization_divisor),
            json_number(self.maximum_response_component_error),
            json_number(self.maximum_modal_mass_diagonal_error),
            json_number(self.maximum_modal_mass_off_diagonal),
            json_number(self.minimum_eigenvector_texture_correlation),
            json_number(self.minimum_sand_low_minus_high_mean),
            self.field_resolution,
            self.texture_width,
            self.texture_height,
            json_string(&self.exact_scientific_payload_sha256),
            payloads,
        )
    }
}

#[derive(Debug)]
struct Ktx2Array {
    width: usize,
    height: usize,
    layers: usize,
    channels: usize,
    supercompression_scheme: u32,
    image_data: Vec<u8>,
}

#[derive(Debug)]
struct SolverEvidence {
    coefficients: Vec<Vec<f64>>,
}

fn checked_slice(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8], String> {
    bytes
        .get(offset..offset.saturating_add(length))
        .ok_or_else(|| format!("binary field at {offset} is truncated"))
}

fn u32_le(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value: [u8; 4] = checked_slice(bytes, offset, 4)?
        .try_into()
        .map_err(|_| "invalid u32 field".to_owned())?;
    Ok(u32::from_le_bytes(value))
}

fn u64_le(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let value: [u8; 8] = checked_slice(bytes, offset, 8)?
        .try_into()
        .map_err(|_| "invalid u64 field".to_owned())?;
    Ok(u64::from_le_bytes(value))
}

fn f32_le(bytes: &[u8], offset: usize, label: &str) -> Result<f32, String> {
    let value: [u8; 4] = checked_slice(bytes, offset, 4)?
        .try_into()
        .map_err(|_| format!("{label} is truncated"))?;
    let value = f32::from_le_bytes(value);
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{label} must be finite"))
    }
}

fn f64_le(bytes: &[u8], offset: usize, label: &str) -> Result<f64, String> {
    let value: [u8; 8] = checked_slice(bytes, offset, 8)?
        .try_into()
        .map_err(|_| format!("{label} is truncated"))?;
    let value = f64::from_le_bytes(value);
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{label} must be finite"))
    }
}

fn usize_from_u32(value: u32, label: &str) -> Result<usize, String> {
    usize::try_from(value).map_err(|_| format!("{label} overflows usize"))
}

fn usize_from_u64(value: u64, label: &str) -> Result<usize, String> {
    usize::try_from(value).map_err(|_| format!("{label} overflows usize"))
}

fn validate_ktx2(bytes: &[u8], label: &str) -> Result<Ktx2Array, String> {
    if bytes.len() < 104 || checked_slice(bytes, 0, 12)? != KTX2_IDENTIFIER {
        return Err(format!("{label}: invalid or truncated KTX2 header"));
    }
    let vk_format = u32_le(bytes, 12)?;
    let type_size = u32_le(bytes, 16)?;
    let width = usize_from_u32(u32_le(bytes, 20)?, "KTX2 width")?;
    let height = usize_from_u32(u32_le(bytes, 24)?, "KTX2 height")?;
    let depth = u32_le(bytes, 28)?;
    let layers = usize_from_u32(u32_le(bytes, 32)?, "KTX2 layers")?;
    let faces = u32_le(bytes, 36)?;
    let levels = u32_le(bytes, 40)?;
    let supercompression = u32_le(bytes, 44)?;
    let dfd_offset = usize_from_u32(u32_le(bytes, 48)?, "KTX2 DFD offset")?;
    let dfd_length = usize_from_u32(u32_le(bytes, 52)?, "KTX2 DFD length")?;
    let kvd_offset = usize_from_u32(u32_le(bytes, 56)?, "KTX2 KVD offset")?;
    let kvd_length = usize_from_u32(u32_le(bytes, 60)?, "KTX2 KVD length")?;
    let sgd_offset = u64_le(bytes, 64)?;
    let sgd_length = u64_le(bytes, 72)?;
    if type_size != 1
        || width == 0
        || height == 0
        || depth != 0
        || layers == 0
        || faces != 1
        || levels != 1
        || !matches!(supercompression, 0 | 3)
        || sgd_offset != 0
        || sgd_length != 0
    {
        return Err(format!("{label}: unsupported KTX2 array layout"));
    }
    let channels = match vk_format {
        VK_FORMAT_R8_UNORM => 1,
        VK_FORMAT_R8G8_UNORM => 2,
        _ => return Err(format!("{label}: unsupported vkFormat {vk_format}")),
    };
    if dfd_offset != 104 || dfd_offset.saturating_add(dfd_length) > bytes.len() || dfd_length < 28 {
        return Err(format!("{label}: invalid DFD range"));
    }
    let dfd_total = usize_from_u32(u32_le(bytes, dfd_offset)?, "KTX2 DFD total")?;
    if dfd_total != dfd_length {
        return Err(format!("{label}: DFD total size mismatch"));
    }
    if kvd_length == 0
        || kvd_offset < dfd_offset + dfd_length
        || kvd_offset.saturating_add(kvd_length) > bytes.len()
    {
        return Err(format!("{label}: invalid key/value data"));
    }
    let kvd = checked_slice(bytes, kvd_offset, kvd_length)?;
    if !contains_bytes(kvd, b"KTXorientation\0ru\0") {
        return Err(format!("{label}: KTXorientation must be ru"));
    }
    let level_offset = usize_from_u64(u64_le(bytes, 80)?, "KTX2 level offset")?;
    let level_length = usize_from_u64(u64_le(bytes, 88)?, "KTX2 level length")?;
    let uncompressed = usize_from_u64(u64_le(bytes, 96)?, "KTX2 uncompressed length")?;
    let expected = width
        .checked_mul(height)
        .and_then(|value| value.checked_mul(layers))
        .and_then(|value| value.checked_mul(channels))
        .ok_or_else(|| format!("{label}: KTX2 dimensions overflow"))?;
    let alignment = 4;
    if uncompressed != expected
        || level_length == 0
        || level_offset % alignment != 0
        || level_offset.saturating_add(level_length) != bytes.len()
    {
        return Err(format!("{label}: KTX2 level range is inconsistent"));
    }
    if (supercompression == 0 && level_length != expected)
        || (supercompression == 3 && level_length >= expected)
    {
        return Err(format!(
            "{label}: KTX2 level length contradicts its supercompression scheme"
        ));
    }
    let dfd_channels = (dfd_length - 28) / 16;
    if dfd_channels != channels || bytes[dfd_offset + 20] as usize != channels {
        return Err(format!("{label}: DFD channel layout mismatch"));
    }
    let encoded = checked_slice(bytes, level_offset, level_length)?;
    let image_data = if supercompression == 3 {
        zlib_decompress(encoded).map_err(|error| format!("{label}: {error}"))?
    } else {
        encoded.to_vec()
    };
    if image_data.len() != expected {
        return Err(format!(
            "{label}: decoded KTX2 level length does not match dimensions"
        ));
    }
    Ok(Ktx2Array {
        width,
        height,
        layers,
        channels,
        supercompression_scheme: supercompression,
        image_data,
    })
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn validate_response_against_modes(
    modes: &[ModeRecord],
    response: &[ResponseSample],
    normalization_floor: f64,
) -> Result<(f64, f64), String> {
    let mut raw = Vec::with_capacity(response.len());
    for sample in response {
        let omega = std::f64::consts::TAU * sample.frequency_hz;
        let mut real = 0.0;
        let mut imaginary = 0.0;
        for mode in modes {
            let omega_i = mode.angular_frequency_rad_per_s;
            let numerator = mode.actuator_coupling
                * mode.microphone_coupling
                * mode.radiation_efficiency
                * omega_i
                * omega_i;
            let denominator_real = omega_i * omega_i - omega * omega;
            let denominator_imaginary = 2.0 * mode.damping_ratio * omega_i * omega;
            let denominator_norm =
                denominator_real * denominator_real + denominator_imaginary * denominator_imaginary;
            if !denominator_norm.is_finite() || denominator_norm <= 0.0 {
                return Err(format!(
                    "response denominator is invalid for {} at {} Hz",
                    mode.mode_id, sample.frequency_hz
                ));
            }
            real += numerator * denominator_real / denominator_norm;
            imaginary -= numerator * denominator_imaginary / denominator_norm;
        }
        raw.push((real, imaginary));
    }
    let normalization = raw
        .iter()
        .map(|(real, imaginary)| real.hypot(*imaginary))
        .fold(normalization_floor, f64::max);
    let mut maximum_error = 0.0_f64;
    for (index, (raw_real, raw_imaginary)) in raw.iter().enumerate() {
        let expected_real = raw_real / normalization;
        let expected_imaginary = raw_imaginary / normalization;
        maximum_error = maximum_error
            .max((expected_real - response[index].real).abs())
            .max((expected_imaginary - response[index].imaginary).abs());
    }
    if maximum_error > RESPONSE_COMPONENT_TOLERANCE {
        return Err(format!(
            "response-v1 differs from modal recomputation by {maximum_error}"
        ));
    }
    Ok((normalization, maximum_error))
}

#[allow(clippy::needless_range_loop)]
fn validate_solver_evidence(
    bytes: &[u8],
    expected_modes: usize,
) -> Result<(SolverEvidence, f64, f64), String> {
    if bytes.len() < 20 || checked_slice(bytes, 0, 8)? != b"MHEVID01" {
        return Err("solver evidence header is invalid".to_owned());
    }
    let version = u32_le(bytes, 8)?;
    let basis_count = usize_from_u32(u32_le(bytes, 12)?, "basis count")?;
    let mode_count = usize_from_u32(u32_le(bytes, 16)?, "evidence mode count")?;
    if version != 1 || basis_count == 0 || mode_count != expected_modes {
        return Err("solver evidence dimensions are incompatible".to_owned());
    }
    let value_count = basis_count
        .checked_mul(basis_count)
        .and_then(|mass| {
            basis_count
                .checked_mul(mode_count)
                .and_then(|modes| mass.checked_add(modes))
        })
        .ok_or_else(|| "solver evidence dimensions overflow".to_owned())?;
    let expected_length = value_count
        .checked_mul(8)
        .and_then(|length| length.checked_add(20))
        .ok_or_else(|| "solver evidence length overflows".to_owned())?;
    if bytes.len() != expected_length {
        return Err("solver evidence length is invalid".to_owned());
    }
    let mut offset = 20;
    let mut mass = vec![vec![0.0; basis_count]; basis_count];
    for row in &mut mass {
        for value in row {
            *value = f64_le(bytes, offset, "mass matrix value")?;
            offset += 8;
        }
    }
    let mut coefficients = vec![vec![0.0; basis_count]; mode_count];
    for mode in &mut coefficients {
        for value in mode {
            *value = f64_le(bytes, offset, "mode coefficient")?;
            offset += 8;
        }
    }
    for row in 0..basis_count {
        for column in 0..basis_count {
            let tolerance =
                1e-11_f64.max(mass[row][column].abs().max(mass[column][row].abs()) * 1e-10);
            if (mass[row][column] - mass[column][row]).abs() > tolerance {
                return Err("solver evidence mass matrix is not symmetric".to_owned());
            }
        }
    }

    let weighted = coefficients
        .iter()
        .map(|mode| {
            mass.iter()
                .map(|row| {
                    row.iter()
                        .zip(mode)
                        .map(|(mass_value, coefficient)| mass_value * coefficient)
                        .sum::<f64>()
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut maximum_diagonal_error = 0.0_f64;
    let mut maximum_off_diagonal = 0.0_f64;
    for (left_index, left) in coefficients.iter().enumerate() {
        for (right_index, right_weighted) in weighted.iter().enumerate() {
            let inner = left
                .iter()
                .zip(right_weighted)
                .map(|(coefficient, weighted_value)| coefficient * weighted_value)
                .sum::<f64>();
            if left_index == right_index {
                maximum_diagonal_error = maximum_diagonal_error.max((inner - 1.0).abs());
            } else {
                maximum_off_diagonal = maximum_off_diagonal.max(inner.abs());
            }
        }
    }
    if maximum_diagonal_error > MODAL_MASS_DIAGONAL_TOLERANCE
        || maximum_off_diagonal > MODAL_MASS_OFF_DIAGONAL_TOLERANCE
    {
        return Err(format!(
            "unit-modal-mass orthogonality failed: diagonal={maximum_diagonal_error}, \
             offDiagonal={maximum_off_diagonal}"
        ));
    }
    Ok((
        SolverEvidence { coefficients },
        maximum_diagonal_error,
        maximum_off_diagonal,
    ))
}

fn validate_field(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() < 24 || checked_slice(bytes, 0, 8)? != b"MHFIELD1" {
        return Err("material field header is invalid".to_owned());
    }
    let version = u32_le(bytes, 8)?;
    let size = usize_from_u32(u32_le(bytes, 12)?, "field resolution")?;
    let minimum = f32_le(bytes, 16, "field minimum")?;
    let maximum = f32_le(bytes, 20, "field maximum")?;
    let expected = size
        .checked_mul(size)
        .and_then(|pixels| pixels.checked_add(24))
        .ok_or_else(|| "field dimensions overflow".to_owned())?;
    if version != 1
        || size < 32
        || bytes.len() != expected
        || minimum >= 0.0
        || maximum <= 0.0
        || (minimum + maximum).abs() > 1e-5
    {
        return Err("material field dimensions or bounds are invalid".to_owned());
    }
    Ok(size)
}

fn validate_material_section_profile(
    field_bytes: &[u8],
    manifest: &Value,
    plate: &Value,
    algorithm: &Algorithm,
) -> Result<(), String> {
    let profile = manifest
        .get("plate")
        .and_then(|value| value.get("materialSectionProfile"))
        .ok_or_else(|| "versioned manifest material section profile is missing".to_owned())?;
    let samples = profile
        .get("thicknessUnorm8")
        .and_then(Value::as_array)
        .ok_or_else(|| "material section thickness samples are missing".to_owned())?;
    let minimum = nested_number(plate, &["thicknessMapping", "minimumThicknessM"])?;
    let maximum = nested_number(plate, &["thicknessMapping", "maximumThicknessM"])?;
    if profile.get("schemaVersion").and_then(Value::as_str)
        != Some("mandelhowl.material-section-profile.v1")
        || profile.get("axis").and_then(Value::as_str)
            != Some(algorithm.material_section_axis.as_str())
        || profile.get("sampleCount").and_then(Value::as_u64)
            != u64::try_from(algorithm.material_section_sample_count).ok()
        || profile.get("minimumThicknessM").and_then(Value::as_f64) != Some(minimum)
        || profile.get("maximumThicknessM").and_then(Value::as_f64) != Some(maximum)
        || samples.len() != algorithm.material_section_sample_count
    {
        return Err("versioned material section profile is incompatible".to_owned());
    }
    let samples = samples
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|sample| u8::try_from(sample).ok())
                .ok_or_else(|| "material section sample is outside UNORM8".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let minimum_sample = samples.iter().copied().min().unwrap_or(0);
    let maximum_sample = samples.iter().copied().max().unwrap_or(0);
    if maximum_sample.saturating_sub(minimum_sample) < 8 {
        return Err("material section profile does not expose thickness variation".to_owned());
    }

    let size = usize_from_u32(u32_le(field_bytes, 12)?, "field resolution")?;
    if size < 2 || field_bytes.len() != 24 + size * size {
        return Err("material field evidence is incompatible".to_owned());
    }
    let pixels = checked_slice(field_bytes, 24, size * size)?;
    let v = 0.5 * (size - 1) as f64;
    let mut maximum_lsb_error = 0_u8;
    for (index, actual) in samples.iter().copied().enumerate() {
        let u = (index as f64 + 0.5) / algorithm.material_section_sample_count as f64
            * (size - 1) as f64;
        let x0 = (u.floor() as usize).min(size - 2);
        let y0 = (v.floor() as usize).min(size - 2);
        let tx = u - x0 as f64;
        let ty = v - y0 as f64;
        let i00 = y0 * size + x0;
        let a = f64::from(pixels[i00]) * (1.0 - tx) + f64::from(pixels[i00 + 1]) * tx;
        let b = f64::from(pixels[i00 + size]) * (1.0 - tx) + f64::from(pixels[i00 + size + 1]) * tx;
        let normalized_field = ((a * (1.0 - ty) + b * ty) / 255.0).clamp(0.0, 1.0);
        let smooth = normalized_field * normalized_field * (3.0 - 2.0 * normalized_field);
        let expected = (smooth * 255.0).round_ties_even() as u8;
        maximum_lsb_error = maximum_lsb_error.max(actual.abs_diff(expected));
    }
    if maximum_lsb_error > 2 {
        return Err(format!(
            "material section profile is not derived from packaged field evidence: \
             maximumLsbError={maximum_lsb_error}"
        ));
    }
    Ok(())
}

fn validate_texture_alignment(
    modes: &[ModeRecord],
    displacement: &Ktx2Array,
    normal: &Ktx2Array,
    nodal: &Ktx2Array,
    sand: &Ktx2Array,
) -> Result<f64, String> {
    for (label, texture, channels) in [
        ("signed-displacement", displacement, 1),
        ("normal", normal, 2),
        ("nodal-mask", nodal, 1),
        ("sand-density", sand, 1),
    ] {
        if texture.width != displacement.width
            || texture.height != displacement.height
            || texture.layers != modes.len()
            || texture.channels != channels
        {
            return Err(format!("{label}: texture/mode dimensions are not aligned"));
        }
    }

    let layer_pixels = displacement.width * displacement.height;
    let mut minimum_contrast = f64::INFINITY;
    for (layer, mode) in modes.iter().enumerate() {
        let start = layer * layer_pixels;
        let end = start + layer_pixels;
        let displacement_layer = &displacement.image_data[start..end];
        let nodal_layer = &nodal.image_data[start..end];
        let sand_layer = &sand.image_data[start..end];
        let mut low_sum = 0_u64;
        let mut low_count = 0_u64;
        let mut high_sum = 0_u64;
        let mut high_count = 0_u64;
        let mut nodal_distance_sum = 0.0;
        let mut nodal_count = 0_u64;
        for index in 0..layer_pixels {
            let absolute = (displacement_layer[index] as f64 / 127.5 - 1.0).abs();
            if nodal_layer[index] >= 250 {
                nodal_distance_sum += absolute;
                nodal_count += 1;
            }
            if absolute <= 0.1 && nodal_layer[index] > 0 {
                low_sum += u64::from(sand_layer[index]);
                low_count += 1;
            } else if absolute >= 0.5 {
                high_sum += u64::from(sand_layer[index]);
                high_count += 1;
            }
        }
        if nodal_count <= 5 || low_count == 0 || high_count == 0 {
            return Err(format!(
                "{} texture layer lacks nodal/sand evidence",
                mode.mode_id
            ));
        }
        let mean_nodal_distance = nodal_distance_sum / nodal_count as f64;
        if mean_nodal_distance >= 0.08 {
            return Err(format!(
                "{} nodal mask is not aligned with displacement",
                mode.mode_id
            ));
        }
        let contrast = low_sum as f64 / low_count as f64 - high_sum as f64 / high_count as f64;
        if contrast <= 0.0 {
            return Err(format!(
                "{} sand density is not concentrated at low velocity",
                mode.mode_id
            ));
        }
        minimum_contrast = minimum_contrast.min(contrast);
    }
    Ok(minimum_contrast)
}

fn nested_value<'a>(value: &'a Value, path: &[&str]) -> Result<&'a Value, String> {
    let mut current = value;
    for component in path {
        current = current
            .get(component)
            .ok_or_else(|| format!("missing scientific contract field {}", path.join(".")))?;
    }
    Ok(current)
}

fn nested_number(value: &Value, path: &[&str]) -> Result<f64, String> {
    nested_value(value, path)?
        .as_f64()
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("scientific contract field {} is not finite", path.join(".")))
}

fn nested_usize(value: &Value, path: &[&str]) -> Result<usize, String> {
    usize::try_from(nested_value(value, path)?.as_u64().ok_or_else(|| {
        format!(
            "scientific contract field {} is not an integer",
            path.join(".")
        )
    })?)
    .map_err(|_| {
        format!(
            "scientific contract field {} overflows usize",
            path.join(".")
        )
    })
}

fn quantize_runtime_scalar(value: f64, quantum: f64) -> f64 {
    let ticks = (value / quantum).round_ties_even();
    if ticks == 0.0 { 0.0 } else { ticks * quantum }
}

#[allow(clippy::too_many_arguments)]
fn validate_modal_coefficient_and_texture_semantics(
    modes: &[ModeRecord],
    evidence: &SolverEvidence,
    algorithm: &Algorithm,
    plate: &Value,
    provenance: &Value,
    displacement: &Ktx2Array,
    nodal: &Ktx2Array,
    sand: &Ktx2Array,
) -> Result<f64, String> {
    let levels = nested_value(plate, &["solverRequest", "meshLevels"])?
        .as_array()
        .ok_or_else(|| "plate finite-strip levels are not an array".to_owned())?;
    let fine = levels
        .last()
        .and_then(|level| level.get("analysisFiniteStrip"))
        .ok_or_else(|| "fine finite-strip analysis request is missing".to_owned())?;
    let radial_elements = nested_usize(fine, &["radialElementCount"])?;
    let maximum_fourier_order = nested_usize(fine, &["maximumFourierOrder"])?;
    let angular_samples = nested_usize(fine, &["angularQuadratureSamples"])?;
    let basis = build_basis(radial_elements, maximum_fourier_order)?;
    if evidence.coefficients.len() != modes.len()
        || evidence
            .coefficients
            .iter()
            .any(|row| row.len() != basis.len())
    {
        return Err("solver evidence does not match the fine finite-strip basis".to_owned());
    }

    let radius = nested_number(plate, &["geometry", "radiusM"])?;
    let hub = nested_number(plate, &["geometry", "hub", "radiusM"])?;
    let actuator_x = nested_number(plate, &["actuator", "positionM", "x"])?;
    let actuator_y = nested_number(plate, &["actuator", "positionM", "y"])?;
    let actuator_radius = nested_number(plate, &["actuator", "footprintRadiusM"])?;
    let actuator_raw = evidence
        .coefficients
        .iter()
        .map(|row| {
            probe_average(
                algorithm,
                row,
                &basis,
                actuator_x,
                actuator_y,
                actuator_radius,
                hub,
                radius,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let actuator_scale = actuator_raw
        .iter()
        .map(|value| value.abs())
        .fold(0.0, f64::max);
    if actuator_scale <= 0.0 {
        return Err("solver evidence actuator scale is zero".to_owned());
    }
    let summaries = provenance
        .get("modes")
        .and_then(Value::as_array)
        .ok_or_else(|| "provenance modal summaries are missing".to_owned())?;
    if summaries.len() != modes.len() {
        return Err("provenance modal summary count is incompatible".to_owned());
    }
    for (index, (((mode, summary), coefficients), raw)) in modes
        .iter()
        .zip(summaries)
        .zip(&evidence.coefficients)
        .zip(&actuator_raw)
        .enumerate()
    {
        let (sign_valid, expected_sign) = if mode.sign_code == 0 {
            (*raw > algorithm.sign_epsilon, "actuator-positive")
        } else {
            let first = first_analysis_node_value(
                algorithm,
                coefficients,
                &basis,
                radial_elements,
                angular_samples,
                hub,
                radius,
            )?;
            (
                raw.abs() <= algorithm.sign_epsilon && first > algorithm.sign_epsilon,
                "first-nonzero-node-positive",
            )
        };
        let expected_coupling =
            quantize_runtime_scalar(raw / actuator_scale, algorithm.runtime_coupling_quantum);
        if !sign_valid
            || summary.get("signReference").and_then(Value::as_str) != Some(expected_sign)
            || mode.actuator_coupling.to_bits() != expected_coupling.to_bits()
        {
            return Err(format!(
                "mode {index} sign/coupling does not match finite-strip coefficients"
            ));
        }
    }

    let width = displacement.width;
    let height = displacement.height;
    let layer_pixels = width
        .checked_mul(height)
        .ok_or_else(|| "texture dimensions overflow".to_owned())?;
    if displacement.layers != modes.len()
        || nodal.layers != modes.len()
        || sand.layers != modes.len()
        || nodal.width != width
        || nodal.height != height
        || sand.width != width
        || sand.height != height
    {
        return Err("scientific texture layers are not mode-aligned".to_owned());
    }
    let step_x = 2.0 * radius / width as f64;
    let step_y = 2.0 * radius / height as f64;
    let sample_stride = (width.min(height) / 16).max(1);
    let nodal_quantization_margin = 1.0 / 127.5;
    let mut minimum_correlation = 1.0_f64;
    for (layer, coefficients) in evidence.coefficients.iter().enumerate() {
        let start = layer * layer_pixels;
        let end = start + layer_pixels;
        let displacement_layer = &displacement.image_data[start..end];
        let nodal_layer = &nodal.image_data[start..end];
        let sand_layer = &sand.image_data[start..end];
        let extreme_index = (0..layer_pixels)
            .max_by(|left, right| {
                let left_value = (displacement_layer[*left] as f64 / 127.5 - 1.0).abs();
                let right_value = (displacement_layer[*right] as f64 / 127.5 - 1.0).abs();
                left_value.total_cmp(&right_value)
            })
            .ok_or_else(|| "texture layer is empty".to_owned())?;
        let mut raw_samples = Vec::new();
        let mut encoded_samples = Vec::new();
        let mut nodal_count = 0_usize;
        for pixel in 0..layer_pixels {
            let y = pixel / width;
            let x = pixel % width;
            let x_m = -radius + (x as f64 + 0.5) * step_x;
            let y_m = -radius + (y as f64 + 0.5) * step_y;
            let radial = x_m.hypot(y_m);
            let encoded = displacement_layer[pixel] as f64 / 127.5 - 1.0;
            let absolute = encoded.abs();
            let nodal_value = nodal_layer[pixel];
            let sand_value = sand_layer[pixel];
            if !(hub < radial && radial <= radius) {
                if displacement_layer[pixel] != 128 || nodal_value != 0 || sand_value != 0 {
                    return Err(format!(
                        "texture layer {layer} leaks outside the plate domain"
                    ));
                }
                continue;
            }
            if nodal_value >= 250 {
                nodal_count += 1;
                if absolute > algorithm.nodal_threshold + nodal_quantization_margin {
                    return Err(format!("texture layer {layer} nodal mask is displaced"));
                }
            } else if absolute < algorithm.nodal_threshold - nodal_quantization_margin {
                return Err(format!(
                    "texture layer {layer} omits a resolved nodal pixel"
                ));
            }
            let expected_sand =
                (255.0 * (-((absolute / algorithm.sand_scale).powi(2))).exp()).round_ties_even();
            if (f64::from(sand_value) - expected_sand).abs() > 10.0 {
                return Err(format!(
                    "texture layer {layer} sand density is not displacement-derived"
                ));
            }
            if (x.is_multiple_of(sample_stride) && y.is_multiple_of(sample_stride))
                || pixel == extreme_index
            {
                raw_samples.push(evaluate_mode(coefficients, &basis, x_m, y_m, hub, radius)?);
                encoded_samples.push(encoded);
            }
        }
        if nodal_count <= 5 {
            return Err(format!(
                "texture layer {layer} lacks resolved nodal evidence"
            ));
        }
        let cross = raw_samples
            .iter()
            .zip(&encoded_samples)
            .map(|(raw, encoded)| raw * encoded)
            .sum::<f64>();
        let raw_norm = raw_samples.iter().map(|value| value * value).sum::<f64>();
        let encoded_norm = encoded_samples
            .iter()
            .map(|value| value * value)
            .sum::<f64>();
        let correlation = cross / (raw_norm * encoded_norm).max(1e-300).sqrt();
        minimum_correlation = minimum_correlation.min(correlation);
        if correlation < 0.995 {
            return Err(format!(
                "texture layer {layer} displacement sign/shape differs from the finite-strip eigenvector"
            ));
        }
    }
    Ok(minimum_correlation)
}

fn read_required(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = root.join(relative);
    fs::read(&path).map_err(|error| format!("unable to read {}: {error}", path.display()))
}

fn read_json(root: &Path, relative: &str) -> Result<Value, String> {
    let source = fs::read_to_string(root.join(relative))
        .map_err(|error| format!("unable to read {relative}: {error}"))?;
    crate::json::from_str(&source).map_err(|error| format!("{relative} JSON is invalid: {error}"))
}

fn json_text<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label}.{key} must be a string"))
}

fn safe_relative_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!("dataset path {relative:?} is unsafe"));
    }
    Ok(root.join(relative))
}

fn validate_asset_descriptor(root: &Path, descriptor: &Value) -> Result<String, String> {
    let relative = json_text(descriptor, "path", "asset")?;
    let expected_length = descriptor
        .get("byteLength")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("asset {relative} byteLength is invalid"))?;
    let expected_sha256 = json_text(descriptor, "sha256", "asset")?;
    if expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("asset {relative} SHA-256 is invalid"));
    }
    let path = safe_relative_path(root, relative)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("unable to read asset {relative}: {error}"))?;
    if bytes.len() as u64 != expected_length || hex(&digest(&bytes)) != expected_sha256 {
        return Err(format!("asset descriptor does not match {relative}"));
    }
    Ok(relative.to_owned())
}

fn append_exact_payload(
    root: &Path,
    relative: &str,
    exact_hasher: &mut Sha256,
    payloads: &mut Vec<PayloadDigest>,
) -> Result<Vec<u8>, String> {
    let path = safe_relative_path(root, relative)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("unable to read {}: {error}", path.display()))?;
    let file_digest = digest(&bytes);
    exact_hasher.update(relative.as_bytes());
    exact_hasher.update(&[0]);
    exact_hasher.update(&(bytes.len() as u64).to_le_bytes());
    exact_hasher.update(&bytes);
    payloads.push(PayloadDigest {
        path: relative.to_owned(),
        byte_length: bytes.len(),
        sha256: hex(&file_digest),
    });
    Ok(bytes)
}

fn decode_manifest_texture_shards(
    root: &Path,
    manifest: &Value,
    modes: &[ModeRecord],
    algorithm: &Algorithm,
    exact_hasher: &mut Sha256,
    payloads: &mut Vec<PayloadDigest>,
) -> Result<(BTreeMap<String, Ktx2Array>, usize), String> {
    let descriptors = manifest
        .get("files")
        .and_then(|value| value.get("textures"))
        .and_then(Value::as_array)
        .ok_or_else(|| "manifest texture descriptors are missing".to_owned())?;
    let versioned = manifest.get("algorithmRevision").is_some();
    let expected_mode_ids = modes
        .iter()
        .map(|mode| mode.mode_id.as_str())
        .collect::<Vec<_>>();
    let mut textures = BTreeMap::new();
    for (kind, channels) in [
        ("signed-displacement", 1_usize),
        ("normal", 2_usize),
        ("nodal-mask", 1_usize),
        ("sand-density", 1_usize),
    ] {
        let kind_descriptors = descriptors
            .iter()
            .filter(|descriptor| descriptor.get("kind").and_then(Value::as_str) == Some(kind))
            .collect::<Vec<_>>();
        if kind_descriptors.is_empty() {
            return Err(format!("manifest texture kind {kind:?} is missing"));
        }
        let mut width = 0_usize;
        let mut height = 0_usize;
        let mut supercompression_scheme = 0_u32;
        let mut cursor = 0_usize;
        let mut image_data = Vec::new();
        for descriptor in kind_descriptors {
            validate_asset_descriptor(root, descriptor)?;
            let relative = json_text(descriptor, "path", "texture")?;
            let descriptor_mode_ids = descriptor
                .get("modeIds")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{relative} modeIds are missing"))?;
            let shard_layers = descriptor_mode_ids.len();
            if shard_layers == 0 || cursor + shard_layers > expected_mode_ids.len() {
                return Err(format!("{relative} texture shard layer range is invalid"));
            }
            let expected_path = format!(
                "textures/{kind}-{cursor:02}-{:02}.ktx2",
                cursor + shard_layers - 1
            );
            if (versioned
                && (shard_layers != algorithm.texture_layers_per_shard
                    || relative != expected_path))
                || descriptor_mode_ids
                    .iter()
                    .enumerate()
                    .any(|(offset, actual)| {
                        actual.as_str() != Some(expected_mode_ids[cursor + offset])
                    })
            {
                return Err(format!("{relative} texture shard order is incompatible"));
            }
            let bytes = append_exact_payload(root, relative, exact_hasher, payloads)?;
            let decoded = validate_ktx2(&bytes, kind)?;
            if decoded.layers != shard_layers
                || decoded.channels != channels
                || descriptor.get("widthPx").and_then(Value::as_u64) != Some(decoded.width as u64)
                || descriptor.get("heightPx").and_then(Value::as_u64) != Some(decoded.height as u64)
                || descriptor.get("layers").and_then(Value::as_u64) != Some(decoded.layers as u64)
                || (versioned
                    && (decoded.supercompression_scheme != 3
                        || descriptor
                            .get("supercompressionScheme")
                            .and_then(Value::as_u64)
                            != Some(3)))
                || (cursor > 0 && (decoded.width != width || decoded.height != height))
            {
                return Err(format!("{relative} texture shard metadata is inconsistent"));
            }
            if cursor == 0 {
                width = decoded.width;
                height = decoded.height;
                supercompression_scheme = decoded.supercompression_scheme;
            }
            image_data.extend_from_slice(&decoded.image_data);
            cursor += shard_layers;
        }
        if cursor != modes.len() {
            return Err(format!("{kind} texture shards do not cover every mode"));
        }
        textures.insert(
            kind.to_owned(),
            Ktx2Array {
                width,
                height,
                layers: cursor,
                channels,
                supercompression_scheme,
                image_data,
            },
        );
    }
    Ok((textures, descriptors.len()))
}

fn inventory_dataset(root: &Path) -> Result<HashSet<String>, String> {
    fn visit(root: &Path, directory: &Path, inventory: &mut HashSet<String>) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("unable to inventory {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| format!("unable to read inventory row: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("unable to inspect inventory row: {error}"))?;
            if file_type.is_dir() {
                visit(root, &entry.path(), inventory)?;
            } else if file_type.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| "inventory path escaped dataset root".to_owned())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !matches!(relative.as_str(), "manifest.json" | "checksums.json") {
                    inventory.insert(relative);
                }
            } else {
                return Err("dataset inventory contains a non-file entry".to_owned());
            }
        }
        Ok(())
    }
    let mut inventory = HashSet::new();
    visit(root, root, &mut inventory)?;
    Ok(inventory)
}

fn validate_mesh_evidence_contract(root: &Path, convergence: &Value) -> Result<(), String> {
    let plate = read_json(root, "plate-spec.json")?;
    let evidence = read_json(root, "mesh/mesh-evidence.json")?;
    let quality = evidence
        .get("qualityPolicy")
        .ok_or_else(|| "mesh quality policy is missing".to_owned())?;
    let requested = plate
        .get("solverRequest")
        .and_then(|value| value.get("meshQuality"))
        .ok_or_else(|| "plate mesh quality request is missing".to_owned())?;
    let levels = evidence
        .get("levels")
        .and_then(Value::as_array)
        .ok_or_else(|| "mesh evidence levels are missing".to_owned())?;
    let requests = plate
        .get("solverRequest")
        .and_then(|value| value.get("meshLevels"))
        .and_then(Value::as_array)
        .ok_or_else(|| "plate mesh levels are missing".to_owned())?;
    for key in [
        "minimumEdgeM",
        "minimumSignedAreaM2",
        "maximumAspectRatio",
        "requiredConnectedComponentCount",
        "maximumInvertedTriangleCount",
    ] {
        if quality.get(key) != requested.get(key) {
            return Err(format!("mesh quality policy differs at {key}"));
        }
    }
    if evidence.get("schemaVersion").and_then(Value::as_str) != Some("mandelhowl.mesh-evidence.v1")
        || levels.len() != requests.len()
        || quality.get("negativeAreaAllowed").and_then(Value::as_bool) != Some(false)
        || quality
            .get("disconnectedComponentsAllowed")
            .and_then(Value::as_bool)
            != Some(false)
        || quality.get("accepted").and_then(Value::as_bool) != Some(true)
        || convergence.get("meshEvidence") != evidence.get("levels")
    {
        return Err("mesh evidence does not bind canonical quality thresholds".to_owned());
    }
    let minimum_edge = requested
        .get("minimumEdgeM")
        .and_then(Value::as_f64)
        .ok_or_else(|| "minimumEdgeM is invalid".to_owned())?;
    let minimum_area = requested
        .get("minimumSignedAreaM2")
        .and_then(Value::as_f64)
        .ok_or_else(|| "minimumSignedAreaM2 is invalid".to_owned())?;
    let maximum_aspect = requested
        .get("maximumAspectRatio")
        .and_then(Value::as_f64)
        .ok_or_else(|| "maximumAspectRatio is invalid".to_owned())?;
    let required_components = requested
        .get("requiredConnectedComponentCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "requiredConnectedComponentCount is invalid".to_owned())?;
    let maximum_inverted = requested
        .get("maximumInvertedTriangleCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "maximumInvertedTriangleCount is invalid".to_owned())?;
    for (index, (level, request)) in levels.iter().zip(requests).enumerate() {
        if level.get("levelName").and_then(Value::as_str)
            != request.get("name").and_then(Value::as_str)
            || level
                .get("minimumEdgeM")
                .and_then(Value::as_f64)
                .is_none_or(|value| value < minimum_edge)
            || level
                .get("minimumSignedAreaM2")
                .and_then(Value::as_f64)
                .is_none_or(|value| value < minimum_area)
            || level
                .get("maximumAspectRatio")
                .and_then(Value::as_f64)
                .is_none_or(|value| value > maximum_aspect)
            || level.get("connectedComponentCount").and_then(Value::as_u64)
                != Some(required_components)
            || level
                .get("invertedTriangleCount")
                .and_then(Value::as_u64)
                .is_none_or(|value| value > maximum_inverted)
        {
            return Err(format!(
                "mesh evidence level {index} failed canonical quality thresholds"
            ));
        }
    }
    Ok(())
}

fn validate_package_integrity(
    root: &Path,
    modes: &[ModeRecord],
    response: &[ResponseSample],
    textures: &[(&str, &Ktx2Array)],
) -> Result<(), String> {
    let mut manifest = read_json(root, "manifest.json")?;
    if json_text(&manifest, "schemaVersion", "manifest")? != "mandelhowl.resonance-manifest.v1" {
        return Err("manifest schema version is incompatible".to_owned());
    }
    let algorithm = Algorithm::load()?;
    let manifest_revision = manifest.get("algorithmRevision").and_then(Value::as_str);
    if manifest_revision.is_some_and(|revision| revision != algorithm.revision) {
        return Err("manifest algorithm revision is incompatible".to_owned());
    }
    let versioned = manifest_revision.is_some();
    if versioned {
        let algorithm_bytes = read_required(root, "science/baker-algorithm.v1.json")?;
        if hex(&digest(&algorithm_bytes)) != algorithm.contract_sha256 {
            return Err("packaged algorithm contract differs from the active revision".to_owned());
        }
        let packaged_algorithm = crate::json::from_str(
            std::str::from_utf8(&algorithm_bytes)
                .map_err(|error| format!("algorithm evidence is not UTF-8: {error}"))?,
        )
        .map_err(|error| format!("algorithm evidence is invalid JSON: {error}"))?;
        if packaged_algorithm
            .get("algorithmRevision")
            .and_then(Value::as_str)
            != Some(algorithm.revision.as_str())
        {
            return Err("packaged algorithm revision is inconsistent".to_owned());
        }
        let provenance = read_json(root, "provenance.json")?;
        let generator = provenance
            .get("generator")
            .ok_or_else(|| "versioned provenance generator is missing".to_owned())?;
        let solver_options = provenance
            .get("solver")
            .and_then(|value| value.get("options"))
            .ok_or_else(|| "versioned provenance solver options are missing".to_owned())?;
        if generator.get("algorithmRevision").and_then(Value::as_str)
            != Some(algorithm.revision.as_str())
            || generator
                .get("algorithmContractSha256")
                .and_then(Value::as_str)
                != Some(algorithm.contract_sha256.as_str())
            || solver_options
                .get("algorithmRevision")
                .and_then(Value::as_str)
                != Some(algorithm.revision.as_str())
            || solver_options
                .get("algorithmContractSha256")
                .and_then(Value::as_str)
                != Some(algorithm.contract_sha256.as_str())
        {
            return Err("versioned provenance does not bind the algorithm contract".to_owned());
        }
        let solver = provenance
            .get("solver")
            .ok_or_else(|| "versioned solver provenance is missing".to_owned())?;
        let manifest_solver = manifest
            .get("solverProvenance")
            .ok_or_else(|| "manifest solver provenance is missing".to_owned())?;
        let execution_kind = solver
            .get("executionKind")
            .and_then(Value::as_str)
            .ok_or_else(|| "solver execution kind is missing".to_owned())?;
        if solver.get("name") != manifest_solver.get("solverName")
            || solver.get("version") != manifest_solver.get("solverVersion")
            || solver.get("executionKind") != manifest_solver.get("executionKind")
            || solver.get("containerImageDigest") != manifest_solver.get("containerImageDigest")
            || solver.get("optionsSha256") != manifest_solver.get("optionsSha256")
        {
            return Err("manifest and detailed solver provenance differ".to_owned());
        }
        match execution_kind {
            "native-process" => {
                if solver.get("containerized").and_then(Value::as_bool) != Some(false)
                    || !matches!(solver.get("containerImageDigest"), Some(Value::Null))
                    || solver
                        .get("containerRunnerAttestation")
                        .and_then(Value::as_str)
                        != Some("not-applicable-native-process")
                {
                    return Err("native execution provenance claims a container image".to_owned());
                }
            }
            "oci-container" => {
                let digest = solver
                    .get("containerImageDigest")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let digest_valid = digest.len() == 71
                    && digest.starts_with("sha256:")
                    && digest[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
                if solver.get("containerized").and_then(Value::as_bool) != Some(true)
                    || !digest_valid
                    || !matches!(
                        solver
                            .get("containerRunnerAttestation")
                            .and_then(Value::as_str),
                        Some("trusted-runner-attested" | "environment-declared-development-only")
                    )
                {
                    return Err("container execution provenance is incomplete".to_owned());
                }
            }
            _ => return Err("solver execution provenance kind is unsupported".to_owned()),
        }
        let derived = provenance
            .get("derivedRuntimeFields")
            .ok_or_else(|| "derived runtime field provenance is missing".to_owned())?;
        let surface = derived
            .get("surfaceKinematics")
            .ok_or_else(|| "surface kinematics provenance is missing".to_owned())?;
        let emissive = derived
            .get("emissiveTexture")
            .ok_or_else(|| "emissive derivation provenance is missing".to_owned())?;
        if surface.get("basisTextureKind").and_then(Value::as_str) != Some("signed-displacement")
            || surface.get("velocityFormula").and_then(Value::as_str)
                != Some("v(x,t)=sum_i(qDot_i(t)*D_i(x))")
            || surface.get("accelerationFormula").and_then(Value::as_str)
                != Some("a(x,t)=sum_i(qDoubleDot_i(t)*D_i(x))")
            || emissive.get("basisTextureKind").and_then(Value::as_str) != Some("nodal-mask")
            || emissive.get("basisAliasPolicy").and_then(Value::as_str)
                != Some("byte-identical-basis-reuse")
            || emissive
                .get("fullScreenFlashAllowed")
                .and_then(Value::as_bool)
                != Some(false)
        {
            return Err("derived runtime field provenance is incompatible".to_owned());
        }
        let convergence = read_json(root, "convergence-report.json")?;
        validate_mesh_evidence_contract(root, &convergence)?;
        let method = convergence
            .get("methodConformance")
            .ok_or_else(|| "versioned method conformance evidence is missing".to_owned())?;
        if convergence.get("accepted").and_then(Value::as_bool) != Some(true)
            || convergence
                .get("finiteElementMeshConvergenceAccepted")
                .and_then(Value::as_bool)
                != Some(true)
            || convergence
                .get("surfaceMeshQualityAccepted")
                .and_then(Value::as_bool)
                != Some(true)
            || convergence
                .get("independentCrossValidation")
                .and_then(|value| value.get("accepted"))
                .and_then(Value::as_bool)
                != Some(true)
            || method
                .get("thinPlateEigenanalysisSupported")
                .and_then(Value::as_bool)
                != Some(true)
            || method
                .get("surfaceMeshQualityValidated")
                .and_then(Value::as_bool)
                != Some(true)
            || method
                .get("finiteElementAssemblyUsed")
                .and_then(Value::as_bool)
                != Some(true)
            || method
                .get("analysisSurfaceElementMeshCoupledToEigenproblem")
                .and_then(Value::as_bool)
                != Some(true)
            || method
                .get("surfaceTriangleArchiveCoupledToEigenproblem")
                .and_then(Value::as_bool)
                != Some(false)
            || method
                .get("strictLiteralSection10_3Conformance")
                .and_then(Value::as_bool)
                != Some(true)
            || method.get("deviationCode").is_some()
            || method.get("operationalDisposition").and_then(Value::as_str)
                != Some("strict-thin-plate-finite-element-adapter")
        {
            return Err(
                "versioned solver evidence does not prove strict Section 10.3/B1 finite-strip finite-element conformance"
                    .to_owned(),
            );
        }
        let generation = read_json(root, "generation-report.json")?;
        let deviations = generation
            .get("knownContractDeviations")
            .and_then(Value::as_array)
            .ok_or_else(|| "generation report method deviations are missing".to_owned())?;
        if generation
            .get("handoffFullConformance")
            .and_then(Value::as_bool)
            != Some(true)
            || generation
                .get("handoffOperationalDisposition")
                .and_then(Value::as_str)
                != Some("strict-thin-plate-finite-element-adapter")
            || !deviations.is_empty()
        {
            return Err(
                "generation report does not prove strict Section 10.3/B1 finite-element conformance"
                    .to_owned(),
            );
        }
        let on_grid = |value: f64, quantum: f64| {
            let ticks = (value / quantum).round_ties_even();
            let quantized = if ticks == 0.0 { 0.0 } else { ticks * quantum };
            value.to_bits() == quantized.to_bits()
        };
        for mode in modes {
            if !on_grid(
                mode.natural_frequency_hz,
                algorithm.runtime_frequency_quantum_hz,
            ) || mode.angular_frequency_rad_per_s.to_bits()
                != (mode.natural_frequency_hz * std::f64::consts::TAU).to_bits()
                || !on_grid(mode.actuator_coupling, algorithm.runtime_coupling_quantum)
                || !on_grid(mode.microphone_coupling, algorithm.runtime_coupling_quantum)
                || !on_grid(
                    mode.radiation_efficiency,
                    algorithm.runtime_coupling_quantum,
                )
            {
                return Err(format!(
                    "{} is outside the versioned runtime modal output grid",
                    mode.mode_id
                ));
            }
        }
    }
    let ownership = manifest
        .get("ownership")
        .ok_or_else(|| "manifest ownership is missing".to_owned())?;
    if json_text(ownership, "kind", "manifest.ownership")? != "generated"
        || !matches!(
            json_text(ownership, "generator", "manifest.ownership")?,
            "tools/physics-baker" | "tools/physics-baker-rs"
        )
        || json_text(ownership, "policy", "manifest.ownership")? != "immutable-regenerate"
    {
        return Err("manifest ownership is incompatible".to_owned());
    }

    let dataset_id = json_text(&manifest, "datasetId", "manifest")?.to_owned();
    let content_addressing = manifest
        .get("contentAddressing")
        .ok_or_else(|| "manifest contentAddressing is missing".to_owned())?;
    let directory_name = json_text(
        content_addressing,
        "directoryName",
        "manifest.contentAddressing",
    )?
    .to_owned();
    if directory_name.len() != 64
        || dataset_id != format!("sha256:{directory_name}")
        || root.file_name().and_then(|name| name.to_str()) != Some(directory_name.as_str())
    {
        return Err("content-addressed directory name is inconsistent".to_owned());
    }
    let identity_digest = {
        let object = manifest
            .as_object_mut()
            .ok_or_else(|| "manifest must be an object".to_owned())?;
        object.remove("datasetId");
        object
            .get_mut("contentAddressing")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "manifest contentAddressing is invalid".to_owned())?
            .remove("directoryName");
        hex(&digest(&crate::json::to_vec(&manifest)?))
    };
    if identity_digest != directory_name {
        return Err("manifest datasetId does not match canonical identity".to_owned());
    }

    let manifest = read_json(root, "manifest.json")?;
    let files = manifest
        .get("files")
        .and_then(Value::as_object)
        .ok_or_else(|| "manifest files inventory is invalid".to_owned())?;
    for key in [
        "plateSpec",
        "modes",
        "response",
        "provenance",
        "convergenceReport",
        "coverageReport",
        "checksums",
    ] {
        validate_asset_descriptor(
            root,
            files
                .get(key)
                .ok_or_else(|| format!("manifest files.{key} is missing"))?,
        )?;
    }
    let texture_descriptors = files
        .get("textures")
        .and_then(Value::as_array)
        .ok_or_else(|| "manifest texture descriptors are missing".to_owned())?;
    let mode_ids = modes
        .iter()
        .map(|mode| mode.mode_id.as_str())
        .collect::<Vec<_>>();
    let mut descriptor_count = 0_usize;
    for (kind, texture) in textures {
        let kind_descriptors = texture_descriptors
            .iter()
            .filter(|descriptor| descriptor.get("kind").and_then(Value::as_str) == Some(*kind))
            .collect::<Vec<_>>();
        if kind_descriptors.is_empty() {
            return Err(format!("manifest texture kind {kind:?} is missing"));
        }
        let mut cursor = 0_usize;
        for descriptor in kind_descriptors {
            descriptor_count += 1;
            validate_asset_descriptor(root, descriptor)?;
            let descriptor_mode_ids = descriptor
                .get("modeIds")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{kind} modeIds are missing"))?;
            let shard_layers = descriptor_mode_ids.len();
            if shard_layers == 0 || cursor + shard_layers > mode_ids.len() {
                return Err(format!("{kind} manifest shard range is invalid"));
            }
            if descriptor.get("widthPx").and_then(Value::as_u64) != Some(texture.width as u64)
                || descriptor.get("heightPx").and_then(Value::as_u64) != Some(texture.height as u64)
                || descriptor.get("layers").and_then(Value::as_u64) != Some(shard_layers as u64)
                || (versioned
                    && descriptor
                        .get("supercompressionScheme")
                        .and_then(Value::as_u64)
                        != Some(u64::from(texture.supercompression_scheme)))
                || (versioned && texture.supercompression_scheme != 3)
                || (versioned && shard_layers != algorithm.texture_layers_per_shard)
                || descriptor_mode_ids
                    .iter()
                    .enumerate()
                    .any(|(offset, actual)| actual.as_str() != Some(mode_ids[cursor + offset]))
            {
                return Err(format!("{kind} manifest metadata is inconsistent"));
            }
            cursor += shard_layers;
        }
        if cursor != mode_ids.len() {
            return Err(format!("{kind} manifest shards do not cover every mode"));
        }
    }
    if descriptor_count != texture_descriptors.len() || textures.len() != 4 {
        return Err("manifest texture descriptor count is invalid".to_owned());
    }
    if manifest.get("modeCount").and_then(Value::as_u64) != Some(modes.len() as u64) {
        return Err("manifest mode count is inconsistent".to_owned());
    }
    if versioned {
        let generation = read_json(root, "generation-report.json")?;
        let coverage = read_json(root, "coverage-report.json")?;
        let runtime_replay = coverage.get("verificationStatus").and_then(Value::as_str)
            == Some("runtime-replay-verified");
        if generation.get("releaseBake").and_then(Value::as_bool) == Some(true) || runtime_replay {
            let modes_sha = manifest
                .get("files")
                .and_then(|value| value.get("modes"))
                .and_then(|value| value.get("sha256"))
                .and_then(Value::as_str)
                .ok_or_else(|| "manifest modes digest is missing".to_owned())?;
            crate::packaging::validate_external_coverage(
                &coverage,
                true,
                &format!("sha256:{modes_sha}"),
            )?;
        } else if generation.get("releaseBake").and_then(Value::as_bool) != Some(false)
            || generation.get("coverageSource").and_then(Value::as_str)
                != Some("baker-physical-search-foundation")
            || coverage.get("verificationStatus").and_then(Value::as_str)
                != Some("physics-foundation-only")
            || coverage.get("releaseEligible").and_then(Value::as_bool) != Some(false)
        {
            return Err("development coverage foundation is inconsistent".to_owned());
        }
    }
    let frequency_range = manifest
        .get("frequencyRange")
        .ok_or_else(|| "manifest frequencyRange is missing".to_owned())?;
    let minimum = frequency_range
        .get("minimumHz")
        .and_then(Value::as_f64)
        .ok_or_else(|| "manifest minimum frequency is invalid".to_owned())?;
    let maximum = frequency_range
        .get("maximumHz")
        .and_then(Value::as_f64)
        .ok_or_else(|| "manifest maximum frequency is invalid".to_owned())?;
    if modes
        .first()
        .is_none_or(|mode| mode.natural_frequency_hz < minimum)
        || modes
            .last()
            .is_none_or(|mode| mode.natural_frequency_hz > maximum)
        || response
            .first()
            .is_none_or(|sample| (sample.frequency_hz - minimum).abs() > 1e-9)
        || response
            .last()
            .is_none_or(|sample| (sample.frequency_hz - maximum).abs() > 1e-9)
    {
        return Err("manifest frequency range is inconsistent".to_owned());
    }

    let checksums = read_json(root, "checksums.json")?;
    if json_text(&checksums, "schemaVersion", "checksums")? != "mandelhowl.checksums.v1"
        || json_text(&checksums, "algorithm", "checksums")? != "sha256"
    {
        return Err("checksums contract is incompatible".to_owned());
    }
    let rows = checksums
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| "checksums files array is missing".to_owned())?;
    let mut checksum_paths = HashSet::with_capacity(rows.len());
    for row in rows {
        let relative = json_text(row, "path", "checksums row")?;
        if matches!(relative, "manifest.json" | "checksums.json")
            || !checksum_paths.insert(relative.to_owned())
        {
            return Err("checksums contains a duplicate or circular path".to_owned());
        }
        validate_asset_descriptor(root, row)?;
    }
    if checksum_paths != inventory_dataset(root)? {
        return Err("checksums inventory is not a complete bidirectional match".to_owned());
    }
    Ok(())
}

pub fn validate_dataset_semantics(root: &Path) -> Result<DatasetSemanticReport, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("unable to resolve dataset directory: {error}"))?;
    if !root.is_dir() {
        return Err("dataset root is not a directory".to_owned());
    }
    let manifest_bytes = read_required(&root, "manifest.json")?;
    let manifest = crate::json::from_str(
        std::str::from_utf8(&manifest_bytes)
            .map_err(|error| format!("manifest.json is not UTF-8: {error}"))?,
    )
    .map_err(|error| format!("manifest.json is invalid JSON: {error}"))?;
    let requested = [
        "field/mandelbrot-field.bin",
        "modes.bin",
        "response.bin",
        "science/solver-evidence.bin",
    ];
    let mut payload_bytes = Vec::with_capacity(requested.len());
    let mut payloads = Vec::new();
    let mut exact_hasher = Sha256::new();
    exact_hasher.update(b"mandelhowl.exact-scientific-payload.v1\0");
    for relative in requested {
        let bytes = append_exact_payload(&root, relative, &mut exact_hasher, &mut payloads)?;
        payload_bytes.push(bytes);
    }

    let field_resolution = validate_field(&payload_bytes[0])?;
    let modes = decode_modes_v1(&payload_bytes[1])?;
    let response = decode_response_v1(&payload_bytes[2])?;
    let algorithm = Algorithm::load()?;
    let (normalization, maximum_response_error) =
        validate_response_against_modes(&modes, &response, algorithm.normalization_floor)?;
    let (solver_evidence, diagonal_error, off_diagonal) =
        validate_solver_evidence(&payload_bytes[3], modes.len())?;
    let (textures, texture_descriptor_count) = decode_manifest_texture_shards(
        &root,
        &manifest,
        &modes,
        &algorithm,
        &mut exact_hasher,
        &mut payloads,
    )?;
    let displacement = textures
        .get("signed-displacement")
        .ok_or_else(|| "signed-displacement texture is missing".to_owned())?;
    let normal = textures
        .get("normal")
        .ok_or_else(|| "normal texture is missing".to_owned())?;
    let nodal = textures
        .get("nodal-mask")
        .ok_or_else(|| "nodal-mask texture is missing".to_owned())?;
    let sand = textures
        .get("sand-density")
        .ok_or_else(|| "sand-density texture is missing".to_owned())?;
    let sand_contrast = validate_texture_alignment(&modes, displacement, normal, nodal, sand)?;
    validate_package_integrity(
        &root,
        &modes,
        &response,
        &[
            ("signed-displacement", displacement),
            ("normal", normal),
            ("nodal-mask", nodal),
            ("sand-density", sand),
        ],
    )?;
    let plate = read_json(&root, "plate-spec.json")?;
    let provenance = read_json(&root, "provenance.json")?;
    if manifest.get("algorithmRevision").is_some() {
        validate_material_section_profile(&payload_bytes[0], &manifest, &plate, &algorithm)?;
    }
    let minimum_eigenvector_texture_correlation = validate_modal_coefficient_and_texture_semantics(
        &modes,
        &solver_evidence,
        &algorithm,
        &plate,
        &provenance,
        displacement,
        nodal,
        sand,
    )?;
    let dataset_id = manifest
        .get("datasetId")
        .and_then(Value::as_str)
        .ok_or_else(|| "manifest datasetId is missing".to_owned())?
        .to_owned();
    let manifest_sha256 = hex(&digest(&manifest_bytes));

    let first_mode = modes.first().expect("mode decoder rejects empty input");
    let last_mode = modes.last().expect("mode decoder rejects empty input");
    let first_response = response
        .first()
        .expect("response decoder rejects fewer than two samples");
    let last_response = response
        .last()
        .expect("response decoder rejects fewer than two samples");
    Ok(DatasetSemanticReport {
        dataset_root: root,
        algorithm_revision: algorithm.revision,
        algorithm_contract_sha256: algorithm.contract_sha256,
        dataset_id,
        manifest_sha256,
        mode_count: modes.len(),
        response_sample_count: response.len(),
        texture_count: texture_descriptor_count,
        first_mode_id: first_mode.mode_id.clone(),
        last_mode_id: last_mode.mode_id.clone(),
        minimum_mode_frequency_hz: first_mode.natural_frequency_hz,
        maximum_mode_frequency_hz: last_mode.natural_frequency_hz,
        minimum_response_frequency_hz: first_response.frequency_hz,
        maximum_response_frequency_hz: last_response.frequency_hz,
        response_normalization_divisor: normalization,
        maximum_response_component_error: maximum_response_error,
        maximum_modal_mass_diagonal_error: diagonal_error,
        maximum_modal_mass_off_diagonal: off_diagonal,
        minimum_eigenvector_texture_correlation,
        minimum_sand_low_minus_high_mean: sand_contrast,
        field_resolution,
        texture_width: displacement.width,
        texture_height: displacement.height,
        exact_scientific_payload_sha256: hex(&exact_hasher.finalize()),
        payloads,
    })
}

pub fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if value.is_control() => {
                output.push_str(&format!("\\u{:04x}", value as u32));
            }
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

fn json_number(value: f64) -> String {
    debug_assert!(value.is_finite());
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_string_escapes_protocol_control_characters() {
        assert_eq!(json_string("a\n\"b\\"), "\"a\\n\\\"b\\\\\"");
    }

    #[test]
    fn response_recomputation_rejects_tampering() {
        let mode = ModeRecord {
            mode_id: "mode-001".to_owned(),
            ordinal: 1,
            texture_layer: 0,
            natural_frequency_hz: 220.0,
            angular_frequency_rad_per_s: 220.0 * std::f64::consts::TAU,
            damping_ratio: 0.01,
            actuator_coupling: 1.0,
            microphone_coupling: 0.5,
            radiation_efficiency: 0.75,
            phase_reference_rad: 0.0,
            sign_code: 0,
        };
        let response = [
            ResponseSample {
                frequency_hz: 100.0,
                real: 1.0,
                imaginary: 0.0,
            },
            ResponseSample {
                frequency_hz: 200.0,
                real: 0.0,
                imaginary: 0.0,
            },
        ];
        assert!(validate_response_against_modes(&[mode], &response, 1e-30).is_err());
    }
}
