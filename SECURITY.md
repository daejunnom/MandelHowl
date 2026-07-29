# Security policy

MandelHowl is a local-first, permission-minimizing interactive instrument.

## Supported release

Only the latest deployed release and the current default branch receive
security fixes.

## Reporting

Report suspected vulnerabilities privately to the project maintainer or through
the repository host's private security-advisory channel. Do not include real
credentials, full browser profiles, or unrelated personal data in reports.

## Security boundaries

- Microphone, camera, location, payment, and USB permissions are denied.
- Gesture traces and virtual measurements remain in the browser.
- Runtime datasets are allowlisted by a pinned manifest and verified with
  SHA-256 before use.
- Audio output is separately limited and never maps virtual volume 100 to device
  maximum volume.
- External HTML and executable dataset content are rejected.
- Production responses apply CSP, permissions, framing, MIME-sniffing, and
  referrer headers.

Integrity or capability failures must produce a stable diagnostic code and a
safe fallback or mute state.
