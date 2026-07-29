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

/**
 * Decodes the deliberately portable subset emitted by MandelHowl's baker:
 * uncompressed R8, RG8 or RGBA8, one mip level, 2D array layers, one face.
 * Basis/UASTC payloads require a version-pinned transcoder and are rejected
 * rather than silently rendered as unrelated procedural data.
 */
export function decodePortableKtx2(buffer: ArrayBuffer): DecodedKtx2Array {
  const bytes = new Uint8Array(buffer);
  if (!hasKtx2Identifier(bytes) || bytes.byteLength < 104) {
    throw new Error("Invalid KTX2 identifier or truncated header.");
  }

  const view = new DataView(buffer);
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
  if (supercompressionScheme !== 0) {
    throw new Error(
      "Supercompressed KTX2 requires the production transcoder and cannot use the portable decoder.",
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
  const byteOffset = readUint64(view, 80);
  const byteLength = readUint64(view, 88);
  const expectedLength = width * height * layers * channels;
  if (
    byteOffset < 104 ||
    byteLength < expectedLength ||
    byteOffset + expectedLength > bytes.byteLength
  ) {
    throw new Error("KTX2 level index does not contain the declared layers.");
  }

  return Object.freeze({
    width,
    height,
    layers,
    channels,
    srgb: vkFormat === VK_FORMAT_R8G8B8A8_SRGB,
    pixels: bytes.slice(byteOffset, byteOffset + expectedLength),
  });
}

export async function fetchPortableKtx2(
  url: string,
  signal?: AbortSignal,
): Promise<DecodedKtx2Array> {
  const response = await fetch(url, {
    cache: "force-cache",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(`KTX2 request failed with HTTP ${response.status}.`);
  }
  return decodePortableKtx2(await response.arrayBuffer());
}
