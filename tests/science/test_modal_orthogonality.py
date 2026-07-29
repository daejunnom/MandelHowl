from __future__ import annotations

import unittest

try:
    from .common import datasets
except ImportError:
    from common import datasets
from mandelhowl_baker.validation import modal_orthogonality_error


class ModalOrthogonalityTests(unittest.TestCase):
    def test_unit_modal_mass_and_orthogonality(self) -> None:
        self.assertTrue(datasets())
        for dataset in datasets():
            diagonal, off_diagonal = modal_orthogonality_error(
                dataset / "science" / "solver-evidence.bin"
            )
            self.assertLess(diagonal, 5e-8)
            self.assertLess(off_diagonal, 5e-7)


if __name__ == "__main__":
    unittest.main()
