# MandelHowl Rust native physics baker

This crate is a full, independent implementation of the versioned algorithm
in `specs/physics/baker-algorithm.v1.json`. It reads the canonical plate YAML,
generates the Mandelbrot material field, solves three C1 finite-strip levels,
checks convergence, emits 48 modes and the response table, builds four texture
kinds as twelve four-layer KTX2 shards per kind plus mesh/solver evidence,
packages a content-addressed dataset, and validates the result semantically.

The crate is standard-library only. JSON, the audited YAML subset, SHA-256,
KTX2, and deterministic zlib fixed-Huffman/stored DEFLATE are implemented
in-tree.
This avoids dependency build scripts and keeps the native runtime surface to
one final executable—important on managed Windows machines where every newly
generated helper PE can trigger Application Control error 4551.

Quality/build commands:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --release --locked -p mandelhowl-baker-native --bin mandelhowl-baker-native
```

These native compilation and execution checks belong on Linux CI or inside
the release OCI envelope. Windows whole-handoff verification consumes the
committed promotion-time OCI evidence and must not recreate or execute a PE.

Do not use `cargo run` or discover executables under `target/` in operational
workflows. Install the one approved artifact at
`tools/physics-baker-rs/bin/<platform>-<arch>/mandelhowl-baker-native`.
`MANDELHOWL_NATIVE_BAKER` is not a general user-selected override: it must be
an absolute file path injected by CI (`CI=true`) or by the managed installer
(`MANDELHOWL_MANAGED_INSTALL=1`) for the approved artifact. Then use the
N-version supervisor:

```text
npm run baker:rust:self-test
npm run physics:validate:strict
npm run baker:nversion:generate -- --strict
```

Rust and Python provenance—and therefore dataset IDs—truthfully differ.
Promotion is based on semantic parity of the algorithm revision, every modal
scalar, all response samples, material-field bytes, solver evidence, and
decoded texture pixels. A missing/timed-out/4551-blocked Rust artifact permits
degraded Python operation but not release promotion. Scientific disagreement
is split-brain and preserves the pinned last-known-good dataset.

The numerical solver assembles the variable-thickness Kirchhoff–Love mass and
stiffness matrices from C1 cubic-Hermite radial finite elements coupled to
normalized real Fourier circumferential functions. The clamped hub value and
slope DOFs are eliminated; the outer edge is natural-free. The independently
archived annular triangle mesh remains manufacturing, coordinate, and quality
evidence rather than being misidentified as the analysis mesh. Python and Rust
both report strict handoff Section 10.3/B1 thin-plate finite-element
conformance and independently validate all 48 modal coefficient/sign/texture
relationships. They also emit and independently recheck the same inline
64-sample rear thickness section used by both browser presenters.
