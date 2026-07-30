"""Minimal standards-oriented ZLIB-supercompressed KTX2 array writer/validator.

The writer emits Vulkan ``R8_UNORM`` or ``R8G8_UNORM`` 2D-array textures,
linear transfer, BT.709 primaries, explicit ``ru`` orientation, standard KTX2
ZLIB supercompression scheme 3, and one mip level. The browser inflates the
payload before portable R8/RG8 upload; no Basis/UASTC GPU block compression is
claimed.
"""

from __future__ import annotations

import math
import struct
import zlib
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
    orientation: str
    supercompression_scheme: int
    encoded_level_length: int
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


class _DeflateBitReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit_offset = 0

    def read(self, bit_count: int) -> int:
        value = 0
        for bit_index in range(bit_count):
            byte_index = self.bit_offset // 8
            if byte_index >= len(self.data):
                raise ValueError("KTX2 DEFLATE payload is truncated")
            value |= (
                (self.data[byte_index] >> (self.bit_offset % 8)) & 1
            ) << bit_index
            self.bit_offset += 1
        return value

    def align(self) -> None:
        self.bit_offset = (self.bit_offset + 7) // 8 * 8


def _read_fixed_symbol(reader: _DeflateBitReader) -> int:
    canonical_code = 0
    for bit_count in range(1, 10):
        canonical_code = (canonical_code << 1) | reader.read(1)
        if bit_count == 7 and canonical_code <= 0x17:
            return 256 + canonical_code
        if bit_count == 8 and 0x30 <= canonical_code <= 0xBF:
            return canonical_code - 0x30
        if bit_count == 8 and 0xC0 <= canonical_code <= 0xC7:
            return 280 + canonical_code - 0xC0
        if bit_count == 9 and 0x190 <= canonical_code <= 0x1FF:
            return 144 + canonical_code - 0x190
    raise ValueError("KTX2 DEFLATE fixed-Huffman symbol is invalid")


def _validate_pinned_deflate_profile(encoded: bytes) -> None:
    if len(encoded) < 6:
        raise ValueError("KTX2 ZLIB payload is truncated")
    cmf, flg = encoded[0], encoded[1]
    if (
        cmf & 0x0F != 8
        or cmf >> 4 > 7
        or (cmf * 256 + flg) % 31
        or flg & 0x20
    ):
        raise ValueError("KTX2 ZLIB header is outside the pinned profile")
    reader = _DeflateBitReader(encoded[2:-4])
    length_extra = (
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
        4, 4, 4, 4, 5, 5, 5, 5, 0,
    )
    distance_extra = (
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
        9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
    )
    while True:
        final_block = reader.read(1)
        block_type = reader.read(2)
        if block_type == 0:
            reader.align()
            length = reader.read(16)
            inverse = reader.read(16)
            if length != (~inverse & 0xFFFF):
                raise ValueError("KTX2 DEFLATE stored block length is invalid")
            reader.read(length * 8)
        elif block_type == 1:
            while True:
                symbol = _read_fixed_symbol(reader)
                if symbol < 256:
                    continue
                if symbol == 256:
                    break
                if symbol > 285:
                    raise ValueError("KTX2 DEFLATE length symbol is reserved")
                reader.read(length_extra[symbol - 257])
                distance_symbol = 0
                for _ in range(5):
                    distance_symbol = (distance_symbol << 1) | reader.read(1)
                if distance_symbol >= 30:
                    raise ValueError("KTX2 DEFLATE distance symbol is reserved")
                reader.read(distance_extra[distance_symbol])
        elif block_type == 2:
            raise ValueError(
                "KTX2 dynamic-Huffman DEFLATE is outside the pinned baker profile"
            )
        else:
            raise ValueError("KTX2 DEFLATE block type is reserved")
        if final_block:
            return


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
    compressor = zlib.compressobj(
        level=9,
        wbits=zlib.MAX_WBITS,
        strategy=zlib.Z_FIXED,
    )
    encoded_image_data = compressor.compress(image_data) + compressor.flush()
    if len(encoded_image_data) >= len(image_data):
        raise ValueError(
            "KTX2 ZLIB level is not smaller than its uncompressed scientific payload"
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
        3,
        dfd_offset,
        len(dfd),
        kvd_offset,
        len(kvd),
        0,
        0,
    )
    level_index = struct.pack(
        "<3Q", data_offset, len(encoded_image_data), len(image_data)
    )
    result = header + level_index + dfd + kvd + padding + encoded_image_data
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
        or supercompression not in {0, 3}
    ):
        raise ValueError("invalid MandelHowl KTX2 2D-array header")
    if sgd_offset != 0 or sgd_length != 0:
        raise ValueError("KTX2 payload must not have global supercompression data")
    if dfd_offset != 104 or dfd_offset + dfd_length > len(data):
        raise ValueError("invalid KTX2 DFD range")
    dfd_total = struct.unpack_from("<I", data, dfd_offset)[0]
    if dfd_total != dfd_length:
        raise ValueError("KTX2 DFD length does not equal dfdTotalSize")
    if (
        kvd_length == 0
        or kvd_offset < dfd_offset + dfd_length
        or kvd_offset + kvd_length > len(data)
    ):
        raise ValueError("invalid KTX2 key/value range")
    level_offset, level_length, uncompressed_length = struct.unpack_from("<3Q", data, 80)
    channels = 1 if vk_format == VK_FORMAT_R8_UNORM else 2
    expected = width * height * layers * channels
    if uncompressed_length != expected or level_length <= 0:
        raise ValueError("KTX2 level byte length does not match dimensions")
    if (
        supercompression == 0
        and level_length != uncompressed_length
        or supercompression == 3
        and level_length >= uncompressed_length
    ):
        raise ValueError("KTX2 level length contradicts its supercompression scheme")
    if level_offset % math.lcm(channels, 4) or level_offset + level_length != len(data):
        raise ValueError("KTX2 level offset is misaligned or out of range")
    dfd_channels = (dfd_length - 28) // 16
    if (
        dfd_channels != channels
        or data[dfd_offset + 12 : dfd_offset + 16] != bytes((1, 1, 1, 0))
        or data[dfd_offset + 20] != channels
    ):
        raise ValueError("KTX2 DFD does not match Vulkan channel layout")
    metadata: dict[str, bytes] = {}
    cursor = kvd_offset
    kvd_end = kvd_offset + kvd_length
    while cursor < kvd_end:
        if cursor + 4 > kvd_end:
            raise ValueError("KTX2 key/value entry is truncated")
        entry_length = struct.unpack_from("<I", data, cursor)[0]
        entry_start = cursor + 4
        entry_end = entry_start + entry_length
        if entry_length == 0 or entry_end > kvd_end:
            raise ValueError("KTX2 key/value entry range is invalid")
        entry = data[entry_start:entry_end]
        separator = entry.find(b"\0")
        if separator <= 0:
            raise ValueError("KTX2 key/value entry has no key separator")
        key = entry[:separator].decode("utf-8")
        metadata[key] = entry[separator + 1 :].split(b"\0", 1)[0]
        cursor = entry_end + (-entry_length) % 4
    if cursor != kvd_end or metadata.get("KTXorientation") != b"ru":
        raise ValueError("KTX2 orientation must be ru")
    encoded_image_data = data[level_offset : level_offset + level_length]
    if supercompression == 3:
        _validate_pinned_deflate_profile(encoded_image_data)
        try:
            image_data = zlib.decompress(encoded_image_data)
        except zlib.error as error:
            raise ValueError(f"KTX2 ZLIB payload is invalid: {error}") from error
    else:
        # Compatibility for the immutable pre-algorithm-revision dataset.
        # Newly generated manifests require standard scheme 3.
        image_data = encoded_image_data
    if len(image_data) != expected:
        raise ValueError("KTX2 ZLIB payload length does not match dimensions")
    return Ktx2Info(
        vk_format=vk_format,
        width=width,
        height=height,
        layers=layers,
        channels=channels,
        orientation="ru",
        supercompression_scheme=supercompression,
        encoded_level_length=level_length,
        level_offset=level_offset,
        level_length=level_length,
        image_data=image_data,
    )
