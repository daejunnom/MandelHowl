import { describe, expect, it } from "vitest";
import {
  blendCanvasSandDensity,
  CanvasPlateRenderer,
  deterministicCanvasGrainAlpha,
} from "./canvas-plate-renderer";
import { decodePortableKtx2 } from "./ktx2-texture";
import {
  expectedPlateTextureChannels,
  frameFromSnapshot,
  ModalBlendTracker,
  RenderFrameTracker,
  selectRenderQuality,
} from "./render-types";
import type { RuntimeSnapshot } from "../../contracts/src";
import type { PlateTextureSource } from "./render-types";

function portableR8Ktx2(
  width: number,
  height: number,
  layers: number,
  pixels: readonly number[],
): ArrayBuffer {
  const buffer = new ArrayBuffer(104 + pixels.length);
  const bytes = new Uint8Array(buffer);
  bytes.set([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
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

function visualSnapshot(
  simulationTimeSeconds: number,
  modes: RuntimeSnapshot["modes"],
  activeModeId: string | null = null,
  datasetId: RuntimeSnapshot["datasetId"] = `sha256:${"a".repeat(64)}`,
): RuntimeSnapshot {
  return {
    datasetId,
    simulationTimeSeconds,
    modes,
    activeModeId,
    feedback: { envelopeNormalized: 0 },
  } as unknown as RuntimeSnapshot;
}

describe("render-engine", () => {
  it("decodes verified portable R8 KTX2 array layers", () => {
    const buffer = portableR8Ktx2(2, 2, 2, [0, 20, 40, 60, 80, 100, 120, 140]);
    const decoded = decodePortableKtx2(buffer);

    expect(decoded).toMatchObject({
      width: 2,
      height: 2,
      layers: 2,
      channels: 1,
      srgb: false,
    });
    expect([...decoded.pixels]).toEqual([0, 20, 40, 60, 80, 100, 120, 140]);
    expect(decoded.pixels.buffer).toBe(buffer);
    expect(decoded.pixels.byteOffset).toBe(104);
  });

  it("decodes a bounded Uint8Array window without copying its level", () => {
    const source = new Uint8Array(portableR8Ktx2(2, 1, 1, [31, 63]));
    const prefixBytes = 17;
    const container = new Uint8Array(prefixBytes + source.byteLength + 23);
    container.fill(0xee);
    container.set(source, prefixBytes);
    const window = new Uint8Array(
      container.buffer,
      prefixBytes,
      source.byteLength,
    );

    const decoded = decodePortableKtx2(window);

    expect([...decoded.pixels]).toEqual([31, 63]);
    expect(decoded.pixels.buffer).toBe(container.buffer);
    expect(decoded.pixels.byteOffset).toBe(prefixBytes + 104);
    expect(decoded.pixels.byteLength).toBe(2);

    container[prefixBytes + 104] = 95;
    expect(decoded.pixels[0]).toBe(95);
  });

  it("does not read a malformed Uint8Array beyond its declared window", () => {
    const source = new Uint8Array(portableR8Ktx2(1, 1, 1, [255]));
    const prefixBytes = 9;
    const container = new Uint8Array(prefixBytes + source.byteLength + 16);
    container.set(source, prefixBytes);
    const truncatedWindow = new Uint8Array(
      container.buffer,
      prefixBytes,
      source.byteLength - 1,
    );

    expect(() => decodePortableKtx2(truncatedWindow)).toThrow(
      /declared layers/i,
    );
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

  it("pins the channel layout for every precomputed atlas kind", () => {
    expect(expectedPlateTextureChannels("normal")).toBe(2);
    expect(expectedPlateTextureChannels("signed-displacement")).toBe(1);
    expect(expectedPlateTextureChannels("nodal-mask")).toBe(1);
    expect(expectedPlateTextureChannels("sand-density")).toBe(1);
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

  it("reuses the render projection on the animation hot path", () => {
    const firstSnapshot = visualSnapshot(0, [
      {
        modeId: "mode-a",
        amplitudeNormalized: 0.5,
        phaseRad: 0.25,
        energyNormalized: 0.25,
      },
    ]);
    const tracker = new RenderFrameTracker(firstSnapshot);
    const first = tracker.update(firstSnapshot);
    const second = tracker.update(
      visualSnapshot(1 / 60, [
        {
          modeId: "mode-a",
          amplitudeNormalized: 0.8,
          phaseRad: 0.75,
          energyNormalized: 0.64,
        },
      ]),
    );

    expect(second).toBe(first);
    expect(second.dominantModeId).toBe("mode-a");
    expect(second.dominantModePhase).toBeCloseTo(0.75);
  });

  it("mixes equal pre-baked modal layers instead of selecting only one", () => {
    const tracker = new ModalBlendTracker(4);
    const selection = tracker.update(
      visualSnapshot(0, [
        {
          modeId: "mode-a",
          amplitudeNormalized: 0.5,
          phaseRad: 0,
          energyNormalized: 0.25,
        },
        {
          modeId: "mode-b",
          amplitudeNormalized: 0.5,
          phaseRad: Math.PI,
          energyNormalized: 0.25,
        },
      ]),
    );

    expect(selection.count).toBe(2);
    expect(selection.modeIds.slice(0, 2)).toEqual(["mode-a", "mode-b"]);
    expect(selection.sandWeights[0]).toBeCloseTo(0.5);
    expect(selection.sandWeights[1]).toBeCloseTo(0.5);
    expect(selection.displacementWeights[0]).toBeCloseTo(0.5);
    expect(selection.displacementWeights[1]).toBeCloseTo(-0.5);
  });

  it("selects all four WebGL modal slots in deterministic energy order", () => {
    const tracker = new ModalBlendTracker(4);
    const selection = tracker.update(
      visualSnapshot(
        0,
        [0.9, 0.7, 0.5, 0.3, 0.1].map((energy, index) => ({
          modeId: `mode-${index}`,
          amplitudeNormalized: Math.sqrt(energy),
          phaseRad: 0,
          energyNormalized: energy,
        })),
      ),
    );

    expect(selection.count).toBe(4);
    expect(selection.modeIds.slice(0, 4)).toEqual([
      "mode-0",
      "mode-1",
      "mode-2",
      "mode-3",
    ]);
    expect(
      [...selection.sandWeights].reduce((total, weight) => total + weight, 0),
    ).toBeCloseTo(1);
  });

  it("turns a dense Canvas field into separated deterministic grains", () => {
    const firstPass = Array.from({ length: 256 }, (_, index) =>
      deterministicCanvasGrainAlpha(255, index % 16, Math.floor(index / 16), 3),
    );
    const secondPass = Array.from({ length: 256 }, (_, index) =>
      deterministicCanvasGrainAlpha(255, index % 16, Math.floor(index / 16), 3),
    );

    expect(secondPass).toEqual(firstPass);
    expect(firstPass.some((alpha) => alpha === 0)).toBe(true);
    expect(firstPass.some((alpha) => alpha > 0)).toBe(true);
    expect(deterministicCanvasGrainAlpha(0, 4, 9, 3)).toBe(0);
  });

  it("blends Canvas density before applying the nonlinear grain pass", () => {
    expect(blendCanvasSandDensity(240, 0.25, 80, 0.75)).toBe(120);
    expect(blendCanvasSandDensity(0, 0.5, 255, 0.5)).toBe(127.5);
  });

  it("shows a newly captured mode immediately while retaining the old pattern", () => {
    const tracker = new ModalBlendTracker(2);
    tracker.update(
      visualSnapshot(0, [
        {
          modeId: "old",
          amplitudeNormalized: 0.9,
          phaseRad: 0,
          energyNormalized: 0.81,
        },
        {
          modeId: "secondary",
          amplitudeNormalized: 0.7,
          phaseRad: 0,
          energyNormalized: 0.49,
        },
        {
          modeId: "captured",
          amplitudeNormalized: 0,
          phaseRad: 0,
          energyNormalized: 0,
        },
      ]),
    );

    const selection = tracker.update(
      visualSnapshot(
        1 / 240,
        [
          {
            modeId: "old",
            amplitudeNormalized: 0.88,
            phaseRad: 0.1,
            energyNormalized: 0.77,
          },
          {
            modeId: "secondary",
            amplitudeNormalized: 0.68,
            phaseRad: 0.1,
            energyNormalized: 0.46,
          },
          {
            modeId: "captured",
            amplitudeNormalized: 0,
            phaseRad: 0,
            energyNormalized: 0,
          },
        ],
        "captured",
      ),
    );

    expect(selection.modeIds.slice(0, 2)).toContain("captured");
    expect(selection.modeIds.slice(0, 2)).toContain("old");
    expect(selection.sandWeights[1]).toBeGreaterThan(0);
  });

  it("keeps a deterministic residual and decays it over subsequent frames", () => {
    const tracker = new ModalBlendTracker(2);
    const energetic = visualSnapshot(0, [
      {
        modeId: "ring",
        amplitudeNormalized: 1,
        phaseRad: 0,
        energyNormalized: 1,
      },
    ]);
    const silentModes = [
      {
        modeId: "ring",
        amplitudeNormalized: 0,
        phaseRad: 0,
        energyNormalized: 0,
      },
    ];
    const first = tracker.update(energetic);
    const sameOutput = tracker.update(visualSnapshot(0.05, silentModes));
    const residualAt50ms = sameOutput.presence;

    expect(sameOutput).toBe(first);
    expect(residualAt50ms).toBeGreaterThan(0.9);
    for (let frame = 2; frame <= 240; frame += 1) {
      tracker.update(visualSnapshot(frame / 60, silentModes));
    }
    expect(sameOutput.presence).toBeLessThan(residualAt50ms);
    expect(sameOutput.presence).toBeLessThan(0.1);
  });

  it("does not leak residual weight across datasets with identical mode ids", () => {
    const tracker = new ModalBlendTracker(2);
    tracker.update(
      visualSnapshot(0, [
        {
          modeId: "shared",
          amplitudeNormalized: 1,
          phaseRad: 0,
          energyNormalized: 1,
        },
      ]),
    );
    const switched = tracker.update(
      visualSnapshot(
        0.1,
        [
          {
            modeId: "shared",
            amplitudeNormalized: 0,
            phaseRad: 0,
            energyNormalized: 0,
          },
        ],
        null,
        `sha256:${"b".repeat(64)}`,
      ),
    );

    expect(switched.count).toBe(0);
    expect(switched.presence).toBe(0);
  });

  it("reuses a verified sand upload when the same dataset is completed", async () => {
    const diagnostics: string[] = [];
    const renderer = new CanvasPlateRenderer(
      {} as HTMLCanvasElement,
      {} as CanvasRenderingContext2D,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
        },
        onDiagnostic: (record) => diagnostics.push(record.code),
      },
    );
    const datasetId = "sha256:same-dataset";
    const source = (bytes: Uint8Array, id = datasetId): PlateTextureSource => ({
      datasetId: id,
      atlases: [
        {
          kind: "sand-density",
          url: "https://example.test/sand.ktx2",
          mediaType: "image/ktx2",
          modeIds: ["mode-a"],
          width: 1,
          height: 1,
          layers: 1,
          bytes,
        },
      ],
    });

    await renderer.setTextureSource(
      source(new Uint8Array(portableR8Ktx2(1, 1, 1, [255]))),
    );
    expect(renderer.status).toMatchObject({
      datasetId,
      textureReady: true,
    });

    // The final full source has the same content-addressed identity. Its sand
    // descriptor is already resident, so even unusable replacement bytes are
    // not decoded or uploaded a second time.
    await renderer.setTextureSource(source(new Uint8Array([0])));
    expect(renderer.status).toMatchObject({
      datasetId,
      textureReady: true,
    });
    expect(diagnostics).toEqual([]);

    await renderer.setTextureSource(
      source(new Uint8Array([0]), "sha256:new-dataset"),
    );
    expect(renderer.status.textureReady).toBe(false);
    expect(diagnostics).toEqual(["MH-DATASET-INTEGRITY"]);
  });

  it("rejects a Canvas sand atlas with extra undeclared layers", async () => {
    const diagnostics: string[] = [];
    const renderer = new CanvasPlateRenderer(
      {} as HTMLCanvasElement,
      {} as CanvasRenderingContext2D,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
        },
        onDiagnostic: (record) => diagnostics.push(record.code),
      },
    );

    await renderer.setTextureSource({
      datasetId: "sha256:extra-layer",
      atlases: [
        {
          kind: "sand-density",
          url: "https://example.test/sand.ktx2",
          mediaType: "image/ktx2",
          modeIds: ["mode-a"],
          width: 1,
          height: 1,
          layers: 1,
          bytes: new Uint8Array(portableR8Ktx2(1, 1, 2, [255, 127])),
        },
      ],
    });

    expect(renderer.status.textureReady).toBe(false);
    expect(diagnostics).toEqual(["MH-DATASET-INTEGRITY"]);
  });

  it("rejects a Canvas sand atlas with the wrong channel layout", async () => {
    const diagnostics: string[] = [];
    const renderer = new CanvasPlateRenderer(
      {} as HTMLCanvasElement,
      {} as CanvasRenderingContext2D,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
        },
        onDiagnostic: (record) => diagnostics.push(record.code),
      },
    );

    await renderer.setTextureSource({
      datasetId: "sha256:wrong-channels",
      atlases: [
        {
          kind: "sand-density",
          url: "https://example.test/sand.ktx2",
          mediaType: "image/ktx2",
          modeIds: ["mode-a"],
          width: 1,
          height: 1,
          layers: 1,
          bytes: new Uint8Array(portableRg8Ktx2()),
        },
      ],
    });

    expect(renderer.status.textureReady).toBe(false);
    expect(diagnostics).toEqual(["MH-DATASET-INTEGRITY"]);
  });
});
