import {
  constants as zlibConstants,
  deflateRawSync,
  deflateSync,
} from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  blendCanvasSandDensity,
  CANVAS_MODAL_CAPACITY,
  CanvasPlateRenderer,
  deterministicCanvasGrainAlpha,
  deterministicCanvasGrainHash,
} from "./canvas-plate-renderer";
import { decodePortableKtx2, decodePortableKtx2Async } from "./ktx2-texture";
import {
  ACTIVE_CAPTURE_FLOOR,
  evaluateDominantBasisFallback,
  expectedPlateTextureChannels,
  frameFromSnapshot,
  localSaturationEnvelope,
  MATERIAL_SECTION_PROFILE_SAMPLE_COUNT,
  ModalBlendTracker,
  normalizeMaterialSectionProfile,
  oscilloscopeSampleCountForQuality,
  plateDisplacementScale,
  PlateRendererStatusTracker,
  reportPlateRendererDiagnostic,
  reportPlateRendererStatus,
  RenderFrameTracker,
  renderQualityConfiguration,
  renderSeedFromDatasetId,
  sandVisibilityFromPresence,
  selectRenderQuality,
} from "./render-types";
import {
  createDiscVertices,
  createQuadVertices,
  feedbackCablePoint,
  FRAGMENT_SHADER,
  verifyEmbeddedWebglShaderIntegrity,
  WebglApparatusMotionTracker,
  WebGlPlateRenderer,
  WEBGL_APPARATUS_LAYOUT,
  WEBGL_APPARATUS_MESH_IDS,
  WEBGL_MODAL_CAPACITY,
  VERTEX_SHADER,
} from "./webgl-plate-renderer";
import { createPlateRenderer } from "./plate-renderer";
import { sha256Utf8Hex } from "./shader-integrity";
import {
  GENERATED_MOTION_SAFETY_SPEC,
  GENERATED_RENDER_QUALITY_TIERS_SPEC,
  type RuntimeSnapshot,
} from "../../contracts/src";
import type { PlateTextureSource } from "./render-types";
import WEBGL_SHADER_ALLOWLIST from "../../../specs/visual/webgl-shader-allowlist.v1.json";

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

function mockWebGl2Context(): WebGL2RenderingContext {
  const constants: Record<string, number> = {
    ARRAY_BUFFER: 0x8892,
    BLEND: 0x0be2,
    CLAMP_TO_EDGE: 0x812f,
    COLOR_BUFFER_BIT: 0x4000,
    COMPILE_STATUS: 0x8b81,
    CULL_FACE: 0x0b44,
    DEPTH_TEST: 0x0b71,
    FLOAT: 0x1406,
    FRAGMENT_SHADER: 0x8b30,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    LINK_STATUS: 0x8b82,
    MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    MAX_TEXTURE_SIZE: 0x0d33,
    NO_ERROR: 0,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    R8: 0x8229,
    RED: 0x1903,
    RG: 0x8227,
    RG8: 0x822b,
    RGBA: 0x1908,
    SRC_ALPHA: 0x0302,
    STATIC_DRAW: 0x88e4,
    TEXTURE0: 0x84c0,
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLES: 0x0004,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_SHADER: 0x8b31,
  };
  const objectFactory = () => ({});
  const special: Record<PropertyKey, unknown> = {
    ...constants,
    createBuffer: objectFactory,
    createProgram: objectFactory,
    createShader: objectFactory,
    createTexture: objectFactory,
    getAttribLocation: () => 0,
    getError: () => 0,
    getParameter: (name: number) =>
      name === constants.MAX_TEXTURE_SIZE ||
      name === constants.MAX_ARRAY_TEXTURE_LAYERS
        ? 4_096
        : 0,
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getUniformLocation: objectFactory,
  };
  return new Proxy(special, {
    get(target, property) {
      return Reflect.get(target, property) ?? (() => undefined);
    },
  }) as unknown as WebGL2RenderingContext;
}

function portableZlibR8Ktx2(
  width: number,
  height: number,
  layers: number,
  pixels: readonly number[],
): ArrayBuffer {
  const uncompressed = new Uint8Array(
    portableR8Ktx2(width, height, layers, pixels),
  );
  const encoded = deflateSync(uncompressed.subarray(104), {
    level: 9,
    strategy: zlibConstants.Z_FIXED,
  });
  const output = new Uint8Array(104 + encoded.byteLength);
  output.set(uncompressed.subarray(0, 104));
  output.set(encoded, 104);
  const view = new DataView(output.buffer);
  view.setUint32(44, 3, true);
  view.setBigUint64(88, BigInt(encoded.byteLength), true);
  view.setBigUint64(96, BigInt(pixels.length), true);
  return output.buffer;
}

function replacePortableZlibLevel(
  source: ArrayBuffer,
  encoded: Uint8Array,
): ArrayBuffer {
  const header = new Uint8Array(source, 0, 104);
  const output = new Uint8Array(104 + encoded.byteLength);
  output.set(header);
  output.set(encoded, 104);
  const view = new DataView(output.buffer);
  view.setBigUint64(88, BigInt(encoded.byteLength), true);
  return output.buffer;
}

function storedThenFixedPortableZlibR8Ktx2(
  width: number,
  height: number,
  layers: number,
  pixels: readonly number[],
): ArrayBuffer {
  const raw = Uint8Array.from(pixels);
  const wrapped = deflateSync(raw, {
    level: 9,
    strategy: zlibConstants.Z_FIXED,
  });
  const fixedDeflate = deflateRawSync(raw, {
    level: 9,
    strategy: zlibConstants.Z_FIXED,
  });
  const encoded = new Uint8Array(2 + 5 + fixedDeflate.byteLength + 4);
  encoded.set(wrapped.subarray(0, 2), 0);
  // Non-final stored block, byte aligned, with an empty LEN/NLEN pair.
  encoded.set([0x00, 0x00, 0x00, 0xff, 0xff], 2);
  encoded.set(fixedDeflate, 7);
  encoded.set(wrapped.subarray(wrapped.byteLength - 4), encoded.byteLength - 4);
  return replacePortableZlibLevel(
    portableZlibR8Ktx2(width, height, layers, pixels),
    encoded,
  );
}

function visualSnapshot(
  simulationTimeSeconds: number,
  modes: readonly (Omit<
    RuntimeSnapshot["modes"][number],
    "naturalFrequencyHz" | "audibleWeightNormalized"
  > & {
    readonly naturalFrequencyHz?: number;
    readonly audibleWeightNormalized?: number;
  })[],
  activeModeId: string | null = null,
  datasetId: RuntimeSnapshot["datasetId"] = `sha256:${"a".repeat(64)}`,
): RuntimeSnapshot {
  return {
    datasetId,
    sequence: 1,
    simulationTimeSeconds,
    dial: {
      driveFrequencyHz: 440,
    },
    modes: modes.map((mode, index) => ({
      ...mode,
      naturalFrequencyHz: mode.naturalFrequencyHz ?? 220 + index * 10,
      audibleWeightNormalized: mode.audibleWeightNormalized ?? 0.5,
    })),
    activeModeId,
    microphone: {
      rmsNormalized: 0,
      peakNormalized: 0,
      recentSamples: [],
    },
    feedback: {
      envelopeNormalized: 0,
      loopSignalNormalized: 0,
      limiterGainReductionDb: 0,
      limiterActive: false,
    },
    regime: "decaying",
    volume: {
      status: "measuring",
      value: null,
      lastSettledValue: null,
      progress: 0,
    },
  } as unknown as RuntimeSnapshot;
}

function apparatusSnapshot(options: {
  readonly timeSeconds: number;
  readonly driveFrequencyHz?: number;
  readonly feedback?: number;
  readonly microphone?: number;
  readonly regime?: RuntimeSnapshot["regime"];
}): RuntimeSnapshot {
  return {
    ...visualSnapshot(options.timeSeconds, []),
    sequence: 7,
    dial: {
      driveFrequencyHz: options.driveFrequencyHz ?? 440,
    },
    microphone: {
      rmsNormalized: options.microphone ?? 0,
      peakNormalized: options.microphone ?? 0,
      recentSamples: [],
    },
    feedback: {
      envelopeNormalized: options.feedback ?? 0,
      loopSignalNormalized: 0,
      limiterGainReductionDb: 0,
      limiterActive: false,
    },
    regime: options.regime ?? "decaying",
  } as unknown as RuntimeSnapshot;
}

describe("render-engine", () => {
  it("isolates throwing presentation observers from renderer control flow", () => {
    const options = {
      preferences: {
        reducedMotion: false,
        forcedColors: false,
      },
      onDiagnostic: () => {
        throw new Error("broken diagnostic observer");
      },
      onStatus: () => {
        throw new Error("broken status observer");
      },
    };

    expect(() =>
      reportPlateRendererDiagnostic(options, {
        code: "MH-TEST-OBSERVER",
        evidenceState: "confirmed",
        severity: "warning",
        messageKey: "test.observer",
        evidence: [],
      }),
    ).not.toThrow();
    expect(() =>
      reportPlateRendererStatus(options, {
        kind: "canvas2d",
        quality: "canvas",
        degradationStage: 6,
        datasetId: null,
        textureReady: false,
        materialSectionReady: false,
        contextLost: false,
        framesRendered: 0,
        lastSnapshotSequence: null,
      }),
    ).not.toThrow();
  });

  it("compiles only the exact embedded WebGL shader allowlist sources", () => {
    expect(sha256Utf8Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const integrity = verifyEmbeddedWebglShaderIntegrity();
    const program = WEBGL_SHADER_ALLOWLIST.programs[0];
    expect(integrity).toEqual({
      programId: "mandelhowl-plate-main",
      vertexSha256: program.vertex.sha256,
      fragmentSha256: program.fragment.sha256,
    });

    const compiledSources: string[] = [];
    const gl = mockWebGl2Context();
    gl.shaderSource = (_shader, source) => compiledSources.push(source);
    const renderer = new WebGlPlateRenderer(
      {
        addEventListener: () => undefined,
        dataset: {},
        height: 240,
        removeEventListener: () => undefined,
        width: 320,
      } as unknown as HTMLCanvasElement,
      gl,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
          preferredQuality: "reduced",
        },
      },
    );
    expect(compiledSources).toEqual([VERTEX_SHADER, FRAGMENT_SHADER]);
    expect(compiledSources.map(sha256Utf8Hex)).toEqual([
      program.vertex.sha256,
      program.fragment.sha256,
    ]);
    renderer.dispose();
  });

  it("uses a sibling Canvas2D renderer when WebGL initialization fails", () => {
    const gl = mockWebGl2Context();
    const deleteShader = vi.fn();
    gl.getShaderParameter = () => false;
    gl.deleteShader = deleteShader;

    const context = {
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const attributes = new Map<string, string>();
    const removed = vi.fn();
    const fallback = {
      className: "",
      classList: null as unknown as DOMTokenList,
      dataset: {},
      getAttribute: (name: string) => attributes.get(name) ?? null,
      getBoundingClientRect: () => ({ width: 320, height: 240 }),
      getContext: (kind: string) => (kind === "2d" ? context : null),
      height: 0,
      remove: removed,
      removeAttribute: (name: string) => attributes.delete(name),
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      width: 0,
    } as unknown as HTMLCanvasElement;
    const parent = {
      insertBefore: vi.fn(),
    } as unknown as HTMLElement;
    const originalAttributes = new Map<string, string>([
      ["role", "img"],
      ["aria-label", "Vibrating plate"],
    ]);
    const original = {
      addEventListener: vi.fn(),
      className: "mh-plate-canvas apparatus",
      classList: null as unknown as DOMTokenList,
      dataset: {},
      getAttribute: (name: string) => originalAttributes.get(name) ?? null,
      getContext: (kind: string) => (kind === "webgl2" ? gl : null),
      nextSibling: null,
      ownerDocument: {
        createElement: () => fallback,
      },
      parentElement: parent,
      removeAttribute: (name: string) => originalAttributes.delete(name),
      removeEventListener: vi.fn(),
      setAttribute: (name: string, value: string) =>
        originalAttributes.set(name, value),
      style: { opacity: "" },
    } as unknown as HTMLCanvasElement;
    const classListFor = (canvas: HTMLCanvasElement): DOMTokenList =>
      ({
        add: (...tokens: string[]) => {
          const classes = new Set(canvas.className.split(/\s+/u).filter(Boolean));
          for (const token of tokens) classes.add(token);
          canvas.className = [...classes].join(" ");
        },
        contains: (token: string) =>
          canvas.className.split(/\s+/u).includes(token),
        remove: (...tokens: string[]) => {
          const removedTokens = new Set(tokens);
          canvas.className = canvas.className
            .split(/\s+/u)
            .filter((token) => token && !removedTokens.has(token))
            .join(" ");
        },
      }) as unknown as DOMTokenList;
    (
      original as unknown as { classList: DOMTokenList }
    ).classList = classListFor(original);
    (
      fallback as unknown as { classList: DOMTokenList }
    ).classList = classListFor(fallback);

    const diagnostics: string[] = [];
    const windowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { devicePixelRatio: 1 },
    });
    try {
      const renderer = createPlateRenderer(original, {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
          preferredQuality: "reduced",
        },
        onDiagnostic: (record) => diagnostics.push(record.code),
      });

      expect(renderer.canvas).toBe(fallback);
      expect(renderer.status.kind).toBe("canvas2d");
      expect(
        fallback.getAttribute("data-render-fallback-reason"),
      ).toBe("webgl-initialization-failed");
      expect(original.classList.contains("mh-plate-canvas-suspended")).toBe(true);
      expect(original.getAttribute("aria-hidden")).toBe("true");
      expect(diagnostics).toEqual(["MH-RENDER-WEBGL-INIT"]);
      expect(deleteShader).toHaveBeenCalledTimes(1);

      renderer.dispose();
      expect(removed).toHaveBeenCalledTimes(1);
      expect(original.className).toBe("mh-plate-canvas apparatus");
      expect(original.getAttribute("role")).toBe("img");
      expect(original.getAttribute("aria-label")).toBe("Vibrating plate");
      expect(original.getAttribute("aria-hidden")).toBeNull();
    } finally {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

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

  it("rejects unsupported supercompression schemes", () => {
    const buffer = portableR8Ktx2(1, 1, 1, [255]);
    new DataView(buffer).setUint32(44, 1, true);
    expect(() => decodePortableKtx2(buffer)).toThrow(
      /Unsupported KTX2 supercompression scheme 1/,
    );
  });

  it("inflates the pinned fixed-Huffman KTX2 ZLIB scheme synchronously", () => {
    const pixels = Array.from({ length: 256 }, (_, index) =>
      index < 128 ? 37 : 219,
    );
    const decoded = decodePortableKtx2(portableZlibR8Ktx2(16, 16, 1, pixels));

    expect(decoded).toMatchObject({
      width: 16,
      height: 16,
      layers: 1,
      channels: 1,
    });
    expect([...decoded.pixels]).toEqual(pixels);
  });

  it("accepts stored blocks within the pinned fixed/stored ZLIB profile", () => {
    const pixels = Array.from({ length: 256 }, () => 73);
    expect([
      ...decodePortableKtx2(
        storedThenFixedPortableZlibR8Ktx2(16, 16, 1, pixels),
      ).pixels,
    ]).toEqual(pixels);
  });

  it("keeps the asynchronous decoder as an abort-aware compatibility API", async () => {
    const pixels = Array.from({ length: 256 }, () => 91);
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodePortableKtx2Async(
        portableZlibR8Ktx2(16, 16, 1, pixels),
        controller.signal,
      ),
    ).rejects.toThrow();
    const ordering = ["caller"];
    const decode = decodePortableKtx2Async(
      portableZlibR8Ktx2(16, 16, 1, pixels),
    ).then((decoded) => {
      ordering.push("decoded");
      return decoded;
    });
    await Promise.resolve();
    expect(ordering).toEqual(["caller"]);
    await expect(decode).resolves.toMatchObject({
      pixels: Uint8Array.from(pixels),
    });
    expect(ordering).toEqual(["caller", "decoded"]);
  });

  it("fails closed for corrupt, truncated, and wrong-length ZLIB payloads", () => {
    const valid = new Uint8Array(
      portableZlibR8Ktx2(
        16,
        16,
        1,
        Array.from({ length: 256 }, () => 73),
      ),
    );
    const checksumCorrupt = valid.slice();
    checksumCorrupt[checksumCorrupt.length - 1] ^= 0xff;
    expect(() => decodePortableKtx2(checksumCorrupt)).toThrow(/Adler-32/);

    const truncated = valid.slice(0, valid.length - 5);
    const truncatedView = new DataView(
      truncated.buffer,
      truncated.byteOffset,
      truncated.byteLength,
    );
    truncatedView.setBigUint64(88, BigInt(truncated.byteLength - 104), true);
    expect(() => decodePortableKtx2(truncated)).toThrow(/truncated|invalid/i);

    const shortRaw = Array.from({ length: 128 }, () => 73);
    const shortEncoded = deflateSync(Uint8Array.from(shortRaw), {
      level: 9,
      strategy: zlibConstants.Z_FIXED,
    });
    const wrongLength = replacePortableZlibLevel(valid.buffer, shortEncoded);
    expect(() => decodePortableKtx2(wrongLength)).toThrow(
      /inflated to 128 bytes; expected 256/,
    );
  });

  it("rejects dynamic-Huffman streams outside the pinned baker profile", () => {
    const pixels = Array.from({ length: 256 }, () => 73);
    const source = portableZlibR8Ktx2(16, 16, 1, pixels);
    // Valid zlib header, then a final dynamic-Huffman block marker. The
    // decoder must reject the profile before attempting to parse its tables.
    const dynamicMarker = Uint8Array.from([
      0x78, 0x01, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() =>
      decodePortableKtx2(replacePortableZlibLevel(source, dynamicMarker)),
    ).toThrow(/dynamic-Huffman/);
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

  it("decodes only the exact pre-baked 64-sample material section contract", () => {
    const profile = {
      schemaVersion: "mandelhowl.material-section-profile.v1" as const,
      axis: "x-at-y-zero" as const,
      sampleCount: MATERIAL_SECTION_PROFILE_SAMPLE_COUNT as 64,
      minimumThicknessM: 0.0018,
      maximumThicknessM: 0.0042,
      thicknessUnorm8: Array.from(
        { length: MATERIAL_SECTION_PROFILE_SAMPLE_COUNT },
        (_, index) => index * 4,
      ),
    };
    const normalized = normalizeMaterialSectionProfile(profile);
    expect(normalized).toBeInstanceOf(Float32Array);
    expect(normalized).toHaveLength(MATERIAL_SECTION_PROFILE_SAMPLE_COUNT);
    expect(normalized?.[0]).toBe(0);
    expect(normalized?.[63]).toBeCloseTo(252 / 255);
    expect(
      normalizeMaterialSectionProfile({
        ...profile,
        thicknessUnorm8: [0, 255],
      }),
    ).toBeNull();
    expect(
      normalizeMaterialSectionProfile({
        ...profile,
        maximumThicknessM: profile.minimumThicknessM,
      }),
    ).toBeNull();
  });

  it("derives bounded local emissive only from saturated nodal state", () => {
    expect(localSaturationEnvelope("growing", 1)).toBe(0);
    expect(localSaturationEnvelope("saturated", 0.74)).toBeCloseTo(0.74);
    expect(localSaturationEnvelope("saturated", 2)).toBe(1);
    expect(localSaturationEnvelope("saturated", Number.NaN)).toBe(0);
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

  it("maps runtime quality values to generated visual-tier budgets", () => {
    expect(renderQualityConfiguration("high")).toBe(
      GENERATED_RENDER_QUALITY_TIERS_SPEC.tiers[0],
    );
    expect(renderQualityConfiguration("balanced")).toBe(
      GENERATED_RENDER_QUALITY_TIERS_SPEC.tiers[1],
    );
    expect(renderQualityConfiguration("reduced")).toBe(
      GENERATED_RENDER_QUALITY_TIERS_SPEC.tiers[2],
    );
    expect(renderQualityConfiguration("canvas")).toBe(
      GENERATED_RENDER_QUALITY_TIERS_SPEC.tiers[3],
    );
    expect(oscilloscopeSampleCountForQuality("high", 0)).toBe(
      renderQualityConfiguration("high").oscilloscopeSamples,
    );
    expect(oscilloscopeSampleCountForQuality("high", 4)).toBe(
      renderQualityConfiguration("canvas").oscilloscopeSamples,
    );
    expect(WEBGL_MODAL_CAPACITY).toBe(
      renderQualityConfiguration("high").maximumTextureModesResident,
    );
    expect(CANVAS_MODAL_CAPACITY).toBe(
      renderQualityConfiguration("canvas").maximumTextureModesResident,
    );
    expect(plateDisplacementScale(false)).toBe(1);
    expect(plateDisplacementScale(true)).toBe(
      GENERATED_MOTION_SAFETY_SPEC.reducedMotion.plateDisplacementScale,
    );
    expect(plateDisplacementScale(true)).toBeLessThan(
      plateDisplacementScale(false),
    );
  });

  it("builds a real tessellated polar disc instead of a four-vertex quad", () => {
    const radialSegments = 4;
    const angularSegments = 8;
    const vertices = createDiscVertices(radialSegments, angularSegments);
    const expectedTriangles =
      angularSegments + (radialSegments - 1) * angularSegments * 2;

    expect(vertices.length).toBe(expectedTriangles * 3 * 2);
    expect(vertices.length / 2).toBeGreaterThan(4);
    let centerVertices = 0;
    for (let index = 0; index < vertices.length; index += 2) {
      const radius = Math.hypot(vertices[index] ?? 0, vertices[index + 1] ?? 0);
      expect(radius).toBeLessThanOrEqual(1.000_001);
      if (radius < 1e-7) centerVertices += 1;
    }
    expect(centerVertices).toBe(angularSegments);
  });

  it("pins literal low-cost speaker, plate, microphone, and cable meshes", () => {
    expect(WEBGL_APPARATUS_MESH_IDS).toEqual([
      "speaker-cone",
      "plate",
      "microphone",
      "feedback-cable",
    ]);
    expect(WEBGL_APPARATUS_LAYOUT.speaker[0]).toBeCloseTo(-0.8);
    expect(WEBGL_APPARATUS_LAYOUT.speaker[1]).toBeCloseTo(-0.3);
    expect(WEBGL_APPARATUS_LAYOUT.plate[0]).toBeCloseTo(0.002973977695167162);
    expect(WEBGL_APPARATUS_LAYOUT.plate[1]).toBeCloseTo(0.06);
    expect(WEBGL_APPARATUS_LAYOUT.microphone[0]).toBeCloseTo(0.8);
    expect(WEBGL_APPARATUS_LAYOUT.microphone[1]).toBeCloseTo(0.3);
    expect([...createQuadVertices()]).toEqual([
      -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1,
    ]);
  });

  it("drives every WebGL apparatus motion from one canonical snapshot", () => {
    const tracker = new WebglApparatusMotionTracker();
    const snapshot = apparatusSnapshot({
      timeSeconds: 0.2125,
      driveFrequencyHz: 6_000,
      feedback: 1,
      microphone: 0.62,
      regime: "growing",
    });
    const normal = tracker.update(snapshot, false);
    const retained = normal;

    expect(normal.feedbackLevelNormalized).toBe(1);
    expect(normal.microphoneLevelNormalized).toBe(0.62);
    expect(normal.cablePulseTravelling).toBe(true);
    // Saturated feedback uses the canonical 0.85 s cycle, so 0.2125 s is
    // exactly one quarter of the directional cable loop.
    expect(normal.cablePulseProgress).toBeCloseTo(0.25);
    expect(Math.abs(normal.speakerConeExcursionNormalized)).toBeLessThanOrEqual(
      1,
    );

    const reduced = tracker.update(snapshot, true);
    expect(reduced).toBe(retained);
    expect(reduced.cablePulseTravelling).toBe(false);
    expect(reduced.cablePulseProgress).toBe(0.5);
    expect(reduced.microphoneRingPhase).toBe(0.5);
    expect(
      Math.abs(reduced.speakerConeExcursionNormalized),
    ).toBeLessThanOrEqual(
      GENERATED_MOTION_SAFETY_SPEC.reducedMotion.plateDisplacementScale,
    );

    const decaying = tracker.update(
      apparatusSnapshot({
        timeSeconds: 0.2125,
        feedback: 1,
        microphone: 0.62,
        regime: "decaying",
      }),
      false,
    );
    expect(decaying.cablePulseTravelling).toBe(false);
    expect(decaying.cablePulseProgress).toBe(0.5);
  });

  it("routes the feedback pulse microphone-to-return-to-speaker", () => {
    expect(feedbackCablePoint(0)).toEqual([0.8, 0.2]);
    expect(feedbackCablePoint(0.24)).toEqual([0.8, -0.66]);
    expect(feedbackCablePoint(0.82)).toEqual([-0.8, -0.66]);
    expect(feedbackCablePoint(1)).toEqual([-0.8, -0.3]);
  });

  it("draws the literal apparatus passes plus the modal plate pass", () => {
    const gl = mockWebGl2Context();
    gl.drawArrays = vi.fn();
    const canvas = {
      addEventListener: () => undefined,
      classList: { contains: () => true },
      dataset: {},
      getBoundingClientRect: () => ({ width: 720, height: 450 }),
      height: 450,
      removeEventListener: () => undefined,
      width: 720,
    } as unknown as HTMLCanvasElement;
    const renderer = new WebGlPlateRenderer(canvas, gl, {
      preferences: {
        reducedMotion: false,
        forcedColors: false,
        preferredQuality: "reduced",
      },
    });

    renderer.render(
      apparatusSnapshot({
        timeSeconds: 0.2125,
        driveFrequencyHz: 6_000,
        feedback: 1,
        microphone: 0.62,
        regime: "growing",
      }),
    );

    // 3 cable segments + pulse + 2 speaker meshes + 3 pressure rings +
    // microphone capsule/stem/base + the final tessellated plate.
    expect(gl.drawArrays).toHaveBeenCalledTimes(13);
    expect(canvas.dataset.webglApparatusMeshes).toBe(
      "speaker-cone,plate,microphone,feedback-cable",
    );
    expect(canvas.dataset.webglApparatusMotion).toBe("canonical-snapshot");
    expect(canvas.dataset.webglCableDirection).toBe(
      "microphone-to-feedback-to-speaker",
    );
    renderer.dispose();
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

  it("reuses renderer status identity on every frame", () => {
    const tracker = new PlateRendererStatusTracker({
      kind: "webgl2",
      quality: "high",
      degradationStage: 0,
      datasetId: null,
      textureReady: false,
      materialSectionReady: false,
      contextLost: false,
      framesRendered: 0,
      lastSnapshotSequence: null,
    });
    const first = tracker.view;
    tracker.recordFrame(17);
    const second = tracker.view;
    tracker.recordFrame(18);

    expect(second).toBe(first);
    expect(tracker.view).toBe(first);
    expect(tracker.view.framesRendered).toBe(2);
    expect(tracker.view.lastSnapshotSequence).toBe(18);

    const observerCopy = tracker.update({ degradationStage: 1 });
    expect(observerCopy).not.toBe(first);
    expect(Object.isFrozen(observerCopy)).toBe(true);
    expect(tracker.view).toBe(first);
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

  it("retains the modal blend view and typed buffers across frames", () => {
    const tracker = new ModalBlendTracker(WEBGL_MODAL_CAPACITY);
    const snapshot = visualSnapshot(0, [
      {
        modeId: "stable",
        amplitudeNormalized: 0.5,
        phaseRad: 0,
        energyNormalized: 0.25,
      },
    ]);
    const first = tracker.update(snapshot);
    const sandWeights = first.sandWeights;
    const displacementWeights = first.displacementWeights;
    const second = tracker.update(
      visualSnapshot(1 / 60, [
        {
          modeId: "stable",
          amplitudeNormalized: 0.6,
          phaseRad: 0.2,
          energyNormalized: 0.36,
        },
      ]),
    );
    expect(second).toBe(first);
    expect(second.sandWeights).toBe(sandWeights);
    expect(second.displacementWeights).toBe(displacementWeights);
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

  it("derives deterministic grain noise from dataset identity and a fixed session seed", () => {
    const firstIdentity = `sha256:${"a".repeat(64)}`;
    const secondIdentity = `sha256:${"b".repeat(64)}`;
    const firstSeed = renderSeedFromDatasetId(firstIdentity);
    const repeatedSeed = renderSeedFromDatasetId(firstIdentity);
    const secondSeed = renderSeedFromDatasetId(secondIdentity);
    const pattern = (seed: number) =>
      Array.from({ length: 32 }, (_, index) =>
        deterministicCanvasGrainHash(index, 7, 1, seed),
      );

    expect(repeatedSeed).toBe(firstSeed);
    expect(secondSeed).not.toBe(firstSeed);
    expect(pattern(repeatedSeed)).toEqual(pattern(firstSeed));
    expect(pattern(secondSeed)).not.toEqual(pattern(firstSeed));
  });

  it("evaluates the verified dominant finite-strip basis deterministically", () => {
    const metadata = {
      modeId: "mode-a",
      radialNodeIndex: 2,
      radialElementCount: 4,
      radialDof: "value" as const,
      angularOrder: 2,
      symmetry: "cosine" as const,
      hubRadiusRatio: 0.1,
    };
    const sample = evaluateDominantBasisFallback(metadata, 0.55, 0);
    expect(sample).toBeGreaterThan(0);
    expect(evaluateDominantBasisFallback(metadata, 0.55, 0)).toBe(sample);
    expect(evaluateDominantBasisFallback(metadata, 0.01, 0)).toBe(0);
    expect(evaluateDominantBasisFallback(metadata, 1.01, 0)).toBe(0);
    expect(evaluateDominantBasisFallback(metadata, 0, 0.55)).not.toBe(sample);
  });

  it("blends Canvas density before applying the nonlinear grain pass", () => {
    expect(blendCanvasSandDensity(240, 0.25, 80, 0.75)).toBe(120);
    expect(blendCanvasSandDensity(0, 0.5, 255, 0.5)).toBe(127.5);
  });

  it("keeps newly captured baked sand legible without inventing sand at zero", () => {
    const tracker = new ModalBlendTracker(2);
    const capture = tracker.update(
      visualSnapshot(
        0,
        [
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
    const capturedPresence = capture.presence;
    expect(capturedPresence).toBeCloseTo(Math.sqrt(ACTIVE_CAPTURE_FLOOR));
    const samples = [0, 0.05, capturedPresence, 0.6, 1].map(
      sandVisibilityFromPresence,
    );

    expect(samples[0]).toBe(0);
    expect(samples[2]).toBeGreaterThanOrEqual(0.48);
    expect(samples.at(-1)).toBeCloseTo(0.95);
    expect(
      samples.every(
        (value, index) => index === 0 || value >= samples[index - 1]!,
      ),
    ).toBe(true);
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

  it("reduces only visual sand residual at the first pressure stage", () => {
    const normal = new ModalBlendTracker(2);
    const degraded = new ModalBlendTracker(2);
    degraded.setReleaseSeconds(0.24);
    const energetic = visualSnapshot(0, [
      {
        modeId: "ring",
        amplitudeNormalized: 1,
        phaseRad: 0,
        energyNormalized: 1,
      },
    ]);
    const silent = visualSnapshot(0.05, [
      {
        modeId: "ring",
        amplitudeNormalized: 0,
        phaseRad: 0,
        energyNormalized: 0,
      },
    ]);
    normal.update(energetic);
    degraded.update(energetic);

    expect(degraded.update(silent).presence).toBeLessThan(
      normal.update(silent).presence,
    );
    expect(silent.modes[0]?.energyNormalized).toBe(0);
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
    const canvas = {
      dataset: {},
      width: 0,
      height: 0,
      getBoundingClientRect: () => ({ width: 320, height: 240 }),
    } as unknown as HTMLCanvasElement;
    const renderer = new CanvasPlateRenderer(
      canvas,
      { setTransform: () => undefined } as unknown as CanvasRenderingContext2D,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
        },
        onDiagnostic: (record) => diagnostics.push(record.code),
      },
    );
    const datasetId = "sha256:same-dataset";
    const source = (
      bytes: Uint8Array,
      id = datasetId,
      withMaterialSection = false,
    ): PlateTextureSource => ({
      datasetId: id,
      ...(withMaterialSection
        ? {
            materialSectionProfile: {
              schemaVersion: "mandelhowl.material-section-profile.v1" as const,
              axis: "x-at-y-zero" as const,
              sampleCount: 64 as const,
              minimumThicknessM: 0.0018,
              maximumThicknessM: 0.0042,
              thicknessUnorm8: Array.from(
                { length: 64 },
                (_, index) => index * 4,
              ),
            },
          }
        : {}),
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
    await renderer.setTextureSource(
      source(new Uint8Array([0]), datasetId, true),
    );
    expect(renderer.status).toMatchObject({
      datasetId,
      textureReady: true,
    });
    expect(canvas.dataset.materialSection).toBe("verified");
    expect(renderer.status.materialSectionReady).toBe(true);
    const windowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { devicePixelRatio: 1 },
    });
    try {
      renderer.resize();
    } finally {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
    expect(canvas.dataset.materialSection).toBe("verified");
    expect(
      (
        renderer as unknown as {
          readonly materialSectionProfile: Float32Array | null;
        }
      ).materialSectionProfile,
    ).toBeInstanceOf(Float32Array);
    expect(diagnostics).toEqual([]);

    await renderer.setTextureSource(
      source(new Uint8Array([0]), "sha256:new-dataset"),
    );
    expect(renderer.status.textureReady).toBe(false);
    expect(renderer.status.materialSectionReady).toBe(false);
    expect(diagnostics).toEqual(["MH-DATASET-INTEGRITY"]);
  });

  it("keeps Canvas texture loading sand-only and out-of-band fetch-free", async () => {
    const gradient = { addColorStop: () => undefined };
    const context = {
      arc: () => undefined,
      beginPath: () => undefined,
      clearRect: () => undefined,
      clip: () => undefined,
      createRadialGradient: () => gradient,
      fill: () => undefined,
      fillRect: () => undefined,
      restore: () => undefined,
      save: () => undefined,
      stroke: () => undefined,
      translate: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      dataset: {},
      width: 320,
      height: 240,
    } as unknown as HTMLCanvasElement;
    const renderer = new CanvasPlateRenderer(canvas, context, {
      preferences: {
        reducedMotion: false,
        forcedColors: false,
      },
    });
    const loads = {
      "signed-displacement": vi.fn(async () => new Uint8Array([0])),
      normal: vi.fn(async () => new Uint8Array([0])),
      "nodal-mask": vi.fn(async () => new Uint8Array([0])),
      "sand-density": vi.fn(
        async () => new Uint8Array(portableR8Ktx2(1, 1, 1, [220])),
      ),
    };
    await renderer.setTextureSource({
      datasetId: "sha256:lazy-canvas",
      loadingPolicy: "mode-sharded-lazy-verified",
      atlases: (
        ["signed-displacement", "normal", "nodal-mask", "sand-density"] as const
      ).map((kind) => ({
        kind,
        url: `https://example.test/${kind}.ktx2`,
        mediaType: "image/ktx2",
        modeIds: ["mode-a"],
        width: 1,
        height: 1,
        layers: 1,
        loadBytes: loads[kind],
      })),
    });
    expect(
      Object.values(loads).every((load) => load.mock.calls.length === 0),
    ).toBe(true);

    const snapshot = (driveFrequencyHz: number, sequence: number) =>
      ({
        ...visualSnapshot(sequence * 0.01, [
          {
            modeId: "mode-a",
            naturalFrequencyHz: 1_000,
            amplitudeNormalized: 0,
            phaseRad: 0,
            energyNormalized: 0,
          },
        ]),
        sequence,
        dial: { driveFrequencyHz },
        regime: "stable",
      }) as unknown as RuntimeSnapshot;
    renderer.render(snapshot(1_100, 1));
    await (
      renderer as unknown as {
        textureShardCache: { waitForIdle(): Promise<void> };
      }
    ).textureShardCache.waitForIdle();
    expect(
      Object.values(loads).every((load) => load.mock.calls.length === 0),
    ).toBe(true);
    expect(renderer.status.textureReady).toBe(false);

    renderer.render(snapshot(1_075, 2));
    await (
      renderer as unknown as {
        textureShardCache: { waitForIdle(): Promise<void> };
      }
    ).textureShardCache.waitForIdle();
    expect(loads["sand-density"]).toHaveBeenCalledTimes(1);
    expect(loads["signed-displacement"]).not.toHaveBeenCalled();
    expect(loads.normal).not.toHaveBeenCalled();
    expect(loads["nodal-mask"]).not.toHaveBeenCalled();
    expect(renderer.status.textureReady).toBe(true);
  });

  it("loads all WebGL basis kinds only for in-band current modes", async () => {
    const requested: string[] = [];
    const grainSeeds: number[] = [];
    const gl = mockWebGl2Context();
    (
      gl as unknown as {
        uniform1ui(_location: WebGLUniformLocation | null, value: number): void;
      }
    ).uniform1ui = (_location, value) => grainSeeds.push(value);
    const canvas = {
      addEventListener: () => undefined,
      dataset: {},
      height: 240,
      removeEventListener: () => undefined,
      width: 320,
    } as unknown as HTMLCanvasElement;
    const renderer = new WebGlPlateRenderer(canvas, gl, {
      preferences: {
        reducedMotion: false,
        forcedColors: false,
        preferredQuality: "reduced",
      },
    });
    const kinds = [
      "signed-displacement",
      "normal",
      "nodal-mask",
      "sand-density",
    ] as const;
    const atlases = kinds.flatMap((kind) =>
      [
        ["mode-a", 1],
        ["mode-b", 2],
      ].map(([modeId, suffix]) => ({
        kind,
        url: `https://example.test/${kind}-${suffix}.ktx2`,
        mediaType: "image/ktx2",
        modeIds: [String(modeId)],
        width: 1,
        height: 1,
        layers: 1,
        loadBytes: async () => {
          requested.push(`${kind}:${modeId}`);
          return new Uint8Array(
            kind === "normal"
              ? portableRg8Ktx2()
              : portableR8Ktx2(1, 1, 1, [180]),
          );
        },
      })),
    );
    await renderer.setTextureSource({
      datasetId: "sha256:lazy-webgl",
      loadingPolicy: "mode-sharded-lazy-verified",
      atlases,
    });
    expect(requested).toEqual([]);
    expect(renderer.status.textureReady).toBe(false);

    const snapshot = (driveFrequencyHz: number, sequence: number) =>
      ({
        ...visualSnapshot(sequence * 0.01, [
          {
            modeId: "mode-a",
            naturalFrequencyHz: 1_000,
            amplitudeNormalized: 0,
            phaseRad: 0,
            energyNormalized: 0,
          },
          {
            modeId: "mode-b",
            naturalFrequencyHz: 2_000,
            amplitudeNormalized: 0,
            phaseRad: 0,
            energyNormalized: 0,
          },
        ]),
        sequence,
        dial: { driveFrequencyHz },
        regime: "stable",
      }) as unknown as RuntimeSnapshot;
    const waitForTextureIdle = () =>
      (
        renderer as unknown as {
          textureShardCache: { waitForIdle(): Promise<void> };
        }
      ).textureShardCache.waitForIdle();

    renderer.render(snapshot(1_500, 1));
    await waitForTextureIdle();
    expect(requested).toEqual([]);
    expect(renderer.status.textureReady).toBe(false);
    expect(grainSeeds.at(-1)).toBe(
      renderSeedFromDatasetId("sha256:lazy-webgl"),
    );

    renderer.render(snapshot(1_075, 2));
    expect(renderer.status.textureReady).toBe(false);
    await waitForTextureIdle();
    expect(requested.sort()).toEqual(
      kinds.map((kind) => `${kind}:mode-a`).sort(),
    );
    expect(renderer.status.textureReady).toBe(true);

    renderer.render(snapshot(2_000, 3));
    expect(renderer.status.textureReady).toBe(false);
    await waitForTextureIdle();
    expect(
      requested.filter((entry) => entry.endsWith(":mode-b")).sort(),
    ).toEqual(kinds.map((kind) => `${kind}:mode-b`).sort());
    expect(renderer.status.textureReady).toBe(true);
  });

  it("maps every local layer of a four-layer ZLIB shard into WebGL residency", async () => {
    const uploadedValues: number[] = [];
    const gl = mockWebGl2Context();
    (
      gl as unknown as {
        texSubImage3D(
          _target: number,
          _level: number,
          _x: number,
          _y: number,
          _z: number,
          _width: number,
          _height: number,
          _depth: number,
          _format: number,
          _type: number,
          pixels: Uint8Array,
        ): void;
      }
    ).texSubImage3D = (
      _target,
      _level,
      _x,
      _y,
      _z,
      _width,
      _height,
      _depth,
      _format,
      _type,
      pixels,
    ) => {
      uploadedValues.push(pixels[0] ?? -1);
    };
    const renderer = new WebGlPlateRenderer(
      {
        addEventListener: () => undefined,
        dataset: {},
        height: 240,
        removeEventListener: () => undefined,
        width: 320,
      } as unknown as HTMLCanvasElement,
      gl,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
          preferredQuality: "reduced",
        },
      },
    );
    const modeIds = ["mode-001", "mode-002", "mode-003", "mode-004"];
    const source: PlateTextureSource = {
      datasetId: "sha256:zlib-local-layers",
      loadingPolicy: "eager-verified",
      atlases: [
        {
          kind: "sand-density",
          url: "https://example.test/sand-00-03.ktx2",
          mediaType: "image/ktx2",
          modeIds,
          width: 4,
          height: 4,
          layers: 4,
          bytes: new Uint8Array(
            portableZlibR8Ktx2(
              4,
              4,
              4,
              [10, 20, 30, 40].flatMap((value) =>
                Array.from({ length: 16 }, () => value),
              ),
            ),
          ),
        },
      ],
    };

    for (let activeIndex = 0; activeIndex < modeIds.length; activeIndex += 1) {
      await renderer.setTextureSource(source);
      renderer.render({
        ...visualSnapshot(
          activeIndex,
          modeIds.map((modeId, index) => ({
            modeId,
            amplitudeNormalized: index === activeIndex ? 1 : 0,
            phaseRad: 0,
            energyNormalized: index === activeIndex ? 1 : 0,
          })),
          modeIds[activeIndex]!,
          source.datasetId as RuntimeSnapshot["datasetId"],
        ),
        sequence: activeIndex + 1,
        dial: { driveFrequencyHz: 220 + activeIndex * 10 },
        regime: "critical",
      } as unknown as RuntimeSnapshot);
    }

    expect(uploadedValues).toEqual([10, 20, 30, 40]);
    renderer.dispose();
  });

  it("uses verified dominant-basis metadata on the first paint before a lazy shard resolves", async () => {
    type NamedUniform = WebGLUniformLocation & { readonly name: string };
    const scalarUniforms = new Map<string, number>();
    const integerUniforms = new Map<string, number>();
    const gl = mockWebGl2Context();
    (
      gl as unknown as {
        getUniformLocation(
          _program: WebGLProgram,
          name: string,
        ): WebGLUniformLocation;
        uniform1f(location: NamedUniform | null, value: number): void;
        uniform1i(location: NamedUniform | null, value: number): void;
      }
    ).getUniformLocation = (_program, name) =>
      ({ name }) as unknown as WebGLUniformLocation;
    (
      gl as unknown as {
        uniform1f(location: NamedUniform | null, value: number): void;
      }
    ).uniform1f = (location, value) => {
      if (location) scalarUniforms.set(location.name, value);
    };
    (
      gl as unknown as {
        uniform1i(location: NamedUniform | null, value: number): void;
      }
    ).uniform1i = (location, value) => {
      if (location) integerUniforms.set(location.name, value);
    };
    let resolveShard!: (bytes: Uint8Array) => void;
    const shard = new Promise<Uint8Array>((resolve) => {
      resolveShard = resolve;
    });
    const renderer = new WebGlPlateRenderer(
      {
        addEventListener: () => undefined,
        dataset: {},
        height: 240,
        removeEventListener: () => undefined,
        width: 320,
      } as unknown as HTMLCanvasElement,
      gl,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
          preferredQuality: "reduced",
        },
      },
    );
    await renderer.setTextureSource({
      datasetId: "sha256:verified-fallback",
      loadingPolicy: "mode-sharded-lazy-verified",
      presentationModes: [
        {
          modeId: "mode-a",
          radialNodeIndex: 2,
          radialElementCount: 5,
          radialDof: "slope",
          angularOrder: 3,
          symmetry: "sine",
          hubRadiusRatio: 0.1,
        },
      ],
      atlases: [
        {
          kind: "sand-density",
          url: "https://example.test/sand.ktx2",
          mediaType: "image/ktx2",
          modeIds: ["mode-a"],
          width: 1,
          height: 1,
          layers: 1,
          loadBytes: () => shard,
        },
      ],
    });
    renderer.render({
      ...visualSnapshot(
        0,
        [
          {
            modeId: "mode-a",
            naturalFrequencyHz: 1_000,
            amplitudeNormalized: 0,
            phaseRad: 0,
            energyNormalized: 0,
          },
        ],
        "mode-a",
        "sha256:verified-fallback",
      ),
      sequence: 1,
      dial: { driveFrequencyHz: 1_000 },
      regime: "critical",
    } as unknown as RuntimeSnapshot);

    expect(integerUniforms.get("uHasAnalyticalShape")).toBe(1);
    expect(integerUniforms.get("uHasDisplacementAtlas")).toBe(0);
    expect(scalarUniforms.get("uAnalyticalKind")).toBe(1);
    expect(scalarUniforms.get("uRadialNodeIndex")).toBe(2);
    expect(scalarUniforms.get("uRadialElementCount")).toBe(5);
    expect(scalarUniforms.get("uRadialDof")).toBe(1);
    expect(scalarUniforms.get("uAngularOrder")).toBe(3);
    expect(scalarUniforms.get("uSymmetry")).toBe(2);
    expect(scalarUniforms.get("uAnalyticalDisplacementWeight")).toBeGreaterThan(
      0,
    );

    resolveShard(new Uint8Array(portableR8Ktx2(1, 1, 1, [220])));
    await (
      renderer as unknown as {
        textureShardCache: { waitForIdle(): Promise<void> };
      }
    ).textureShardCache.waitForIdle();
    renderer.dispose();
  });

  it("overlays the active verified basis beside a resident WebGL residual until its shard arrives", async () => {
    type NamedUniform = WebGLUniformLocation & { readonly name: string };
    const scalarUniforms = new Map<string, number>();
    const integerUniforms = new Map<string, number>();
    const gl = mockWebGl2Context();
    (
      gl as unknown as {
        getUniformLocation(
          _program: WebGLProgram,
          name: string,
        ): WebGLUniformLocation;
        uniform1f(location: NamedUniform | null, value: number): void;
        uniform1i(location: NamedUniform | null, value: number): void;
      }
    ).getUniformLocation = (_program, name) =>
      ({ name }) as unknown as WebGLUniformLocation;
    (
      gl as unknown as {
        uniform1f(location: NamedUniform | null, value: number): void;
      }
    ).uniform1f = (location, value) => {
      if (location) scalarUniforms.set(location.name, value);
    };
    (
      gl as unknown as {
        uniform1i(location: NamedUniform | null, value: number): void;
      }
    ).uniform1i = (location, value) => {
      if (location) integerUniforms.set(location.name, value);
    };
    const renderer = new WebGlPlateRenderer(
      {
        addEventListener: () => undefined,
        dataset: {},
        height: 240,
        removeEventListener: () => undefined,
        width: 320,
      } as unknown as HTMLCanvasElement,
      gl,
      {
        preferences: {
          reducedMotion: false,
          forcedColors: false,
          preferredQuality: "reduced",
        },
      },
    );
    await renderer.setTextureSource({
      datasetId: "sha256:active-over-residual",
      loadingPolicy: "mode-sharded-lazy-verified",
      presentationModes: [
        {
          modeId: "mode-old",
          radialNodeIndex: 1,
          radialElementCount: 5,
          radialDof: "value",
          angularOrder: 1,
          symmetry: "cosine",
          hubRadiusRatio: 0.1,
        },
        {
          modeId: "mode-new",
          radialNodeIndex: 3,
          radialElementCount: 5,
          radialDof: "slope",
          angularOrder: 4,
          symmetry: "sine",
          hubRadiusRatio: 0.1,
        },
      ],
      atlases: (["signed-displacement", "sand-density"] as const).map(
        (kind) => ({
          kind,
          url: `https://example.test/${kind}.ktx2`,
          mediaType: "image/ktx2" as const,
          modeIds: ["mode-old", "mode-new"],
          width: 1,
          height: 1,
          layers: 2,
          loadBytes: () => new Promise<Uint8Array>(() => undefined),
        }),
      ),
    });
    let activeShardAvailable = false;
    const cache = (
      renderer as unknown as {
        textureShardCache: {
          request(..._arguments: unknown[]): void;
          isModeAvailable(kind: string, modeId: string): boolean;
        };
      }
    ).textureShardCache;
    cache.request = () => undefined;
    cache.isModeAvailable = (_kind, modeId) =>
      modeId === "mode-old" || (modeId === "mode-new" && activeShardAvailable);
    const capture = {
      ...visualSnapshot(
        1,
        [
          {
            modeId: "mode-old",
            amplitudeNormalized: 0.8,
            phaseRad: 0.2,
            energyNormalized: 0.8,
          },
          {
            modeId: "mode-new",
            amplitudeNormalized: 0,
            phaseRad: 1.1,
            energyNormalized: 0,
          },
        ],
        "mode-new",
        "sha256:active-over-residual",
      ),
      sequence: 1,
      dial: { driveFrequencyHz: 230 },
      regime: "critical",
    } as unknown as RuntimeSnapshot;

    renderer.render(capture);
    expect(integerUniforms.get("uHasDisplacementAtlas")).toBe(1);
    expect(integerUniforms.get("uHasSandAtlas")).toBe(1);
    expect(integerUniforms.get("uUseAnalyticalDisplacement")).toBe(1);
    expect(integerUniforms.get("uUseAnalyticalSand")).toBe(1);
    expect(scalarUniforms.get("uRadialNodeIndex")).toBe(3);
    expect(scalarUniforms.get("uAngularOrder")).toBe(4);
    expect(scalarUniforms.get("uAnalyticalSandWeight")).toBeGreaterThan(0);
    expect(scalarUniforms.get("uAnalyticalSandWeight")).toBeLessThan(1);
    expect(scalarUniforms.get("uAnalyticalDisplacementWeight")).toBeCloseTo(
      Math.sqrt(ACTIVE_CAPTURE_FLOOR) * Math.cos(1.1),
    );

    activeShardAvailable = true;
    renderer.render({
      ...capture,
      sequence: 2,
      simulationTimeSeconds: 1 + 1 / 60,
    });
    expect(integerUniforms.get("uUseAnalyticalDisplacement")).toBe(0);
    expect(integerUniforms.get("uUseAnalyticalSand")).toBe(0);
    renderer.dispose();
  });

  it("draws Canvas verified dominant-basis fallback while its sand shard is pending", async () => {
    const radii: number[] = [];
    const context = {
      arc: (_x: number, _y: number, radius: number) => radii.push(radius),
      beginPath: () => undefined,
      clearRect: () => undefined,
      clip: () => undefined,
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      fill: () => undefined,
      fillRect: () => undefined,
      lineTo: () => undefined,
      moveTo: () => undefined,
      restore: () => undefined,
      save: () => undefined,
      stroke: () => undefined,
      translate: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    let resolveShard!: (bytes: Uint8Array) => void;
    const shard = new Promise<Uint8Array>((resolve) => {
      resolveShard = resolve;
    });
    const renderer = new CanvasPlateRenderer(
      {
        dataset: {},
        height: 240,
        width: 320,
      } as unknown as HTMLCanvasElement,
      context,
      {
        preferences: { reducedMotion: false, forcedColors: false },
      },
    );
    await renderer.setTextureSource({
      datasetId: "sha256:canvas-fallback",
      loadingPolicy: "mode-sharded-lazy-verified",
      presentationModes: [
        {
          modeId: "mode-a",
          radialNodeIndex: 2,
          radialElementCount: 5,
          radialDof: "value",
          angularOrder: 3,
          symmetry: "cosine",
          hubRadiusRatio: 0.1,
        },
      ],
      atlases: [
        {
          kind: "sand-density",
          url: "https://example.test/sand.ktx2",
          mediaType: "image/ktx2",
          modeIds: ["mode-a"],
          width: 1,
          height: 1,
          layers: 1,
          loadBytes: () => shard,
        },
      ],
    });
    const documentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => ({
          getContext: () => ({}),
          height: 0,
          width: 0,
        }),
      },
    });
    try {
      renderer.render({
        ...visualSnapshot(
          0,
          [
            {
              modeId: "mode-a",
              naturalFrequencyHz: 1_000,
              amplitudeNormalized: 0,
              phaseRad: 0,
              energyNormalized: 0,
            },
          ],
          "mode-a",
          "sha256:canvas-fallback",
        ),
        sequence: 1,
        dial: { driveFrequencyHz: 1_000 },
        regime: "critical",
      } as unknown as RuntimeSnapshot);
    } finally {
      if (documentDescriptor) {
        Object.defineProperty(globalThis, "document", documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
    const expectedFallbackRadius = 0.46 * (0.1 + (2 / 5) * (1 - 0.1));
    expect(
      radii.some((radius) => Math.abs(radius - expectedFallbackRadius) < 1e-9),
    ).toBe(true);
    expect(renderer.status.textureReady).toBe(false);

    resolveShard(new Uint8Array(portableR8Ktx2(1, 1, 1, [220])));
    await (
      renderer as unknown as {
        textureShardCache: { waitForIdle(): Promise<void> };
      }
    ).textureShardCache.waitForIdle();
    renderer.dispose();
  });

  it("overlays the active Canvas basis beside a loaded residual and removes it on arrival", async () => {
    const radii: number[] = [];
    const drawImage = vi.fn();
    const context = {
      arc: (_x: number, _y: number, radius: number) => radii.push(radius),
      beginPath: () => undefined,
      clearRect: () => undefined,
      clip: () => undefined,
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      drawImage,
      fill: () => undefined,
      fillRect: () => undefined,
      lineTo: () => undefined,
      moveTo: () => undefined,
      restore: () => undefined,
      save: () => undefined,
      stroke: () => undefined,
      translate: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    const renderer = new CanvasPlateRenderer(
      {
        dataset: {},
        height: 240,
        width: 320,
      } as unknown as HTMLCanvasElement,
      context,
      {
        preferences: { reducedMotion: false, forcedColors: false },
      },
    );
    await renderer.setTextureSource({
      datasetId: "sha256:canvas-active-over-residual",
      loadingPolicy: "mode-sharded-lazy-verified",
      presentationModes: [
        {
          modeId: "mode-old",
          radialNodeIndex: 1,
          radialElementCount: 5,
          radialDof: "value",
          angularOrder: 1,
          symmetry: "cosine",
          hubRadiusRatio: 0.1,
        },
        {
          modeId: "mode-new",
          radialNodeIndex: 3,
          radialElementCount: 5,
          radialDof: "slope",
          angularOrder: 4,
          symmetry: "sine",
          hubRadiusRatio: 0.1,
        },
      ],
      atlases: [
        {
          kind: "sand-density",
          url: "https://example.test/sand.ktx2",
          mediaType: "image/ktx2",
          modeIds: ["mode-old", "mode-new"],
          width: 1,
          height: 1,
          layers: 2,
          loadBytes: () => new Promise<Uint8Array>(() => undefined),
        },
      ],
    });
    let activeShardAvailable = false;
    const internal = renderer as unknown as {
      composeSandLayers(): HTMLCanvasElement | null;
      textureShardCache: {
        request(..._arguments: unknown[]): void;
        isModeAvailable(kind: string, modeId: string): boolean;
      };
    };
    internal.composeSandLayers = () => ({}) as HTMLCanvasElement;
    internal.textureShardCache.request = () => undefined;
    internal.textureShardCache.isModeAvailable = (_kind, modeId) =>
      modeId === "mode-old" || (modeId === "mode-new" && activeShardAvailable);
    const capture = {
      ...visualSnapshot(
        1,
        [
          {
            modeId: "mode-old",
            amplitudeNormalized: 0.8,
            phaseRad: 0.2,
            energyNormalized: 0.8,
          },
          {
            modeId: "mode-new",
            amplitudeNormalized: 0,
            phaseRad: 1.1,
            energyNormalized: 0,
          },
        ],
        "mode-new",
        "sha256:canvas-active-over-residual",
      ),
      sequence: 1,
      dial: { driveFrequencyHz: 230 },
      regime: "critical",
    } as unknown as RuntimeSnapshot;
    const fallbackRadius = 0.46 * (0.1 + (3 / 5) * (1 - 0.1));

    renderer.render(capture);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(
      radii.some((radius) => Math.abs(radius - fallbackRadius) < 1e-9),
    ).toBe(true);

    radii.length = 0;
    activeShardAvailable = true;
    renderer.render({
      ...capture,
      sequence: 2,
      simulationTimeSeconds: 1 + 1 / 60,
    });
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(
      radii.some((radius) => Math.abs(radius - fallbackRadius) < 1e-9),
    ).toBe(false);
    renderer.dispose();
  });

  it("prevents Canvas and WebGL deferred source commits after disposal", async () => {
    const canvasContext = {
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    const renderers = [
      {
        statuses: [] as string[],
        create() {
          return new CanvasPlateRenderer(
            {
              dataset: {},
              height: 240,
              width: 320,
            } as unknown as HTMLCanvasElement,
            canvasContext,
            {
              preferences: { reducedMotion: false, forcedColors: false },
              onStatus: (status) =>
                this.statuses.push(status.datasetId ?? "none"),
            },
          );
        },
      },
      {
        statuses: [] as string[],
        create() {
          return new WebGlPlateRenderer(
            {
              addEventListener: () => undefined,
              dataset: {},
              height: 240,
              removeEventListener: () => undefined,
              width: 320,
            } as unknown as HTMLCanvasElement,
            mockWebGl2Context(),
            {
              preferences: {
                reducedMotion: false,
                forcedColors: false,
                preferredQuality: "reduced",
              },
              onStatus: (status) =>
                this.statuses.push(status.datasetId ?? "none"),
            },
          );
        },
      },
    ];

    for (const entry of renderers) {
      let resolveBytes!: (bytes: Uint8Array) => void;
      const deferredBytes = new Promise<Uint8Array>((resolve) => {
        resolveBytes = resolve;
      });
      const loadBytes = vi.fn(() => deferredBytes);
      const renderer = entry.create();
      const source: PlateTextureSource = {
        datasetId: "sha256:deferred-disposal",
        atlases: [
          {
            kind: "sand-density",
            url: "https://example.test/deferred.ktx2",
            mediaType: "image/ktx2",
            modeIds: ["mode-a"],
            width: 1,
            height: 1,
            layers: 1,
            loadBytes,
          },
        ],
      };
      const installation = renderer.setTextureSource(source);
      await Promise.resolve();
      expect(loadBytes).toHaveBeenCalledTimes(1);
      const statusCountAtDispose = entry.statuses.length;
      renderer.dispose();
      resolveBytes(new Uint8Array(portableR8Ktx2(1, 1, 1, [200])));
      await installation;
      expect(entry.statuses).toHaveLength(statusCountAtDispose);

      await renderer.setTextureSource(source);
      expect(loadBytes).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps a newer texture source authoritative over an older deferred install", async () => {
    let resolveOld!: (bytes: Uint8Array) => void;
    const oldBytes = new Promise<Uint8Array>((resolve) => {
      resolveOld = resolve;
    });
    const statuses: string[] = [];
    const renderer = new CanvasPlateRenderer(
      {
        dataset: {},
        height: 240,
        width: 320,
      } as unknown as HTMLCanvasElement,
      { clearRect: () => undefined } as unknown as CanvasRenderingContext2D,
      {
        preferences: { reducedMotion: false, forcedColors: false },
        onStatus: (status) => statuses.push(status.datasetId ?? "none"),
      },
    );
    const atlas = {
      kind: "sand-density" as const,
      url: "https://example.test/sand.ktx2",
      mediaType: "image/ktx2",
      modeIds: ["mode-a"],
      width: 1,
      height: 1,
      layers: 1,
    };
    const older = renderer.setTextureSource({
      datasetId: "sha256:older",
      atlases: [{ ...atlas, loadBytes: () => oldBytes }],
    });
    await Promise.resolve();
    await renderer.setTextureSource({
      datasetId: "sha256:newer",
      atlases: [
        {
          ...atlas,
          bytes: new Uint8Array(portableR8Ktx2(1, 1, 1, [210])),
        },
      ],
    });
    expect(renderer.status).toMatchObject({
      datasetId: "sha256:newer",
      textureReady: true,
    });

    resolveOld(new Uint8Array(portableR8Ktx2(1, 1, 1, [190])));
    await older;
    expect(renderer.status).toMatchObject({
      datasetId: "sha256:newer",
      textureReady: true,
    });
    expect(statuses.at(-1)).toBe("sha256:newer");
  });

  it("rejects a Canvas sand atlas with extra undeclared layers", async () => {
    const diagnostics: string[] = [];
    const renderer = new CanvasPlateRenderer(
      { dataset: {} } as unknown as HTMLCanvasElement,
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
      { dataset: {} } as unknown as HTMLCanvasElement,
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
