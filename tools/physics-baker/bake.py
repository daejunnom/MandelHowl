#!/usr/bin/env python3
"""Repository-local entry point that does not require package installation."""

from pathlib import Path
import sys

PACKAGE_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from mandelhowl_baker.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
