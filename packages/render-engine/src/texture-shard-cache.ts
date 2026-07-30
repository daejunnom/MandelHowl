import { GENERATED_FEEDBACK_SPEC } from "../../contracts/src";
import {
  decodePortableKtx2Async,
  type DecodedKtx2Array,
} from "./ktx2-texture";
import {
  expectedPlateTextureChannels,
  type PlateTextureAtlasSource,
  type PlateTextureKind,
} from "./render-types";

export interface DecodedTextureShard {
  readonly source: PlateTextureAtlasSource;
  readonly decoded: DecodedKtx2Array;
}

export interface TextureShardCacheOptions {
  readonly maximumShardsPerKind: number;
  readonly onLoaded?: (kind: PlateTextureKind) => void;
  readonly onError?: (
    kind: PlateTextureKind,
    source: PlateTextureAtlasSource,
    error: unknown,
  ) => void;
}

interface CachedShard extends DecodedTextureShard {
  lastUse: number;
}

const TEXTURE_KINDS = Object.freeze([
  "signed-displacement",
  "normal",
  "nodal-mask",
  "sand-density",
] as const satisfies readonly PlateTextureKind[]);

/**
 * Bounded decoded-shard cache for the renderer presentation layer.
 *
 * Asset-runtime owns hash verification. This cache keeps only decoded shards
 * needed by the current modal top-K (plus one in-band pre-capture hint), and
 * never retains the source byte buffers after decoding.
 */
export class TextureShardCache {
  private readonly options: TextureShardCacheOptions;
  private readonly sourceByKindAndMode = new Map<
    PlateTextureKind,
    Map<string, PlateTextureAtlasSource>
  >();
  private readonly cached = new Map<string, CachedShard>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private abortController = new AbortController();
  private cacheIdentity: string | null = null;
  private clock = 0;
  private disposed = false;

  constructor(options: TextureShardCacheOptions) {
    if (
      !Number.isInteger(options.maximumShardsPerKind) ||
      options.maximumShardsPerKind < 1
    ) {
      throw new Error("Texture shard cache capacity must be a positive integer.");
    }
    this.options = options;
    this.configure([]);
  }

  configure(
    atlases: readonly PlateTextureAtlasSource[],
    cacheIdentity: string | null = null,
  ): void {
    const canReuse = cacheIdentity !== null && cacheIdentity === this.cacheIdentity;
    const reusableCached = canReuse ? new Map(this.cached) : new Map();
    this.abortController.abort();
    this.abortController = new AbortController();
    this.sourceByKindAndMode.clear();
    for (const kind of TEXTURE_KINDS) {
      this.sourceByKindAndMode.set(kind, new Map());
    }
    this.cached.clear();
    this.inFlight.clear();
    this.failed.clear();
    this.clock = 0;
    this.cacheIdentity = cacheIdentity;
    this.disposed = false;
    const uniqueSources = new Map<string, PlateTextureAtlasSource>();
    for (const atlas of atlases) {
      const byMode = this.sourceByKindAndMode.get(atlas.kind)!;
      uniqueSources.set(this.sourceKey(atlas.kind, atlas.url), atlas);
      for (const modeId of atlas.modeIds) {
        if (byMode.has(modeId)) {
          throw new Error(
            `${atlas.kind} mode ${modeId} belongs to multiple texture shards.`,
          );
        }
        byMode.set(modeId, atlas);
      }
    }
    for (const [key, source] of uniqueSources) {
      const reusable = reusableCached.get(key);
      if (reusable && this.matchesDescriptor(reusable.source, source)) {
        this.cached.set(key, {
          source: this.retainedDescriptor(source),
          decoded: reusable.decoded,
          lastUse: reusable.lastUse,
        });
        this.clock = Math.max(this.clock, reusable.lastUse);
      }
    }
  }

  request(
    kind: PlateTextureKind,
    modeIds: readonly (string | null)[],
  ): void {
    if (this.disposed) return;
    const byMode = this.sourceByKindAndMode.get(kind);
    if (!byMode) return;
    for (const modeId of modeIds) {
      if (!modeId) continue;
      const source = byMode.get(modeId);
      if (!source) continue;
      const key = this.sourceKey(kind, source.url);
      const cached = this.cached.get(key);
      if (cached) {
        cached.lastUse = ++this.clock;
        continue;
      }
      if (this.inFlight.has(key) || this.failed.has(key)) {
        continue;
      }
      const operation = this.load(kind, source);
      this.inFlight.set(key, operation);
      void operation.finally(() => {
        if (this.inFlight.get(key) === operation) {
          this.inFlight.delete(key);
        }
      });
    }
  }

  find(
    kind: PlateTextureKind,
    modeId: string,
  ): DecodedTextureShard | null {
    const source = this.sourceByKindAndMode.get(kind)?.get(modeId);
    if (!source) return null;
    const cached = this.cached.get(this.sourceKey(kind, source.url));
    if (!cached) return null;
    cached.lastUse = ++this.clock;
    return cached;
  }

  isModeAvailable(kind: PlateTextureKind, modeId: string): boolean {
    return this.find(kind, modeId) !== null;
  }

  cachedShardCount(kind: PlateTextureKind): number {
    let count = 0;
    for (const shard of this.cached.values()) {
      if (shard.source.kind === kind) count += 1;
    }
    return count;
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.sourceByKindAndMode.clear();
    this.cached.clear();
    this.inFlight.clear();
    this.failed.clear();
    this.cacheIdentity = null;
  }

  private async load(
    kind: PlateTextureKind,
    source: PlateTextureAtlasSource,
  ): Promise<void> {
    const signal = this.abortController.signal;
    try {
      if (!source.bytes && !source.loadBytes) {
        throw new Error(
          `Texture shard ${source.url} has no verified byte provider.`,
        );
      }
      const decoded = source.bytes
        ? await decodePortableKtx2Async(source.bytes, signal)
        : await decodePortableKtx2Async(
            await source.loadBytes!(signal),
            signal,
          );
      if (signal.aborted || this.disposed) return;
      if (
        decoded.width !== source.width ||
        decoded.height !== source.height ||
        decoded.layers !== source.layers ||
        source.modeIds.length !== source.layers ||
        decoded.channels !== expectedPlateTextureChannels(kind)
      ) {
        throw new Error(
          `Decoded ${kind} shard dimensions do not match its descriptor.`,
        );
      }
      this.cached.set(this.sourceKey(kind, source.url), {
        source: this.retainedDescriptor(source),
        decoded,
        lastUse: ++this.clock,
      });
      this.evict(kind);
      this.options.onLoaded?.(kind);
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      this.failed.add(this.sourceKey(kind, source.url));
      this.options.onError?.(kind, source, error);
    }
  }

  private evict(kind: PlateTextureKind): void {
    while (
      this.cachedShardCount(kind) >
      this.options.maximumShardsPerKind
    ) {
      let oldestUrl: string | null = null;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [url, shard] of this.cached) {
        if (
          shard.source.kind === kind &&
          shard.lastUse < oldestUse
        ) {
          oldestUrl = url;
          oldestUse = shard.lastUse;
        }
      }
      if (oldestUrl === null) return;
      this.cached.delete(oldestUrl);
    }
  }

  private sourceKey(kind: PlateTextureKind, url: string): string {
    return `${kind}\u0000${url}`;
  }

  private matchesDescriptor(
    left: PlateTextureAtlasSource,
    right: PlateTextureAtlasSource,
  ): boolean {
    return (
      left.kind === right.kind &&
      left.url === right.url &&
      left.mediaType === right.mediaType &&
      left.width === right.width &&
      left.height === right.height &&
      left.layers === right.layers &&
      left.modeIds.length === right.modeIds.length &&
      left.modeIds.every((modeId, index) => modeId === right.modeIds[index])
    );
  }

  private retainedDescriptor(
    source: PlateTextureAtlasSource,
  ): PlateTextureAtlasSource {
    return Object.freeze({
      kind: source.kind,
      url: source.url,
      mediaType: source.mediaType,
      modeIds: Object.freeze([...source.modeIds]),
      width: source.width,
      height: source.height,
      layers: source.layers,
    });
  }
}

/**
 * Adds at most one nearest modal shard before capture. Off-band modes never
 * enter this prefetch hint, so a broad sweep cannot download unrelated data.
 */
export function nearestInBandTextureModeId(snapshot: {
  readonly dial: { readonly driveFrequencyHz: number };
  readonly modes: readonly {
    readonly modeId: string;
    readonly naturalFrequencyHz: number;
  }[];
}): string | null {
  const driveFrequencyHz = snapshot.dial.driveFrequencyHz;
  let nearestModeId: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const mode of snapshot.modes) {
    const relativeDistance =
      Math.abs(driveFrequencyHz - mode.naturalFrequencyHz) /
      Math.max(Number.EPSILON, mode.naturalFrequencyHz);
    if (
      relativeDistance <=
        GENERATED_FEEDBACK_SPEC.modalSelection.activationBandwidthRatio &&
      relativeDistance < nearestDistance
    ) {
      nearestModeId = mode.modeId;
      nearestDistance = relativeDistance;
    }
  }
  return nearestModeId;
}
