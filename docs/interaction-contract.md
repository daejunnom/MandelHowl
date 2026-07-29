# Interaction contract

## One input

`DRIVE FREQUENCY` is the sole conceptual control. Pointer, touch, keyboard, and
wheel events are adapters to the same unwrapped-angle dial command stream.
Three physical turns map logarithmically to `45..6000 Hz`.

- pointer/touch: direct circular dragging with centre dead zone and pointer
  capture cleanup;
- keyboard: Arrow keys for fine rotation, Page Up/Down for coarse rotation,
  Home/End for physical limits;
- wheel: bounded angular nudge;
- release: bounded inertia and spring-damped end-stop resistance.

Every adapter records timestamp, sweep speed, and approach direction so the
same final frequency can retain a different physically meaningful history.

Audio activation is a side effect of the user's first dial gesture, not a
second conceptual control. Challenge targets, diagnostics, meters, and
provenance displays are read-only.
Audible frequency follows the shared per-frame drive state. Its independent
master-gain safety smoother limits level changes to `40 dB/s`, bounding the
largest silence-to-safe-maximum transition to two seconds.

## One output

`VOLUME` is the sole result and is always an integer `000..100` once settled.
During observation the presenter shows `MEASURING`, progress, and the previous
settled value. Frequency, waveform, pattern, envelope, regime, and limiter
state explain the result but do not constitute additional outputs or controls.

DOM, renderer, audio, and challenge reporting consume the same canonical
simulation state and sequence; none recomputes physics. Renderer and audio
receive one shared, synchronous, non-retaining lease on every animation frame.
DOM, challenge reporting, and diagnostics receive an owned immutable
projection at up to 24 Hz, plus forced publication on dataset and lifecycle
boundaries.
