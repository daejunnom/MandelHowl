# Promotion-time OCI attestations

Each directory is named by the 64-hex portion of the promoted Rust dataset ID
and contains the complete `baker-nversion-attestation` directory produced by
the release-only OCI runner:

- `attestation.json`
- `container-runner-attestation.json`
- `container-envelope-attestation.json`
- `candidates/rust/<dataset-id-hex>/...`
- `candidates/python/<dataset-id-hex>/...`

Use `npm run baker:container:release -- --output-dir <fresh-name>
--stage-release-evidence` during promotion. The runner creates a new directory
atomically and refuses to overwrite an existing one.

The attestation directory is intentionally not part of the Baker source-tree
digest because it contains that digest. Release verification instead derives
the exact directory from `release/dataset-lock.json` and validates the source
digest, both candidates, semantic comparison, OCI envelope, inspected Linux
image ID, and exact pinned Rust manifest without executing native code.
