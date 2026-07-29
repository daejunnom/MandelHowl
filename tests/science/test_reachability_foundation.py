from __future__ import annotations

import json
import unittest

try:
    from .common import datasets
except ImportError:
    from common import datasets


class ReachabilityFoundationTests(unittest.TestCase):
    def test_every_output_has_trace_or_physical_search_seed(self) -> None:
        self.assertTrue(datasets())
        for dataset in datasets():
            report = json.loads(
                (dataset / "coverage-report.json").read_text(encoding="utf-8")
            )
            self.assertFalse(report["perValueRuntimeExceptionTable"])
            outputs = report["outputs"]
            self.assertEqual([row["target"] for row in outputs], list(range(101)))
            for row in outputs:
                self.assertTrue(
                    "physicalAnchor" in row
                    or "trace" in row
                    or "segments" in row,
                    f"target {row['target']} has no physical evidence",
                )
            generation = json.loads(
                (dataset / "generation-report.json").read_text(encoding="utf-8")
            )
            if generation["releaseBake"]:
                self.assertEqual(
                    report["verificationStatus"], "runtime-replay-verified"
                )
                self.assertTrue(report["replayVerified"])
                self.assertEqual(report["missingValues"], [])
                self.assertTrue(report["staticDistribution"]["passed"])
                self.assertGreaterEqual(
                    report["staticDistribution"]["extremeFraction"], 0.9
                )
                self.assertTrue(
                    all(
                        row["verification"] == "runtime-replay-verified"
                        and row["verified"] is True
                        for row in outputs
                    )
                )


if __name__ == "__main__":
    unittest.main()
