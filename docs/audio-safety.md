# Audio safety

The virtual `VOLUME 000..100` result and audible Web Audio gain are independent.
The audio engine accepts only finite frequency, normalized feedback envelope,
mode, and regime values. It never receives the integer volume result.

## Activation and privacy

- AudioContext starts only after a dial gesture.
- Simulation and visual measurement work while audio is muted.
- Microphone permission and `getUserMedia` are forbidden.
- Hiding, unloading, or faulting the page fades to zero, suspends, and
  disconnects reusable nodes.

## Safety chain

The canonical limits live in `specs/runtime/audio-safety.v1.yaml`:

```text
bounded modal source
→ DC-blocking high-pass
→ high/low band limit
→ normalized soft clip
→ RMS control
→ look-ahead/peak ceiling
→ smoothed master gain
→ destination
```

The independent exposure guard attenuates prolonged high-frequency or saturated
operation. Invalid numbers immediately request a mute state and a structured
diagnostic. No alternate graph may bypass the limiter or master gain.

Automated safety sweeps verify the parameter mapper, maximum requested gain,
peak ceiling, RMS target, exposure attenuation, and lifecycle node counts.
These are virtual/offline guarantees; the project does not claim to calibrate a
user's headphones, operating-system volume, or listening environment.
