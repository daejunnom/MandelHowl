import { describe, expect, it } from "vitest";
import { decodePortableKtx2 } from "./ktx2-texture";
import {
  frameFromSnapshot,
  selectRenderQuality,
} from "./render-types";
import type { RuntimeSnapshot } from "../../contracts/src";

function portableR8Ktx2(
  width: number,
  height: number,
  layers: number,
  pixels: readonly number[],
): ArrayBuffer {
  const buffer = new ArrayBuffer(104 + pixels.length);
  const bytes = new Uint8Array(buffer);
  bytes.set([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a,
    0x0a,
  ]);
  const view = new DataView(buffer);
  view.setUint32(12, 9, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, layers, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  view.setUint32(44, 0, true);
  view.setBigUint64(80, BigInt(104), true);
  view.setBigUint64(88, BigInt(pixels.length), true);
  view.setBigUint64(96, BigInt(pixels.length), true);
  bytes.set(pixels, 104);
  return buffer;
}

function portableRg8Ktx2(): ArrayBuffer {
  const buffer = portableR8Ktx2(1, 1, 1, [11, 22]);
  new DataView(buffer).setUint32(12, 16, true);
  return buffer;
}

describe("render-engine", () => {
  it("decodes verified portable R8 KTX2 array layers", () => {
    const decoded = decodePortableKtx2(
      portableR8Ktx2(2, 2, 2, [0, 20, 40, 60, 80, 100, 120, 140]),
    );

    expect(decoded).toMatchObject({
      width: 2,
      height: 2,
      layers: 2,
      channels: 1,
      srgb: false,
    });
    expect([...decoded.pixels]).toEqual([
      0, 20, 40, 60, 80, 100, 120, 140,
    ]);
  });

  it("rejects supercompressed textures without a pinned transcoder", () => {
    const buffer = portableR8Ktx2(1, 1, 1, [255]);
    new DataView(buffer).setUint32(44, 1, true);
    expect(() => decodePortableKtx2(buffer)).toThrow(/transcoder/i);
  });

  it("preserves the canonical two-channel normal atlas without RGBA padding", () => {
    const decoded = decodePortableKtx2(portableRg8Ktx2());
    expect(decoded.channels).toBe(2);
    expect([...decoded.pixels]).toEqual([11, 22]);
  });

  it("selects quality without changing the simulation contract", () => {
    expect(
      selectRenderQuality(
        "webgl2",
        { reducedMotion: false, forcedColors: false },
        { logicalProcessors: 12, deviceMemoryGb: 8 },
      ),
    ).toBe("high");
    expect(
      selectRenderQuality("webgl2", {
        reducedMotion: true,
        forcedColors: false,
      }),
    ).toBe("reduced");
    expect(
      selectRenderQuality("canvas2d", {
        reducedMotion: false,
        forcedColors: false,
      }),
    ).toBe("canvas");
  });

  it("does not invent a dominant mode after the plate has fully decayed", () => {
    const snapshot = {
      modes: [
        {
          modeId: "mode-001",
          amplitudeNormalized: 0,
          phaseRad: 1,
          energyNormalized: 0,
        },
      ],
      feedback: { envelopeNormalized: 0 },
    } as unknown as RuntimeSnapshot;
    expect(frameFromSnapshot(snapshot).dominantModeId).toBeNull();
  });
});
