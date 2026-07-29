import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AssetReference,
  ResonanceManifest,
  TextureAtlasReference,
} from "../../contracts/src";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  MODES_BINARY_V1,
  RESPONSE_BINARY_V1,
  RUNTIME_SPEC_SOURCE_HASHES,
} from "../../contracts/src";
import {
  canonicalizeJson,
  loadResonanceDataset,
  manifestIdentityPayload,
  sha256Hex,
  validateResonanceManifest,
  isRuntimeCompatible,
} from "./index";

const encoder = new TextEncoder();
const BASE = "https://example.test/runtime/";

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function modesBytes(): Uint8Array {
  const bytes = new Uint8Array(
    MODES_BINARY_V1.headerBytes + MODES_BINARY_V1.recordBytes,
  );
  bytes.set(encoder.encode(MODES_BINARY_V1.magic), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, MODES_BINARY_V1.version, true);
  view.setUint16(10, MODES_BINARY_V1.headerBytes, true);
  view.setUint32(12, 1, true);
  bytes.set(encoder.encode("mode-001"), 16);
  const base = MODES_BINARY_V1.headerBytes;
  view.setUint32(base + 24, 0, true);
  view.setUint32(base + 28, 0, true);
  view.setFloat64(base + 32, 220, true);
  view.setFloat64(base + 40, 220 * Math.PI * 2, true);
  view.setFloat64(base + 48, 0.01, true);
  view.setFloat64(base + 56, 0.95, true);
  view.setFloat64(base + 64, 0.9, true);
  view.setFloat64(base + 72, 0.8, true);
  view.setFloat64(base + 80, 0.25, true);
  view.setUint8(base + 88, 0);
  return bytes;
}

function responseBytes(): Uint8Array {
  const bytes = new Uint8Array(
    RESPONSE_BINARY_V1.headerBytes +
      RESPONSE_BINARY_V1.recordBytes * 2,
  );
  bytes.set(encoder.encode(RESPONSE_BINARY_V1.magic), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, RESPONSE_BINARY_V1.version, true);
  view.setUint16(10, RESPONSE_BINARY_V1.headerBytes, true);
  view.setUint32(12, 2, true);
  view.setFloat64(16, 45, true);
  view.setFloat64(24, 0.1, true);
  view.setFloat64(32, -0.2, true);
  view.setFloat64(40, 6000, true);
  view.setFloat64(48, 0.01, true);
  view.setFloat64(56, 0.02, true);
  return bytes;
}

async function reference(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<AssetReference> {
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    mediaType,
  };
}

async function fixture() {
  const assets = new Map<string, Uint8Array>();
  assets.set(
    "plate-spec.json",
    jsonBytes({
      schemaVersion: "mandelhowl.plate-spec.v1",
      plateId: "test-plate",
    }),
  );
  assets.set("modes.bin", modesBytes());
  assets.set("response.bin", responseBytes());
  assets.set("provenance.json", jsonBytes({ solver: "test" }));
  assets.set("convergence-report.json", jsonBytes({ passed: true }));
  assets.set("coverage-report.json", jsonBytes({ replayVerified: true }));
  for (const kind of [
    "signed-displacement",
    "normal",
    "nodal-mask",
    "sand-density",
  ] as const) {
    assets.set(`textures/${kind}.ktx2`, encoder.encode(`KTX2-${kind}`));
  }

  const plateSpec = await reference(
    "plate-spec.json",
    assets.get("plate-spec.json")!,
    "application/json",
  );
  const modes = await reference(
    "modes.bin",
    assets.get("modes.bin")!,
    "application/vnd.mandelhowl.modes-v1",
  );
  const response = await reference(
    "response.bin",
    assets.get("response.bin")!,
    "application/vnd.mandelhowl.response-v1",
  );
  const modalModelId = `sha256:${modes.sha256}`;
  const traces = Array.from({ length: 101 }, (_, target) => ({
    schemaVersion: "mandelhowl.resonance-trajectory-trace.v1",
    traceId: `fixture-${target.toString().padStart(3, "0")}`,
    modalModelId,
    initialFrequencyHz: 45,
    durationSeconds: 1,
    expectedSettledVolume: target,
    keyframes: [
      { sequence: 0, atSeconds: 0, frequencyHz: 45 },
    ],
  }));
  assets.set(
    "provenance.json",
    jsonBytes({
      schemaVersion: "mandelhowl.provenance.v1",
      canonicalInput: {
        plateId: "test-plate",
        canonicalJsonSha256: plateSpec.sha256,
      },
      generator: {
        name: "fixture",
        version: "1.0.0",
        randomSource: "forbidden",
      },
      modes: [{ modeId: "mode-001" }],
    }),
  );
  assets.set(
    "convergence-report.json",
    jsonBytes({
      schemaVersion: "mandelhowl.convergence-report.v1",
      accepted: true,
      quadratureConvergenceAccepted: true,
      methodConformance: {
        handoffThinPlateMethodAllowed: true,
        matchesCanonicalElementFamily: true,
      },
      independentCrossValidation: { accepted: true },
    }),
  );
  assets.set(
    "coverage-report.json",
    jsonBytes({
      schemaVersion: "mandelhowl.coverage-report.v1",
      modalModelId,
      generatedBy: {
        algorithm: "deterministic-global-trajectory-search-v1",
        perValueRuntimeLookup: "forbidden",
        randomSource: "forbidden",
      },
      perValueRuntimeExceptionTable: false,
      verificationStatus: "runtime-replay-verified",
      runtimeSpecSha256: {
        dial: RUNTIME_SPEC_SOURCE_HASHES.dial,
        feedback: RUNTIME_SPEC_SOURCE_HASHES.feedback,
        volumeMap: RUNTIME_SPEC_SOURCE_HASHES.volumeMap,
      },
      staticDistribution: {
        sampleCount: 1,
        zeroCount: 1,
        hundredCount: 0,
        intermediateCount: 0,
        extremeFraction: 1,
        requiredExtremeFraction: 0.9,
        passed: true,
      },
      replayVerified: true,
      coveredValues: Array.from({ length: 101 }, (_, value) => value),
      missingValues: [],
      traces,
      outputs: traces.map((trace, target) => ({
        target,
        verification: "runtime-replay-verified",
        verified: true,
        trace,
      })),
    }),
  );
  const provenance = await reference(
    "provenance.json",
    assets.get("provenance.json")!,
    "application/json",
  );
  const convergenceReport = await reference(
    "convergence-report.json",
    assets.get("convergence-report.json")!,
    "application/json",
  );
  const coverageReport = await reference(
    "coverage-report.json",
    assets.get("coverage-report.json")!,
    "application/json",
  );
  const textures: TextureAtlasReference[] = [];
  for (const kind of [
    "signed-displacement",
    "normal",
    "nodal-mask",
    "sand-density",
  ] as const) {
    const asset = await reference(
      `textures/${kind}.ktx2`,
      assets.get(`textures/${kind}.ktx2`)!,
      "image/ktx2",
    );
    textures.push({
      ...asset,
      kind,
      modeIds: ["mode-001"],
      widthPx: 128,
      heightPx: 128,
      layers: 1,
      uvOrigin: "negative-x-negative-y",
    });
  }
  const beforeChecksums = [
    plateSpec,
    modes,
    response,
    ...textures,
    provenance,
    convergenceReport,
    coverageReport,
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const checksumBytes = jsonBytes({
    schemaVersion: "mandelhowl.checksums.v1",
    algorithm: "sha256",
    files: [
      ...beforeChecksums.map(({ path, byteLength, sha256 }) => ({
        path,
        byteLength,
        sha256,
      })),
      {
        path: "science/solver-evidence.bin",
        byteLength: 3_145_728,
        sha256: "a".repeat(64),
      },
    ].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  });
  assets.set("checksums.json", checksumBytes);
  const checksums = await reference(
    "checksums.json",
    checksumBytes,
    "application/json",
  );

  const zero = "0".repeat(64);
  const manifestDraft = {
    schemaVersion: "mandelhowl.resonance-manifest.v1",
    datasetId: `sha256:${zero}`,
    ownership: {
      kind: "generated",
      generator: "tools/physics-baker",
      policy: "immutable-regenerate",
    },
    contentAddressing: {
      algorithm: "sha256",
      canonicalization: "RFC8785",
      identityScope:
        "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests",
      directoryName: zero,
    },
    plate: {
      plateId: "test-plate",
      specSha256: plateSpec.sha256,
    },
    runtimeCompatibility: {
      minimumRuntimeVersion: "0.1.0",
      maximumRuntimeVersionExclusive: "1.0.0",
      modeBinaryFormat: "mandelhowl-modes-v1",
      responseBinaryFormat: "mandelhowl-response-v1",
    },
    units: {
      system: "SI",
      length: "m",
      mass: "kg",
      time: "s",
      frequency: "Hz",
      angle: "rad",
      pressure: "Pa",
      density: "kg/m^3",
    },
    coordinateSystem: {
      frame: "plate-local",
      handedness: "right",
      origin: "plate-centre-front-surface",
      xAxis: "mandelbrot-real-positive",
      yAxis: "mandelbrot-imaginary-positive",
      zAxis: "front-normal",
    },
    modeCount: 1,
    frequencyRange: {
      minimumHz: 45,
      maximumHz: 6000,
    },
    solverProvenance: {
      solverName: "test-solver",
      solverVersion: "1.0.0",
      containerImageDigest: `sha256:${"1".repeat(64)}`,
      optionsSha256: "2".repeat(64),
    },
    files: {
      plateSpec,
      modes,
      response,
      textures,
      provenance,
      convergenceReport,
      coverageReport,
      checksums,
    },
  } as ResonanceManifest;
  const digest = await sha256Hex(
    canonicalizeJson(manifestIdentityPayload(manifestDraft)),
  );
  const manifest = {
    ...manifestDraft,
    datasetId: `sha256:${digest}`,
    contentAddressing: {
      ...manifestDraft.contentAddressing,
      directoryName: digest,
    },
  } as ResonanceManifest;
  assets.set("manifest.json", jsonBytes(manifest));
  return { assets, manifest };
}

function fetchFrom(assets: ReadonlyMap<string, Uint8Array>) {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/runtime/", "");
    const bytes = assets.get(path);
    const body = bytes
      ? Uint8Array.from(bytes).buffer
      : "missing";
    return bytes
      ? new Response(body, { status: 200 })
      : new Response(body, { status: 404 });
  };
}

describe("asset runtime", () => {
  it("loads a manifest-relative dataset only after schema and every hash pass", async () => {
    const { assets, manifest } = await fixture();
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: fetchFrom(assets) as typeof fetch,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.dataset.modes).toHaveLength(1);
    expect(result.dataset.response.sampleCount).toBe(2);
    expect(result.assetUrls.textures.normal?.url).toBe(
      `${BASE}textures/normal.ktx2`,
    );
    expect(result.diagnostics.at(-1)?.code).toBe("DATASET_READY");
  });

  it("fails closed with confirmed evidence when a fetched asset is tampered", async () => {
    const { assets } = await fixture();
    const tampered = new Map(assets);
    const modes = new Uint8Array(tampered.get("modes.bin")!);
    modes[modes.length - 1] ^= 1;
    tampered.set("modes.bin", modes);
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      fetch: fetchFrom(tampered) as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "DATASET_ASSET_HASH_MISMATCH" &&
        diagnostic.evidenceState === "confirmed",
    )).toBe(true);
  });

  it("rejects a valid dataset when it is not the canonical release pin", async () => {
    const { assets, manifest } = await fixture();
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: `sha256:${"f".repeat(64)}`,
      fetch: fetchFrom(assets) as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(result.manifest?.datasetId).toBe(manifest.datasetId);
    expect(
      result.diagnostics.some(
        ({ code }) => code === "DATASET_EXPECTED_ID_MISMATCH",
      ),
    ).toBe(true);
  });

  it("rejects traversal paths at the manifest schema boundary", async () => {
    const { manifest } = await fixture();
    const invalid = {
      ...manifest,
      files: {
        ...manifest.files,
        modes: {
          ...manifest.files.modes,
          path: "../modes.bin",
        },
      },
    };
    const result = validateResonanceManifest(invalid);
    expect(result.manifest).toBeNull();
    expect(result.diagnostics[0]?.code).toBe(
      "DATASET_ASSET_PATH_UNSAFE",
    );
  });

  it(
    "loads the pinned production thin-plate release with all 48 modes",
    async () => {
      const datasetRoot = resolve(
        process.cwd(),
        GENERATED_DATASET_RELEASE_SPEC.sourceDirectory,
      );
      const fileFetch = async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const prefix = "/runtime/";
        if (!url.pathname.startsWith(prefix)) {
          return new Response("outside dataset", { status: 404 });
        }
        const relative = url.pathname.slice(prefix.length);
        if (
          relative === "" ||
          relative.includes("\\") ||
          relative.split("/").includes("..")
        ) {
          return new Response("unsafe", { status: 400 });
        }
        try {
          const bytes = await readFile(resolve(datasetRoot, relative));
          return new Response(Uint8Array.from(bytes).buffer, {
            status: 200,
          });
        } catch {
          return new Response("missing", { status: 404 });
        }
      };
      const result = await loadResonanceDataset({
        manifestUrl: `${BASE}manifest.json`,
        expectedDatasetId: GENERATED_DATASET_RELEASE_SPEC.datasetId,
        fetch: fileFetch as typeof fetch,
      });

      expect(result.status).toBe("ready");
      if (result.status !== "ready") {
        throw new Error(
          result.diagnostics
            .map((diagnostic) => diagnostic.code)
            .join(","),
        );
      }
      expect(result.dataset.modes).toHaveLength(48);
      expect(isRuntimeCompatible(result.manifest, "0.1.0")).toBe(true);
      expect(isRuntimeCompatible(result.manifest, "0.0.9")).toBe(false);
      expect(isRuntimeCompatible(result.manifest, "1.0.0")).toBe(false);
      expect(
        `sha256:${result.manifest.files.modes.sha256}`,
      ).toBe(GENERATED_DATASET_RELEASE_SPEC.modalModelId);
      const coverage = JSON.parse(
        new TextDecoder().decode(
          result.assets.get(result.manifest.files.coverageReport.path),
        ),
      ) as { outputs?: unknown[]; replayVerified?: boolean };
      expect(coverage.outputs).toHaveLength(101);
      expect(coverage.replayVerified).toBe(true);
    },
    30_000,
  );
});
