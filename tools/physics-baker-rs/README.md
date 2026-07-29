# MandelHowl native baker seam

This Rust workspace is the native replacement boundary for the offline Python
baker. It currently validates the fixed-width `modes-v1` and `response-v1`
contracts with an implementation independent from both Python and TypeScript.

`generate` deliberately exits with an error until field, solver, postprocess,
KTX2 and packaging parity are implemented and differentially verified. The
Python baker remains the scientific oracle during that migration.

Commands:

```text
cargo test --workspace --locked
cargo run --locked -p mandelhowl-baker-native -- contract
cargo run --locked -p mandelhowl-baker-native -- validate <dataset-directory>
npm run physics:validate:strict
```

Some managed Windows hosts block newly built executables. The non-strict
`npm run physics:validate` reports that condition as an explicit skip after
the Python oracle and Rust compile/clippy checks; strict validation must run
on a policy-compatible CI or release host and never converts that skip into a
parity pass.

Parity is semantic rather than a cross-backend `datasetId` equality claim:
provenance truthfully differs between Python and Rust. Each backend must be
internally deterministic, while mode ordering/signs, scientific values,
response samples and decoded texture pixels are compared by the migration
gate.
