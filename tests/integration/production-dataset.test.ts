import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadResonanceDataset,
  type ResonanceDatasetLoadResult,
} from "../../packages/asset-runtime/src";
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

async function loadPinnedDataset(): Promise<ResonanceDatasetLoadResult> {
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
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(
        result.diagnostics.map((diagnostic) => diagnostic.code).join(", "),
      );
    }

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

  it("decodes all four production KTX2 arrays with aligned mode layers", async () => {
    const result = await loadPinnedDataset();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    const channelsByKind = {
      "signed-displacement": 1,
      normal: 2,
      "nodal-mask": 1,
      "sand-density": 1,
    } as const;
    for (const texture of result.manifest.files.textures) {
      const source = result.assets.get(texture.path);
      expect(source, texture.path).toBeDefined();
      if (!source) continue;
      const arrayBuffer = Uint8Array.from(source).buffer;
      const decoded = decodePortableKtx2(arrayBuffer);
      expect(decoded.width).toBe(texture.widthPx);
      expect(decoded.height).toBe(texture.heightPx);
      expect(decoded.layers).toBe(texture.layers);
      expect(decoded.channels).toBe(channelsByKind[texture.kind]);
      expect(texture.modeIds).toHaveLength(result.manifest.modeCount);
    }
  });

  it(
    "simulates one hour without replacing or growing fixed runtime buffers",
    { timeout: 60_000 },
    async () => {
      const result = await loadPinnedDataset();
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;

      let runtime = createMandelHowlRuntime({
        dataset: result.dataset,
        initialFrequencyHz: 220,
        datasetReadiness: "verified",
      });
      const resonance = runtime.resonance;
      const buffers = {
        modeEnergy: resonance.modeEnergy,
        modePhaseRadians: resonance.modePhaseRadians,
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
