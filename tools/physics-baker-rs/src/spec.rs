use std::fs;
use std::path::{Path, PathBuf};

use crate::json::Value;
use crate::sha256::{digest, hex};

#[derive(Debug, Clone)]
pub struct PlateSpec {
    pub source_path: PathBuf,
    pub value: Value,
    pub canonical_json: Vec<u8>,
    pub canonical_sha256: String,
}

#[derive(Debug, Clone)]
pub struct MeshLevel {
    pub name: String,
    pub target_element_size_m: f64,
    pub analysis_radial_element_count: usize,
    pub analysis_maximum_fourier_order: usize,
    pub analysis_angular_samples: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct MeshQuality {
    pub minimum_edge_m: f64,
    pub minimum_signed_area_m2: f64,
    pub maximum_aspect_ratio: f64,
    pub required_connected_component_count: usize,
    pub maximum_inverted_triangle_count: usize,
}

impl PlateSpec {
    pub fn load(path: &Path) -> Result<Self, String> {
        let source = fs::read_to_string(path)
            .map_err(|error| format!("unable to read plate spec {}: {error}", path.display()))?;
        let value = crate::yaml::parse(&source)
            .map_err(|error| format!("plate spec YAML is invalid: {error}"))?;
        validate_finite_json(&value, "$")?;
        let canonical_json = crate::json::to_vec(&value)
            .map_err(|error| format!("plate spec canonicalization failed: {error}"))?;
        let result = Self {
            source_path: path.to_path_buf(),
            canonical_sha256: hex(&digest(&canonical_json)),
            canonical_json,
            value,
        };
        result.validate_contract()?;
        Ok(result)
    }

    pub fn value_at<'a>(&'a self, path: &[&str]) -> Result<&'a Value, String> {
        let mut current = &self.value;
        let mut rendered = String::from("$");
        for component in path {
            rendered.push('.');
            rendered.push_str(component);
            current = current
                .as_object()
                .and_then(|object| object.get(*component))
                .ok_or_else(|| format!("plate spec is missing {rendered}"))?;
        }
        Ok(current)
    }

    pub fn number(&self, path: &[&str]) -> Result<f64, String> {
        let value = self
            .value_at(path)?
            .as_f64()
            .ok_or_else(|| format!("{} must be a number", render_path(path)))?;
        if value.is_finite() {
            Ok(value)
        } else {
            Err(format!("{} must be finite", render_path(path)))
        }
    }

    pub fn usize(&self, path: &[&str]) -> Result<usize, String> {
        let value = self
            .value_at(path)?
            .as_u64()
            .ok_or_else(|| format!("{} must be a non-negative integer", render_path(path)))?;
        usize::try_from(value).map_err(|_| format!("{} overflows usize", render_path(path)))
    }

    pub fn string(&self, path: &[&str]) -> Result<&str, String> {
        self.value_at(path)?
            .as_str()
            .ok_or_else(|| format!("{} must be a string", render_path(path)))
    }

    pub fn boolean(&self, path: &[&str]) -> Result<bool, String> {
        self.value_at(path)?
            .as_bool()
            .ok_or_else(|| format!("{} must be a boolean", render_path(path)))
    }

    pub fn number_pair(&self, path: &[&str]) -> Result<(f64, f64), String> {
        let values = self
            .value_at(path)?
            .as_array()
            .ok_or_else(|| format!("{} must be an array", render_path(path)))?;
        if values.len() != 2 {
            return Err(format!("{} must contain two numbers", render_path(path)));
        }
        let first = values[0]
            .as_f64()
            .ok_or_else(|| format!("{}[0] must be a number", render_path(path)))?;
        let second = values[1]
            .as_f64()
            .ok_or_else(|| format!("{}[1] must be a number", render_path(path)))?;
        if !first.is_finite() || !second.is_finite() {
            return Err(format!("{} values must be finite", render_path(path)));
        }
        Ok((first, second))
    }

    pub fn mesh_levels(&self) -> Result<Vec<MeshLevel>, String> {
        let values = self
            .value_at(&["solverRequest", "meshLevels"])?
            .as_array()
            .ok_or_else(|| "$.solverRequest.meshLevels must be an array".to_owned())?;
        if values.len() < 2 {
            return Err("$.solverRequest.meshLevels must have at least two levels".to_owned());
        }
        values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let object = value.as_object().ok_or_else(|| {
                    format!("$.solverRequest.meshLevels[{index}] must be an object")
                })?;
                let name = object
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| format!("mesh level {index} has no name"))?;
                let target = object
                    .get("targetElementSizeM")
                    .and_then(Value::as_f64)
                    .filter(|target| target.is_finite() && *target > 0.0)
                    .ok_or_else(|| format!("mesh level {index} target is invalid"))?;
                let analysis = object
                    .get("analysisFiniteStrip")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        format!("mesh level {index} finite-strip analysis is missing")
                    })?;
                let analysis_radial_element_count = analysis
                    .get("radialElementCount")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| *value >= 2)
                    .ok_or_else(|| format!("mesh level {index} radial element count is invalid"))?;
                let analysis_maximum_fourier_order = analysis
                    .get("maximumFourierOrder")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| *value >= 1)
                    .ok_or_else(|| {
                        format!("mesh level {index} maximum Fourier order is invalid")
                    })?;
                let analysis_angular_samples = analysis
                    .get("angularQuadratureSamples")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| *value >= 16)
                    .ok_or_else(|| {
                        format!("mesh level {index} analysis angular samples are invalid")
                    })?;
                Ok(MeshLevel {
                    name: name.to_owned(),
                    target_element_size_m: target,
                    analysis_radial_element_count,
                    analysis_maximum_fourier_order,
                    analysis_angular_samples,
                })
            })
            .collect()
    }

    pub fn mesh_quality(&self) -> Result<MeshQuality, String> {
        Ok(MeshQuality {
            minimum_edge_m: self.number(&["solverRequest", "meshQuality", "minimumEdgeM"])?,
            minimum_signed_area_m2: self.number(&[
                "solverRequest",
                "meshQuality",
                "minimumSignedAreaM2",
            ])?,
            maximum_aspect_ratio: self.number(&[
                "solverRequest",
                "meshQuality",
                "maximumAspectRatio",
            ])?,
            required_connected_component_count: self.usize(&[
                "solverRequest",
                "meshQuality",
                "requiredConnectedComponentCount",
            ])?,
            maximum_inverted_triangle_count: self.usize(&[
                "solverRequest",
                "meshQuality",
                "maximumInvertedTriangleCount",
            ])?,
        })
    }

    fn validate_contract(&self) -> Result<(), String> {
        assert_string(self, &["schemaVersion"], "mandelhowl.plate-spec.v1")?;
        assert_string(self, &["geometry", "frontShape"], "circle")?;
        assert_string(self, &["geometry", "hub", "shape"], "circle")?;
        assert_string(self, &["boundaryCondition", "hub"], "clamped")?;
        assert_string(self, &["boundaryCondition", "outerEdge"], "free")?;
        assert_string(
            self,
            &["solverRequest", "analysis"],
            "undamped-eigenmodes-with-modal-damping",
        )?;
        assert_string(
            self,
            &["solverRequest", "elementFamily"],
            "kirchhoff-love-thin-plate",
        )?;
        assert_string(self, &["solverRequest", "normalization"], "unit-modal-mass")?;
        assert_string(
            self,
            &["solverRequest", "signReference"],
            "positive-at-actuator-or-first-nonzero-node",
        )?;
        assert_string(self, &["textureRequest", "container"], "KTX2")?;
        assert_string(self, &["determinism", "offlineFloatPrecision"], "float64")?;
        assert_string(self, &["determinism", "randomSource"], "forbidden")?;
        if !self.boolean(&["thicknessMapping", "frontSurfaceRemainsPlanar"])? {
            return Err("front surface must remain planar".to_owned());
        }
        let radius = self.number(&["geometry", "radiusM"])?;
        let hub = self.number(&["geometry", "hub", "radiusM"])?;
        if radius <= 0.0 || hub <= 0.0 || hub >= radius {
            return Err("plate and hub radii are inconsistent".to_owned());
        }
        for axis in ["x", "y", "z"] {
            if self.number(&["geometry", "hub", "centreM", axis])? != 0.0 {
                return Err("the clamped hub must be centred on the plate origin".to_owned());
            }
        }
        let real_min = self.number(&["mandelbrotField", "complexBounds", "realMin"])?;
        let real_max = self.number(&["mandelbrotField", "complexBounds", "realMax"])?;
        let imaginary_min = self.number(&["mandelbrotField", "complexBounds", "imaginaryMin"])?;
        let imaginary_max = self.number(&["mandelbrotField", "complexBounds", "imaginaryMax"])?;
        if real_min >= real_max || imaginary_min >= imaginary_max {
            return Err("Mandelbrot complex bounds are not ordered".to_owned());
        }
        let minimum_feature =
            self.number(&["mandelbrotField", "manufacturingFilter", "minimumFeatureM"])?;
        let filter_radius = self.number(&["mandelbrotField", "manufacturingFilter", "radiusM"])?;
        if filter_radius <= 0.0 || minimum_feature <= 0.0 || filter_radius > minimum_feature {
            return Err("manufacturing feature/filter radii are inconsistent".to_owned());
        }
        let minimum_thickness = self.number(&["thicknessMapping", "minimumThicknessM"])?;
        let maximum_thickness = self.number(&["thicknessMapping", "maximumThicknessM"])?;
        let connected_thickness =
            self.number(&["manufacturingLimits", "minimumConnectedThicknessM"])?;
        if minimum_thickness <= 0.0
            || minimum_thickness >= maximum_thickness
            || connected_thickness > minimum_thickness
        {
            return Err("thickness mapping limits are inconsistent".to_owned());
        }
        let (minimum_mass, maximum_mass) =
            self.number_pair(&["manufacturingLimits", "totalMassRangeKg"])?;
        let maximum_offset = self.number(&["manufacturingLimits", "centreOfMassOffsetMaximumM"])?;
        if minimum_mass <= 0.0
            || minimum_mass >= maximum_mass
            || maximum_offset < 0.0
            || maximum_offset >= radius
        {
            return Err("manufacturing mass/centre-of-mass limits are inconsistent".to_owned());
        }
        let poisson = self.number(&["material", "poissonRatio"])?;
        if !(0.0..0.5).contains(&poisson) {
            return Err("Poisson ratio must be in [0,0.5)".to_owned());
        }
        let minimum_frequency = self.number(&["frequencyRange", "minimumHz"])?;
        let maximum_frequency = self.number(&["frequencyRange", "maximumHz"])?;
        if minimum_frequency <= 0.0 || maximum_frequency <= minimum_frequency {
            return Err("frequency range is invalid".to_owned());
        }
        let (solver_minimum, solver_maximum) =
            self.number_pair(&["solverRequest", "frequencyRangeHz"])?;
        if solver_minimum != minimum_frequency || solver_maximum != maximum_frequency {
            return Err("solver and runtime frequency ranges differ".to_owned());
        }
        for (label, path) in [
            ("actuator.direction", ["actuator", "direction"].as_slice()),
            (
                "virtualMicrophone.aimDirection",
                ["virtualMicrophone", "aimDirection"].as_slice(),
            ),
        ] {
            let norm = ["x", "y", "z"]
                .iter()
                .map(|axis| {
                    let mut component_path = path.to_vec();
                    component_path.push(*axis);
                    self.number(&component_path)
                })
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|value| value * value)
                .sum::<f64>()
                .sqrt();
            if (norm - 1.0).abs() > 1e-12 {
                return Err(format!("{label} must be a unit vector"));
            }
        }
        let actuator_x = self.number(&["actuator", "positionM", "x"])?;
        let actuator_y = self.number(&["actuator", "positionM", "y"])?;
        let actuator_footprint = self.number(&["actuator", "footprintRadiusM"])?;
        let actuator_radius = actuator_x.hypot(actuator_y);
        if actuator_radius - actuator_footprint <= hub
            || actuator_radius + actuator_footprint >= radius
        {
            return Err("actuator footprint must lie on the free annular surface".to_owned());
        }
        let microphone_x = self.number(&["virtualMicrophone", "positionM", "x"])?;
        let microphone_y = self.number(&["virtualMicrophone", "positionM", "y"])?;
        let microphone_z = self.number(&["virtualMicrophone", "positionM", "z"])?;
        let microphone_aperture = self.number(&["virtualMicrophone", "apertureRadiusM"])?;
        let microphone_aim_z = self.number(&["virtualMicrophone", "aimDirection", "z"])?;
        if microphone_x.hypot(microphone_y) + microphone_aperture >= radius
            || microphone_z <= self.number(&["geometry", "frontSurfaceZM"])?
            || microphone_aim_z >= 0.0
        {
            return Err("virtual microphone placement/aim is inconsistent".to_owned());
        }
        let requested_modes = self.usize(&["solverRequest", "requestedModeCount"])?;
        if requested_modes == 0 {
            return Err("at least one mode must be requested".to_owned());
        }
        let field_width = self.usize(&["mandelbrotField", "sampleResolution", "widthPx"])?;
        let field_height = self.usize(&["mandelbrotField", "sampleResolution", "heightPx"])?;
        let texture_width = self.usize(&["textureRequest", "widthPx"])?;
        let texture_height = self.usize(&["textureRequest", "heightPx"])?;
        if field_width != field_height || texture_width != texture_height {
            return Err("native v1 generation requires square fields and textures".to_owned());
        }
        let channels = self
            .value_at(&["textureRequest", "channels"])?
            .as_array()
            .ok_or_else(|| "$.textureRequest.channels must be an array".to_owned())?;
        let channel_set = channels
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "texture channel must be a string".to_owned())
            })
            .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
        let expected_channels = [
            "signed-displacement-r8",
            "normal-rg8",
            "nodal-mask-r8",
            "sand-density-r8",
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
        if channel_set != expected_channels {
            return Err("the v1 runtime requires all four scientific texture atlases".to_owned());
        }
        let levels = self.mesh_levels()?;
        if levels.len() != 3
            || levels[0].name != "coarse"
            || levels[1].name != "medium"
            || levels[2].name != "fine"
            || levels.windows(2).any(|pair| {
                pair[0].target_element_size_m <= pair[1].target_element_size_m
                    || pair[0].analysis_radial_element_count
                        >= pair[1].analysis_radial_element_count
                    || pair[0].analysis_maximum_fourier_order
                        >= pair[1].analysis_maximum_fourier_order
                    || pair[0].analysis_angular_samples >= pair[1].analysis_angular_samples
            })
            || levels.iter().any(|level| {
                level.analysis_angular_samples < 4 * level.analysis_maximum_fourier_order + 1
                    || 2 * level.analysis_radial_element_count
                        * (1 + 2 * level.analysis_maximum_fourier_order)
                        < requested_modes
            })
        {
            return Err(
                "v1 mesh and analysis discretization levels must refine coarse-to-fine".to_owned(),
            );
        }
        let mesh_quality = self.mesh_quality()?;
        if mesh_quality.minimum_edge_m <= 0.0
            || mesh_quality.minimum_signed_area_m2 <= 0.0
            || mesh_quality.maximum_aspect_ratio < 1.0
            || mesh_quality.required_connected_component_count != 1
            || mesh_quality.maximum_inverted_triangle_count != 0
            || mesh_quality.minimum_edge_m >= levels[2].target_element_size_m
        {
            return Err("mesh quality thresholds are invalid".to_owned());
        }
        Ok(())
    }
}

fn assert_string(spec: &PlateSpec, path: &[&str], expected: &str) -> Result<(), String> {
    let actual = spec.string(path)?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "{} must be {expected:?}, received {actual:?}",
            render_path(path)
        ))
    }
}

fn validate_finite_json(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Number(number) => {
            if number.is_finite() {
                Ok(())
            } else {
                Err(format!(
                    "{path} contains a non-finite or unsupported number"
                ))
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                validate_finite_json(child, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (key, child) in values {
                validate_finite_json(child, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn render_path(path: &[&str]) -> String {
    format!("$.{}", path.join("."))
}
