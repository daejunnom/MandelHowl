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
                Ok(MeshLevel {
                    name: name.to_owned(),
                    target_element_size_m: target,
                })
            })
            .collect()
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
        let poisson = self.number(&["material", "poissonRatio"])?;
        if !(0.0..0.5).contains(&poisson) {
            return Err("Poisson ratio must be in [0,0.5)".to_owned());
        }
        let minimum_frequency = self.number(&["frequencyRange", "minimumHz"])?;
        let maximum_frequency = self.number(&["frequencyRange", "maximumHz"])?;
        if minimum_frequency <= 0.0 || maximum_frequency <= minimum_frequency {
            return Err("frequency range is invalid".to_owned());
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
        self.mesh_levels()?;
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
