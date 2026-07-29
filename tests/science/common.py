from __future__ import annotations

import sys
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
BAKER_SOURCE = REPOSITORY / "tools" / "physics-baker" / "src"
if str(BAKER_SOURCE) not in sys.path:
    sys.path.insert(0, str(BAKER_SOURCE))


def datasets() -> list[Path]:
    root = REPOSITORY / "assets" / "generated"
    return sorted(
        path
        for path in root.iterdir()
        if path.is_dir()
        and len(path.name) == 64
        and all(character in "0123456789abcdef" for character in path.name)
    )
