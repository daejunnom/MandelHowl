use std::env;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use mandelhowl_baker_native::{validate_modes_v1, validate_response_v1};

fn json_string(value: &str) -> String {
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

fn contract() {
    println!(
        "{{\"schemaVersion\":\"mandelhowl.native-baker-capabilities.v1\",\
         \"backend\":\"rust-native\",\
         \"generate\":false,\
         \"validate\":true,\
         \"binaryContracts\":[\"modes-v1\",\"response-v1\"]}}"
    );
}

fn validate(dataset_root: &Path) -> Result<(), String> {
    let modes = fs::read(dataset_root.join("modes.bin"))
        .map_err(|error| format!("unable to read modes.bin: {error}"))?;
    let response = fs::read(dataset_root.join("response.bin"))
        .map_err(|error| format!("unable to read response.bin: {error}"))?;
    let modes = validate_modes_v1(&modes)?;
    let response = validate_response_v1(&response)?;
    println!(
        "{{\"schemaVersion\":\"mandelhowl.native-baker-validation.v1\",\
         \"backend\":\"rust-native\",\
         \"status\":\"valid\",\
         \"modeCount\":{},\
         \"responseSampleCount\":{},\
         \"firstModeId\":{},\
         \"lastModeId\":{},\
         \"minimumModeFrequencyHz\":{},\
         \"maximumModeFrequencyHz\":{},\
         \"minimumResponseFrequencyHz\":{},\
         \"maximumResponseFrequencyHz\":{}}}",
        modes.count,
        response.sample_count,
        json_string(&modes.first_mode_id),
        json_string(&modes.last_mode_id),
        modes.minimum_frequency_hz,
        modes.maximum_frequency_hz,
        response.minimum_frequency_hz,
        response.maximum_frequency_hz,
    );
    Ok(())
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    match arguments.next().as_deref() {
        Some("contract") => {
            contract();
            Ok(())
        }
        Some("validate") => {
            let dataset_root = arguments
                .next()
                .ok_or_else(|| "validate requires a dataset directory".to_owned())?;
            if arguments.next().is_some() {
                return Err("validate accepts exactly one dataset directory".to_owned());
            }
            validate(Path::new(&dataset_root))
        }
        Some("generate") => Err(
            "native generation is not implemented yet; keep the Python baker as the oracle"
                .to_owned(),
        ),
        _ => Err("usage: mandelhowl-baker-native <contract|validate|generate> [path]".to_owned()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("mandelhowl-baker-native: {error}");
            ExitCode::from(2)
        }
    }
}
