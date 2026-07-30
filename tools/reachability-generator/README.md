# Reachability generator

This directory owns offline coverage search and trajectory replay helpers used
to generate and audit `tests/runtime/fixtures/reachability-report.json`.

It is deliberately outside `packages/resonance-engine`: coverage generation
indexes observations by settled output while searching for one replayable
trace per value. That value-indexed search is valid verification tooling but
must never be exported by, or bundled with, the production runtime package.
`tests/runtime/generate-reachability-report.ts` imports this tool directly.

After a non-release Baker candidate establishes the next modal byte identity,
regenerate the checked-in report through the closed repository command:

```text
npm run reachability:generate -- --manifest <candidate>/manifest.json --modes <candidate>/modes.bin
```

The release Baker then independently rechecks the report against its own
fresh Rust and Python modal outputs. The bootstrap candidate is never itself
promoted.
