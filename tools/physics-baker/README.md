# MandelHowl physics baker

This package deterministically derives a compact browser dataset from
`specs/plate/mandelbrot-plate.v1.yaml`. It has no third-party Python runtime
dependencies and never performs a solve in the browser.

Generate a development dataset with physical reachability anchors:

```powershell
python tools/physics-baker/bake.py generate --output-root assets/generated
```

Generate a release dataset only after the runtime search has produced a
replay-verified `0..100` report:

```powershell
python tools/physics-baker/bake.py generate `
  --output-root assets/generated `
  --coverage-report path/to/runtime-coverage-report.json `
  --release
```

Validate an immutable dataset independently:

```powershell
python tools/physics-baker/bake.py validate assets/generated/<dataset-hash>
python -m unittest discover -s tests/science -p "test_*.py"
```

The solver is a variable-thickness Kirchhoff–Love C1 finite-strip
finite-element calculation. Cubic-Hermite radial elements are coupled to
normalized real Fourier circumferential functions; the clamped hub value and
slope DOFs are eliminated and the free rim remains a natural boundary.
Three refinement levels, the separately archived manufacturing triangle-mesh
quality, unit-modal-mass orthogonality, sign normalization, all 48
eigenvector/texture correlations, and an independent finite-difference
Rayleigh check are recorded. The manifest also carries a verified 64-sample
`x-at-y-zero` thickness section for the rear/edge presentation, derived from
the same filtered field without a browser-side solve. See
`docs/asset-pipeline.md` for the scientific scope and binary layouts. The
versioned reports assert strict Section 10.3/B1
thin-plate finite-element conformance without claiming that the independent
triangle archive is the analysis mesh.
