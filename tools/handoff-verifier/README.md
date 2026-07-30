# Handoff verifier

`specs/acceptance/handoff-verification.v1.json` pins the reviewed handoff text and
maps every normative bullet, ordered item, narrative paragraph, blockquote,
table row, and code flow, as well as every numbered heading, validation
section, A0–G0 gate, and completion criterion, to executable suites and
concrete repository evidence.

The fast structural check fails when:

- the handoff changes without a full re-audit and digest update;
- a heading, validation section, implementation gate, or quality criterion is
  omitted or reordered;
- a source heading is unmapped or mapped more than once;
- any of the 503 obligations (369 bullets, 44 ordered items, 73 narrative
  paragraphs, 2 blockquotes, 11 table rows, and 4 code flows) loses its stable
  ID, source line/digest,
  exactly-one coverage owner, executable suite, or semantic claim anchor;
- a direct case is merely recycled from the same section instead of matching
  the obligation's independently derived semantic concepts and the selected
  executable test name;
- an evidence anchor is empty, unrelated to its declared selector, or resolves
  to a directory instead of a concrete test/source file;
- a release-blocking JSON assertion reports incomplete conformance (including
  B1 finite-element assembly, coupled analysis-element mesh, or strict literal
  conformance);
- the acceptance documents still label a normative handoff gap as a completed
  PASS.

```bash
npm run handoff:check
```

The check first runs mutation tests for the verifier itself and writes the
auditable generated ledger to
`work/handoff/obligation-ledger.json`. The ledger contains every obligation's
stable ID, source line and SHA-256, coverage group, critical claim (for
16.1–16.5 and A0–G0), executable suites, and content-checked evidence anchors.
It also records the semantic concepts derived from each source sentence. The
verifier rejects both a case from an unrelated concept and a nominally
compatible case whose exact executable anchor does not describe that concept.
Its ownership and semantic projection is digest-pinned by the acceptance
contract.

Whole-handoff verification runs every registered implementation, browser, and
security npm suite as a dedicated recorded stage before release provenance and
deterministic archive gates. A successful aggregate command cannot stand in
for a missing suite. Native Rust
format, clippy, unit, strict validation, and fresh dual generation are owned by
the prerequisite Linux CI job. On Windows, the verifier never invokes Cargo,
creates a Rust PE, or runs `physics:validate:strict`. It recursively expands
the complete npm-script DAG, including `pre*`/`post*` lifecycle hooks, rejects
every native-capable Baker/physics script and native command token, and checks
the canonical DAG digest. Child stages also receive
`MANDELHOWL_EVIDENCE_ONLY_NO_NATIVE_SPAWN=1`; the Baker broker refuses a native
process before spawn if a transitive path reaches it.

The structural gate scopes native workflow evidence to the exact
`native-baker-nversion` job, requires the Windows job to depend on it, and
recognizes only the committed-evidence handoff stage. Whole-handoff security
also reconstructs the embedded WebGL shaders and verifies their canonical
allowlist SHA-256 values.

Release evidence is the promotion-time OCI bundle committed at
`release/attestations/<dataset-id-hex>/attestation.json`, derived from
`release/dataset-lock.json`; arbitrary external attestation paths are rejected.
The committed directory contains both complete candidate packages plus the
container runner and envelope attestations. The release gate rechecks every
candidate byte, reruns the semantic differential, binds the Rust candidate
exactly to the pinned manifest, requires `executionKind: oci-container`, binds
the manifest container digest to the inspected Linux image ID, and rejects a
current source-tree mismatch. Rebuilding the image is not treated as an
identity proof.

```bash
npm run handoff:verify -- \
  --report work/handoff-verification-report.json
```

The default release gate requires a clean Git tree. `--allow-dirty` is only for
development diagnosis; it deliberately does not prove a clean release.
`--no-archive` omits deterministic archive generation and recheck.
