# Feedback and volume model

`specs/runtime/feedback.v1.yaml` and `specs/runtime/volume-map.v1.yaml` are the
canonical runtime sources.

For every active mode, the fixed-step runtime advances an equivalent modal
state with frequency, damping, drive coupling, microphone coupling, amplitude,
phase, and residual energy. The virtual microphone sums the measured modal
response. Its delayed and band-limited signal returns through one global loop:

```text
drive → modal plate → virtual microphone → delay/filter/gain
      → gate/soft clip/limiter → drive
```

The state is deterministic for a fixed dataset and gesture trace. Frame
presentation rate never changes simulation step size, long paused gaps are
bounded, and no random forcing is used.

The verified runtime dataset also retains the baked `response-v1` complex
transfer curve and exposes deterministic logarithmic-frequency interpolation.
That curve is one normalized aggregate across all modes, not a per-mode state
table. Consequently it is suitable for response-curve display and diagnostics,
but it does not replace the mode-specific capture and residual-energy weights
in this v1 feedback integrator.

## Regimes

- `decaying`: loop margin is below the narrow critical band and residual mode
  energy follows its physical release;
- `critical`: loop margin lies within `±0.025`, so growth and decay compete;
- `growing`: loop margin is above the critical band;
- `saturated`: the virtual limiter holds the feedback envelope at its ceiling.

Residual energy and phase preserve sweep direction, capture speed, beating, and
reverberation. They are not replaced by arbitrary timers.

## Measurement

The volume mapper observes virtual RMS over a bounded measurement window.
Values below the noise floor become 0, values at or beyond virtual saturation
become 100, and stable intermediate RMS maps logarithmically to integers 1–99.
While the observation is unstable, consumers receive `MEASURING` plus progress
and the last settled value rather than a flickering provisional result.

Audible gain is a separate consumer of the normalized envelope; it never reads
the virtual 0–100 result.
