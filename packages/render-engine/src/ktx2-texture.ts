const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a,
  0x0a,
]);

const VK_FORMAT_R8_UNORM = 9;
const VK_FORMAT_R8G8_UNORM = 16;
const VK_FORMAT_R8G8B8A8_UNORM = 37;
const VK_FORMAT_R8G8B8A8_SRGB = 43;

export interface DecodedKtx2Array {
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly channels: 1 | 2 | 4;
  readonly srgb: boolean;
  readonly pixels: Uint8Array;
}

interface PortableKtx2Header
  extends Omit<DecodedKtx2Array, "pixels"> {
  readonly bytes: Uint8Array;
  readonly levelOffset: number;
  readonly levelLength: number;
  readonly uncompressedLength: number;
  readonly supercompressionScheme: number;
}

function readUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("KTX2 offset exceeds the browser safe integer range.");
  }
  return Number(value);
}

function hasKtx2Identifier(bytes: Uint8Array): boolean {
  if (bytes.byteLength < KTX2_IDENTIFIER.byteLength) return false;
  return KTX2_IDENTIFIER.every((byte, index) => bytes[index] === byte);
}

function parsePortableKtx2(
  input: ArrayBuffer | Uint8Array,
): PortableKtx2Header {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!hasKtx2Identifier(bytes) || bytes.byteLength < 104) {
    throw new Error("Invalid KTX2 identifier or truncated header.");
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const vkFormat = view.getUint32(12, true);
  const typeSize = view.getUint32(16, true);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const depth = view.getUint32(28, true);
  const rawLayerCount = view.getUint32(32, true);
  const faceCount = view.getUint32(36, true);
  const levelCount = view.getUint32(40, true);
  const supercompressionScheme = view.getUint32(44, true);

  if (typeSize !== 1 || width === 0 || height === 0) {
    throw new Error("KTX2 texture dimensions or component type are invalid.");
  }
  if (depth > 1 || faceCount !== 1 || levelCount !== 1) {
    throw new Error("Only one-level 2D KTX2 array textures are supported.");
  }
  if (
    supercompressionScheme !== 0 &&
    supercompressionScheme !== 3
  ) {
    throw new Error(
      `Unsupported KTX2 supercompression scheme ${supercompressionScheme}.`,
    );
  }

  const channels =
    vkFormat === VK_FORMAT_R8_UNORM
      ? 1
      : vkFormat === VK_FORMAT_R8G8_UNORM
        ? 2
      : vkFormat === VK_FORMAT_R8G8B8A8_UNORM ||
          vkFormat === VK_FORMAT_R8G8B8A8_SRGB
          ? 4
          : null;
  if (!channels) {
    throw new Error(`Unsupported portable KTX2 vkFormat ${vkFormat}.`);
  }

  const layers = Math.max(1, rawLayerCount);
  const levelOffset = readUint64(view, 80);
  const levelLength = readUint64(view, 88);
  const uncompressedLength = readUint64(view, 96);
  const expectedLength = width * height * layers * channels;
  if (
    levelOffset < 104 ||
    levelLength < 1 ||
    uncompressedLength !== expectedLength ||
    levelOffset + levelLength > bytes.byteLength ||
    (supercompressionScheme === 0 && levelLength !== expectedLength) ||
    (supercompressionScheme === 3 && levelLength >= expectedLength)
  ) {
    throw new Error("KTX2 level index does not contain the declared layers.");
  }

  return Object.freeze({
    bytes,
    width,
    height,
    layers,
    channels,
    srgb: vkFormat === VK_FORMAT_R8G8B8A8_SRGB,
    levelOffset,
    levelLength,
    uncompressedLength,
    supercompressionScheme,
  });
}

const LENGTH_BASE = Object.freeze([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35,
  43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA_BITS = Object.freeze([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4,
  4, 4, 4, 5, 5, 5, 5, 0,
]);
const DISTANCE_BASE = Object.freeze([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
  12289, 16385, 24577,
]);
const DISTANCE_EXTRA_BITS = Object.freeze([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9,
  9, 10, 10, 11, 11, 12, 12, 13, 13,
]);

function reverseBits(value: number, width: number): number {
  let reversed = 0;
  for (let index = 0; index < width; index += 1) {
    reversed = (reversed << 1) | ((value >>> index) & 1);
  }
  return reversed;
}

function createFixedLiteralTables(): readonly Int16Array[] {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  const counts = new Uint16Array(10);
  for (const length of lengths) counts[length] += 1;
  const nextCode = new Uint16Array(10);
  let code = 0;
  for (let bits = 1; bits <= 9; bits += 1) {
    code = (code + counts[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const tables = Array.from(
    { length: 10 },
    (_, length) => {
      const table = new Int16Array(1 << length);
      table.fill(-1);
      return table;
    },
  );
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    const canonicalCode = nextCode[length]++;
    tables[length][reverseBits(canonicalCode, length)] = symbol;
  }
  return Object.freeze(tables);
}

const FIXED_LITERAL_TABLES = createFixedLiteralTables();

class DeflateBitReader {
  private offset: number;
  private bitBuffer = 0;
  private bufferedBits = 0;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    private readonly end: number,
  ) {
    this.offset = start;
  }

  readBits(width: number): number {
    while (this.bufferedBits < width) {
      if (this.offset >= this.end) {
        throw new Error("KTX2 ZLIB DEFLATE payload is truncated.");
      }
      this.bitBuffer |= (this.bytes[this.offset] ?? 0) << this.bufferedBits;
      this.bufferedBits += 8;
      this.offset += 1;
    }
    const mask = width === 0 ? 0 : (1 << width) - 1;
    const value = this.bitBuffer & mask;
    this.bitBuffer >>>= width;
    this.bufferedBits -= width;
    return value;
  }

  alignToByte(): void {
    const discardedBits = this.bufferedBits % 8;
    this.bitBuffer >>>= discardedBits;
    this.bufferedBits -= discardedBits;
  }

  get isAtEncodedEnd(): boolean {
    return this.offset === this.end && this.bufferedBits < 8;
  }
}

function decodeFixedLiteralOrLength(reader: DeflateBitReader): number {
  let transmittedCode = 0;
  for (let width = 1; width <= 9; width += 1) {
    transmittedCode |= reader.readBits(1) << (width - 1);
    const symbol = FIXED_LITERAL_TABLES[width][transmittedCode] ?? -1;
    if (symbol >= 0) return symbol;
  }
  throw new Error("KTX2 ZLIB fixed-Huffman symbol is invalid.");
}

function readBigEndianUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function adler32(bytes: Uint8Array): number {
  const modulus = 65_521;
  let first = 1;
  let second = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    first += bytes[index] ?? 0;
    if (first >= modulus) first -= modulus;
    second += first;
    if (second >= modulus) second -= modulus;
  }
  return ((second << 16) | first) >>> 0;
}

/**
 * Bounded inflater for the pinned baker profile. It intentionally accepts
 * only stored and fixed-Huffman DEFLATE blocks, writes into the exact declared
 * KTX2 level size, and verifies the RFC 1950 Adler-32 trailer. Dynamic-Huffman
 * streams are rejected because neither versioned baker is allowed to emit
 * them.
 */
function inflatePinnedZlib(
  encoded: Uint8Array,
  expectedLength: number,
): Uint8Array {
  if (encoded.byteLength < 8) {
    throw new Error("KTX2 ZLIB payload is truncated.");
  }
  const cmf = encoded[0] ?? 0;
  const flg = encoded[1] ?? 0;
  if (
    (cmf & 0x0f) !== 8 ||
    (cmf >>> 4) > 7 ||
    ((cmf << 8) | flg) % 31 !== 0
  ) {
    throw new Error("KTX2 ZLIB header is invalid.");
  }
  if ((flg & 0x20) !== 0) {
    throw new Error("KTX2 ZLIB preset dictionaries are unsupported.");
  }

  const deflateEnd = encoded.byteLength - 4;
  const reader = new DeflateBitReader(encoded, 2, deflateEnd);
  const output = new Uint8Array(expectedLength);
  let outputOffset = 0;
  let finalBlock = false;

  while (!finalBlock) {
    finalBlock = reader.readBits(1) === 1;
    const blockType = reader.readBits(2);
    if (blockType === 0) {
      reader.alignToByte();
      const length = reader.readBits(16);
      const complement = reader.readBits(16);
      if (((length ^ 0xffff) & 0xffff) !== complement) {
        throw new Error("KTX2 ZLIB stored block length is corrupt.");
      }
      if (outputOffset + length > output.length) {
        throw new Error("KTX2 ZLIB output exceeds its declared level size.");
      }
      for (let index = 0; index < length; index += 1) {
        output[outputOffset] = reader.readBits(8);
        outputOffset += 1;
      }
      continue;
    }
    if (blockType === 2) {
      throw new Error(
        "KTX2 ZLIB dynamic-Huffman blocks violate the pinned baker profile.",
      );
    }
    if (blockType === 3) {
      throw new Error("KTX2 ZLIB DEFLATE block type is reserved.");
    }

    while (true) {
      const symbol = decodeFixedLiteralOrLength(reader);
      if (symbol < 256) {
        if (outputOffset >= output.length) {
          throw new Error("KTX2 ZLIB output exceeds its declared level size.");
        }
        output[outputOffset] = symbol;
        outputOffset += 1;
        continue;
      }
      if (symbol === 256) break;
      const lengthIndex = symbol - 257;
      if (lengthIndex < 0 || lengthIndex >= LENGTH_BASE.length) {
        throw new Error("KTX2 ZLIB length symbol is invalid.");
      }
      const length =
        (LENGTH_BASE[lengthIndex] ?? 0) +
        reader.readBits(LENGTH_EXTRA_BITS[lengthIndex] ?? 0);
      const distanceSymbol = reverseBits(reader.readBits(5), 5);
      if (distanceSymbol >= DISTANCE_BASE.length) {
        throw new Error("KTX2 ZLIB distance symbol is invalid.");
      }
      const distance =
        (DISTANCE_BASE[distanceSymbol] ?? 0) +
        reader.readBits(DISTANCE_EXTRA_BITS[distanceSymbol] ?? 0);
      if (
        distance < 1 ||
        distance > outputOffset ||
        distance > 32_768 ||
        outputOffset + length > output.length
      ) {
        throw new Error("KTX2 ZLIB back-reference is out of bounds.");
      }
      for (let index = 0; index < length; index += 1) {
        output[outputOffset] = output[outputOffset - distance] ?? 0;
        outputOffset += 1;
      }
    }
  }

  if (!reader.isAtEncodedEnd) {
    throw new Error("KTX2 ZLIB stream has trailing DEFLATE data.");
  }
  if (outputOffset !== expectedLength) {
    throw new Error(
      `KTX2 ZLIB payload inflated to ${outputOffset} bytes; expected ${expectedLength}.`,
    );
  }
  const expectedChecksum = readBigEndianUint32(encoded, deflateEnd);
  if (adler32(output) !== expectedChecksum) {
    throw new Error("KTX2 ZLIB Adler-32 checksum is invalid.");
  }
  return output;
}

/**
 * Synchronous portable decoder for the pinned MandelHowl KTX2 profile.
 * Scheme 0 stays zero-copy; scheme 3 is bounded by the declared level size.
 */
export function decodePortableKtx2(
  input: ArrayBuffer | Uint8Array,
): DecodedKtx2Array {
  const header = parsePortableKtx2(input);
  const encoded = header.bytes.subarray(
    header.levelOffset,
    header.levelOffset + header.levelLength,
  );
  return Object.freeze({
    width: header.width,
    height: header.height,
    layers: header.layers,
    channels: header.channels,
    srgb: header.srgb,
    pixels:
      header.supercompressionScheme === 0
        ? encoded
        : inflatePinnedZlib(encoded, header.uncompressedLength),
  });
}

/**
 * Decodes the versioned portable subset emitted by both native bakers:
 * R8/RG8/RGBA8, one mip level, 2D array layers, and either no
 * supercompression or standard KTX2 ZLIB scheme 3.
 */
export async function decodePortableKtx2Async(
  input: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<DecodedKtx2Array> {
  signal?.throwIfAborted();
  // Atlas installation can request several independent arrays at once. Put
  // each bounded inflate in its own browser task so those decodes cannot form
  // one contiguous main-thread long task before the next paint opportunity.
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
  signal?.throwIfAborted();
  const decoded = decodePortableKtx2(input);
  signal?.throwIfAborted();
  return decoded;
}
