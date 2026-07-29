# Runtime diagnostics

Diagnostics separate confirmed evidence from guesses. A record contains a
stable code, severity, evidence state, user message key, and bounded evidence
entries. The user sees a short recovery-oriented explanation; development
details remain structured and contain no broad browser fingerprint.

## Capability codes

| Code                        | Meaning                               | Safe response                                         |
| --------------------------- | ------------------------------------- | ----------------------------------------------------- |
| `MH-CAP-WEBGL2-UNAVAILABLE` | WebGL2 probe failed                   | Use data-consistent Canvas renderer                   |
| `MH-CAP-CANVAS-UNAVAILABLE` | Neither WebGL2 nor Canvas2D is usable | Preserve static apparatus and mute animation          |
| `MH-CAP-KTX2-FALLBACK`      | Native/selected KTX2 path unavailable | Decode verified portable atlas or reduce texture tier |
| `MH-CAP-AUDIO-UNAVAILABLE`  | AudioContext unavailable              | Keep simulation active and audible output muted       |

Dataset loading distinguishes fetch, unsupported schema, incompatible runtime,
unsafe path, byte-length mismatch, SHA-256 mismatch, binary decode, coordinate,
and partial texture failures. Audio diagnostics distinguish activation refusal,
invalid parameter, safety mute, and lifecycle failure.

Fatal dataset integrity failures never fall back to unverified physics data.
Recoverable presentation failures may reduce WebGL quality or use Canvas while
the canonical simulation snapshot and volume remain unchanged.

## UI N-version codes

The Svelte-primary/React-standby supervisor emits the same bounded
`DiagnosticRecord` contract. A framework availability failure may select the
standby once; a contract disagreement never does.

| Code                              | Meaning                                              | Safe response                                               |
| --------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `MH-UI-PRIMARY-LOAD-FAILED`       | Svelte module could not load or timed out            | Detach partial primary resources and try React once         |
| `MH-UI-PRIMARY-MOUNT-FAILED`      | Svelte mount failed or timed out                     | Keep the canonical session and mount React                  |
| `MH-UI-PRIMARY-READINESS-TIMEOUT` | Svelte did not commit its first ready view in budget | Treat as availability failure                               |
| `MH-UI-PRIMARY-HEARTBEAT-STALE`   | A visible Svelte view stopped committing snapshots   | Preserve state and activate React                           |
| `MH-UI-PRIMARY-VIEW-FAILED`       | Svelte reported a framework view error               | Detach only the view and activate React                     |
| `MH-UI-STANDBY-*`                 | The corresponding React standby stage failed         | Do not return to Svelte; show the static fatal state        |
| `MH-UI-FAILOVER-ACTIVATED`        | The single allowed Svelte→React transition began     | Continue from the same dataset and snapshot sequence        |
| `MH-UI-ALL-VERSIONS-FAILED`       | Neither framework view is available                  | Keep runtime ownership isolated and show static diagnostics |
| `MH-UI-SPLIT-BRAIN`               | Scientific or presentation contract digest disagrees | Quarantine both versions; automatic selection is forbidden  |
| `MH-UI-STALE-INPUT-REJECTED`      | A detached generation attempted input                | Ignore the command                                          |
| `MH-UI-DUPLICATE-INPUT-REJECTED`  | A native event identity was already consumed         | Ignore the replay                                           |

Every availability record includes implementation ID, primary/standby role,
stage, error kind and lease generation. Split-brain evidence includes the
digest dimension, expected/actual digest and `automaticSelection: false`.
Hidden documents suspend heartbeat judgment, so background throttling is not
reported as failure. A failure of the renderer attached to the active view is
view-local availability and may trigger the one allowed switch. A canonical
renderer, dataset, audio or runtime failure remains a shared capability fault.
If both presentation versions fail, the host retains a static fatal state and
suspends audio rather than leaving an unseen sound graph active.

## Baker N-version codes

The offline supervisor distinguishes execution availability from scientific
validity. Only dual semantic agreement is promotable or release-eligible.

| Code/state                                                                   | Meaning                                                             | Safe response                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `dual-verified` / `MH_BAKER_OK`                                              | Both full generators completed and semantic comparison accepted     | Select Rust primary; allow explicit promotion/attestation                      |
| `MH_BAKER_APPLICATION_CONTROL_4551`                                          | Windows Application Control blocked the managed native executable   | Use Python degraded for continuity; forbid promotion/release                   |
| `MH_BAKER_EXECUTABLE_MISSING` / `MH_BAKER_TIMEOUT` / `MH_BAKER_SPAWN_FAILED` | Native execution surface is unavailable                             | Use the surviving implementation degraded; preserve evidence                   |
| `MH_BAKER_NATIVE_ATTESTATION_MISSING`                                        | A managed installed native binary has no approved SHA-256 sidecar   | Refuse native execution; use Python degraded without promotion/release         |
| `MH_BAKER_NATIVE_ATTESTATION_UNREADABLE`                                     | The approved SHA-256 sidecar could not be read                      | Refuse native execution; repair the managed installation                       |
| `MH_BAKER_NATIVE_ATTESTATION_INVALID`                                        | The sidecar is not one lowercase 64-hex SHA-256 value               | Refuse native execution; replace the malformed attestation                     |
| `MH_BAKER_NATIVE_ATTESTATION_MISMATCH`                                       | The pre-run native binary digest differs from its approved sidecar  | Refuse execution and preserve the mismatch evidence                            |
| `MH_BAKER_NATIVE_ARTIFACT_POSTRUN_UNREADABLE`                                | The executable could not be hashed again after the process returned | Discard that native result; continue degraded only                             |
| `MH_BAKER_NATIVE_ARTIFACT_CHANGED`                                           | Pre-run and post-run executable digests differ                      | Discard the native result as an availability failure; forbid promotion/release |
| `MH_BAKER_SCIENTIFIC_REJECTION`                                              | A generator rejected its own scientific output                      | Enter split-brain; retain validated last-known-good                            |
| `split-brain`                                                                | Both succeeded but differ, or scientific agreement is unavailable   | Select neither candidate; retain validated last-known-good                     |
| `MH_BAKER_UNMANAGED_NATIVE_OVERRIDE`                                         | A caller attempted an unapproved native path override               | Refuse execution; require managed CI/installer injection                       |

The normal operational path executes one stable platform/architecture binary,
not `cargo run` or a discovered `target/` artifact. Cargo is limited to
development and Linux CI quality gates. `--report-file` records backend
identity/status/duration, native pre-run/post-run SHA-256, Python interpreter
SHA-256, algorithm contract revision/digest, semantic metrics, selection state
and promotion/release eligibility for release attestation. A CI source-build
override is separately identified in the report; the approved sidecar codes
above describe the managed installed-binary path.
