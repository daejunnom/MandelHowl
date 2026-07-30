use std::path::{Path, PathBuf};

use crate::algorithm::Algorithm;
use crate::dataset::{DatasetSemanticReport, validate_dataset_semantics};
use crate::field::generate_material_field;
use crate::json;
use crate::mesh::build_mesh_evidence;
use crate::packaging::{PackageOptions, package_dataset};
use crate::postprocess::postprocess;
use crate::solver::{convergence_report, solve_modes};
use crate::spec::PlateSpec;

#[derive(Debug, Clone)]
pub struct GenerateOptions {
    pub spec_path: PathBuf,
    pub output_root: PathBuf,
    pub coverage_report: Option<PathBuf>,
    pub release: bool,
    pub field_resolution: Option<usize>,
    pub texture_size: Option<usize>,
}

impl GenerateOptions {
    pub fn repository_defaults(repository: &Path) -> Self {
        Self {
            spec_path: repository.join("specs/plate/mandelbrot-plate.v1.yaml"),
            output_root: repository.join("assets/generated"),
            coverage_report: None,
            release: false,
            field_resolution: None,
            texture_size: None,
        }
    }
}

pub struct GenerateResult {
    pub dataset_path: PathBuf,
    pub semantic_report: DatasetSemanticReport,
    pub algorithm: Algorithm,
}

impl GenerateResult {
    pub fn to_json(&self) -> String {
        let value = json!({
            "schemaVersion": "mandelhowl.native-generation-result.v1",
            "backend": "rust-native",
            "status": "generated-and-validated",
            "algorithmRevision": self.algorithm.revision,
            "algorithmContractSha256": self.algorithm.contract_sha256,
            "datasetPath": self.dataset_path,
            "datasetId": self.semantic_report.dataset_id.as_str(),
            "manifestSha256": self.semantic_report.manifest_sha256.as_str(),
            "datasetSemanticReport": crate::json::from_str(
                &self.semantic_report.to_json()
            ).expect("native semantic report JSON is valid"),
        });
        String::from_utf8(crate::json::to_vec(&value).expect("generation JSON"))
            .expect("generation JSON is UTF-8")
    }
}

pub fn generate(options: &GenerateOptions) -> Result<GenerateResult, String> {
    let algorithm = Algorithm::load()?;
    let spec = PlateSpec::load(&options.spec_path)?;
    let canonical_field_resolution =
        spec.usize(&["mandelbrotField", "sampleResolution", "widthPx"])?;
    let canonical_texture_size = spec.usize(&["textureRequest", "widthPx"])?;
    let levels = spec.mesh_levels()?;
    validate_release_overrides(
        options,
        canonical_field_resolution,
        canonical_texture_size,
        &levels,
    )?;
    let field_resolution = options
        .field_resolution
        .unwrap_or(canonical_field_resolution);
    let texture_size = options.texture_size.unwrap_or(canonical_texture_size);
    let field = generate_material_field(&spec, &algorithm, field_resolution)?;
    let meshes = levels
        .iter()
        .map(|level| build_mesh_evidence(&spec, level))
        .collect::<Result<Vec<_>, _>>()?;
    let coarse = solve_modes(
        &spec,
        &algorithm,
        &field,
        levels[0].analysis_radial_element_count,
        levels[0].analysis_maximum_fourier_order,
        levels[0].analysis_angular_samples,
    )?;
    let medium = solve_modes(
        &spec,
        &algorithm,
        &field,
        levels[1].analysis_radial_element_count,
        levels[1].analysis_maximum_fourier_order,
        levels[1].analysis_angular_samples,
    )?;
    let fine = solve_modes(
        &spec,
        &algorithm,
        &field,
        levels[2].analysis_radial_element_count,
        levels[2].analysis_maximum_fourier_order,
        levels[2].analysis_angular_samples,
    )?;
    let convergence = convergence_report(&spec, &algorithm, &field, &coarse, &medium, &fine)?;
    let processed = postprocess(&spec, &algorithm, &field, &fine, texture_size)?;
    let dataset_path = package_dataset(
        &PackageOptions {
            output_root: options.output_root.clone(),
            external_coverage_path: options.coverage_report.clone(),
            release: options.release,
        },
        &spec,
        &algorithm,
        &field,
        &meshes,
        &fine,
        &convergence,
        &processed,
    )?;
    let semantic_report = validate_dataset_semantics(&dataset_path)?;
    Ok(GenerateResult {
        dataset_path,
        semantic_report,
        algorithm,
    })
}

fn validate_release_overrides(
    options: &GenerateOptions,
    field_resolution: usize,
    texture_size: usize,
    levels: &[crate::spec::MeshLevel],
) -> Result<(), String> {
    if !options.release {
        return Ok(());
    }
    if levels.len() != 3 {
        return Err("release generation requires exactly three canonical mesh levels".to_owned());
    }
    let candidates = [
        (
            "--field-resolution",
            options.field_resolution.unwrap_or(field_resolution),
            field_resolution,
        ),
        (
            "--texture-size",
            options.texture_size.unwrap_or(texture_size),
            texture_size,
        ),
    ];
    let mismatches = candidates
        .into_iter()
        .filter(|(_, actual, canonical)| actual != canonical)
        .map(|(flag, actual, canonical)| format!("{flag}={actual} (spec={canonical})"))
        .collect::<Vec<_>>();
    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "release generation forbids analysis overrides outside the content-addressed plate spec: {}",
            mismatches.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_rejects_noncanonical_asset_resolution_override() {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let spec =
            PlateSpec::load(&repository.join("specs/plate/mandelbrot-plate.v1.yaml")).unwrap();
        let levels = spec.mesh_levels().unwrap();
        let field_resolution = spec
            .usize(&["mandelbrotField", "sampleResolution", "widthPx"])
            .unwrap();
        let texture_size = spec.usize(&["textureRequest", "widthPx"]).unwrap();
        let mut options = GenerateOptions::repository_defaults(&repository);
        options.release = true;
        options.texture_size = Some(texture_size + 1);
        let error = validate_release_overrides(&options, field_resolution, texture_size, &levels)
            .unwrap_err();
        assert!(error.contains("--texture-size"));
        options.texture_size = Some(texture_size);
        validate_release_overrides(&options, field_resolution, texture_size, &levels).unwrap();
    }
}
