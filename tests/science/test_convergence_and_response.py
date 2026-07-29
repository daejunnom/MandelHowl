from __future__ import annotations

import json
import math
import unittest

try:
    from .common import datasets
except ImportError:
    from common import datasets
from mandelhowl_baker.validation import decode_modes, decode_response


class ConvergenceAndResponseTests(unittest.TestCase):
    def test_three_level_frequency_and_shape_convergence(self) -> None:
        self.assertTrue(datasets())
        for dataset in datasets():
            report = json.loads(
                (dataset / "convergence-report.json").read_text(encoding="utf-8")
            )
            self.assertEqual([row["name"] for row in report["levels"]], ["coarse", "medium", "fine"])
            self.assertTrue(report["accepted"])
            for row in report["comparisons"]:
                self.assertLessEqual(
                    row["mediumToFineRelativeChange"],
                    report["criteria"]["maximumRelativeFrequencyChange"],
                )
                self.assertGreaterEqual(
                    row["mediumToFineModalAssuranceCriterion"],
                    report["criteria"]["minimumModalAssuranceCriterion"],
                )
            reference = report["independentCrossValidation"]
            self.assertGreaterEqual(len(reference["frequencyChecks"]), 3)
            self.assertLess(
                max(row["relativeDifference"] for row in reference["frequencyChecks"]),
                0.15,
            )

    def test_response_is_recomputed_from_modal_coupling(self) -> None:
        for dataset in datasets():
            modes = decode_modes(dataset / "modes.bin")
            response = decode_response(dataset / "response.bin")
            provenance = json.loads(
                (dataset / "provenance.json").read_text(encoding="utf-8")
            )
            divisor = provenance["response"]["normalizationDivisor"]
            for sample_index in (0, 51, 177, 311, 511):
                frequency, stored_real, stored_imaginary = response[sample_index]
                omega = 2 * math.pi * frequency
                value = 0j
                for mode in modes:
                    omega_i = mode["angularFrequencyRadPerSecond"]
                    numerator = (
                        mode["actuatorCoupling"]
                        * mode["microphoneCoupling"]
                        * mode["radiationEfficiency"]
                        * omega_i
                        * omega_i
                    )
                    denominator = complex(
                        omega_i * omega_i - omega * omega,
                        2 * mode["dampingRatio"] * omega_i * omega,
                    )
                    value += numerator / denominator
                value /= divisor
                self.assertAlmostEqual(value.real, stored_real, places=12)
                self.assertAlmostEqual(value.imag, stored_imaginary, places=12)


if __name__ == "__main__":
    unittest.main()
