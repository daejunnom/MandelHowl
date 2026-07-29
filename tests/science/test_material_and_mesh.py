from __future__ import annotations

import copy
import json
import math
import struct
import unittest
import zlib

try:
    from .common import REPOSITORY, datasets
except ImportError:
    from common import REPOSITORY, datasets
from mandelhowl_baker.field import generate_material_field, mandelbrot_value
from mandelhowl_baker.yaml_min import load


class MaterialAndMeshTests(unittest.TestCase):
    def test_known_mandelbrot_coordinates_and_conjugacy(self) -> None:
        self.assertEqual(mandelbrot_value(0.0, 0.0, 256), 1.0)
        self.assertEqual(mandelbrot_value(-1.0, 0.0, 256), 1.0)
        self.assertLess(mandelbrot_value(2.0, 2.0, 256), 0.05)
        self.assertEqual(
            mandelbrot_value(-0.21, 0.73, 256),
            mandelbrot_value(-0.21, -0.73, 256),
        )

    def test_reduced_fixture_preserves_symmetry_and_limits(self) -> None:
        spec = load(REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml")
        field = generate_material_field(spec, 96)
        for y in range(48):
            mirror = 95 - y
            for x in range(96):
                self.assertEqual(
                    field.values[y * 96 + x],
                    field.values[mirror * 96 + x],
                )
        self.assertTrue(field.statistics["massWithinLimits"])
        self.assertTrue(field.statistics["centreOfMassWithinLimit"])
        self.assertTrue(field.statistics["minimumThicknessWithinLimit"])

    def test_alternate_valid_bounds_remain_asymmetric(self) -> None:
        spec = load(REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml")
        alternate = copy.deepcopy(spec)
        alternate["mandelbrotField"]["complexBounds"]["imaginaryMin"] = -1.0
        alternate["mandelbrotField"]["complexBounds"]["imaginaryMax"] = 1.5
        field = generate_material_field(alternate, 32)
        self.assertTrue(
            any(
                field.values[y * 32 + x]
                != field.values[(31 - y) * 32 + x]
                for y in range(16)
                for x in range(32)
            )
        )

    def test_escape_radius_is_fixed_by_algorithm_revision(self) -> None:
        spec = load(REPOSITORY / "specs" / "plate" / "mandelbrot-plate.v1.yaml")
        alternate = copy.deepcopy(spec)
        alternate["mandelbrotField"]["escapeRadius"] = 3
        with self.assertRaisesRegex(ValueError, "requires escape radius 2"):
            generate_material_field(alternate, 32)

    def test_packaged_meshes_have_positive_quality_and_fingerprint(self) -> None:
        self.assertTrue(datasets(), "no generated physics dataset found")
        for dataset in datasets():
            report = json.loads(
                (dataset / "mesh" / "mesh-evidence.json").read_text(encoding="utf-8")
            )
            self.assertEqual(len(report["levels"]), 3)
            for level in report["levels"]:
                self.assertEqual(level["invertedTriangleCount"], 0)
                self.assertEqual(level["connectedComponentCount"], 1)
                self.assertGreater(level["minimumSignedAreaM2"], 0)
                self.assertEqual(len(level["fingerprintSha256"]), 64)
                self.assertTrue(math.isfinite(level["maximumAspectRatio"]))
            fine = report["levels"][-1]
            archive = zlib.decompress(
                (dataset / "mesh" / "fine-polar-mesh.mhmz").read_bytes()
            )
            magic, version, nodes, triangles, components = struct.unpack_from(
                "<8sIIII", archive, 0
            )
            self.assertEqual((magic, version, components), (b"MHMESH01", 1, 3))
            self.assertEqual(nodes, fine["nodeCount"])
            self.assertEqual(triangles, fine["triangleCount"])
            self.assertEqual(len(archive), 24 + nodes * 12 + triangles * 12)


if __name__ == "__main__":
    unittest.main()
