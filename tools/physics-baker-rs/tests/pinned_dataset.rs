use std::env;
use std::fs;
use std::path::PathBuf;

use mandelhowl_baker_native::{validate_modes_v1, validate_response_v1};

fn required_environment(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} must be supplied by the parity runner"))
}

#[test]
#[ignore = "run through npm run physics:validate with pinned manifest expectations"]
fn validates_pinned_dataset() {
    let dataset_root = PathBuf::from(required_environment("MANDELHOWL_PINNED_DATASET"));
    let modes = validate_modes_v1(
        &fs::read(dataset_root.join("modes.bin")).expect("read pinned modes.bin"),
    )
    .expect("validate pinned modes.bin");
    let response = validate_response_v1(
        &fs::read(dataset_root.join("response.bin")).expect("read pinned response.bin"),
    )
    .expect("validate pinned response.bin");

    assert_eq!(
        modes.count,
        required_environment("MANDELHOWL_EXPECTED_MODE_COUNT")
            .parse::<usize>()
            .expect("mode count")
    );
    assert_eq!(
        response.sample_count,
        required_environment("MANDELHOWL_EXPECTED_RESPONSE_COUNT")
            .parse::<usize>()
            .expect("response count")
    );
    assert_eq!(
        modes.first_mode_id,
        required_environment("MANDELHOWL_EXPECTED_FIRST_MODE")
    );
    assert_eq!(
        modes.last_mode_id,
        required_environment("MANDELHOWL_EXPECTED_LAST_MODE")
    );
    assert_eq!(
        response.minimum_frequency_hz,
        required_environment("MANDELHOWL_EXPECTED_MINIMUM_FREQUENCY")
            .parse::<f64>()
            .expect("minimum response frequency")
    );
    assert_eq!(
        response.maximum_frequency_hz,
        required_environment("MANDELHOWL_EXPECTED_MAXIMUM_FREQUENCY")
            .parse::<f64>()
            .expect("maximum response frequency")
    );
}
