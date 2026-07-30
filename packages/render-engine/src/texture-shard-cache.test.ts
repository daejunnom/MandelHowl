import { describe, expect, it, vi } from "vitest";
import {
  nearestInBandTextureModeId,
  TextureShardCache,
} from "./texture-shard-cache";
import type { PlateTextureAtlasSource } from "./render-types";

function portableR8Ktx2(value: number): Uint8Array {
  const bytes = new Uint8Array(105);
  bytes.set([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a,
    0x0a,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, 9, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, 1, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  view.setUint32(44, 0, true);
  view.setBigUint64(80, BigInt(104), true);
  view.setBigUint64(88, BigInt(1), true);
  view.setBigUint64(96, BigInt(1), true);
  bytes[104] = value;
  return bytes;
}

function sandShard(
  modeId: string,
  url: string,
  loadBytes?: PlateTextureAtlasSource["loadBytes"],
): PlateTextureAtlasSource {
  return {
    kind: "sand-density",
    url,
    mediaType: "image/ktx2",
    modeIds: [modeId],
    width: 1,
    height: 1,
    layers: 1,
    ...(loadBytes ? { loadBytes } : {}),
  };
}

describe("texture shard cache", () => {
  it("prefetches only the nearest in-band mode shard before capture", async () => {
    const loadBytes = vi.fn(async () => portableR8Ktx2(180));
    const cache = new TextureShardCache({ maximumShardsPerKind: 2 });
    cache.configure(
      [sandShard("mode-a", "https://example.test/a.ktx2", loadBytes)],
      "sha256:dataset-a",
    );

    const modes = [{ modeId: "mode-a", naturalFrequencyHz: 1_000 }];
    const outOfBand = nearestInBandTextureModeId({
      dial: { driveFrequencyHz: 1_100 },
      modes,
    });
    expect(outOfBand).toBeNull();
    cache.request("sand-density", [outOfBand]);
    await cache.waitForIdle();
    expect(loadBytes).not.toHaveBeenCalled();

    const inBand = nearestInBandTextureModeId({
      dial: { driveFrequencyHz: 1_075 },
      modes,
    });
    expect(inBand).toBe("mode-a");
    cache.request("sand-density", [inBand]);
    await cache.waitForIdle();
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(cache.isModeAvailable("sand-density", "mode-a")).toBe(true);
  });

  it("bounds decoded texture shards and evicts the least-recently-used shard", async () => {
    const cache = new TextureShardCache({ maximumShardsPerKind: 2 });
    cache.configure(
      [
        sandShard("mode-a", "https://example.test/a.ktx2", async () =>
          portableR8Ktx2(1),
        ),
        sandShard("mode-b", "https://example.test/b.ktx2", async () =>
          portableR8Ktx2(2),
        ),
        sandShard("mode-c", "https://example.test/c.ktx2", async () =>
          portableR8Ktx2(3),
        ),
      ],
      "sha256:dataset-a",
    );

    cache.request("sand-density", ["mode-a"]);
    await cache.waitForIdle();
    cache.request("sand-density", ["mode-b"]);
    await cache.waitForIdle();
    expect(cache.find("sand-density", "mode-a")).not.toBeNull();
    cache.request("sand-density", ["mode-c"]);
    await cache.waitForIdle();

    expect(cache.cachedShardCount("sand-density")).toBe(2);
    expect(cache.find("sand-density", "mode-a")).not.toBeNull();
    expect(cache.find("sand-density", "mode-b")).toBeNull();
    expect(cache.find("sand-density", "mode-c")).not.toBeNull();
  });

  it("fails closed when a deferred shard has no verified provider or invalid KTX2", async () => {
    const errors: unknown[] = [];
    const cache = new TextureShardCache({
      maximumShardsPerKind: 2,
      onError: (_kind, _source, error) => errors.push(error),
    });
    cache.configure(
      [
        sandShard("mode-a", "https://example.test/no-provider.ktx2"),
        sandShard(
          "mode-b",
          "https://example.test/invalid.ktx2",
          async () => new Uint8Array([0]),
        ),
      ],
      "sha256:dataset-a",
    );

    cache.request("sand-density", ["mode-a", "mode-b"]);
    await cache.waitForIdle();

    expect(errors).toHaveLength(2);
    expect(cache.cachedShardCount("sand-density")).toBe(0);
    expect(cache.find("sand-density", "mode-a")).toBeNull();
    expect(cache.find("sand-density", "mode-b")).toBeNull();
  });

  it("reuses decoded shards only for the same dataset identity", async () => {
    const replacementLoad = vi.fn(async () => new Uint8Array([0]));
    const cache = new TextureShardCache({ maximumShardsPerKind: 1 });
    cache.configure(
      [
        sandShard("mode-a", "https://example.test/a.ktx2", async () =>
          portableR8Ktx2(100),
        ),
      ],
      "sha256:dataset-a",
    );
    cache.request("sand-density", ["mode-a"]);
    await cache.waitForIdle();

    cache.configure(
      [
        sandShard(
          "mode-a",
          "https://example.test/a.ktx2",
          replacementLoad,
        ),
      ],
      "sha256:dataset-a",
    );
    cache.request("sand-density", ["mode-a"]);
    await cache.waitForIdle();
    expect(replacementLoad).not.toHaveBeenCalled();
    expect(cache.find("sand-density", "mode-a")).not.toBeNull();

    cache.configure(
      [
        sandShard(
          "mode-a",
          "https://example.test/a.ktx2",
          replacementLoad,
        ),
      ],
      "sha256:dataset-b",
    );
    cache.request("sand-density", ["mode-a"]);
    await cache.waitForIdle();
    expect(replacementLoad).toHaveBeenCalledTimes(1);
    expect(cache.find("sand-density", "mode-a")).toBeNull();
  });

  it("allows a reconfigured verified source to retry a transient shard failure", async () => {
    const loadBytes = vi
      .fn<() => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValue(portableR8Ktx2(140));
    const source = sandShard(
      "mode-a",
      "https://example.test/a.ktx2",
      loadBytes,
    );
    const cache = new TextureShardCache({ maximumShardsPerKind: 1 });
    cache.configure([source], "sha256:dataset-a");
    cache.request("sand-density", ["mode-a"]);
    await cache.waitForIdle();
    cache.request("sand-density", ["mode-a"]);
    await cache.waitForIdle();
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(cache.find("sand-density", "mode-a")).toBeNull();

    cache.configure([source], "sha256:dataset-a");
    cache.request("sand-density", ["mode-a"]);
    await cache.waitForIdle();
    expect(loadBytes).toHaveBeenCalledTimes(2);
    expect(cache.find("sand-density", "mode-a")).not.toBeNull();
  });
});
