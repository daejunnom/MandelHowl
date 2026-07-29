//! Independent semantic validation for a packaged MandelHowl dataset.
//!
//! This module deliberately does not call the Python baker and does not share
//! its decoders. It validates the runtime payload and solver evidence directly
//! from the documented binary contracts.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::algorithm::Algorithm;
use crate::json::Value;
use crate::sha256::{Sha256, digest, hex};
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
    pub path: &'static str,
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
                    json_string(payload.path),
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
                "\"sand-displacement-semantic-alignment\",",
                "\"solver-evidence-unit-modal-mass\",",
                "\"material-field-v1\",",
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
    image_data: Vec<u8>,
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
        || supercompression != 0
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
    if level_length != expected
        || uncompressed != expected
        || level_offset % alignment != 0
        || level_offset.saturating_add(level_length) != bytes.len()
    {
        return Err(format!("{label}: KTX2 level range is inconsistent"));
    }
    let dfd_channels = (dfd_length - 28) / 16;
    if dfd_channels != channels || bytes[dfd_offset + 20] as usize != channels {
        return Err(format!("{label}: DFD channel layout mismatch"));
    }
    Ok(Ktx2Array {
        width,
        height,
        layers,
        channels,
        image_data: checked_slice(bytes, level_offset, level_length)?.to_vec(),
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
fn validate_solver_evidence(bytes: &[u8], expected_modes: usize) -> Result<(f64, f64), String> {
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
    Ok((maximum_diagonal_error, maximum_off_diagonal))
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

fn read_required(root: &Path, relative: &'static str) -> Result<Vec<u8>, String> {
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
    if manifest
        .get("algorithmRevision")
        .and_then(Value::as_str)
        .is_some_and(|revision| revision != algorithm.revision)
    {
        return Err("manifest algorithm revision is incompatible".to_owned());
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
    if texture_descriptors.len() != textures.len() {
        return Err("manifest texture descriptor count is invalid".to_owned());
    }
    let mode_ids = modes
        .iter()
        .map(|mode| mode.mode_id.as_str())
        .collect::<Vec<_>>();
    for descriptor in texture_descriptors {
        validate_asset_descriptor(root, descriptor)?;
        let kind = json_text(descriptor, "kind", "texture")?;
        let (_, texture) = textures
            .iter()
            .find(|(candidate, _)| *candidate == kind)
            .ok_or_else(|| format!("manifest texture kind {kind:?} is unsupported"))?;
        let descriptor_mode_ids = descriptor
            .get("modeIds")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{kind} modeIds are missing"))?;
        if descriptor.get("widthPx").and_then(Value::as_u64) != Some(texture.width as u64)
            || descriptor.get("heightPx").and_then(Value::as_u64) != Some(texture.height as u64)
            || descriptor.get("layers").and_then(Value::as_u64) != Some(texture.layers as u64)
            || descriptor_mode_ids.len() != mode_ids.len()
            || descriptor_mode_ids
                .iter()
                .zip(&mode_ids)
                .any(|(actual, expected)| actual.as_str() != Some(expected))
        {
            return Err(format!("{kind} manifest metadata is inconsistent"));
        }
    }
    if manifest.get("modeCount").and_then(Value::as_u64) != Some(modes.len() as u64) {
        return Err("manifest mode count is inconsistent".to_owned());
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
    let requested = [
        "field/mandelbrot-field.bin",
        "modes.bin",
        "response.bin",
        "science/solver-evidence.bin",
        "textures/signed-displacement.ktx2",
        "textures/normal.ktx2",
        "textures/nodal-mask.ktx2",
        "textures/sand-density.ktx2",
    ];
    let mut payload_bytes = Vec::with_capacity(requested.len());
    let mut payloads = Vec::with_capacity(requested.len());
    let mut exact_hasher = Sha256::new();
    exact_hasher.update(b"mandelhowl.exact-scientific-payload.v1\0");
    for relative in requested {
        let bytes = read_required(&root, relative)?;
        let file_digest = digest(&bytes);
        exact_hasher.update(relative.as_bytes());
        exact_hasher.update(&[0]);
        exact_hasher.update(&(bytes.len() as u64).to_le_bytes());
        exact_hasher.update(&bytes);
        payloads.push(PayloadDigest {
            path: relative,
            byte_length: bytes.len(),
            sha256: hex(&file_digest),
        });
        payload_bytes.push(bytes);
    }

    let field_resolution = validate_field(&payload_bytes[0])?;
    let modes = decode_modes_v1(&payload_bytes[1])?;
    let response = decode_response_v1(&payload_bytes[2])?;
    let algorithm = Algorithm::load()?;
    let (normalization, maximum_response_error) =
        validate_response_against_modes(&modes, &response, algorithm.normalization_floor)?;
    let (diagonal_error, off_diagonal) = validate_solver_evidence(&payload_bytes[3], modes.len())?;
    let displacement = validate_ktx2(&payload_bytes[4], "signed-displacement")?;
    let normal = validate_ktx2(&payload_bytes[5], "normal")?;
    let nodal = validate_ktx2(&payload_bytes[6], "nodal-mask")?;
    let sand = validate_ktx2(&payload_bytes[7], "sand-density")?;
    let sand_contrast = validate_texture_alignment(&modes, &displacement, &normal, &nodal, &sand)?;
    validate_package_integrity(
        &root,
        &modes,
        &response,
        &[
            ("signed-displacement", &displacement),
            ("normal", &normal),
            ("nodal-mask", &nodal),
            ("sand-density", &sand),
        ],
    )?;
    let manifest_bytes = read_required(&root, "manifest.json")?;
    let manifest = crate::json::from_str(
        std::str::from_utf8(&manifest_bytes)
            .map_err(|error| format!("manifest.json is not UTF-8: {error}"))?,
    )
    .map_err(|error| format!("manifest.json is invalid JSON: {error}"))?;
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
        texture_count: 4,
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
