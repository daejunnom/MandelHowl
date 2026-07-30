from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).resolve().parents[2]
BAKER_SOURCE = REPOSITORY / "tools" / "physics-baker" / "src"
if str(BAKER_SOURCE) not in sys.path:
    sys.path.insert(0, str(BAKER_SOURCE))

from mandelhowl_baker.ktx2 import Ktx2Info, validate_ktx2


def datasets() -> list[Path]:
    root = REPOSITORY / "assets" / "generated"
    return sorted(
        path
        for path in root.iterdir()
        if path.is_dir()
        and len(path.name) == 64
        and all(character in "0123456789abcdef" for character in path.name)
    )


def texture_by_kind(
    dataset: Path,
    manifest: dict[str, Any],
    kind: str,
) -> Ktx2Info:
    descriptors = [
        row
        for row in manifest["files"]["textures"]
        if row["kind"] == kind
    ]
    if not descriptors:
        raise AssertionError(f"texture kind is missing: {kind}")
    decoded = [
        validate_ktx2((dataset / row["path"]).read_bytes())
        for row in descriptors
    ]
    first = decoded[0]
    if any(
        item.width != first.width
        or item.height != first.height
        or item.channels != first.channels
        for item in decoded
    ):
        raise AssertionError(f"texture shards differ: {kind}")
    return Ktx2Info(
        vk_format=first.vk_format,
        width=first.width,
        height=first.height,
        layers=sum(item.layers for item in decoded),
        channels=first.channels,
        orientation=first.orientation,
        supercompression_scheme=first.supercompression_scheme,
        encoded_level_length=sum(
            item.encoded_level_length for item in decoded
        ),
        level_offset=0,
        level_length=sum(item.level_length for item in decoded),
        image_data=b"".join(item.image_data for item in decoded),
    )
