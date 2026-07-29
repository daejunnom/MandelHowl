"""Command-line orchestration for generation and validation."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from .canonical import canonical_json_bytes, sha256_bytes
from .field import generate_material_field
from .diagnostics import from_exception
from .mesh import build_mesh_evidence
from .packaging import package_dataset
from .postprocess import postprocess
from .schema_validation import validate as validate_schema
from .solver import convergence_report, solve_modes
from .validation import validate_dataset
from .yaml_min import load as load_yaml


def _repository_root() -> Path:
    return Path(__file__).resolve().parents[4]


def generate(args: argparse.Namespace) -> int:
    repository = _repository_root()
    spec_path = (
        Path(args.spec).resolve()
        if args.spec
        else repository / "specs" / "plate" / "mandelbrot-plate.v1.yaml"
    )
    output_root = (
        Path(args.output_root).resolve()
        if args.output_root
        else repository / "assets" / "generated"
    )
    spec = load_yaml(spec_path)
    plate_schema = json.loads(
        (
            repository
            / "packages"
            / "contracts"
            / "schemas"
            / "plate-spec.schema.json"
        ).read_text(encoding="utf-8")
    )
    validate_schema(spec, plate_schema)
    spec_sha256 = sha256_bytes(canonical_json_bytes(spec))
    field_resolution = (
        args.field_resolution
        if args.field_resolution is not None
        else int(spec["mandelbrotField"]["sampleResolution"]["widthPx"])
    )
    texture_size = (
        args.texture_size
        if args.texture_size is not None
        else int(spec["textureRequest"]["widthPx"])
    )
    if int(spec["mandelbrotField"]["sampleResolution"]["heightPx"]) != field_resolution:
        raise ValueError("the v1 baker requires a square Mandelbrot sample field")
    if int(spec["textureRequest"]["heightPx"]) != texture_size:
        raise ValueError("the v1 baker requires square texture atlases")
    field = generate_material_field(spec, size=field_resolution)
    meshes = [
        build_mesh_evidence(spec, level)
        for level in spec["solverRequest"]["meshLevels"]
    ]
    coarse = solve_modes(
        spec,
        field,
        radial_samples=args.coarse_radial,
        angular_samples=args.coarse_angular,
    )
    medium = solve_modes(
        spec,
        field,
        radial_samples=args.medium_radial,
        angular_samples=args.medium_angular,
    )
    fine = solve_modes(
        spec,
        field,
        radial_samples=args.fine_radial,
        angular_samples=args.fine_angular,
    )
    convergence = convergence_report(spec, coarse, medium, fine)
    processed = postprocess(spec, field, fine, texture_size=texture_size)
    dataset = package_dataset(
        output_root=output_root,
        spec=spec,
        spec_sha256=spec_sha256,
        field=field,
        meshes=meshes,
        fine_result=fine,
        convergence=convergence,
        postprocessed=processed,
        external_coverage_path=(
            Path(args.coverage_report).resolve() if args.coverage_report else None
        ),
        release=args.release,
    )
    result = validate_dataset(dataset)
    print(json.dumps({"datasetPath": str(dataset), **result}, indent=2))
    return 0


def validate(args: argparse.Namespace) -> int:
    result = validate_dataset(Path(args.dataset))
    print(json.dumps(result, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mandelhowl-baker",
        description="Deterministic MandelHowl offline physics asset baker",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    generate_parser = subcommands.add_parser(
        "generate", help="generate and validate a content-addressed dataset"
    )
    generate_parser.add_argument("--spec")
    generate_parser.add_argument("--output-root")
    generate_parser.add_argument("--coverage-report")
    generate_parser.add_argument(
        "--release",
        action="store_true",
        help="require a runtime-replay-verified external 0..100 coverage report",
    )
    generate_parser.add_argument("--field-resolution", type=int)
    generate_parser.add_argument("--texture-size", type=int)
    generate_parser.add_argument("--coarse-radial", type=int, default=24)
    generate_parser.add_argument("--coarse-angular", type=int, default=64)
    generate_parser.add_argument("--medium-radial", type=int, default=32)
    generate_parser.add_argument("--medium-angular", type=int, default=80)
    generate_parser.add_argument("--fine-radial", type=int, default=40)
    generate_parser.add_argument("--fine-angular", type=int, default=96)
    generate_parser.set_defaults(function=generate)

    validate_parser = subcommands.add_parser(
        "validate", help="validate schemas, hashes, binaries, textures, and science evidence"
    )
    validate_parser.add_argument("dataset")
    validate_parser.set_defaults(function=validate)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.function(args))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(
            json.dumps(
                from_exception(error, getattr(args, "command", None)).as_dict(),
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
