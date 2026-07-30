import type { TextureAtlasReference } from "../../contracts/src";

const IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a,
  0x0a,
]);
const VK_FORMAT_R8_UNORM = 9;
const VK_FORMAT_R8G8_UNORM = 16;

function uint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("KTX2 offset exceeds the safe integer range");
  }
  return Number(value);
}

function validateOrientation(
  bytes: Uint8Array,
  offset: number,
  length: number,
): void {
  const end = offset + length;
  let cursor = offset;
  let orientation: string | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (cursor < end) {
    if (cursor + 4 > end) throw new RangeError("KTX2 KVD entry is truncated");
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + cursor,
      end - cursor,
    );
    const entryLength = view.getUint32(0, true);
    const entryStart = cursor + 4;
    const entryEnd = entryStart + entryLength;
    if (entryLength === 0 || entryEnd > end) {
      throw new RangeError("KTX2 KVD entry range is invalid");
    }
    const entry = bytes.subarray(entryStart, entryEnd);
    const separator = entry.indexOf(0);
    if (separator <= 0) throw new TypeError("KTX2 KVD key is invalid");
    const key = decoder.decode(entry.subarray(0, separator));
    if (key === "KTXorientation") {
      const value = entry.subarray(separator + 1);
      const terminator = value.indexOf(0);
      orientation = decoder.decode(
        terminator < 0 ? value : value.subarray(0, terminator),
      );
    }
    cursor = entryEnd + ((4 - (entryLength % 4)) % 4);
  }
  if (cursor !== end || orientation !== "ru") {
    throw new TypeError("KTX2 orientation must be ru");
  }
}

/**
 * Validate the exact portable KTX2 subset consumed by MandelHowl. Hash
 * verification proves identity; this check proves that the pinned bytes still
 * satisfy the declared layer, coordinate and channel contract.
 */
export function validateTextureAtlasBytes(
  bytes: Uint8Array,
  descriptor: TextureAtlasReference,
): void {
  if (
    bytes.byteLength < 104 ||
    !IDENTIFIER.every((byte, index) => bytes[index] === byte)
  ) {
    throw new TypeError(`${descriptor.kind} is not a complete KTX2 file`);
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const expectedChannels = descriptor.kind === "normal" ? 2 : 1;
  const expectedFormat =
    expectedChannels === 2 ? VK_FORMAT_R8G8_UNORM : VK_FORMAT_R8_UNORM;
  const format = view.getUint32(12, true);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const layers = view.getUint32(32, true);
  const supercompressionScheme = view.getUint32(44, true);
  const expectedSupercompressionScheme =
    descriptor.supercompressionScheme ?? 0;
  const dfdOffset = view.getUint32(48, true);
  const dfdLength = view.getUint32(52, true);
  const kvdOffset = view.getUint32(56, true);
  const kvdLength = view.getUint32(60, true);
  if (
    format !== expectedFormat ||
    view.getUint32(16, true) !== 1 ||
    width !== descriptor.widthPx ||
    height !== descriptor.heightPx ||
    view.getUint32(28, true) !== 0 ||
    layers !== descriptor.layers ||
    view.getUint32(36, true) !== 1 ||
    view.getUint32(40, true) !== 1 ||
    supercompressionScheme !== expectedSupercompressionScheme ||
    view.getBigUint64(64, true) !== BigInt(0) ||
    view.getBigUint64(72, true) !== BigInt(0)
  ) {
    throw new TypeError(`${descriptor.kind} KTX2 header disagrees with manifest`);
  }
  if (
    dfdOffset !== 104 ||
    dfdLength < 28 ||
    dfdOffset + dfdLength > bytes.byteLength ||
    view.getUint32(dfdOffset, true) !== dfdLength ||
    bytes[dfdOffset + 20] !== expectedChannels
  ) {
    throw new TypeError(`${descriptor.kind} KTX2 data format is invalid`);
  }
  if (
    kvdLength === 0 ||
    kvdOffset < dfdOffset + dfdLength ||
    kvdOffset + kvdLength > bytes.byteLength
  ) {
    throw new TypeError(`${descriptor.kind} KTX2 metadata range is invalid`);
  }
  validateOrientation(bytes, kvdOffset, kvdLength);

  const levelOffset = uint64(view, 80);
  const levelLength = uint64(view, 88);
  const uncompressedLength = uint64(view, 96);
  const expectedLength =
    descriptor.widthPx *
    descriptor.heightPx *
    descriptor.layers *
    expectedChannels;
  if (
    uncompressedLength !== expectedLength ||
    levelLength <= 0 ||
    (supercompressionScheme === 0 && levelLength !== expectedLength) ||
    (supercompressionScheme === 3 && levelLength >= expectedLength) ||
    levelOffset < kvdOffset + kvdLength ||
    levelOffset % Math.max(4, expectedChannels) !== 0 ||
    levelOffset + levelLength !== bytes.byteLength
  ) {
    throw new RangeError(`${descriptor.kind} KTX2 level range is invalid`);
  }
}
