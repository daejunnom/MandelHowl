# Runtime diagnostics

Diagnostics separate confirmed evidence from guesses. A record contains a
stable code, severity, evidence state, user message key, and bounded evidence
entries. The user sees a short recovery-oriented explanation; development
details remain structured and contain no broad browser fingerprint.

## Capability codes

| Code | Meaning | Safe response |
|---|---|---|
| `MH-CAP-WEBGL2-UNAVAILABLE` | WebGL2 probe failed | Use data-consistent Canvas renderer |
| `MH-CAP-CANVAS-UNAVAILABLE` | Neither WebGL2 nor Canvas2D is usable | Preserve static apparatus and mute animation |
| `MH-CAP-KTX2-FALLBACK` | Native/selected KTX2 path unavailable | Decode verified portable atlas or reduce texture tier |
| `MH-CAP-AUDIO-UNAVAILABLE` | AudioContext unavailable | Keep simulation active and audible output muted |

Dataset loading distinguishes fetch, unsupported schema, incompatible runtime,
unsafe path, byte-length mismatch, SHA-256 mismatch, binary decode, coordinate,
and partial texture failures. Audio diagnostics distinguish activation refusal,
invalid parameter, safety mute, and lifecycle failure.

Fatal dataset integrity failures never fall back to unverified physics data.
Recoverable presentation failures may reduce WebGL quality or use Canvas while
the canonical simulation snapshot and volume remain unchanged.
