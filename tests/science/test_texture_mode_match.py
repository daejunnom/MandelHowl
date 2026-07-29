from __future__ import annotations

import json
import unittest

try:
    from .common import datasets
except ImportError:
    from common import datasets
from mandelhowl_baker.ktx2 import validate_ktx2


class TextureModeMatchTests(unittest.TestCase):
    def test_nodal_and_sand_layers_match_signed_displacement(self) -> None:
        self.assertTrue(datasets())
        for dataset in datasets():
            manifest = json.loads(
                (dataset / "manifest.json").read_text(encoding="utf-8")
            )
            textures = {
                row["kind"]: validate_ktx2((dataset / row["path"]).read_bytes())
                for row in manifest["files"]["textures"]
            }
            displacement = textures["signed-displacement"]
            nodal = textures["nodal-mask"]
            sand = textures["sand-density"]
            self.assertEqual(displacement.layers, 48)
            self.assertEqual(displacement.width, 128)
            self.assertEqual(textures["normal"].channels, 2)
            layer_pixels = displacement.width * displacement.height
            for layer in (0, 7, 15, 31, 47):
                start = layer * layer_pixels
                end = start + layer_pixels
                d = displacement.image_data[start:end]
                n = nodal.image_data[start:end]
                s = sand.image_data[start:end]
                nodal_indices = [index for index, value in enumerate(n) if value >= 250]
                self.assertGreater(len(nodal_indices), 5)
                self.assertLess(
                    sum(abs(d[index] / 127.5 - 1.0) for index in nodal_indices)
                    / len(nodal_indices),
                    0.08,
                )
                low = [
                    s[index]
                    for index, value in enumerate(d)
                    if abs(value / 127.5 - 1.0) <= 0.1 and n[index] > 0
                ]
                high = [
                    s[index]
                    for index, value in enumerate(d)
                    if abs(value / 127.5 - 1.0) >= 0.5
                ]
                self.assertGreater(sum(low) / len(low), sum(high) / len(high))


if __name__ == "__main__":
    unittest.main()
