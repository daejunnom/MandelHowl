import {
  MODES_BINARY_V1,
  RESPONSE_BINARY_V1,
  type FrequencyResponseTable,
  type ModeRecord,
} from "../../contracts/src";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}
function assertHeader(
  bytes: Uint8Array,
  expected: {
    readonly magic: string;
    readonly version: number;
    readonly headerBytes: number;
  },
): DataView {
  if (bytes.byteLength < expected.headerBytes) {
    throw new RangeError(`${expected.magic} header is truncated`);
  }
  const magic = textDecoder.decode(bytes.subarray(0, 8));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (magic !== expected.magic) {
    throw new TypeError(`Unexpected binary magic ${JSON.stringify(magic)}`);
  }
  if (view.getUint16(8, true) !== expected.version) {
    throw new TypeError(`${expected.magic} version is unsupported`);
  }
  if (view.getUint16(10, true) !== expected.headerBytes) {
    throw new TypeError(`${expected.magic} header length is invalid`);
  }
  return view;
}

function decodeFixedString(bytes: Uint8Array): string {
  const nullIndex = bytes.indexOf(0);
  const text = textDecoder
    .decode(nullIndex < 0 ? bytes : bytes.subarray(0, nullIndex))
    .trim();
  if (text === "") throw new TypeError("Mode id must not be empty");
  return text;
}

export function decodeModesBinaryV1(
  input: ArrayBuffer | Uint8Array,
): readonly ModeRecord[] {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = assertHeader(bytes, MODES_BINARY_V1);
  const count = view.getUint32(12, true);
  const expectedBytes =
    MODES_BINARY_V1.headerBytes + count * MODES_BINARY_V1.recordBytes;
  if (bytes.byteLength !== expectedBytes) {
    throw new RangeError(
      `Modes length ${bytes.byteLength} does not match ${expectedBytes}`,
    );
  }

  const records: ModeRecord[] = [];
  let previousFrequency = 0;
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const base =
      MODES_BINARY_V1.headerBytes + index * MODES_BINARY_V1.recordBytes;
    const modeId = decodeFixedString(
      bytes.subarray(base, base + MODES_BINARY_V1.idBytes),
    );
    const naturalFrequencyHz = assertFinite(
      view.getFloat64(base + 32, true),
      `${modeId}.naturalFrequencyHz`,
    );
    const angularFrequencyRadPerSecond = assertFinite(
      view.getFloat64(base + 40, true),
      `${modeId}.angularFrequencyRadPerSecond`,
    );
    const dampingRatio = assertFinite(
      view.getFloat64(base + 48, true),
      `${modeId}.dampingRatio`,
    );
    const signCode = view.getUint8(base + 88);
    if (
      ids.has(modeId) ||
      naturalFrequencyHz <= previousFrequency ||
      naturalFrequencyHz <= 0 ||
      dampingRatio < 0 ||
      signCode > 1
    ) {
      throw new TypeError(`Mode record ${modeId} violates ordering or bounds`);
    }
    const expectedAngular = naturalFrequencyHz * Math.PI * 2;
    if (
      Math.abs(angularFrequencyRadPerSecond - expectedAngular) >
      Math.max(1e-8, expectedAngular * 1e-8)
    ) {
      throw new TypeError(`${modeId} angular frequency is inconsistent`);
    }
    ids.add(modeId);
    previousFrequency = naturalFrequencyHz;
    records.push(
      Object.freeze({
        modeId,
        ordinal: view.getUint32(base + 24, true),
        textureLayer: view.getUint32(base + 28, true),
        naturalFrequencyHz,
        angularFrequencyRadPerSecond,
        dampingRatio,
        actuatorCoupling: assertFinite(
          view.getFloat64(base + 56, true),
          `${modeId}.actuatorCoupling`,
        ),
        microphoneCoupling: assertFinite(
          view.getFloat64(base + 64, true),
          `${modeId}.microphoneCoupling`,
        ),
        radiationEfficiency: assertFinite(
          view.getFloat64(base + 72, true),
          `${modeId}.radiationEfficiency`,
        ),
        phaseReferenceRad: assertFinite(
          view.getFloat64(base + 80, true),
          `${modeId}.phaseReferenceRad`,
        ),
        signReference:
          signCode === 0
            ? "actuator-positive"
            : "first-nonzero-node-positive",
      }),
    );
  }
  return Object.freeze(records);
}

export function decodeResponseBinaryV1(
  input: ArrayBuffer | Uint8Array,
): FrequencyResponseTable {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = assertHeader(bytes, RESPONSE_BINARY_V1);
  const sampleCount = view.getUint32(12, true);
  const expectedBytes =
    RESPONSE_BINARY_V1.headerBytes +
    sampleCount * RESPONSE_BINARY_V1.recordBytes;
  if (bytes.byteLength !== expectedBytes) {
    throw new RangeError(
      `Response length ${bytes.byteLength} does not match ${expectedBytes}`,
    );
  }

  const frequenciesHz: number[] = [];
  const real: number[] = [];
  const imaginary: number[] = [];
  let previousFrequency = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const base =
      RESPONSE_BINARY_V1.headerBytes +
      index * RESPONSE_BINARY_V1.recordBytes;
    const frequency = assertFinite(
      view.getFloat64(base, true),
      `response[${index}].frequencyHz`,
    );
    if (frequency <= previousFrequency || frequency <= 0) {
      throw new TypeError("Response frequencies must be strictly increasing");
    }
    previousFrequency = frequency;
    frequenciesHz.push(frequency);
    real.push(
      assertFinite(
        view.getFloat64(base + 8, true),
        `response[${index}].real`,
      ),
    );
    imaginary.push(
      assertFinite(
        view.getFloat64(base + 16, true),
        `response[${index}].imaginary`,
      ),
    );
  }
  return Object.freeze({
    sampleCount,
    frequenciesHz: Object.freeze(frequenciesHz),
    real: Object.freeze(real),
    imaginary: Object.freeze(imaginary),
  });
}
