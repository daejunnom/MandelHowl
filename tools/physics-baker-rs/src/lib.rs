use std::collections::HashSet;

pub mod algorithm;
pub mod dataset;
pub mod field;
pub mod generator;
pub mod json;
pub mod ktx2;
pub mod linear_algebra;
pub mod mesh;
pub mod packaging;
pub mod postprocess;
pub mod sha256;
pub mod solver;
pub mod spec;
pub mod yaml;

pub const MODES_MAGIC: &[u8; 8] = b"MHMODES1";
pub const RESPONSE_MAGIC: &[u8; 8] = b"MHRESPN1";
pub const BINARY_VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 16;
pub const MODE_RECORD_BYTES: usize = 96;
pub const MODE_ID_BYTES: usize = 24;
pub const RESPONSE_RECORD_BYTES: usize = 24;

#[derive(Debug, Clone, PartialEq)]
pub struct ModesSummary {
    pub count: usize,
    pub first_mode_id: String,
    pub last_mode_id: String,
    pub minimum_frequency_hz: f64,
    pub maximum_frequency_hz: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResponseSummary {
    pub sample_count: usize,
    pub minimum_frequency_hz: f64,
    pub maximum_frequency_hz: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModeRecord {
    pub mode_id: String,
    pub ordinal: usize,
    pub texture_layer: usize,
    pub natural_frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub damping_ratio: f64,
    pub actuator_coupling: f64,
    pub microphone_coupling: f64,
    pub radiation_efficiency: f64,
    pub phase_reference_rad: f64,
    pub sign_code: u8,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResponseSample {
    pub frequency_hz: f64,
    pub real: f64,
    pub imaginary: f64,
}

fn checked_slice(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8], String> {
    bytes
        .get(offset..offset.saturating_add(length))
        .ok_or_else(|| format!("binary field at {offset} is truncated"))
}

fn u16_le(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let field: [u8; 2] = checked_slice(bytes, offset, 2)?
        .try_into()
        .map_err(|_| "invalid u16 field".to_owned())?;
    Ok(u16::from_le_bytes(field))
}

fn u32_le(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let field: [u8; 4] = checked_slice(bytes, offset, 4)?
        .try_into()
        .map_err(|_| "invalid u32 field".to_owned())?;
    Ok(u32::from_le_bytes(field))
}

fn f64_le(bytes: &[u8], offset: usize, label: &str) -> Result<f64, String> {
    let field: [u8; 8] = checked_slice(bytes, offset, 8)?
        .try_into()
        .map_err(|_| format!("{label} is truncated"))?;
    let value = f64::from_le_bytes(field);
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{label} must be finite"))
    }
}

fn assert_header(bytes: &[u8], magic: &[u8; 8]) -> Result<usize, String> {
    if bytes.len() < HEADER_BYTES {
        return Err("binary header is truncated".to_owned());
    }
    if checked_slice(bytes, 0, 8)? != magic {
        return Err("binary magic is unsupported".to_owned());
    }
    if u16_le(bytes, 8)? != BINARY_VERSION {
        return Err("binary version is unsupported".to_owned());
    }
    if usize::from(u16_le(bytes, 10)?) != HEADER_BYTES {
        return Err("binary header length is invalid".to_owned());
    }
    usize::try_from(u32_le(bytes, 12)?).map_err(|_| "record count overflows usize".to_owned())
}

fn fixed_string(bytes: &[u8]) -> Result<String, String> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    let value = std::str::from_utf8(&bytes[..end])
        .map_err(|_| "mode id is not valid UTF-8".to_owned())?
        .trim();
    if value.is_empty() {
        Err("mode id must not be empty".to_owned())
    } else {
        Ok(value.to_owned())
    }
}

pub fn decode_modes_v1(bytes: &[u8]) -> Result<Vec<ModeRecord>, String> {
    let count = assert_header(bytes, MODES_MAGIC)?;
    let payload_bytes = count
        .checked_mul(MODE_RECORD_BYTES)
        .and_then(|value| value.checked_add(HEADER_BYTES))
        .ok_or_else(|| "modes byte length overflows usize".to_owned())?;
    if bytes.len() != payload_bytes {
        return Err(format!(
            "modes length {} does not match {payload_bytes}",
            bytes.len()
        ));
    }
    if count == 0 {
        return Err("modes binary must contain at least one record".to_owned());
    }

    let mut ids = HashSet::with_capacity(count);
    let mut previous_frequency = 0.0;
    let mut records = Vec::with_capacity(count);
    for index in 0..count {
        let base = HEADER_BYTES + index * MODE_RECORD_BYTES;
        let mode_id = fixed_string(checked_slice(bytes, base, MODE_ID_BYTES)?)?;
        let ordinal = usize::try_from(u32_le(bytes, base + 24)?)
            .map_err(|_| "mode ordinal overflows usize".to_owned())?;
        let texture_layer = usize::try_from(u32_le(bytes, base + 28)?)
            .map_err(|_| "texture layer overflows usize".to_owned())?;
        let natural_frequency = f64_le(bytes, base + 32, "natural frequency")?;
        let angular_frequency = f64_le(bytes, base + 40, "angular frequency")?;
        let damping_ratio = f64_le(bytes, base + 48, "damping ratio")?;
        let actuator_coupling = f64_le(bytes, base + 56, "actuator coupling")?;
        let microphone_coupling = f64_le(bytes, base + 64, "microphone coupling")?;
        let radiation_efficiency = f64_le(bytes, base + 72, "radiation efficiency")?;
        let phase_reference_rad = f64_le(bytes, base + 80, "phase reference")?;
        let sign_code = *checked_slice(bytes, base + 88, 1)?
            .first()
            .ok_or_else(|| "mode sign is truncated".to_owned())?;
        let expected_mode_id = format!("mode-{:03}", index + 1);
        if !ids.insert(mode_id.clone())
            || natural_frequency <= previous_frequency
            || natural_frequency <= 0.0
            || !(0.0..=0.2).contains(&damping_ratio)
            || damping_ratio == 0.0
            || !(-1.0..=1.0).contains(&actuator_coupling)
            || !(-1.0..=1.0).contains(&microphone_coupling)
            || !(0.0..=1.0).contains(&radiation_efficiency)
            || sign_code > 1
            || ordinal != index + 1
            || texture_layer != index
            || mode_id != expected_mode_id
        {
            return Err(format!("mode record {mode_id} violates ordering or bounds"));
        }
        if checked_slice(bytes, base + 89, 7)?
            .iter()
            .any(|byte| *byte != 0)
        {
            return Err(format!("{mode_id} reserved bytes must be zero"));
        }
        let expected_angular = natural_frequency * std::f64::consts::TAU;
        if (angular_frequency - expected_angular).abs() > (expected_angular * 1e-8).max(1e-8) {
            return Err(format!("{mode_id} angular frequency is inconsistent"));
        }
        records.push(ModeRecord {
            mode_id,
            ordinal,
            texture_layer,
            natural_frequency_hz: natural_frequency,
            angular_frequency_rad_per_s: angular_frequency,
            damping_ratio,
            actuator_coupling,
            microphone_coupling,
            radiation_efficiency,
            phase_reference_rad,
            sign_code,
        });
        previous_frequency = natural_frequency;
    }
    Ok(records)
}

pub fn validate_modes_v1(bytes: &[u8]) -> Result<ModesSummary, String> {
    let records = decode_modes_v1(bytes)?;
    let first = records.first().expect("decode rejects empty modes");
    let last = records.last().expect("decode rejects empty modes");
    Ok(ModesSummary {
        count: records.len(),
        first_mode_id: first.mode_id.clone(),
        last_mode_id: last.mode_id.clone(),
        minimum_frequency_hz: first.natural_frequency_hz,
        maximum_frequency_hz: last.natural_frequency_hz,
    })
}

pub fn decode_response_v1(bytes: &[u8]) -> Result<Vec<ResponseSample>, String> {
    let sample_count = assert_header(bytes, RESPONSE_MAGIC)?;
    let payload_bytes = sample_count
        .checked_mul(RESPONSE_RECORD_BYTES)
        .and_then(|value| value.checked_add(HEADER_BYTES))
        .ok_or_else(|| "response byte length overflows usize".to_owned())?;
    if bytes.len() != payload_bytes {
        return Err(format!(
            "response length {} does not match {payload_bytes}",
            bytes.len()
        ));
    }
    if sample_count < 2 {
        return Err("response binary must contain at least two samples".to_owned());
    }

    let mut previous_frequency = 0.0;
    let mut samples = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let base = HEADER_BYTES + index * RESPONSE_RECORD_BYTES;
        let frequency = f64_le(bytes, base, "response frequency")?;
        let real = f64_le(bytes, base + 8, "response real component")?;
        let imaginary = f64_le(bytes, base + 16, "response imaginary component")?;
        if frequency <= previous_frequency || frequency <= 0.0 {
            return Err("response frequencies must be strictly increasing".to_owned());
        }
        samples.push(ResponseSample {
            frequency_hz: frequency,
            real,
            imaginary,
        });
        previous_frequency = frequency;
    }
    Ok(samples)
}

pub fn validate_response_v1(bytes: &[u8]) -> Result<ResponseSummary, String> {
    let samples = decode_response_v1(bytes)?;
    Ok(ResponseSummary {
        sample_count: samples.len(),
        minimum_frequency_hz: samples
            .first()
            .expect("decode rejects short response")
            .frequency_hz,
        maximum_frequency_hz: samples
            .last()
            .expect("decode rejects short response")
            .frequency_hz,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(magic: &[u8; 8], count: u32, record_bytes: usize) -> Vec<u8> {
        let mut bytes = vec![0; HEADER_BYTES + count as usize * record_bytes];
        bytes[..8].copy_from_slice(magic);
        bytes[8..10].copy_from_slice(&BINARY_VERSION.to_le_bytes());
        bytes[10..12].copy_from_slice(&(HEADER_BYTES as u16).to_le_bytes());
        bytes[12..16].copy_from_slice(&count.to_le_bytes());
        bytes
    }

    #[test]
    fn validates_modes_contract() {
        let mut bytes = header(MODES_MAGIC, 1, MODE_RECORD_BYTES);
        let base = HEADER_BYTES;
        bytes[base..base + 8].copy_from_slice(b"mode-001");
        bytes[base + 24..base + 28].copy_from_slice(&1_u32.to_le_bytes());
        bytes[base + 32..base + 40].copy_from_slice(&220.0_f64.to_le_bytes());
        bytes[base + 40..base + 48]
            .copy_from_slice(&(220.0_f64 * std::f64::consts::TAU).to_le_bytes());
        bytes[base + 48..base + 56].copy_from_slice(&0.01_f64.to_le_bytes());
        let summary = validate_modes_v1(&bytes).expect("valid mode");
        assert_eq!(summary.count, 1);
        assert_eq!(summary.first_mode_id, "mode-001");
    }

    #[test]
    fn rejects_truncated_response_contract() {
        let bytes = header(RESPONSE_MAGIC, 2, RESPONSE_RECORD_BYTES);
        assert!(validate_response_v1(&bytes[..bytes.len() - 1]).is_err());
    }
}
