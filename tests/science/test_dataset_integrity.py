from __future__ import annotations

import json
import unittest

try:
    from .common import datasets
except ImportError:
    from common import datasets
from mandelhowl_baker.validation import validate_dataset


class DatasetIntegrityTests(unittest.TestCase):
    def test_every_content_addressed_dataset_validates(self) -> None:
        found = datasets()
        self.assertTrue(found, "no generated physics dataset found")
        for dataset in found:
            result = validate_dataset(dataset)
            self.assertTrue(result["valid"])
            self.assertEqual(result["modeCount"], 48)
            self.assertEqual(result["textureCount"], 4)

    def test_manifest_frequency_and_solver_are_canonical(self) -> None:
        for dataset in datasets():
            manifest = json.loads(
                (dataset / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["frequencyRange"], {"minimumHz": 45.0, "maximumHz": 6000.0})
            self.assertEqual(
                manifest["solverProvenance"]["solverName"],
                "mandelhowl-kirchhoff-love-rayleigh-ritz",
            )
            self.assertEqual(
                manifest["plate"]["specSha256"],
                manifest["files"]["plateSpec"]["sha256"],
            )


if __name__ == "__main__":
    unittest.main()
