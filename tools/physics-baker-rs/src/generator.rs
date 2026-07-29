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
    pub coarse_radial: usize,
    pub coarse_angular: usize,
    pub medium_radial: usize,
    pub medium_angular: usize,
    pub fine_radial: usize,
    pub fine_angular: usize,
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
            coarse_radial: 24,
            coarse_angular: 64,
            medium_radial: 32,
            medium_angular: 80,
            fine_radial: 40,
            fine_angular: 96,
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
    let field_resolution = options.field_resolution.unwrap_or(spec.usize(&[
        "mandelbrotField",
        "sampleResolution",
        "widthPx",
    ])?);
    let texture_size = options
        .texture_size
        .unwrap_or(spec.usize(&["textureRequest", "widthPx"])?);
    let field = generate_material_field(&spec, &algorithm, field_resolution)?;
    let levels = spec.mesh_levels()?;
    let meshes = levels
        .iter()
        .map(|level| build_mesh_evidence(&spec, level))
        .collect::<Result<Vec<_>, _>>()?;
    let coarse = solve_modes(
        &spec,
        &algorithm,
        &field,
        options.coarse_radial,
        options.coarse_angular,
    )?;
    let medium = solve_modes(
        &spec,
        &algorithm,
        &field,
        options.medium_radial,
        options.medium_angular,
    )?;
    let fine = solve_modes(
        &spec,
        &algorithm,
        &field,
        options.fine_radial,
        options.fine_angular,
    )?;
    let convergence = convergence_report(&spec, &algorithm, &coarse, &medium, &fine)?;
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
