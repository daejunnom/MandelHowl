# MandelHowl release-only OCI Baker envelope

This runner is an offline release tool. It is not imported by the browser,
worker, React/Svelte UI, simulation loop, or any production request path. Its
only purpose is to execute the existing Rust + Python N-version Baker inside a
Linux OCI boundary when a Windows native executable may be blocked by
Application Control 4551.

The image uses official multi-architecture index digest pins for Rust 1.96.0
and Node 22.19.0, selects `linux/amd64`, and separately records that platform's
final local image ID after the build. It contains Python 3 and one release-built
native Baker; the Rust compiler and Cargo remain only in the builder stage.
A narrow, explicit Baker-source allowlist is copied from the
`.dockerignore`-filtered context into the image and indexed as a local Git
worktree for source-tree attestation. Host secrets, package/build outputs, and
host Baker binaries are neither copied nor mounted at run time. The
allowlist includes the canonical embedded WebGL shader manifest, renderer
source, and release integrity verifier so promotion evidence cannot omit or
silently change that release-bound surface. The
content-addressed generated dataset store is included only so the supervisor
can retain the release-pinned last-known-good dataset on a version failure.
Only the canonical dataset release YAML and its generated TypeScript
projection are omitted as promotion outputs, which lets a dual-verified OCI
candidate be pinned afterward without changing the image identity. The
attestation records that exact two-file exclusion set; runtime and algorithm
generated constants remain image and source-digest inputs.
Only `work/container-baker-runs/<safe-name>` is mounted read-write. Network
access and Linux capabilities are removed, the root filesystem is read-only,
and the supervisor receives a fixed strict release command.

The selected output leaf must be empty. The runner never deletes or merges a
previous attempt, follows no output-directory links, and creates the two
container-envelope JSON files with exclusive writes.
If either implementation fails or the semantic comparison disagrees, the
supervisor preserves only the structured `attestation.json` failure report
with `attestationBundle: null`; it does not create candidate or container
attestation artifacts.

The host runner obtains the real local image ID from `docker image inspect`
or `podman image inspect` after the build. Only then does it inject:

- `MANDELHOWL_CONTAINER_IMAGE_DIGEST=sha256:<actual-image-id>`
- `MANDELHOWL_CONTAINER_RUNNER_ATTESTED=1`
- the fixed managed native path and Python path inside the container

No arbitrary command, container path, environment variable, or backend
argument is accepted. Child processes use argument arrays with `shell: false`.
The output directory contains:

- `baker-nversion-attestation/attestation.json`
- `baker-nversion-attestation/candidates/{rust,python}/...`
- `baker-nversion-attestation/container-runner-attestation.json`
- `baker-nversion-attestation/container-envelope-attestation.json`
- the content-addressed candidate under `datasets/`

Commands:

```text
npm run baker:container:doctor
npm run baker:container:release -- --dry-run
npm run baker:container:release -- --output-dir release-01
npm run baker:container:release -- --output-dir release-01 --stage-release-evidence
npm run baker:container:test
```

`doctor` is a read-only availability check. `--dry-run` validates and prints
the complete plan without contacting the OCI engine, building an image, or
creating output.

`--stage-release-evidence` is an explicit promotion-time operation. After the
strict OCI run and all bundle checks pass, it atomically copies the complete
bundle to `release/attestations/<rust-dataset-id-hex>/`. It refuses an existing
destination and never overwrites prior evidence. Commit that directory with
the promoted dataset pin. Windows release verification derives this one path
from `release/dataset-lock.json`; it does not rebuild or execute the native
Baker. The recorded local Linux image ID is the identity being attested—this
workflow makes no unsupported claim that separate OCI builds reproduce the
same image ID.

CI integration should remain a dedicated release job rather than part of
ordinary UI verification: run `baker:container:test` on every change, and run
`baker:container:release` only on an explicitly authorized Linux release
runner that uploads the three JSON attestations. The existing native
N-version CI path remains the faster default.
