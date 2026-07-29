/**
 * Binary layouts are deliberately fixed-width and little-endian so Python
 * baking and browser decoding share one inspectable contract.
 */
export const MODES_BINARY_V1 = Object.freeze({
  magic: "MHMODES1",
  version: 1,
  headerBytes: 16,
  recordBytes: 96,
  idBytes: 24,
} as const);
export const RESPONSE_BINARY_V1 = Object.freeze({
  magic: "MHRESPN1",
  version: 1,
  headerBytes: 16,
  recordBytes: 24,
} as const);
