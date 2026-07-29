use std::collections::VecDeque;

use crate::algorithm::Algorithm;
use crate::spec::PlateSpec;

#[derive(Debug, Clone)]
pub struct FieldStatistics {
    pub analysis_resolution_px: usize,
    pub pixel_pitch_m: f64,
    pub filter_radius_px: usize,
    pub manufacturing_bevel_passes: usize,
    pub actual_minimum_feature_m: f64,
    pub quantization_levels: usize,
    pub minimum_thickness_m: f64,
    pub maximum_thickness_m: f64,
    pub maximum_thickness_gradient: f64,
    pub total_mass_kg: f64,
    pub centre_of_mass_x_m: f64,
    pub centre_of_mass_y_m: f64,
    pub centre_of_mass_offset_m: f64,
    pub mass_within_limits: bool,
    pub centre_of_mass_within_limit: bool,
    pub gradient_within_limit: bool,
    pub minimum_thickness_within_limit: bool,
    pub minimum_feature_within_limit: bool,
}

#[derive(Debug, Clone)]
pub struct MaterialField {
    pub size: usize,
    pub radius_m: f64,
    pub values: Vec<f64>,
    pub thickness_m: Vec<f64>,
    pub inside_plate: Vec<bool>,
    pub statistics: FieldStatistics,
}

impl MaterialField {
    pub fn at(&self, x_m: f64, y_m: f64, thickness: bool) -> f64 {
        let values = if thickness {
            &self.thickness_m
        } else {
            &self.values
        };
        let limit = (self.size - 1) as f64;
        let mut u = (x_m / (2.0 * self.radius_m) + 0.5) * limit;
        let mut v = (y_m / (2.0 * self.radius_m) + 0.5) * limit;
        u = u.clamp(0.0, limit);
        v = v.clamp(0.0, limit);
        let x0 = (u.floor() as usize).min(self.size - 2);
        let y0 = (v.floor() as usize).min(self.size - 2);
        let tx = u - x0 as f64;
        let ty = v - y0 as f64;
        let i00 = y0 * self.size + x0;
        let a = values[i00] * (1.0 - tx) + values[i00 + 1] * tx;
        let b = values[i00 + self.size] * (1.0 - tx) + values[i00 + self.size + 1] * tx;
        a * (1.0 - ty) + b * ty
    }

    pub fn to_binary(&self) -> Result<Vec<u8>, String> {
        let size = u32::try_from(self.size)
            .map_err(|_| "field resolution exceeds the v1 binary contract".to_owned())?;
        let radius = self.radius_m as f32;
        let mut output = Vec::with_capacity(24 + self.values.len());
        output.extend_from_slice(b"MHFIELD1");
        output.extend_from_slice(&1_u32.to_le_bytes());
        output.extend_from_slice(&size.to_le_bytes());
        output.extend_from_slice(&(-radius).to_le_bytes());
        output.extend_from_slice(&radius.to_le_bytes());
        output.extend(self.values.iter().map(|value| quantize_unorm(*value)));
        Ok(output)
    }
}

pub fn mandelbrot_value(
    real: f64,
    imaginary: f64,
    maximum_iterations: usize,
    escape_radius: f64,
) -> f64 {
    let mut zr = 0.0;
    let mut zi = 0.0;
    let mut escape_iteration = maximum_iterations;
    let mut magnitude_squared = 0.0;
    let escape_squared = escape_radius * escape_radius;
    for iteration in 0..maximum_iterations {
        (zr, zi) = (zr * zr - zi * zi + real, 2.0 * zr * zi + imaginary);
        magnitude_squared = zr * zr + zi * zi;
        if magnitude_squared > escape_squared {
            escape_iteration = iteration + 1;
            break;
        }
    }
    if escape_iteration == maximum_iterations {
        return 1.0;
    }
    let magnitude = magnitude_squared.sqrt();
    let smooth_iteration = escape_iteration as f64 + 1.0 - magnitude.ln().ln() / 2.0_f64.ln();
    (smooth_iteration / maximum_iterations as f64).clamp(0.0, 1.0)
}

pub fn generate_material_field(
    spec: &PlateSpec,
    algorithm: &Algorithm,
    size: usize,
) -> Result<MaterialField, String> {
    if size < algorithm.field_minimum_resolution {
        return Err(format!(
            "analysis field resolution must be at least {}",
            algorithm.field_minimum_resolution
        ));
    }
    let radius = spec.number(&["geometry", "radiusM"])?;
    let (real_minimum, real_maximum) = (
        spec.number(&["mandelbrotField", "complexBounds", "realMin"])?,
        spec.number(&["mandelbrotField", "complexBounds", "realMax"])?,
    );
    let (imaginary_minimum, imaginary_maximum) = (
        spec.number(&["mandelbrotField", "complexBounds", "imaginaryMin"])?,
        spec.number(&["mandelbrotField", "complexBounds", "imaginaryMax"])?,
    );
    let maximum_iterations = spec.usize(&["mandelbrotField", "maximumIterations"])?;
    let requested_escape_radius = spec.number(&["mandelbrotField", "escapeRadius"])?;
    if (requested_escape_radius - algorithm.field_escape_radius).abs() > f64::EPSILON {
        return Err(format!(
            "algorithm revision requires escape radius {}, spec requested {}",
            algorithm.field_escape_radius, requested_escape_radius
        ));
    }
    let pixel_m = 2.0 * radius / size as f64;
    let mut raw = vec![0.0; size * size];
    let mut inside_plate = vec![false; size * size];
    let conjugate_symmetric =
        (imaginary_minimum + imaginary_maximum).abs() <= algorithm.conjugate_tolerance;
    let evaluated_rows = if conjugate_symmetric {
        size.div_ceil(2)
    } else {
        size
    };
    for y in 0..evaluated_rows {
        let y_m = -radius + (y as f64 + 0.5) * pixel_m;
        let imaginary = imaginary_minimum
            + (y_m + radius) / (2.0 * radius) * (imaginary_maximum - imaginary_minimum);
        for x in 0..size {
            let x_m = -radius + (x as f64 + 0.5) * pixel_m;
            let real =
                real_minimum + (x_m + radius) / (2.0 * radius) * (real_maximum - real_minimum);
            let index = y * size + x;
            raw[index] = mandelbrot_value(
                real,
                imaginary,
                maximum_iterations,
                algorithm.field_escape_radius,
            );
            inside_plate[index] = x_m * x_m + y_m * y_m <= radius * radius;
            if conjugate_symmetric {
                let mirror_y = size - 1 - y;
                let mirror = mirror_y * size + x;
                raw[mirror] = raw[index];
                inside_plate[mirror] = inside_plate[index];
            }
        }
    }

    let filter_radius_m = spec.number(&["mandelbrotField", "manufacturingFilter", "radiusM"])?;
    let filter_radius = ((filter_radius_m / pixel_m).round_ties_even() as isize).max(1) as usize;
    let mut filtered = raw;
    for _ in 0..algorithm.field_box_passes {
        filtered = box_blur(&filtered, size, filter_radius);
    }
    let closed = window_extreme(
        &window_extreme(&filtered, size, filter_radius, true),
        size,
        filter_radius,
        false,
    );
    filtered = window_extreme(
        &window_extreme(&closed, size, filter_radius, false),
        size,
        filter_radius,
        true,
    );
    let levels = spec.usize(&[
        "mandelbrotField",
        "manufacturingFilter",
        "quantizationLevels",
    ])?;
    if levels < 2 {
        return Err("manufacturing quantization requires at least two levels".to_owned());
    }
    let scale = (levels - 1) as f64;
    for value in &mut filtered {
        *value = (*value * scale).round_ties_even() / scale;
    }
    for _ in 0..algorithm.field_bevel_passes {
        filtered = box_blur(&filtered, size, filter_radius);
    }
    if conjugate_symmetric {
        for y in 0..size / 2 {
            let mirror_y = size - 1 - y;
            for x in 0..size {
                let index = y * size + x;
                let mirror = mirror_y * size + x;
                let average = (filtered[index] + filtered[mirror]) * 0.5;
                filtered[index] = average;
                filtered[mirror] = average;
            }
        }
    }

    let minimum_thickness = spec.number(&["thicknessMapping", "minimumThicknessM"])?;
    let maximum_thickness = spec.number(&["thicknessMapping", "maximumThicknessM"])?;
    if minimum_thickness <= 0.0 || maximum_thickness <= minimum_thickness {
        return Err("thickness mapping is invalid".to_owned());
    }
    let thickness_m = filtered
        .iter()
        .map(|value| {
            minimum_thickness + (maximum_thickness - minimum_thickness) * smoothstep(*value)
        })
        .collect::<Vec<_>>();

    let density = spec.number(&["material", "densityKgPerM3"])?;
    let area = pixel_m * pixel_m;
    let mut total_mass = 0.0;
    let mut first_x = 0.0;
    let mut first_y = 0.0;
    for y in 0..size {
        let y_m = -radius + (y as f64 + 0.5) * pixel_m;
        for x in 0..size {
            let index = y * size + x;
            if !inside_plate[index] {
                continue;
            }
            let x_m = -radius + (x as f64 + 0.5) * pixel_m;
            let sample_mass = density * thickness_m[index] * area;
            total_mass += sample_mass;
            first_x += sample_mass * x_m;
            first_y += sample_mass * y_m;
        }
    }
    if !total_mass.is_finite() || total_mass <= 0.0 {
        return Err("material field has invalid total mass".to_owned());
    }
    let centre_x = first_x / total_mass;
    let centre_y = first_y / total_mass;
    let centre_offset = centre_x.hypot(centre_y);

    let mut maximum_gradient = 0.0_f64;
    for y in 1..size - 1 {
        for x in 1..size - 1 {
            let index = y * size + x;
            if !inside_plate[index] {
                continue;
            }
            let dx = (thickness_m[index + 1] - thickness_m[index - 1]) / (2.0 * pixel_m);
            let dy = (thickness_m[index + size] - thickness_m[index - size]) / (2.0 * pixel_m);
            maximum_gradient = maximum_gradient.max(dx.hypot(dy));
        }
    }
    let actual_minimum = thickness_m
        .iter()
        .zip(&inside_plate)
        .filter_map(|(value, inside)| inside.then_some(*value))
        .fold(f64::INFINITY, f64::min);
    let actual_maximum = thickness_m
        .iter()
        .zip(&inside_plate)
        .filter_map(|(value, inside)| inside.then_some(*value))
        .fold(f64::NEG_INFINITY, f64::max);
    let (mass_minimum, mass_maximum) =
        spec.number_pair(&["manufacturingLimits", "totalMassRangeKg"])?;
    let feature_m = 2.0 * filter_radius as f64 * pixel_m;
    let statistics = FieldStatistics {
        analysis_resolution_px: size,
        pixel_pitch_m: pixel_m,
        filter_radius_px: filter_radius,
        manufacturing_bevel_passes: algorithm.field_bevel_passes,
        actual_minimum_feature_m: feature_m,
        quantization_levels: levels,
        minimum_thickness_m: actual_minimum,
        maximum_thickness_m: actual_maximum,
        maximum_thickness_gradient: maximum_gradient,
        total_mass_kg: total_mass,
        centre_of_mass_x_m: centre_x,
        centre_of_mass_y_m: centre_y,
        centre_of_mass_offset_m: centre_offset,
        mass_within_limits: mass_minimum <= total_mass && total_mass <= mass_maximum,
        centre_of_mass_within_limit: centre_offset
            <= spec.number(&["manufacturingLimits", "centreOfMassOffsetMaximumM"])?,
        gradient_within_limit: maximum_gradient
            <= spec.number(&["manufacturingLimits", "maximumThicknessGradient"])?,
        minimum_thickness_within_limit: thickness_m.iter().copied().fold(f64::INFINITY, f64::min)
            >= spec.number(&["manufacturingLimits", "minimumConnectedThicknessM"])?,
        minimum_feature_within_limit: feature_m
            >= spec.number(&["mandelbrotField", "manufacturingFilter", "minimumFeatureM"])?,
    };
    Ok(MaterialField {
        size,
        radius_m: radius,
        values: filtered,
        thickness_m,
        inside_plate,
        statistics,
    })
}

fn quantize_unorm(value: f64) -> u8 {
    (value * 255.0).round_ties_even().clamp(0.0, 255.0) as u8
}

fn smoothstep(value: f64) -> f64 {
    let value = value.clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

fn window_extreme(values: &[f64], size: usize, radius: usize, maximum: bool) -> Vec<f64> {
    fn sliding(samples: &[f64], radius: usize, maximum: bool) -> Vec<f64> {
        let mut result = vec![0.0; samples.len()];
        let mut candidates = VecDeque::<usize>::new();
        let mut added: isize = -1;
        for (index, output) in result.iter_mut().enumerate() {
            let wanted = (index + radius).min(samples.len() - 1);
            while added < wanted as isize {
                added += 1;
                let added_index = added as usize;
                while candidates.back().is_some_and(|candidate| {
                    if maximum {
                        samples[*candidate] <= samples[added_index]
                    } else {
                        samples[*candidate] >= samples[added_index]
                    }
                }) {
                    candidates.pop_back();
                }
                candidates.push_back(added_index);
            }
            let minimum_index = index.saturating_sub(radius);
            while candidates
                .front()
                .is_some_and(|candidate| *candidate < minimum_index)
            {
                candidates.pop_front();
            }
            *output = samples[*candidates.front().expect("sliding window candidate")];
        }
        result
    }

    let mut horizontal = vec![0.0; values.len()];
    for y in 0..size {
        let row = y * size;
        horizontal[row..row + size].copy_from_slice(&sliding(
            &values[row..row + size],
            radius,
            maximum,
        ));
    }
    let mut result = vec![0.0; values.len()];
    for x in 0..size {
        let samples = (0..size)
            .map(|y| horizontal[y * size + x])
            .collect::<Vec<_>>();
        for (y, sample) in sliding(&samples, radius, maximum).into_iter().enumerate() {
            result[y * size + x] = sample;
        }
    }
    result
}

fn box_blur(values: &[f64], size: usize, radius: usize) -> Vec<f64> {
    let mut horizontal = vec![0.0; values.len()];
    for y in 0..size {
        let mut prefix = Vec::with_capacity(size + 1);
        prefix.push(0.0);
        let row = y * size;
        for x in 0..size {
            prefix.push(prefix[x] + values[row + x]);
        }
        for x in 0..size {
            let low = x.saturating_sub(radius);
            let high = (x + radius).min(size - 1);
            horizontal[row + x] = (prefix[high + 1] - prefix[low]) / (high - low + 1) as f64;
        }
    }
    let mut result = vec![0.0; values.len()];
    for x in 0..size {
        let mut prefix = Vec::with_capacity(size + 1);
        prefix.push(0.0);
        for y in 0..size {
            prefix.push(prefix[y] + horizontal[y * size + x]);
        }
        for y in 0..size {
            let low = y.saturating_sub(radius);
            let high = (y + radius).min(size - 1);
            result[y * size + x] = (prefix[high + 1] - prefix[low]) / (high - low + 1) as f64;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::json::Value;

    fn fixture() -> (PlateSpec, Algorithm) {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let spec = PlateSpec::load(&repository.join("specs/plate/mandelbrot-plate.v1.yaml"))
            .expect("plate spec");
        let algorithm = Algorithm::load().expect("algorithm");
        (spec, algorithm)
    }

    fn set_number(spec: &mut PlateSpec, path: &[&str], value: f64) {
        let mut current = &mut spec.value;
        for component in &path[..path.len() - 1] {
            current = current.get_mut(component).expect("spec path");
        }
        current
            .as_object_mut()
            .expect("spec object")
            .insert(path[path.len() - 1].to_owned(), Value::Number(value));
    }

    #[test]
    fn alternate_valid_bounds_remain_asymmetric() {
        let (mut spec, algorithm) = fixture();
        set_number(
            &mut spec,
            &["mandelbrotField", "complexBounds", "imaginaryMin"],
            -1.0,
        );
        let field = generate_material_field(&spec, &algorithm, 32).expect("field");
        assert!((0..16).any(|y| {
            (0..32).any(|x| field.values[y * 32 + x] != field.values[(31 - y) * 32 + x])
        }));
    }

    #[test]
    fn escape_radius_is_fixed_by_algorithm_revision() {
        let (mut spec, algorithm) = fixture();
        set_number(&mut spec, &["mandelbrotField", "escapeRadius"], 3.0);
        let error = generate_material_field(&spec, &algorithm, 32).expect_err("reject");
        assert!(error.contains("requires escape radius 2"));
    }
}
