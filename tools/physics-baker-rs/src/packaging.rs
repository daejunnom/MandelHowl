use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use crate::algorithm::{ALGORITHM_CONTRACT_JSON, Algorithm};
use crate::field::{FieldStatistics, MaterialField};
use crate::json;
use crate::json::Value;
use crate::mesh::{MeshEvidence, build_mesh_archive};
use crate::postprocess::{PostprocessedDataset, RuntimeMode};
use crate::sha256::{digest, hex};
use crate::solver::{SolveResult, solver_evidence_binary};
use crate::spec::PlateSpec;

pub const IDENTITY_SCOPE: &str =
    "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests";
static TEMPORARY_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct PackageOptions {
    pub output_root: PathBuf,
    pub external_coverage_path: Option<PathBuf>,
    pub release: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn package_dataset(
    options: &PackageOptions,
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    meshes: &[MeshEvidence],
    fine_result: &SolveResult,
    convergence: &Value,
    postprocessed: &PostprocessedDataset,
) -> Result<PathBuf, String> {
    fs::create_dir_all(&options.output_root).map_err(|error| {
        format!(
            "unable to create output root {}: {error}",
            options.output_root.display()
        )
    })?;
    let output_root = options
        .output_root
        .canonicalize()
        .map_err(|error| format!("unable to resolve output root: {error}"))?;
    let temporary = create_temporary_directory(&output_root)?;
    let result = package_into(
        &temporary,
        &output_root,
        options,
        spec,
        algorithm,
        field,
        meshes,
        fine_result,
        convergence,
        postprocessed,
    );
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn package_into(
    temporary: &Path,
    output_root: &Path,
    options: &PackageOptions,
    spec: &PlateSpec,
    algorithm: &Algorithm,
    field: &MaterialField,
    meshes: &[MeshEvidence],
    fine_result: &SolveResult,
    convergence: &Value,
    postprocessed: &PostprocessedDataset,
) -> Result<PathBuf, String> {
    write_bytes(temporary, "plate-spec.json", &spec.canonical_json)?;
    write_bytes(temporary, "field/mandelbrot-field.bin", &field.to_binary()?)?;
    write_bytes(
        temporary,
        "science/baker-algorithm.v1.json",
        ALGORITHM_CONTRACT_JSON.as_bytes(),
    )?;
    let mesh_report = json!({
        "schemaVersion": "mandelhowl.mesh-evidence.v1",
        "domain": "annulus from clamped hub radius to free outer rim",
        "levels": meshes.iter().map(MeshEvidence::to_json).collect::<Vec<_>>(),
        "qualityPolicy": {
            "negativeAreaAllowed": false,
            "disconnectedComponentsAllowed": false,
            "fingerprint": "sha256 over float64 node positions and uint32 triangle indices",
        },
    });
    write_json(temporary, "mesh/mesh-evidence.json", &mesh_report)?;
    let levels = spec.mesh_levels()?;
    let fine_level = levels
        .last()
        .ok_or_else(|| "plate spec has no fine mesh level".to_owned())?;
    write_bytes(
        temporary,
        "mesh/fine-polar-mesh.mhmz",
        &build_mesh_archive(spec, fine_level)?,
    )?;
    write_bytes(temporary, "modes.bin", &postprocessed.modes_binary)?;
    write_bytes(temporary, "response.bin", &postprocessed.response_binary)?;
    write_bytes(
        temporary,
        "science/solver-evidence.bin",
        &solver_evidence_binary(fine_result)?,
    )?;
    for (kind, bytes) in &postprocessed.textures {
        write_bytes(temporary, &format!("textures/{kind}.ktx2"), bytes)?;
    }

    let (coverage, coverage_source) = if let Some(path) = &options.external_coverage_path {
        let source = fs::read_to_string(path).map_err(|error| {
            format!("unable to read coverage report {}: {error}", path.display())
        })?;
        let coverage: Value = crate::json::from_str(&source)
            .map_err(|error| format!("coverage report JSON is invalid: {error}"))?;
        validate_external_coverage(&coverage, options.release)?;
        (coverage, "external-runtime-replay-report")
    } else {
        if options.release {
            return Err("--release requires --coverage-report".to_owned());
        }
        (
            foundation_coverage(&postprocessed.modes, algorithm),
            "baker-physical-search-foundation",
        )
    };
    write_json(temporary, "coverage-report.json", &coverage)?;

    let mut convergence = convergence.clone();
    let convergence_object = convergence
        .as_object_mut()
        .ok_or_else(|| "convergence report must be an object".to_owned())?;
    convergence_object.insert(
        "meshEvidence".to_owned(),
        Value::Array(meshes.iter().map(MeshEvidence::to_json).collect()),
    );
    let mut cross_validation = postprocessed.cross_validation.clone();
    let checks = cross_validation
        .get("frequencyChecks")
        .and_then(Value::as_array)
        .ok_or_else(|| "cross-validation frequency checks are missing".to_owned())?;
    let cross_accepted = checks.iter().all(|row| {
        row.get("relativeDifference")
            .and_then(Value::as_f64)
            .is_some_and(|difference| difference <= algorithm.cross_validation_tolerance)
    });
    let cross_object = cross_validation
        .as_object_mut()
        .ok_or_else(|| "cross-validation report must be an object".to_owned())?;
    cross_object.insert(
        "criterion".to_owned(),
        json!({
            "maximumRelativeFrequencyDifference": algorithm.cross_validation_tolerance,
        }),
    );
    cross_object.insert("accepted".to_owned(), Value::Bool(cross_accepted));
    let quadrature_accepted = convergence_object
        .get("accepted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    convergence_object.insert("independentCrossValidation".to_owned(), cross_validation);
    convergence_object.insert(
        "quadratureConvergenceAccepted".to_owned(),
        Value::Bool(quadrature_accepted),
    );
    convergence_object.insert(
        "accepted".to_owned(),
        Value::Bool(quadrature_accepted && cross_accepted),
    );
    if !quadrature_accepted || !cross_accepted {
        return Err(
            "physics convergence failed: quadrature and independent finite-difference \
             cross-validation must both pass"
                .to_owned(),
        );
    }
    write_json(temporary, "convergence-report.json", &convergence)?;

    let solver_options = json!({
        "method": "variable-thickness-kirchhoff-love-rayleigh-ritz",
        "algorithmRevision": algorithm.revision,
        "algorithmContractSha256": algorithm.contract_sha256,
        "basisCount": fine_result.basis.len(),
        "quadrature": {
            "radialSamples": fine_result.quadrature.radial_samples,
            "angularSamples": fine_result.quadrature.angular_samples,
            "pointCount": fine_result.quadrature.radial_samples * fine_result.quadrature.angular_samples,
        },
        "finiteDifferenceHessianStepRatio": algorithm.hessian_step_ratio,
        "floatPrecision": "binary64",
        "fastMath": false,
        "randomSource": "forbidden",
    });
    let options_sha256 = hex(&digest(&canonical_json_bytes(&solver_options)?));
    let environment_sentinel = hex(&digest(
        b"not-containerized:rust-std:mandelhowl-physics-baker-native-1",
    ));
    let mode_summaries = postprocessed
        .modes
        .iter()
        .map(mode_summary)
        .collect::<Vec<_>>();
    let provenance = json!({
        "schemaVersion": "mandelhowl.provenance.v1",
        "generator": {
            "name": "tools/physics-baker-rs",
            "version": env!("CARGO_PKG_VERSION"),
            "dependencies": "Rust native; locked Cargo workspace",
            "algorithmRevision": algorithm.revision,
            "algorithmContractSha256": algorithm.contract_sha256,
            "randomSource": "forbidden",
        },
        "canonicalInput": {
            "plateId": spec.string(&["plateId"])?,
            "path": "specs/plate/mandelbrot-plate.v1.yaml",
            "canonicalJsonSha256": spec.canonical_sha256,
        },
        "solver": {
            "name": "mandelhowl-kirchhoff-love-rayleigh-ritz",
            "version": env!("CARGO_PKG_VERSION"),
            "options": solver_options,
            "optionsSha256": options_sha256,
            "containerized": false,
            "containerImageDigest": format!("sha256:{environment_sentinel}"),
            "containerDigestMeaning": "Explicit deterministic sentinel for an uncontainerized Rust run; it is not evidence that a container image was executed.",
            "canonicalRequest": {
                "elementFamily": spec.string(&["solverRequest", "elementFamily"])?,
                "requestedModeCount": spec.usize(&["solverRequest", "requestedModeCount"])?,
            },
            "executedMethod": "global-rayleigh-ritz-thin-plate-basis",
            "methodRequestMismatchRecorded": spec.string(&["solverRequest", "elementFamily"])? != "kirchhoff-love-thin-plate",
            "normalization": "unit-modal-mass",
            "signRule": "positive-at-actuator-or-first-nonzero-node",
            "eigensolver": {
                "name": "cyclic-jacobi-generalized-symmetric",
                "sweeps": fine_result.eigensolver.sweeps,
                "finalMaximumOffDiagonal": fine_result.eigensolver.final_maximum_off_diagonal,
            },
        },
        "manufacturing": field_statistics_json(&field.statistics),
        "mesh": mesh_report,
        "convergenceReport": "convergence-report.json",
        "coverage": {
            "path": "coverage-report.json",
            "source": coverage_source,
            "releaseBake": options.release,
        },
        "response": postprocessed.response_metadata,
        "textures": {
            "requested": spec.value_at(&["textureRequest"])?,
            "emittedRuntimeLod": postprocessed.texture_metadata,
            "precisionStatement": "The emitted uncompressed R8/RG8 KTX2 arrays match the canonical runtime request and are derived from float64 solver modes. No Basis/UASTC block compression is claimed.",
        },
        "modes": mode_summaries,
        "scientificScope": {
            "established": [
                "finite-resolution Mandelbrot field mapped into thickness",
                "variable-thickness Kirchhoff-Love bending energy",
                "generalized eigenproblem with unit-modal-mass normalization",
                "nodal/low-velocity sand-density postprocessing",
            ],
            "limitations": [
                "Rayleigh-Ritz global basis is not a shell finite-element solve",
                "the clamped hub is represented as an annular essential boundary",
                "air loading, nonlinear material response, and grain dynamics are omitted",
                "the independent finite-difference check is a reduced cross-check, not certification",
                "runtime textures are a quantized LOD of float64 solver fields",
            ],
            "claimPolicy": "The Mandelbrot iteration defines a finite material field; it does not directly generate sound or guarantee Mandelbrot-shaped sand.",
        },
        "extraEvidenceFiles": [
            "field/mandelbrot-field.bin",
            "mesh/mesh-evidence.json",
            "mesh/fine-polar-mesh.mhmz",
            "science/baker-algorithm.v1.json",
            "science/solver-evidence.bin",
        ],
    });
    write_json(temporary, "provenance.json", &provenance)?;

    let manufacturing_passed = [
        field.statistics.mass_within_limits,
        field.statistics.centre_of_mass_within_limit,
        field.statistics.gradient_within_limit,
        field.statistics.minimum_thickness_within_limit,
        field.statistics.minimum_feature_within_limit,
    ]
    .into_iter()
    .all(|value| value);
    let mesh_passed = meshes.iter().all(|mesh| {
        mesh.inverted_triangle_count == 0
            && mesh.connected_component_count == 1
            && mesh.minimum_signed_area_m2 > 0.0
    });
    if !manufacturing_passed {
        return Err("manufacturing checks failed".to_owned());
    }
    if !mesh_passed {
        return Err("mesh checks failed".to_owned());
    }
    let generation_report = json!({
        "schemaVersion": "mandelhowl.generation-report.v1",
        "deterministic": true,
        "releaseBake": options.release,
        "backend": "rust-native",
        "algorithmRevision": algorithm.revision,
        "manufacturingChecksPassed": manufacturing_passed,
        "meshChecksPassed": mesh_passed,
        "convergenceChecksPassed": true,
        "coverageSource": coverage_source,
        "knownContractDeviations": [],
    });
    write_json(temporary, "generation-report.json", &generation_report)?;

    let inventory_paths = inventory_paths(temporary)?;
    let checksum_rows = inventory_paths
        .iter()
        .map(|relative| {
            let path = temporary.join(relative);
            Ok(json!({
                "path": normalize_relative(relative),
                "byteLength": file_length(&path)?,
                "sha256": file_sha256(&path)?,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let checksums = json!({
        "schemaVersion": "mandelhowl.checksums.v1",
        "algorithm": "sha256",
        "files": checksum_rows,
    });
    write_json(temporary, "checksums.json", &checksums)?;

    let mode_ids = postprocessed
        .modes
        .iter()
        .map(|mode| mode.mode_id.clone())
        .collect::<Vec<_>>();
    let mut texture_descriptors = Vec::new();
    for kind in [
        "signed-displacement",
        "normal",
        "nodal-mask",
        "sand-density",
    ] {
        let path = format!("textures/{kind}.ktx2");
        let mut descriptor = asset_descriptor(temporary, &path, "image/ktx2")?;
        let object = descriptor
            .as_object_mut()
            .expect("asset descriptor is an object");
        object.insert("kind".to_owned(), Value::String(kind.to_owned()));
        object.insert(
            "modeIds".to_owned(),
            Value::Array(mode_ids.iter().cloned().map(Value::String).collect()),
        );
        let metadata = postprocessed
            .texture_metadata
            .get(kind)
            .ok_or_else(|| format!("texture metadata is missing {kind}"))?;
        object.insert(
            "widthPx".to_owned(),
            metadata
                .get("widthPx")
                .cloned()
                .ok_or_else(|| format!("{kind} width metadata is missing"))?,
        );
        object.insert(
            "heightPx".to_owned(),
            metadata
                .get("heightPx")
                .cloned()
                .ok_or_else(|| format!("{kind} height metadata is missing"))?,
        );
        object.insert("layers".to_owned(), json!(mode_ids.len()));
        object.insert(
            "uvOrigin".to_owned(),
            Value::String("negative-x-negative-y".to_owned()),
        );
        texture_descriptors.push(descriptor);
    }
    let mut manifest = json!({
        "schemaVersion": "mandelhowl.resonance-manifest.v1",
        "algorithmRevision": algorithm.revision,
        "ownership": {
            "kind": "generated",
            "generator": "tools/physics-baker-rs",
            "policy": "immutable-regenerate",
        },
        "contentAddressing": {
            "algorithm": "sha256",
            "canonicalization": "RFC8785",
            "identityScope": IDENTITY_SCOPE,
        },
        "plate": {
            "plateId": spec.string(&["plateId"])?,
            "specSha256": spec.canonical_sha256,
        },
        "runtimeCompatibility": {
            "minimumRuntimeVersion": "0.1.0",
            "maximumRuntimeVersionExclusive": "1.0.0",
            "modeBinaryFormat": "mandelhowl-modes-v1",
            "responseBinaryFormat": "mandelhowl-response-v1",
        },
        "units": spec.value_at(&["units"])?,
        "coordinateSystem": spec.value_at(&["coordinateSystem"])?,
        "modeCount": postprocessed.modes.len(),
        "frequencyRange": {
            "minimumHz": spec.value_at(&["frequencyRange", "minimumHz"])?,
            "maximumHz": spec.value_at(&["frequencyRange", "maximumHz"])?,
        },
        "solverProvenance": {
            "solverName": "mandelhowl-kirchhoff-love-rayleigh-ritz",
            "solverVersion": env!("CARGO_PKG_VERSION"),
            "containerImageDigest": format!("sha256:{environment_sentinel}"),
            "optionsSha256": options_sha256,
        },
        "files": {
            "plateSpec": asset_descriptor(temporary, "plate-spec.json", "application/json")?,
            "modes": asset_descriptor(temporary, "modes.bin", "application/vnd.mandelhowl.modes-v1")?,
            "response": asset_descriptor(temporary, "response.bin", "application/vnd.mandelhowl.response-v1")?,
            "textures": texture_descriptors,
            "provenance": asset_descriptor(temporary, "provenance.json", "application/json")?,
            "convergenceReport": asset_descriptor(temporary, "convergence-report.json", "application/json")?,
            "coverageReport": asset_descriptor(temporary, "coverage-report.json", "application/json")?,
            "checksums": asset_descriptor(temporary, "checksums.json", "application/json")?,
        },
    });
    let identity_digest = {
        let mut identity = manifest.clone();
        let object = identity
            .as_object_mut()
            .ok_or_else(|| "manifest must be an object".to_owned())?;
        object.remove("datasetId");
        object
            .get_mut("contentAddressing")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "manifest contentAddressing is invalid".to_owned())?
            .remove("directoryName");
        hex(&digest(&canonical_json_bytes(&identity)?))
    };
    let manifest_object = manifest
        .as_object_mut()
        .ok_or_else(|| "manifest must be an object".to_owned())?;
    manifest_object.insert(
        "datasetId".to_owned(),
        Value::String(format!("sha256:{identity_digest}")),
    );
    manifest_object
        .get_mut("contentAddressing")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "manifest contentAddressing is invalid".to_owned())?
        .insert(
            "directoryName".to_owned(),
            Value::String(identity_digest.clone()),
        );
    write_json(temporary, "manifest.json", &manifest)?;

    let destination = output_root.join(&identity_digest);
    if destination.exists() {
        let existing_manifest = destination.join("manifest.json");
        if !existing_manifest.is_file()
            || fs::read(&existing_manifest)
                .map_err(|error| format!("unable to read existing manifest: {error}"))?
                != fs::read(temporary.join("manifest.json"))
                    .map_err(|error| format!("unable to read temporary manifest: {error}"))?
        {
            return Err(format!(
                "content-addressed destination exists with different content: {}",
                destination.display()
            ));
        }
        fs::remove_dir_all(temporary)
            .map_err(|error| format!("unable to remove duplicate temporary dataset: {error}"))?;
        return Ok(destination);
    }
    fs::rename(temporary, &destination).map_err(|error| {
        format!(
            "unable to promote native dataset {}: {error}",
            destination.display()
        )
    })?;
    Ok(destination)
}

fn foundation_coverage(modes: &[RuntimeMode], algorithm: &Algorithm) -> Value {
    let mut strongest = modes.iter().collect::<Vec<_>>();
    strongest.sort_by(|left, right| {
        let left = (left.actuator_coupling * left.microphone_coupling).abs();
        let right = (right.actuator_coupling * right.microphone_coupling).abs();
        right.partial_cmp(&left).unwrap_or(Ordering::Equal)
    });
    let outputs = (0..=100)
        .map(|target| {
            let anchor = strongest[target % strongest.len()];
            let fraction = target as f64 / 100.0;
            let dwell = if target == 0 {
                0.0
            } else {
                -(algorithm
                    .coverage_minimum_log_argument
                    .max(1.0 - algorithm.coverage_maximum_fraction * fraction))
                .ln()
                    / algorithm.coverage_capture_rate
            };
            let approach = if target % 2 == 0 { 1 } else { -1 };
            json!({
                "target": target,
                "verification": "candidate-requires-runtime-replay",
                "physicalAnchor": {
                    "modeId": anchor.mode_id,
                    "naturalFrequencyHz": anchor.natural_frequency_hz,
                    "approachDirection": approach,
                    "estimatedDwellSeconds": dwell,
                    "detuneRatio": (algorithm.coverage_base_detune
                        + algorithm.coverage_detune_step
                            * (target % algorithm.coverage_detune_cycle) as f64)
                        * approach as f64,
                },
            })
        })
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": "mandelhowl.coverage-report.v1",
        "verificationStatus": "physics-foundation-only",
        "model": "global-exponential-modal-capture-seed-v1",
        "perValueRuntimeExceptionTable": false,
        "targetRange": [0, 100],
        "outputs": outputs,
        "releaseEligible": false,
        "note": "These are deterministic search seeds derived from baked mode coupling. A release bake must inject the runtime engine's replay-verified report with --coverage-report and --release.",
    })
}

fn validate_external_coverage(report: &Value, release: bool) -> Result<(), String> {
    let outputs = report
        .get("outputs")
        .and_then(Value::as_array)
        .ok_or_else(|| "coverage report must contain an outputs array".to_owned())?;
    let mut targets = outputs
        .iter()
        .map(|row| {
            row.get("target")
                .and_then(Value::as_u64)
                .ok_or_else(|| "coverage output target is invalid".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    targets.sort_unstable();
    if targets != (0_u64..=100).collect::<Vec<_>>() {
        return Err(
            "coverage report must contain exactly one entry for every target 0..100".to_owned(),
        );
    }
    if report
        .get("perValueRuntimeExceptionTable")
        .and_then(Value::as_bool)
        != Some(false)
    {
        return Err("coverage report must explicitly deny per-value runtime exceptions".to_owned());
    }
    if release {
        let accepted_status = matches!(
            report.get("verificationStatus").and_then(Value::as_str),
            Some("runtime-replay-verified" | "verified" | "complete")
        );
        if !accepted_status {
            return Err(
                "release bake requires a runtime-replay-verified coverage report".to_owned(),
            );
        }
        let unverified = outputs.iter().filter(|row| {
            !matches!(
                row.get("verification").and_then(Value::as_str),
                Some("verified" | "runtime-replay-verified")
            ) && row.get("verified").and_then(Value::as_bool) != Some(true)
        });
        if unverified.count() != 0 {
            return Err("release coverage has unverified targets".to_owned());
        }
    }
    Ok(())
}

fn field_statistics_json(statistics: &FieldStatistics) -> Value {
    json!({
        "analysisResolutionPx": statistics.analysis_resolution_px,
        "pixelPitchM": statistics.pixel_pitch_m,
        "filterRadiusPx": statistics.filter_radius_px,
        "manufacturingBevelPasses": statistics.manufacturing_bevel_passes,
        "actualMinimumFeatureM": statistics.actual_minimum_feature_m,
        "minimumFeatureMeasurement": "conservative close/open structuring-element diameter on the sampled field",
        "quantizationLevels": statistics.quantization_levels,
        "minimumThicknessM": statistics.minimum_thickness_m,
        "maximumThicknessM": statistics.maximum_thickness_m,
        "maximumThicknessGradient": statistics.maximum_thickness_gradient,
        "totalMassKg": statistics.total_mass_kg,
        "centreOfMassXM": statistics.centre_of_mass_x_m,
        "centreOfMassYM": statistics.centre_of_mass_y_m,
        "centreOfMassOffsetM": statistics.centre_of_mass_offset_m,
        "massWithinLimits": statistics.mass_within_limits,
        "centreOfMassWithinLimit": statistics.centre_of_mass_within_limit,
        "gradientWithinLimit": statistics.gradient_within_limit,
        "minimumThicknessWithinLimit": statistics.minimum_thickness_within_limit,
        "minimumFeatureWithinLimit": statistics.minimum_feature_within_limit,
    })
}

fn mode_summary(mode: &RuntimeMode) -> Value {
    json!({
        "modeId": mode.mode_id,
        "ordinal": mode.ordinal,
        "naturalFrequencyHz": mode.natural_frequency_hz,
        "dampingRatio": mode.damping_ratio,
        "actuatorCoupling": mode.actuator_coupling,
        "microphoneCoupling": mode.microphone_coupling,
        "radiationEfficiency": mode.radiation_efficiency,
        "dominantBasis": {
            "radialOrder": mode.dominant_radial_order,
            "angularOrder": mode.dominant_angular_order,
            "symmetry": mode.dominant_symmetry,
        },
        "signReference": mode.sign_reference,
        "textureLayer": mode.texture_layer,
    })
}

fn create_temporary_directory(output_root: &Path) -> Result<PathBuf, String> {
    for _ in 0..100 {
        let counter = TEMPORARY_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let path = output_root.join(format!(
            ".mandelhowl-native-bake-{}-{counter}",
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "unable to create temporary dataset {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Err("unable to allocate a unique native bake directory".to_owned())
}

fn write_bytes(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("unable to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, bytes).map_err(|error| format!("unable to write {}: {error}", path.display()))
}

fn write_json(root: &Path, relative: &str, value: &Value) -> Result<(), String> {
    let mut bytes = crate::json::to_vec_pretty(value)
        .map_err(|error| format!("unable to serialize {relative}: {error}"))?;
    bytes.push(b'\n');
    write_bytes(root, relative, &bytes)
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    crate::json::to_vec(value).map_err(|error| format!("canonical JSON failed: {error}"))
}

fn asset_descriptor(root: &Path, relative: &str, media_type: &str) -> Result<Value, String> {
    let path = root.join(relative);
    Ok(json!({
        "path": relative.replace('\\', "/"),
        "byteLength": file_length(&path)?,
        "sha256": file_sha256(&path)?,
        "mediaType": media_type,
    }))
}

fn file_length(path: &Path) -> Result<u64, String> {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| format!("unable to stat {}: {error}", path.display()))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("unable to read {}: {error}", path.display()))?;
    Ok(hex(&digest(&bytes)))
}

fn inventory_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(root: &Path, directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("unable to inventory {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| format!("unable to read inventory row: {error}"))?;
            let path = entry.path();
            if path.is_dir() {
                visit(root, &path, output)?;
            } else if path.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "inventory path escaped dataset root".to_owned())?;
                let name = relative.file_name().and_then(|value| value.to_str());
                if !matches!(name, Some("manifest.json" | "checksums.json")) {
                    output.push(relative.to_path_buf());
                }
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    visit(root, root, &mut paths)?;
    paths.sort_by_key(|path| normalize_relative(path));
    Ok(paths)
}

fn normalize_relative(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
