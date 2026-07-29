# Managed native baker installation

The supervisor resolves its operational Rust artifact only at
`<platform>-<arch>/mandelhowl-baker-native[.exe]` below this directory.
Managed installers may place the approved executable there. Executables and
adjacent symbol/signature files sharing that exact basename are ignored by
Git; this policy file remains tracked. Every installed executable must have an
adjacent `<executable>.sha256` text file whose first token is the approved
lowercase SHA-256 digest. The supervisor verifies that digest immediately
before execution and verifies the executable again afterward.

Development builds under Cargo `target/` are never discovered or executed by
the supervisor. CI may inject one absolute source-built artifact with
`CI=true`; its workflow build attestation replaces the installed sidecar for
that run.
