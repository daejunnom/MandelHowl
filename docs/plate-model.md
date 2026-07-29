# Plate model

The canonical plate definition is
`specs/plate/mandelbrot-plate.v1.yaml`; generated meshes and datasets may not
silently override it.

## Geometry and material

- circular aluminium 6061-T6 plate, radius `0.18 m`;
- planar front face at `z = 0`, thickness extending in negative `z`;
- centre hub radius `0.018 m`, clamped in every degree of freedom;
- outer rim free;
- Young's modulus `68.9 GPa`, density `2700 kg/m³`, Poisson ratio `0.33`;
- nominal modal damping ratio `0.004`.

The right-handed plate-local `x/y` plane maps linearly to the Mandelbrot complex
plane. A filtered continuous escape-time value maps through a smoothstep curve
to `1.8..4.2 mm` thickness. Feature filtering, thickness gradients, total mass,
and centre-of-mass offset are checked before meshing.

## Numerical request

The solver request covers `45..6000 Hz`, uses a centre-clamped shell/thin-plate
model, and compares coarse, medium, and fine discretizations. Accepted leading
modes must satisfy the requested frequency convergence and modal correlation
thresholds. Each mode is unit-modal-mass normalized and receives a deterministic
sign based on the actuator location.

The generated dataset includes mode frequencies, damping, actuator and virtual
microphone coupling, response data, nodal/sand textures, mesh convergence, and
complete SHA-256 provenance.
