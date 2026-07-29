# MandelHowl baker N-version supervisor

The supervisor treats the Rust native baker and Python standard-library baker
as independent implementations of
`specs/physics/baker-algorithm.v1.json`.

- Rust is primary only after both backends succeed and the semantic comparator
  accepts all modes, response samples, field pixels, solver evidence, and four
  texture atlases.
- Missing, timed-out, or Windows Application Control-blocked Rust execution is
  an availability failure. Python remains operational in a degraded state, but
  the candidate is not release-eligible and cannot promote the dataset lock.
- A scientific rejection or semantic mismatch is split-brain. Neither new
  candidate wins a two-version vote; `release/dataset-lock.json` remains the
  last-known-good dataset only after its lock identity, manifest bytes, complete
  checksum inventory, and semantic self-check all pass. An invalid LKG cannot
  claim fail-operational service.
- The default native path is
  `tools/physics-baker-rs/bin/<platform>-<arch>/mandelhowl-baker-native`.
  Cargo `target/` discovery is forbidden. `MANDELHOWL_NATIVE_BAKER` is reserved
  for managed CI/installer injection of one exact approved absolute file path;
  it is accepted only with `CI=true` or `MANDELHOWL_MANAGED_INSTALL=1` and is
  not an unrestricted user/backend-selection override. Installed/managed
  artifacts require an adjacent approved `.sha256` sidecar. A CI source-build
  override is separately identified in the report.
- Native SHA-256 is measured before and after spawn; a changed or unreadable
  artifact discards the backend result. Python reports and validates its
  implementation, version, absolute interpreter path, and executable SHA-256
  without starting an additional process.
- Accepted candidates are copied into a sibling temporary directory, checked
  against the full manifest/checksum inventory, and atomically renamed into
  their final content-addressed directory. Existing directories are reused
  only on exact package identity, not merely semantic similarity.

The supervisor never edits the dataset lock. Release promotion remains an
explicit packaging operation after a `dual-verified` result.

Every command accepts `--report-file <absolute-or-project-relative-path>`.
The supervisor writes the same machine-readable result that it prints,
including backend statuses, the approved native executable SHA-256,
Python executable identity, algorithm revision/digest, both generator and
dataset/manifest identities, semantic metrics, verified LKG identity,
split-brain/degraded state, and promotion/release eligibility. Release
provenance can bind this attestation without scraping terminal output.
