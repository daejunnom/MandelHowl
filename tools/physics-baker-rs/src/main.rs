use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use mandelhowl_baker_native::algorithm::Algorithm;
use mandelhowl_baker_native::dataset::{json_string, validate_dataset_semantics};
use mandelhowl_baker_native::generator::{GenerateOptions, generate};
use mandelhowl_baker_native::ktx2::write_ktx2_array;
use mandelhowl_baker_native::sha256::{digest, hex};
use mandelhowl_baker_native::solver::{build_basis, hermite_shapes};
use mandelhowl_baker_native::{MODE_RECORD_BYTES, decode_modes_v1};

const EXIT_USAGE_OR_DATA: u8 = 2;
const EXIT_INTERNAL: u8 = 3;

fn contract() -> Result<(), String> {
    let algorithm = Algorithm::load()?;
    println!(
        concat!(
            "{{",
            "\"schemaVersion\":\"mandelhowl.native-baker-capabilities.v1\",",
            "\"backend\":\"rust-native\",",
            "\"backendVersion\":{},",
            "\"algorithmRevision\":{},",
            "\"algorithmContractSha256\":{},",
            "\"generate\":true,",
            "\"validate\":true,",
            "\"selfTest\":true,",
            "\"semanticDigest\":true,",
            "\"fullDatasetGeneration\":true,",
            "\"pythonSubprocess\":false,",
            "\"binaryContracts\":[\"modes-v1\",\"response-v1\",\"field-v1\",",
            "\"solver-evidence-v1\",\"portable-ktx2-array-v1\"],",
            "\"commands\":[\"contract\",\"self-test\",\"generate\",\"validate\",",
            "\"semantic-digest\"]",
            "}}"
        ),
        json_string(env!("CARGO_PKG_VERSION")),
        json_string(&algorithm.revision),
        json_string(&algorithm.contract_sha256),
    );
    Ok(())
}

fn validate(dataset_root: &Path) -> Result<(), String> {
    let report = validate_dataset_semantics(dataset_root)?;
    println!("{}", report.to_json());
    Ok(())
}

fn self_test() -> Result<(), String> {
    let algorithm = Algorithm::load()?;
    if [
        build_basis(3, 7)?.len(),
        build_basis(4, 8)?.len(),
        build_basis(5, 9)?.len(),
    ] != [90, 136, 190]
    {
        return Err("finite-strip basis dimensions are incompatible".to_owned());
    }
    let start = hermite_shapes(0.0, 0.03)?;
    let end = hermite_shapes(1.0, 0.03)?;
    if start.map(|row| row[0]) != [1.0, 0.0, 0.0, 0.0]
        || end.map(|row| row[0]) != [0.0, 0.0, 1.0, 0.0]
        || start.map(|row| row[1]) != [0.0, 1.0, 0.0, 0.0]
        || end.map(|row| row[1]) != [0.0, 0.0, 0.0, 1.0]
    {
        return Err("finite-strip Hermite endpoint identities failed".to_owned());
    }
    if hex(&digest(b"abc")) != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
        return Err("SHA-256 self-test failed".to_owned());
    }
    let texture_pixels = (0..32 * 32)
        .map(|index| ((index / 16) % 16) as u8)
        .collect::<Vec<_>>();
    let texture = write_ktx2_array(32, 32, 1, 1, &texture_pixels)?;
    if texture.len() < 108 || &texture[..12] != b"\xabKTX 20\xbb\r\n\x1a\n" {
        return Err("KTX2 writer self-test failed".to_owned());
    }
    let mut modes = vec![0_u8; 16 + MODE_RECORD_BYTES];
    modes[..8].copy_from_slice(b"MHMODES1");
    modes[8..10].copy_from_slice(&1_u16.to_le_bytes());
    modes[10..12].copy_from_slice(&16_u16.to_le_bytes());
    modes[12..16].copy_from_slice(&1_u32.to_le_bytes());
    modes[16..24].copy_from_slice(b"mode-001");
    modes[40..44].copy_from_slice(&1_u32.to_le_bytes());
    modes[48..56].copy_from_slice(&220.0_f64.to_le_bytes());
    modes[56..64].copy_from_slice(&(220.0_f64 * std::f64::consts::TAU).to_le_bytes());
    modes[64..72].copy_from_slice(&0.01_f64.to_le_bytes());
    if decode_modes_v1(&modes)?.len() != 1 {
        return Err("modes-v1 decoder self-test failed".to_owned());
    }
    println!(
        "{{\"schemaVersion\":\"mandelhowl.native-self-test.v1\",\
         \"backend\":\"rust-native\",\"status\":\"pass\",\
         \"algorithmRevision\":{},\"algorithmContractSha256\":{},\
         \"checks\":7}}",
        json_string(&algorithm.revision),
        json_string(&algorithm.contract_sha256),
    );
    Ok(())
}

fn run_generate(arguments: Vec<String>) -> Result<(), String> {
    let current = env::current_dir()
        .map_err(|error| format!("unable to determine current directory: {error}"))?;
    let mut options = GenerateOptions::repository_defaults(&current);
    let mut index = 0;
    while index < arguments.len() {
        let flag = &arguments[index];
        match flag.as_str() {
            "--release" => {
                options.release = true;
                index += 1;
            }
            "--spec" => {
                options.spec_path = path_argument(&arguments, index, flag)?;
                index += 2;
            }
            "--output-root" => {
                options.output_root = path_argument(&arguments, index, flag)?;
                index += 2;
            }
            "--coverage-report" => {
                options.coverage_report = Some(path_argument(&arguments, index, flag)?);
                index += 2;
            }
            "--field-resolution" => {
                options.field_resolution = Some(integer_argument(&arguments, index, flag)?);
                index += 2;
            }
            "--texture-size" => {
                options.texture_size = Some(integer_argument(&arguments, index, flag)?);
                index += 2;
            }
            _ => return Err(format!("generate received unknown option {flag:?}")),
        }
    }
    let result = generate(&options)?;
    println!("{}", result.to_json());
    Ok(())
}

fn path_argument(arguments: &[String], index: usize, flag: &str) -> Result<PathBuf, String> {
    arguments
        .get(index + 1)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{flag} requires a path"))
}

fn integer_argument(arguments: &[String], index: usize, flag: &str) -> Result<usize, String> {
    let value = arguments
        .get(index + 1)
        .ok_or_else(|| format!("{flag} requires an integer"))?;
    let value = value
        .parse::<usize>()
        .map_err(|_| format!("{flag} requires a non-negative integer"))?;
    if value == 0 {
        Err(format!("{flag} must be positive"))
    } else {
        Ok(value)
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    match arguments.next().as_deref() {
        Some("contract") => {
            if arguments.next().is_some() {
                return Err("contract accepts no arguments".to_owned());
            }
            contract()
        }
        Some("self-test") => {
            if arguments.next().is_some() {
                return Err("self-test accepts no arguments".to_owned());
            }
            self_test()
        }
        Some("validate" | "semantic-digest") => {
            let dataset_root = arguments
                .next()
                .ok_or_else(|| "validation requires a dataset directory".to_owned())?;
            if arguments.next().is_some() {
                return Err("validation accepts exactly one dataset directory".to_owned());
            }
            validate(Path::new(&dataset_root))
        }
        Some("generate") => run_generate(arguments.collect()),
        _ => Err("usage: mandelhowl-baker-native \
             <contract|self-test|generate|validate|semantic-digest> [arguments]"
            .to_owned()),
    }
}

fn diagnostic(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    let code = if lower.contains("usage")
        || lower.contains("unknown option")
        || lower.contains("requires")
    {
        "MH_NATIVE_USAGE_INVALID"
    } else if lower.contains("unable to read")
        || lower.contains("missing")
        || lower.contains("not a directory")
    {
        "MH_NATIVE_INPUT_MISSING"
    } else if lower.contains("convergence")
        || lower.contains("eigensolver")
        || lower.contains("mass matrix")
    {
        "MH_NATIVE_SOLVER_FAILED"
    } else {
        "MH_NATIVE_DATASET_INVALID"
    };
    format!(
        "{{\"schemaVersion\":\"mandelhowl.native-baker-diagnostic.v1\",\
         \"backend\":\"rust-native\",\"status\":\"failed\",\"code\":{},\
         \"message\":{}}}",
        json_string(code),
        json_string(error),
    )
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", diagnostic(&error));
            if error.contains("internal invariant") {
                ExitCode::from(EXIT_INTERNAL)
            } else {
                ExitCode::from(EXIT_USAGE_OR_DATA)
            }
        }
    }
}
