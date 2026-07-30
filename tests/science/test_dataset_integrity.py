from __future__ import annotations

import json
import unittest

try:
    from .common import datasets
except ImportError:
    from common import datasets
from mandelhowl_baker.algorithm import (
    ALGORITHM_REVISION,
    TEXTURE_LAYERS_PER_SHARD,
)
from mandelhowl_baker.validation import validate_dataset


class DatasetIntegrityTests(unittest.TestCase):
    def test_every_content_addressed_dataset_validates(self) -> None:
        found = datasets()
        self.assertTrue(found, "no generated physics dataset found")
        for dataset in found:
            manifest = json.loads(
                (dataset / "manifest.json").read_text(encoding="utf-8")
            )
            if manifest.get("algorithmRevision") == ALGORITHM_REVISION:
                result = validate_dataset(dataset)
                self.assertTrue(result["valid"])
                self.assertEqual(result["modeCount"], 48)
                self.assertEqual(
                    result["textureCount"],
                    4 * 48 // TEXTURE_LAYERS_PER_SHARD,
                )
            else:
                # Pre-contract v1 archives remain readable compatibility
                # fixtures, but current r2 convergence policy cannot
                # retroactively attest their older numerical evidence.
                self.assertNotIn("algorithmRevision", manifest)
                self.assertEqual(manifest["modeCount"], 48)
                self.assertEqual(len(manifest["files"]["textures"]), 4)

    def test_manifest_frequency_and_solver_are_canonical(self) -> None:
        for dataset in datasets():
            manifest = json.loads(
                (dataset / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["frequencyRange"], {"minimumHz": 45.0, "maximumHz": 6000.0})
            expected_solver = (
                "mandelhowl-kirchhoff-love-finite-strip"
                if manifest.get("algorithmRevision") == ALGORITHM_REVISION
                else "mandelhowl-kirchhoff-love-rayleigh-ritz"
            )
            self.assertEqual(
                manifest["solverProvenance"]["solverName"],
                expected_solver,
            )
            self.assertEqual(
                manifest["plate"]["specSha256"],
                manifest["files"]["plateSpec"]["sha256"],
            )


if __name__ == "__main__":
    unittest.main()
