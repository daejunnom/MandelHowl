use std::collections::{BTreeMap, HashSet};

use crate::algorithm::Algorithm;
use crate::field::MaterialField;
use crate::json;
use crate::json::Value;
use crate::ktx2::write_ktx2_array;
use crate::solver::{Mode, SolveResult, evaluate_mode};
use crate::spec::PlateSpec;

#[derive(Debug, Clone)]
pub struct RuntimeMode {
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
    pub sign_reference: &'static str,
    pub dominant_radial_order: usize,
    pub dominant_angular_order: usize,
    pub dominant_symmetry: String,
}

#[derive(Debug, Clone)]
pub struct PostprocessedDataset {
    pub modes: Vec<RuntimeMode>,
    pub modes_binary: Vec<u8>,
    pub response_binary: Vec<u8>,
    pub response_metadata: Value,
    pub textures: BTreeMap<String, Vec<u8>>,
    pub texture_metadata: BTreeMap<String, Value>,
    pub cross_validation: Value,
}

pub fn postprocess(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    result: &SolveResult,
    texture_size: usize,
) -> Result<PostprocessedDataset, String> {
    let modes = normalized_runtime_modes(&result.modes)?;
    let modes_binary = write_modes_binary(&modes)?;
    let (response_binary, response_metadata) = write_response_binary(
        &modes,
        spec.number(&["frequencyRange", "minimumHz"])?,
        spec.number(&["frequencyRange", "maximumHz"])?,
        algorithm.response_sample_count,
        algorithm.normalization_floor,
    )?;
    let (textures, texture_metadata, cross_validation) =
        build_textures(spec, algorithm, field, result, texture_size)?;
    Ok(PostprocessedDataset {
        modes,
        modes_binary,
        response_binary,
        response_metadata,
        textures,
        texture_metadata,
        cross_validation,
    })
}

fn normalized_runtime_modes(modes: &[Mode]) -> Result<Vec<RuntimeMode>, String> {
    if modes.is_empty() {
        return Err("postprocess requires at least one mode".to_owned());
    }
    let actuator_scale = modes
        .iter()
        .map(|mode| mode.actuator_coupling_raw.abs())
        .fold(0.0_f64, f64::max);
    let microphone_scale = modes
        .iter()
        .map(|mode| mode.microphone_coupling_raw.abs())
        .fold(0.0_f64, f64::max);
    let radiation_scale = modes
        .iter()
        .map(|mode| mode.radiation_efficiency_raw)
        .fold(0.0_f64, f64::max);
    if actuator_scale <= 0.0 || microphone_scale <= 0.0 || radiation_scale <= 0.0 {
        return Err("modal coupling normalization scale is zero".to_owned());
    }
    Ok(modes
        .iter()
        .enumerate()
        .map(|(layer, mode)| RuntimeMode {
            mode_id: format!("mode-{:03}", mode.ordinal),
            ordinal: mode.ordinal,
            texture_layer: layer,
            natural_frequency_hz: mode.frequency_hz,
            angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
            damping_ratio: mode.damping_ratio,
            actuator_coupling: mode.actuator_coupling_raw / actuator_scale,
            microphone_coupling: mode.microphone_coupling_raw / microphone_scale,
            radiation_efficiency: (mode.radiation_efficiency_raw / radiation_scale).clamp(0.0, 1.0),
            phase_reference_rad: 0.0,
            sign_reference: mode.sign_reference,
            dominant_radial_order: mode.dominant_radial_order,
            dominant_angular_order: mode.dominant_angular_order,
            dominant_symmetry: mode.dominant_symmetry.as_str().to_owned(),
        })
        .collect())
}

pub fn write_modes_binary(modes: &[RuntimeMode]) -> Result<Vec<u8>, String> {
    let count = u32::try_from(modes.len()).map_err(|_| "mode count exceeds modes-v1".to_owned())?;
    let mut output = Vec::with_capacity(16 + modes.len() * 96);
    output.extend_from_slice(b"MHMODES1");
    output.extend_from_slice(&1_u16.to_le_bytes());
    output.extend_from_slice(&16_u16.to_le_bytes());
    output.extend_from_slice(&count.to_le_bytes());
    for mode in modes {
        let identifier = mode.mode_id.as_bytes();
        if identifier.len() >= 24 {
            return Err("mode id is too long for modes-v1".to_owned());
        }
        let mut record = [0_u8; 96];
        record[..identifier.len()].copy_from_slice(identifier);
        record[24..28].copy_from_slice(
            &u32::try_from(mode.ordinal)
                .map_err(|_| "mode ordinal exceeds u32".to_owned())?
                .to_le_bytes(),
        );
        record[28..32].copy_from_slice(
            &u32::try_from(mode.texture_layer)
                .map_err(|_| "texture layer exceeds u32".to_owned())?
                .to_le_bytes(),
        );
        for (index, value) in [
            mode.natural_frequency_hz,
            mode.angular_frequency_rad_per_s,
            mode.damping_ratio,
            mode.actuator_coupling,
            mode.microphone_coupling,
            mode.radiation_efficiency,
            mode.phase_reference_rad,
        ]
        .iter()
        .enumerate()
        {
            let offset = 32 + index * 8;
            record[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        record[88] = if mode.sign_reference == "actuator-positive" {
            0
        } else {
            1
        };
        output.extend_from_slice(&record);
    }
    Ok(output)
}

fn complex_response(mode: &RuntimeMode, frequency_hz: f64) -> (f64, f64) {
    let omega = std::f64::consts::TAU * frequency_hz;
    let omega_i = mode.angular_frequency_rad_per_s;
    let numerator = mode.actuator_coupling
        * mode.microphone_coupling
        * mode.radiation_efficiency
        * omega_i
        * omega_i;
    let real = omega_i * omega_i - omega * omega;
    let imaginary = 2.0 * mode.damping_ratio * omega_i * omega;
    let denominator = real * real + imaginary * imaginary;
    (
        numerator * real / denominator,
        -numerator * imaginary / denominator,
    )
}

fn write_response_binary(
    modes: &[RuntimeMode],
    minimum_hz: f64,
    maximum_hz: f64,
    sample_count: usize,
    normalization_floor: f64,
) -> Result<(Vec<u8>, Value), String> {
    if sample_count < 2 || minimum_hz <= 0.0 || maximum_hz <= minimum_hz {
        return Err("response sampling request is invalid".to_owned());
    }
    let ratio = maximum_hz / minimum_hz;
    let frequencies = (0..sample_count)
        .map(|index| minimum_hz * ratio.powf(index as f64 / (sample_count - 1) as f64))
        .collect::<Vec<_>>();
    let raw = frequencies
        .iter()
        .map(|frequency| {
            modes.iter().fold((0.0, 0.0), |sum, mode| {
                let value = complex_response(mode, *frequency);
                (sum.0 + value.0, sum.1 + value.1)
            })
        })
        .collect::<Vec<_>>();
    let normalization = raw
        .iter()
        .map(|value| value.0.hypot(value.1))
        .fold(normalization_floor, f64::max);
    let count = u32::try_from(sample_count)
        .map_err(|_| "response sample count exceeds response-v1".to_owned())?;
    let mut output = Vec::with_capacity(16 + sample_count * 24);
    output.extend_from_slice(b"MHRESPN1");
    output.extend_from_slice(&1_u16.to_le_bytes());
    output.extend_from_slice(&16_u16.to_le_bytes());
    output.extend_from_slice(&count.to_le_bytes());
    for (frequency, value) in frequencies.iter().zip(raw) {
        output.extend_from_slice(&frequency.to_le_bytes());
        output.extend_from_slice(&(value.0 / normalization).to_le_bytes());
        output.extend_from_slice(&(value.1 / normalization).to_le_bytes());
    }
    Ok((
        output,
        json!({
            "sampleCount": sample_count,
            "spacing": "logarithmic",
            "minimumFrequencyHz": minimum_hz,
            "maximumFrequencyHz": maximum_hz,
            "normalizationDivisor": normalization,
            "definition": "sum(g_i*m_i*r_i*omega_i^2/(omega_i^2-omega^2+j*2*zeta_i*omega_i*omega))",
        }),
    ))
}

fn shape_grid(
    spec: &PlateSpec,
    result: &SolveResult,
    mode: &Mode,
    size: usize,
) -> Result<(Vec<f64>, Vec<bool>), String> {
    let radius = spec.number(&["geometry", "radiusM"])?;
    let hub = spec.number(&["geometry", "hub", "radiusM"])?;
    let step = 2.0 * radius / size as f64;
    let mut values = Vec::with_capacity(size * size);
    let mut valid = Vec::with_capacity(size * size);
    for y in 0..size {
        let y_m = -radius + (y as f64 + 0.5) * step;
        for x in 0..size {
            let x_m = -radius + (x as f64 + 0.5) * step;
            let radial = x_m.hypot(y_m);
            let is_valid = hub < radial && radial <= radius;
            valid.push(is_valid);
            values.push(if is_valid {
                evaluate_mode(&mode.coefficients, &result.basis, x_m, y_m, hub, radius)
            } else {
                0.0
            });
        }
    }
    let scale = values
        .iter()
        .zip(&valid)
        .filter_map(|(value, valid)| valid.then_some(value.abs()))
        .fold(f64::NEG_INFINITY, f64::max);
    if !scale.is_finite() || scale <= 0.0 {
        return Err("mode shape has no non-zero pixels inside the plate".to_owned());
    }
    for value in &mut values {
        *value /= scale;
    }
    Ok((values, valid))
}

fn finite_difference_frequency(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    values: &[f64],
    valid: &[bool],
    size: usize,
) -> Result<f64, String> {
    let radius = spec.number(&["geometry", "radiusM"])?;
    let step = 2.0 * radius / size as f64;
    let density = spec.number(&["material", "densityKgPerM3"])?;
    let youngs = spec.number(&["material", "youngsModulusPa"])?;
    let poisson = spec.number(&["material", "poissonRatio"])?;
    let mut bending_energy = 0.0;
    let mut mass_energy = 0.0;
    let area = step * step;
    for y in 1..size - 1 {
        let y_m = -radius + (y as f64 + 0.5) * step;
        for x in 1..size - 1 {
            let index = y * size + x;
            let neighbours = [
                index,
                index - 1,
                index + 1,
                index - size,
                index + size,
                index - size - 1,
                index - size + 1,
                index + size - 1,
                index + size + 1,
            ];
            if neighbours.iter().any(|neighbour| !valid[*neighbour]) {
                continue;
            }
            let x_m = -radius + (x as f64 + 0.5) * step;
            let thickness = field.at(x_m, y_m, true);
            let rigidity = youngs * thickness.powi(3) / (12.0 * (1.0 - poisson * poisson));
            let hxx = (values[index - 1] - 2.0 * values[index] + values[index + 1]) / (step * step);
            let hyy =
                (values[index - size] - 2.0 * values[index] + values[index + size]) / (step * step);
            let hxy =
                (values[index + size + 1] - values[index + size - 1] - values[index - size + 1]
                    + values[index - size - 1])
                    / (4.0 * step * step);
            let curvature = hxx * hxx
                + hyy * hyy
                + 2.0 * poisson * hxx * hyy
                + 2.0 * (1.0 - poisson) * hxy * hxy;
            bending_energy += rigidity * curvature * area;
            mass_energy += density * thickness * values[index].powi(2) * area;
        }
    }
    Ok(
        (bending_energy / mass_energy.max(algorithm.normalization_floor)).sqrt()
            / std::f64::consts::TAU,
    )
}

type TextureBuild = (BTreeMap<String, Vec<u8>>, BTreeMap<String, Value>, Value);

fn build_textures(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    result: &SolveResult,
    size: usize,
) -> Result<TextureBuild, String> {
    if size < 16 {
        return Err("texture size must be at least 16".to_owned());
    }
    let mut displacement = Vec::new();
    let mut normal = Vec::new();
    let mut nodal = Vec::new();
    let mut sand = Vec::new();
    let mut fd_checks = Vec::new();
    let mut sand_alignment = Vec::new();
    let radius = spec.number(&["geometry", "radiusM"])?;
    let step = 2.0 * radius / size as f64;
    let check_ordinals = algorithm
        .fd_check_ordinals
        .iter()
        .copied()
        .collect::<HashSet<_>>();

    for mode in &result.modes {
        let (values, valid) = shape_grid(spec, result, mode, size)?;
        let layer_displacement = values
            .iter()
            .map(|value| quantize_byte(127.5 * (value + 1.0)))
            .collect::<Vec<_>>();
        let mut layer_nodal = vec![0_u8; values.len()];
        let mut layer_sand = vec![0_u8; values.len()];
        let mut layer_normal = Vec::with_capacity(values.len() * 2);
        let mut low_velocity_sand = Vec::new();
        let mut high_velocity_sand = Vec::new();
        for y in 0..size {
            for x in 0..size {
                let index = y * size + x;
                if !valid[index] {
                    layer_normal.extend_from_slice(&[128, 128]);
                    continue;
                }
                let absolute = values[index].abs();
                layer_nodal[index] = if absolute <= algorithm.nodal_threshold {
                    255
                } else {
                    0
                };
                let density = (-(absolute / algorithm.sand_scale).powi(2)).exp();
                layer_sand[index] = quantize_byte(255.0 * density);
                if absolute <= algorithm.low_velocity_threshold {
                    low_velocity_sand.push(density);
                } else if absolute >= algorithm.high_velocity_threshold {
                    high_velocity_sand.push(density);
                }
                let left = if x > 0 && valid[index - 1] {
                    values[index - 1]
                } else {
                    values[index]
                };
                let right = if x + 1 < size && valid[index + 1] {
                    values[index + 1]
                } else {
                    values[index]
                };
                let down = if y > 0 && valid[index - size] {
                    values[index - size]
                } else {
                    values[index]
                };
                let up = if y + 1 < size && valid[index + size] {
                    values[index + size]
                } else {
                    values[index]
                };
                let dx = (right - left) / (2.0 * step);
                let dy = (up - down) / (2.0 * step);
                let length = (1.0
                    + (algorithm.normal_visual_scale * dx).powi(2)
                    + (algorithm.normal_visual_scale * dy).powi(2))
                .sqrt();
                let nx = -algorithm.normal_visual_scale * dx / length;
                let ny = -algorithm.normal_visual_scale * dy / length;
                layer_normal.push(quantize_byte(127.5 * (nx + 1.0)));
                layer_normal.push(quantize_byte(127.5 * (ny + 1.0)));
            }
        }
        displacement.extend(layer_displacement);
        nodal.extend(layer_nodal);
        sand.extend(layer_sand);
        normal.extend(layer_normal);
        let low_mean =
            low_velocity_sand.iter().sum::<f64>() / low_velocity_sand.len().max(1) as f64;
        let high_mean =
            high_velocity_sand.iter().sum::<f64>() / high_velocity_sand.len().max(1) as f64;
        sand_alignment.push(low_mean - high_mean);
        if check_ordinals.contains(&mode.ordinal) {
            let reference =
                finite_difference_frequency(spec, algorithm, field, &values, &valid, size)?;
            fd_checks.push(json!({
                "modeId": format!("mode-{:03}", mode.ordinal),
                "rayleighRitzFrequencyHz": mode.frequency_hz,
                "finiteDifferenceRayleighFrequencyHz": reference,
                "relativeDifference": (reference - mode.frequency_hz).abs() / mode.frequency_hz,
            }));
        }
    }
    let layers = result.modes.len();
    let mut textures = BTreeMap::new();
    textures.insert(
        "signed-displacement".to_owned(),
        write_ktx2_array(size, size, layers, 1, &displacement)?,
    );
    textures.insert(
        "normal".to_owned(),
        write_ktx2_array(size, size, layers, 2, &normal)?,
    );
    textures.insert(
        "nodal-mask".to_owned(),
        write_ktx2_array(size, size, layers, 1, &nodal)?,
    );
    textures.insert(
        "sand-density".to_owned(),
        write_ktx2_array(size, size, layers, 1, &sand)?,
    );
    let mut metadata = BTreeMap::new();
    for kind in textures.keys() {
        let channels = if kind == "normal" { 2 } else { 1 };
        metadata.insert(
            kind.clone(),
            json!({
                "widthPx": size,
                "heightPx": size,
                "layers": layers,
                "channels": channels,
                "vkFormat": if channels == 2 { "VK_FORMAT_R8G8_UNORM" } else { "VK_FORMAT_R8_UNORM" },
                "supercompression": "none",
                "orientation": "ru",
                "uvOrigin": "negative-x-negative-y",
                "quantization": if kind == "signed-displacement" {
                    "signed [-1,1] mapped to [0,255]"
                } else {
                    "linear UNORM"
                },
            }),
        );
    }
    let minimum_alignment = sand_alignment.into_iter().fold(f64::INFINITY, f64::min);
    let cross_validation = json!({
        "independentReferenceMethod": "nine-point finite-difference Hessian Kirchhoff-Love Rayleigh quotient on the rasterized mode; independent spatial discretization, not a second certified solver",
        "frequencyChecks": fd_checks,
        "sandDensityMeanContrastLowMinusHighVelocity": minimum_alignment,
        "textureCoordinateAlignment": {
            "allAtlasesShareDimensions": true,
            "allAtlasesShareLayerOrder": true,
            "physicalPixel00M": [-radius + step * 0.5, -radius + step * 0.5],
            "xDirection": "increasing-column",
            "yDirection": "increasing-row",
        },
    });
    Ok((textures, metadata, cross_validation))
}

fn quantize_byte(value: f64) -> u8 {
    value.round_ties_even().clamp(0.0, 255.0) as u8
}
