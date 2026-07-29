# Scientific basis and representation limits

## Established physics

MandelHowl relies on three established ideas:

1. a plate's geometry, boundary conditions, elastic properties, density, and
   thickness distribution determine its modal frequencies and shapes;
2. particles on a driven plate migrate away from strongly moving regions and
   collect near nodal regions, producing Chladni-like patterns;
3. a closed speaker–plate–microphone loop decays, grows, or self-oscillates
   according to its loop gain and phase, with nonlinear limits preventing
   unbounded amplitude.

The offline pipeline encodes a Mandelbrot escape-time field into a bounded,
manufacturable thickness field. It then solves the resulting variable-property
plate and records modes, coupling coefficients, convergence evidence, and
textures. Mandelbrot information therefore changes the physical model rather
than acting as a decorative overlay.

## Creative combination

The virtual apparatus and its conversion to a single `VOLUME 000..100` reading
are an artistic instrument. The number is a normalized virtual measurement, not
sound-pressure level, hearing level, operating-system volume, or a claim about
a fabricated plate's exact audible loudness.

The sand pattern is derived from modal nodal structure. It is not, and must not
be described as, a Mandelbrot silhouette. Similarities that appear between a
modal pattern and the source field are consequences of the encoded material
distribution and numerical model, not a direct image mapping.

## Numerical limits

The production dataset records its discretization, solver implementation,
normalization, convergence thresholds, and validation results. A converged
discrete solution is still an approximation: manufacturing tolerances, material
variation, actuator contact, particle interactions, air loading, and acoustic
room effects are simplified.

Runtime rendering and audio consume the baked modal state. They do not perform
real-time finite-element analysis and do not use a real microphone.
