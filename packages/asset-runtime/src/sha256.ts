export async function sha256Hex(
  input: string | ArrayBuffer | Uint8Array,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<string> {
  if (!cryptoProvider?.subtle) {
    throw new Error("WebCrypto SubtleCrypto is unavailable");
  }
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await cryptoProvider.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function bytesEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
