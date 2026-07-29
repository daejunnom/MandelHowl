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

The solver is a variable-thickness Kirchhoff–Love Rayleigh–Ritz calculation,
not shell FEM. Three polar quadrature levels, three explicit polar mesh-quality
levels, unit-modal-mass orthogonality, sign normalization, and an independent
finite-difference Rayleigh check are recorded. See
`docs/asset-pipeline.md` for the scientific scope and binary layouts.
