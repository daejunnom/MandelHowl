import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadResonanceDataset,
  type ResonanceDatasetLoadResult,
} from "../../packages/asset-runtime/src";
import { VERSIONED_TEXTURE_LAYERS_PER_SHARD } from "../../packages/contracts/src";
import {
  advanceMandelHowlRuntime,
  createMandelHowlRuntime,
  getRuntimeSnapshot,
} from "../../packages/resonance-engine/src";
import { decodePortableKtx2 } from "../../packages/render-engine/src";

interface DatasetLock {
  readonly schemaVersion: "mandelhowl.dataset-lock.v1";
  readonly datasetId: `sha256:${string}`;
  readonly datasetDirectory: string;
}

async function loadPinnedDataset(
  requestedPaths?: string[],
): Promise<ResonanceDatasetLoadResult> {
  const repository = process.cwd();
  const lock = JSON.parse(
    await readFile(
      path.join(repository, "release", "dataset-lock.json"),
      "utf8",
    ),
  ) as DatasetLock;
  const datasetRoot = path.resolve(repository, lock.datasetDirectory);
  const fetchDataset = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const relativePath =
      url.pathname === "/runtime/manifest.json"
        ? "manifest.json"
        : url.pathname.replace(/^\/runtime\//, "");
    requestedPaths?.push(relativePath);
    const absolutePath = path.resolve(datasetRoot, relativePath);
    const relative = path.relative(datasetRoot, absolutePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.length === 0
    ) {
      return new Response("not found", { status: 404 });
    }
    try {
      const file = await readFile(absolutePath);
      return new Response(Uint8Array.from(file).buffer, { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }) as typeof globalThis.fetch;

  return loadResonanceDataset({
    manifestUrl: "https://dataset.invalid/runtime/manifest.json",
    expectedDatasetId: lock.datasetId,
    fetch: fetchDataset,
  });
}

describe("production dataset integration", () => {
  it("loads every pinned asset and drives the canonical runtime", async () => {
    const result = await loadPinnedDataset();
    if (result.status !== "ready") {
      throw new Error(
        JSON.stringify(result.diagnostics, null, 2),
      );
    }
    expect(result.status).toBe("ready");

    expect(result.dataset.modes).toHaveLength(48);
    const runtime = createMandelHowlRuntime({
      dataset: result.dataset,
      initialFrequencyHz: 220,
      datasetReadiness: "verified",
    });
    const snapshot = getRuntimeSnapshot(runtime);
    expect(snapshot.datasetId).toBe(result.manifest.datasetId);
    expect(snapshot.modes).toHaveLength(result.manifest.modeCount);
    expect(snapshot.dial.driveFrequencyHz).toBeCloseTo(220, 10);

    const coverageReference = result.manifest.files.coverageReport;
    const coverage = JSON.parse(
      new TextDecoder().decode(result.assets.get(coverageReference.path)),
    ) as {
      replayVerified: boolean;
      coveredValues: number[];
      missingValues: number[];
      staticDistribution: { passed: boolean };
    };
    expect(coverage.replayVerified).toBe(true);
    expect(coverage.coveredValues).toEqual(
      Array.from({ length: 101 }, (_, value) => value),
    );
    expect(coverage.missingValues).toEqual([]);
    expect(coverage.staticDistribution.passed).toBe(true);
  });

  it("keeps production shards lazy, ordered, and hash/KTX verified on request", async () => {
    const requestedPaths: string[] = [];
    const result = await loadPinnedDataset(requestedPaths);
    if (result.status !== "ready") {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.status).toBe("ready");

    expect(result.manifest.algorithmRevision).toBe(
      "kirchhoff-love-c1-finite-strip-r2",
    );
    const channelsByKind = {
      "signed-displacement": 1,
      normal: 2,
      "nodal-mask": 1,
      "sand-density": 1,
    } as const;
    const expectedModeIds = result.dataset.modes.map(
      (mode) => mode.modeId,
    );
    const texturePaths = new Set(
      result.manifest.files.textures.map((texture) => texture.path),
    );
    expect(
      requestedPaths.filter((requested) => texturePaths.has(requested)),
    ).toEqual([]);
    for (const texture of result.manifest.files.textures) {
      expect(result.assets.has(texture.path), texture.path).toBe(false);
    }

    for (const kind of Object.keys(channelsByKind) as Array<
      keyof typeof channelsByKind
    >) {
      const descriptors = result.manifest.files.textures.filter(
        (texture) => texture.kind === kind,
      );
      const verifiedShards = result.textureAssets[kind];
      expect(descriptors).toHaveLength(
        result.manifest.modeCount /
          VERSIONED_TEXTURE_LAYERS_PER_SHARD,
      );
      expect(verifiedShards).toHaveLength(descriptors.length);
      expect(descriptors.flatMap((texture) => texture.modeIds)).toEqual(
        expectedModeIds,
      );

      for (
        let shardIndex = 0;
        shardIndex < descriptors.length;
        shardIndex += 1
      ) {
        const texture = descriptors[shardIndex]!;
        const verified = verifiedShards[shardIndex]!;
        const firstLayer =
          shardIndex * VERSIONED_TEXTURE_LAYERS_PER_SHARD;
        const lastLayer =
          firstLayer + VERSIONED_TEXTURE_LAYERS_PER_SHARD - 1;
        expect(texture.path).toBe(
          `textures/${kind}-${String(firstLayer).padStart(2, "0")}-${String(lastLayer).padStart(2, "0")}.ktx2`,
        );
        expect(texture.layers).toBe(
          VERSIONED_TEXTURE_LAYERS_PER_SHARD,
        );
        expect(texture.modeIds).toEqual(
          expectedModeIds.slice(firstLayer, lastLayer + 1),
        );
        expect(texture.supercompressionScheme).toBe(3);
        expect(verified.path).toBe(texture.path);

        const source = await verified.loadBytes();
        expect(new DataView(source.buffer, source.byteOffset).getUint32(44, true)).toBe(
          3,
        );
        const decoded = decodePortableKtx2(
          Uint8Array.from(source).buffer,
        );
        expect(decoded.width).toBe(texture.widthPx);
        expect(decoded.height).toBe(texture.heightPx);
        expect(decoded.layers).toBe(texture.layers);
        expect(decoded.channels).toBe(channelsByKind[kind]);
      }
    }
    expect(
      requestedPaths.filter((requested) => texturePaths.has(requested)),
    ).toEqual(result.manifest.files.textures.map(({ path }) => path));
  });

  it(
    "simulates one hour without replacing or growing fixed runtime buffers",
    { timeout: 60_000 },
    async () => {
      const result = await loadPinnedDataset();
      if (result.status !== "ready") {
        throw new Error(JSON.stringify(result.diagnostics, null, 2));
      }
      expect(result.status).toBe("ready");

      let runtime = createMandelHowlRuntime({
        dataset: result.dataset,
        initialFrequencyHz: 220,
        datasetReadiness: "verified",
      });
      const resonance = runtime.resonance;
      const buffers = {
        modeEnergy: resonance.modeEnergy,
        modePhaseRadians: resonance.modePhaseRadians,
        modeResponseScratch: resonance.modeResponseScratch,
        modeDriveScoreScratch: resonance.modeDriveScoreScratch,
        modeLoopScoreScratch: resonance.modeLoopScoreScratch,
        frequencySortedModeIndices:
          resonance.frequencySortedModeIndices,
        modeUpdateIndices: resonance.modeUpdateIndices,
        modeUpdateMarks: resonance.modeUpdateMarks,
        nonzeroModeIndices: resonance.nonzeroModeIndices,
        nextNonzeroModeIndices:
          resonance.nextNonzeroModeIndices,
        activeModeIndices: resonance.activeModeIndices,
        activeModePriorityScratch:
          resonance.activeModePriorityScratch,
        delayBuffer: resonance.delayBuffer,
        recentMicrophoneSamples: resonance.recentMicrophoneSamples,
        rmsWindow: resonance.rmsWindow,
      };
      const lengths = Object.fromEntries(
        Object.entries(buffers).map(([name, buffer]) => [
          name,
          buffer.length,
        ]),
      );

      const frames = 36_000;
      for (let frame = 0; frame < frames; frame += 1) {
        runtime = advanceMandelHowlRuntime(runtime, 0.1);
      }

      expect(runtime.resonance).toBe(resonance);
      for (const [name, buffer] of Object.entries(buffers)) {
        const current = runtime.resonance[
          name as keyof typeof buffers
        ];
        expect(current).toBe(buffer);
        expect(buffer.length).toBe(lengths[name]);
        expect(Array.from(buffer).every(Number.isFinite)).toBe(true);
      }
      expect(runtime.resonance.sequence).toBe(frames);
      expect(runtime.resonance.simulationTimeSeconds).toBeCloseTo(
        60 * 60,
        5,
      );
      expect(runtime.resonance.simulationStep).toBe(60 * 60 * 240);

      const snapshot = getRuntimeSnapshot(runtime);
      expect(snapshot.sequence).toBe(frames);
      expect(
        snapshot.diagnostics.some(({ severity }) => severity === "fatal"),
      ).toBe(false);
      expect(
        snapshot.modes.every(
          (mode) =>
            Number.isFinite(mode.energyNormalized) &&
            Number.isFinite(mode.phaseRad),
        ),
      ).toBe(true);
    },
  );
});
