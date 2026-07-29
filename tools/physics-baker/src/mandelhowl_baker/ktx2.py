"""Minimal standards-oriented uncompressed KTX2 array writer and validator.

The writer emits Vulkan ``R8_UNORM`` or ``R8G8_UNORM`` 2D-array textures,
linear transfer, BT.709 primaries, explicit ``ru`` orientation, no
supercompression, and one mip level. It does not claim Basis/UASTC GPU block
compression. The compact uncompressed LOD is intentional for this repository.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass

KTX2_IDENTIFIER = bytes.fromhex("ab4b5458203230bb0d0a1a0a")
VK_FORMAT_R8_UNORM = 9
VK_FORMAT_R8G8_UNORM = 16


@dataclass(frozen=True)
class Ktx2Info:
    vk_format: int
    width: int
    height: int
    layers: int
    channels: int
    level_offset: int
    level_length: int
    image_data: bytes


def _dfd(channels: int) -> bytes:
    if channels not in {1, 2}:
        raise ValueError("only one- and two-channel KTX2 output is supported")
    block_size = 24 + 16 * channels
    output = bytearray(struct.pack("<IIHH", 4 + block_size, 0, 2, block_size))
    # KHR_DF_MODEL_RGBSDA=1, BT709=1, LINEAR=1, straight alpha flags=0.
    output.extend(struct.pack("<4B", 1, 1, 1, 0))
    output.extend(struct.pack("<4B", 0, 0, 0, 0))
    output.extend(bytes([channels, 0, 0, 0, 0, 0, 0, 0]))
    for channel in range(channels):
        # bitOffset, bitLength-minus-one, channel id, sample position,
        # lower, upper.
        output.extend(
            struct.pack("<HBB4BII", channel * 8, 7, channel, 0, 0, 0, 0, 0, 255)
        )
    return bytes(output)


def _kvd_entry(key: str, value: bytes) -> bytes:
    payload = key.encode("utf-8") + b"\0" + value
    padding = (-len(payload)) % 4
    return struct.pack("<I", len(payload)) + payload + bytes(padding)


def write_ktx2_array(
    *,
    width: int,
    height: int,
    layers: int,
    channels: int,
    image_data: bytes,
) -> bytes:
    if min(width, height, layers) <= 0:
        raise ValueError("KTX2 dimensions and layer count must be positive")
    expected = width * height * layers * channels
    if len(image_data) != expected:
        raise ValueError(f"expected {expected} image bytes, received {len(image_data)}")
    vk_format = VK_FORMAT_R8_UNORM if channels == 1 else VK_FORMAT_R8G8_UNORM
    dfd = _dfd(channels)
    kvd = b"".join(
        (
            _kvd_entry("KTXorientation", b"ru\0"),
            _kvd_entry("KTXwriter", b"MandelHowl physics-baker 1.0.0\0"),
        )
    )
    header_bytes = 80
    level_index_bytes = 24
    dfd_offset = header_bytes + level_index_bytes
    kvd_offset = dfd_offset + len(dfd)
    unaligned_data_offset = kvd_offset + len(kvd)
    alignment = math.lcm(channels, 4)
    data_offset = (unaligned_data_offset + alignment - 1) // alignment * alignment
    padding = bytes(data_offset - unaligned_data_offset)
    header = struct.pack(
        "<12s9I4I2Q",
        KTX2_IDENTIFIER,
        vk_format,
        1,
        width,
        height,
        0,
        layers,
        1,
        1,
        0,
        dfd_offset,
        len(dfd),
        kvd_offset,
        len(kvd),
        0,
        0,
    )
    level_index = struct.pack("<3Q", data_offset, len(image_data), len(image_data))
    result = header + level_index + dfd + kvd + padding + image_data
    validate_ktx2(result)
    return result


def validate_ktx2(data: bytes) -> Ktx2Info:
    if len(data) < 104:
        raise ValueError("KTX2 file is shorter than its header and level index")
    unpacked = struct.unpack_from("<12s9I4I2Q", data, 0)
    (
        identifier,
        vk_format,
        type_size,
        width,
        height,
        depth,
        layers,
        faces,
        levels,
        supercompression,
        dfd_offset,
        dfd_length,
        kvd_offset,
        kvd_length,
        sgd_offset,
        sgd_length,
    ) = unpacked
    if identifier != KTX2_IDENTIFIER:
        raise ValueError("invalid KTX2 identifier")
    if vk_format not in {VK_FORMAT_R8_UNORM, VK_FORMAT_R8G8_UNORM}:
        raise ValueError(f"unsupported Vulkan format {vk_format}")
    if (
        type_size != 1
        or width <= 0
        or height <= 0
        or depth != 0
        or layers <= 0
        or faces != 1
        or levels != 1
        or supercompression != 0
    ):
        raise ValueError("invalid MandelHowl KTX2 2D-array header")
    if sgd_offset != 0 or sgd_length != 0:
        raise ValueError("uncompressed KTX2 must not have supercompression global data")
    if dfd_offset != 104 or dfd_offset + dfd_length > len(data):
        raise ValueError("invalid KTX2 DFD range")
    dfd_total = struct.unpack_from("<I", data, dfd_offset)[0]
    if dfd_total != dfd_length:
        raise ValueError("KTX2 DFD length does not equal dfdTotalSize")
    if kvd_length and (kvd_offset < dfd_offset + dfd_length or kvd_offset + kvd_length > len(data)):
        raise ValueError("invalid KTX2 key/value range")
    level_offset, level_length, uncompressed_length = struct.unpack_from("<3Q", data, 80)
    channels = 1 if vk_format == VK_FORMAT_R8_UNORM else 2
    expected = width * height * layers * channels
    if level_length != expected or uncompressed_length != expected:
        raise ValueError("KTX2 level byte length does not match dimensions")
    if level_offset % math.lcm(channels, 4) or level_offset + level_length != len(data):
        raise ValueError("KTX2 level offset is misaligned or out of range")
    dfd_channels = (dfd_length - 28) // 16
    if dfd_channels != channels or data[dfd_offset + 20] != channels:
        raise ValueError("KTX2 DFD does not match Vulkan channel layout")
    return Ktx2Info(
        vk_format=vk_format,
        width=width,
        height=height,
        layers=layers,
        channels=channels,
        level_offset=level_offset,
        level_length=level_length,
        image_data=data[level_offset : level_offset + level_length],
    )
