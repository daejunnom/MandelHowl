import type { DiagnosticRecord } from "../../contracts/src/diagnostic-record";
import type { RuntimeSnapshot } from "../../contracts/src/runtime-snapshot";
import { GENERATED_MOTION_SAFETY_SPEC } from "../../contracts/src";
import { createDiagnostic } from "../../diagnostics/src";
import {
  MATERIAL_SECTION_PROFILE_SAMPLE_COUNT,
  ModalBlendTracker,
  normalizeMaterialSectionProfile,
  plateDisplacementScale,
  PlateRendererStatusTracker,
  reportPlateRendererDiagnostic,
  reportPlateRendererStatus,
  renderSeedFromDatasetId,
  RENDER_SESSION_FIXED_SEED,
  RenderFrameTracker,
  renderQualityConfiguration,
  sandVisibilityFromPresence,
  type ModalBlendSelection,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateModePresentationMetadata,
  type PlateTextureSource,
} from "./render-types";
import {
  nearestInBandTextureModeId,
  TextureShardCache,
  type DecodedTextureShard,
} from "./texture-shard-cache";

const TAU = Math.PI * 2;
export const CANVAS_MODAL_CAPACITY =
  renderQualityConfiguration("canvas").maximumTextureModesResident;

export function deterministicCanvasGrainAlpha(
  density: number,
  x: number,
  y: number,
  layer: number,
  seed = RENDER_SESSION_FIXED_SEED,
): number {
  const grainHash = deterministicCanvasGrainHash(x, y, layer, seed);
  const grain = (grainHash & 255) / 255;
  const occupied = grain < (Math.max(0, Math.min(255, density)) / 255) * 0.68;
  return occupied ? Math.min(255, 220 + Math.round(density * 0.13)) : 0;
}

export function deterministicCanvasGrainHash(
  x: number,
  y: number,
  layer: number,
  seed: number,
): number {
  let hash =
    (Math.imul(x, 73_856_093) ^
      Math.imul(y, 19_349_663) ^
      Math.imul(layer, 83_492_791) ^
      seed) >>>
    0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7f_eb_35_2d) >>> 0;
  hash ^= hash >>> 15;
  return Math.imul(hash, 0x84_6c_a6_8b) >>> 0;
}

export function blendCanvasSandDensity(
  firstDensity: number,
  firstWeight: number,
  secondDensity: number,
  secondWeight: number,
): number {
  return firstDensity * firstWeight + secondDensity * secondWeight;
}

function diagnostic(
  code: string,
  messageKey: string,
  evidence: DiagnosticRecord["evidence"],
): DiagnosticRecord {
  return createDiagnostic({
    code,
    severity: code === "MH-DATASET-INTEGRITY" ? "warning" : "info",
    messageKey,
    evidence,
  });
}

export class CanvasPlateRenderer implements PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: PlateRendererOptions;
  private readonly modalBlend = new ModalBlendTracker(CANVAS_MODAL_CAPACITY);
  private frameTracker: RenderFrameTracker | null = null;
  private readonly textureShardCache: TextureShardCache;
  private readonly requestedModeIds: (string | null)[] = Array.from(
    { length: CANVAS_MODAL_CAPACITY + 1 },
    () => null,
  );
  private readonly readinessModeIds: (string | null)[] = Array.from(
    { length: CANVAS_MODAL_CAPACITY },
    () => null,
  );
  private sandBlendCanvas: HTMLCanvasElement | null = null;
  private sandBlendContext: CanvasRenderingContext2D | null = null;
  private sandBlendImage: ImageData | null = null;
  private metalGradient: CanvasGradient | null = null;
  private metalGradientRadius = -1;
  private materialSectionProfile: Float32Array | null = null;
  private disposed = false;
  private textureSourceGeneration = 0;
  private grainSeed = renderSeedFromDatasetId(null);
  private loadingPolicy: PlateTextureSource["loadingPolicy"] = "eager-verified";
  private logicalWidth = 1;
  private logicalHeight = 1;
  private readonly statusTracker: PlateRendererStatusTracker;
  private readonly fallbackModeById = new Map<
    string,
    {
      readonly modeId: string;
      readonly radialOrder: number;
      readonly angularOrder: number;
    }
  >();
  private readonly verifiedFallbackModeById = new Map<
    string,
    PlateModePresentationMetadata
  >();

  constructor(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    options: PlateRendererOptions,
  ) {
    this.canvas = canvas;
    this.context = context;
    this.options = options;
    for (const mode of options.fallbackModes ?? []) {
      this.fallbackModeById.set(mode.modeId, mode);
    }
    this.statusTracker = new PlateRendererStatusTracker({
      kind: "canvas2d",
      quality: "canvas",
      degradationStage: 6,
      datasetId: null,
      textureReady: false,
      materialSectionReady: false,
      contextLost: false,
      framesRendered: 0,
      lastSnapshotSequence: null,
    });
    this.textureShardCache = new TextureShardCache({
      maximumShardsPerKind: CANVAS_MODAL_CAPACITY + 1,
      onLoaded: (kind) => {
        if (kind === "sand-density") {
          this.updateStatus({
            textureReady: this.currentTextureShardsReady(),
          });
        }
      },
      onError: (kind, source, error) => {
        reportPlateRendererDiagnostic(
          this.options,
          diagnostic("MH-DATASET-INTEGRITY", "dataset.textureDecodeFailed", [
            {
              key: "datasetId",
              value: this.status.datasetId,
              source: "render-engine",
            },
            {
              key: "textureKind",
              value: kind,
              source: source.url,
            },
            {
              key: "reason",
              value: error instanceof Error ? error.message : "unknown",
              source: "portable-ktx2-decoder",
            },
          ]),
        );
        if (kind === "sand-density") {
          this.updateStatus({ textureReady: false });
        }
      },
    });
  }

  get status(): PlateRendererStatus {
    return this.statusTracker.view;
  }

  async setTextureSource(source: PlateTextureSource | null): Promise<void> {
    if (this.disposed) return;
    const sourceGeneration = ++this.textureSourceGeneration;
    this.grainSeed = renderSeedFromDatasetId(source?.datasetId ?? null);
    this.verifiedFallbackModeById.clear();
    for (const mode of source?.presentationModes ?? []) {
      this.verifiedFallbackModeById.set(mode.modeId, mode);
    }
    this.materialSectionProfile = normalizeMaterialSectionProfile(
      source?.materialSectionProfile,
    );
    this.canvas.dataset.materialSection =
      this.materialSectionProfile === null ? "unavailable" : "verified";
    this.updateStatus({
      materialSectionReady: this.materialSectionProfile !== null,
    });
    if (
      source?.materialSectionProfile !== undefined &&
      this.materialSectionProfile === null
    ) {
      reportPlateRendererDiagnostic(
        this.options,
        diagnostic(
          "MH-DATASET-INTEGRITY",
          "dataset.materialSectionProfileInvalid",
          [
            {
              key: "datasetId",
              value: source.datasetId,
              source: "render-engine",
            },
          ],
        ),
      );
    }
    this.modalBlend.reset();
    this.loadingPolicy = source?.loadingPolicy ?? "eager-verified";
    this.requestedModeIds.fill(null);
    this.readinessModeIds.fill(null);
    this.sandBlendCanvas = null;
    this.sandBlendContext = null;
    this.sandBlendImage = null;
    this.textureShardCache.configure(
      source?.atlases ?? [],
      source?.datasetId ?? null,
    );
    this.updateStatus({
      datasetId: source?.datasetId ?? null,
      textureReady: false,
    });

    if (!source) {
      return;
    }

    const sandAtlases = source.atlases.filter(
      (atlas) => atlas.kind === "sand-density",
    );
    if (sandAtlases.length === 0) {
      reportPlateRendererDiagnostic(
        this.options,
        diagnostic("MH-DATASET-INTEGRITY", "dataset.sandAtlasMissing", [
          {
            key: "datasetId",
            value: source.datasetId,
            source: "render-engine",
          },
        ]),
      );
      this.updateStatus({
        datasetId: source.datasetId,
        textureReady: false,
      });
      return;
    }
    if (source.loadingPolicy !== "mode-sharded-lazy-verified") {
      this.textureShardCache.request(
        "sand-density",
        sandAtlases.flatMap((atlas) => atlas.modeIds),
      );
      await this.textureShardCache.waitForIdle();
    }
    if (this.disposed || sourceGeneration !== this.textureSourceGeneration) {
      return;
    }
    this.updateStatus({
      datasetId: source.datasetId,
      textureReady: this.currentTextureShardsReady(),
    });
  }

  render(snapshot: RuntimeSnapshot): void {
    if (this.disposed) return;
    this.frameTracker ??= new RenderFrameTracker(snapshot);
    const frame = this.frameTracker.update(snapshot);
    const blend = this.modalBlend.update(snapshot);
    for (let slot = 0; slot < CANVAS_MODAL_CAPACITY; slot += 1) {
      const modeId = blend.modeIds[slot] ?? null;
      this.requestedModeIds[slot] = modeId;
      this.readinessModeIds[slot] = modeId;
    }
    const nearestModeId = nearestInBandTextureModeId(snapshot);
    this.requestedModeIds[CANVAS_MODAL_CAPACITY] = nearestModeId;
    let hasRequiredMode = false;
    for (const modeId of this.readinessModeIds) {
      if (modeId !== null) {
        hasRequiredMode = true;
        break;
      }
    }
    if (!hasRequiredMode) {
      this.readinessModeIds[0] = nearestModeId;
    }
    this.textureShardCache.request("sand-density", this.requestedModeIds);
    const textureReady = this.currentTextureShardsReady();
    if (textureReady !== this.status.textureReady) {
      this.updateStatus({ textureReady });
    }
    const width = this.logicalWidth;
    const height = this.logicalHeight;
    const context = this.context;
    const rendersWholeApparatus =
      this.canvas.classList?.contains("mh-apparatus-canvas") === true;
    const radius =
      Math.min(width, height) * (rendersWholeApparatus ? 0.32 : 0.46);
    const centerX = width * 0.5;
    const centerY = height * (rendersWholeApparatus ? 0.47 : 0.5);
    const motionScale = plateDisplacementScale(
      this.options.preferences.reducedMotion,
    );
    const pulse =
      Math.sin(
        snapshot.simulationTimeSeconds *
          Math.min(180, snapshot.dial.driveFrequencyHz) *
          0.032,
      ) *
      frame.envelope *
      GENERATED_MOTION_SAFETY_SPEC.limits.maximumPlateDisplacementPx *
      0.43 *
      motionScale;

    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(centerX, centerY + pulse);
    context.beginPath();
    context.arc(0, 0, radius, 0, TAU);
    context.clip();

    if (!this.metalGradient || this.metalGradientRadius !== radius) {
      this.metalGradient = context.createRadialGradient(
        -radius * 0.3,
        -radius * 0.35,
        radius * 0.02,
        0,
        0,
        radius,
      );
      this.metalGradient.addColorStop(0, "#f3efe0");
      this.metalGradient.addColorStop(0.32, "#b9bbb0");
      this.metalGradient.addColorStop(0.76, "#656b67");
      this.metalGradient.addColorStop(1, "#111817");
      this.metalGradientRadius = radius;
    }
    context.fillStyle = this.metalGradient;
    context.fillRect(-radius, -radius, radius * 2, radius * 2);
    this.paintMaterialSection(radius);

    const analyticalModeId =
      snapshot.activeModeId ?? frame.dominantModeId ?? nearestModeId;
    let analyticalSandWeight = 0;
    if (analyticalModeId) {
      for (let slot = 0; slot < blend.count; slot += 1) {
        if (blend.modeIds[slot] !== analyticalModeId) continue;
        analyticalSandWeight = Math.max(
          0,
          Math.min(1, blend.sandWeights[slot] ?? 0),
        );
        break;
      }
    }
    const useAnalyticalFallback = Boolean(
      analyticalModeId &&
      !this.textureShardCache.isModeAvailable("sand-density", analyticalModeId),
    );
    const blendedSand = this.composeSandLayers(blend);
    if (blendedSand) {
      context.save();
      context.globalAlpha = sandVisibilityFromPresence(blend.presence);
      context.globalCompositeOperation = "source-over";
      context.imageSmoothingEnabled = false;
      context.shadowColor = "rgba(45, 27, 4, 0.52)";
      // A crisp one-pixel contact offset keeps individual grains separated
      // without a full 128² shadow-blur pass on every Canvas fallback frame.
      context.shadowBlur = 0;
      context.shadowOffsetX = Math.max(0.35, radius * 0.002);
      context.shadowOffsetY = Math.max(0.5, radius * 0.003);
      context.drawImage(blendedSand, -radius, -radius, radius * 2, radius * 2);
      context.restore();
    }
    // Preserve already decoded residual grains and overlay the newly captured
    // verified basis until (and only until) its own sand shard arrives.
    if (useAnalyticalFallback) {
      this.paintAnalyticalFallback(
        analyticalModeId,
        blend.presence,
        analyticalSandWeight,
        radius,
      );
    }

    context.restore();
    context.save();
    context.translate(centerX, centerY + pulse);
    context.beginPath();
    context.arc(0, 0, radius, 0, TAU);
    context.lineWidth = Math.max(1.4, radius * 0.015);
    context.strokeStyle = "rgba(242, 236, 213, .72)";
    context.stroke();
    context.beginPath();
    context.arc(0, 0, radius * 0.1, 0, TAU);
    context.fillStyle = "#303735";
    context.fill();
    context.strokeStyle = "#d3d5ca";
    context.stroke();
    context.restore();

    this.statusTracker.recordFrame(snapshot.sequence);
  }

  recordFrameTiming(): void {
    // Canvas2D is the final presentation fallback in the degradation ladder.
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.logicalWidth = Math.max(1, rect.width);
    this.logicalHeight = Math.max(1, rect.height);
    this.metalGradient = null;
    this.metalGradientRadius = -1;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      renderQualityConfiguration("canvas").maximumDevicePixelRatio,
    );
    const width = Math.max(1, Math.round(this.logicalWidth * dpr));
    const height = Math.max(1, Math.round(this.logicalHeight * dpr));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textureSourceGeneration += 1;
    this.textureShardCache.dispose();
    this.sandBlendCanvas = null;
    this.sandBlendContext = null;
    this.sandBlendImage = null;
    this.metalGradient = null;
    this.metalGradientRadius = -1;
    this.materialSectionProfile = null;
    this.verifiedFallbackModeById.clear();
    this.canvas.dataset.materialSection = "unavailable";
    this.modalBlend.reset();
    this.frameTracker = null;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private paintMaterialSection(radius: number): void {
    const profile = this.materialSectionProfile;
    if (!profile) return;

    const context = this.context;
    const startX = -radius * 0.72;
    const endX = radius * 0.72;
    const width = endX - startX;
    const bottomY = radius * 0.6;
    const lastIndex = MATERIAL_SECTION_PROFILE_SAMPLE_COUNT - 1;
    const firstTopY = bottomY - radius * (0.05 + (profile[0] ?? 0) * 0.11);
    const lastTopY =
      bottomY - radius * (0.05 + (profile[lastIndex] ?? 0) * 0.11);

    context.save();
    context.globalCompositeOperation = "source-over";
    context.beginPath();
    context.moveTo(startX, bottomY);
    context.lineTo(endX, bottomY);
    context.lineTo(endX, lastTopY);
    for (let index = lastIndex; index >= 0; index -= 1) {
      const x =
        startX +
        ((index + 0.5) / MATERIAL_SECTION_PROFILE_SAMPLE_COUNT) * width;
      const y = bottomY - radius * (0.05 + (profile[index] ?? 0) * 0.11);
      context.lineTo(x, y);
    }
    context.lineTo(startX, firstTopY);
    context.closePath();
    context.fillStyle = "rgba(30, 141, 145, 0.38)";
    context.fill();

    context.beginPath();
    context.moveTo(startX, firstTopY);
    for (
      let index = 0;
      index < MATERIAL_SECTION_PROFILE_SAMPLE_COUNT;
      index += 1
    ) {
      const x =
        startX +
        ((index + 0.5) / MATERIAL_SECTION_PROFILE_SAMPLE_COUNT) * width;
      const y = bottomY - radius * (0.05 + (profile[index] ?? 0) * 0.11);
      context.lineTo(x, y);
    }
    context.lineTo(endX, lastTopY);
    context.lineWidth = Math.max(0.8, radius * 0.006);
    context.strokeStyle = "rgba(137, 235, 226, 0.72)";
    context.stroke();
    context.restore();
  }

  private composeSandLayers(
    blend: ModalBlendSelection,
  ): HTMLCanvasElement | null {
    if (blend.count < 1) return null;
    const grainResolution = Math.max(
      1,
      Math.ceil(
        Math.sqrt(renderQualityConfiguration("canvas").sandParticleBudget),
      ),
    );
    if (
      !this.sandBlendCanvas ||
      this.sandBlendCanvas.width !== grainResolution ||
      this.sandBlendCanvas.height !== grainResolution
    ) {
      this.sandBlendCanvas = document.createElement("canvas");
      this.sandBlendCanvas.width = grainResolution;
      this.sandBlendCanvas.height = grainResolution;
      this.sandBlendContext = this.sandBlendCanvas.getContext("2d");
      this.sandBlendImage = null;
    }
    const canvas = this.sandBlendCanvas;
    const context = this.sandBlendContext;
    if (!canvas || !context) return null;

    let firstShard: DecodedTextureShard | null = null;
    let firstLayer = -1;
    let firstWeight = 0;
    let secondShard: DecodedTextureShard | null = null;
    let secondLayer = -1;
    let secondWeight = 0;
    for (let slot = 0; slot < blend.count; slot += 1) {
      const modeId = blend.modeIds[slot] ?? null;
      const shard = modeId
        ? this.textureShardCache.find("sand-density", modeId)
        : null;
      const layer = modeId && shard ? shard.source.modeIds.indexOf(modeId) : -1;
      if (!shard || layer < 0 || layer >= shard.decoded.layers) continue;
      if (firstLayer < 0) {
        firstShard = shard;
        firstLayer = layer;
        firstWeight = blend.sandWeights[slot] ?? 0;
      } else {
        secondShard = shard;
        secondLayer = layer;
        secondWeight = blend.sandWeights[slot] ?? 0;
        break;
      }
    }
    if (firstLayer < 0 || !firstShard) return null;

    this.sandBlendImage ??= context.createImageData(
      grainResolution,
      grainResolution,
    );
    const image = this.sandBlendImage;
    const firstTexture = firstShard.decoded;
    const firstPixelsPerLayer =
      firstTexture.width * firstTexture.height * firstTexture.channels;
    const firstOffset = firstLayer * firstPixelsPerLayer;
    const secondTexture = secondShard?.decoded ?? null;
    const secondPixelsPerLayer = secondTexture
      ? secondTexture.width * secondTexture.height * secondTexture.channels
      : 0;
    const secondOffset =
      secondTexture && secondLayer >= 0
        ? secondLayer * secondPixelsPerLayer
        : 0;
    const pixelCount = grainResolution * grainResolution;

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const grainX = pixel % grainResolution;
      const grainY = Math.floor(pixel / grainResolution);
      const sourceX = Math.min(
        firstTexture.width - 1,
        Math.floor(((grainX + 0.5) / grainResolution) * firstTexture.width),
      );
      const sourceY = Math.min(
        firstTexture.height - 1,
        Math.floor(((grainY + 0.5) / grainResolution) * firstTexture.height),
      );
      const channelOffset =
        (sourceY * firstTexture.width + sourceX) * firstTexture.channels;
      const firstDensity =
        firstTexture.pixels[firstOffset + channelOffset] ?? 0;
      const secondSourceX = secondTexture
        ? Math.min(
            secondTexture.width - 1,
            Math.floor(
              ((grainX + 0.5) / grainResolution) * secondTexture.width,
            ),
          )
        : 0;
      const secondSourceY = secondTexture
        ? Math.min(
            secondTexture.height - 1,
            Math.floor(
              ((grainY + 0.5) / grainResolution) * secondTexture.height,
            ),
          )
        : 0;
      const secondChannelOffset = secondTexture
        ? (secondSourceY * secondTexture.width + secondSourceX) *
          secondTexture.channels
        : 0;
      const secondDensity =
        secondTexture && secondLayer >= 0
          ? (secondTexture.pixels[secondOffset + secondChannelOffset] ?? 0)
          : 0;
      // Blend the precomputed density basis before applying the nonlinear
      // particle pass: S(x) = sum_i w_i * S_i(x).
      const density = blendCanvasSandDensity(
        firstDensity,
        firstWeight,
        secondDensity,
        secondWeight,
      );
      // Canonical KTXorientation=ru stores row zero at negative-y. Canvas
      // ImageData is top-down, so rows are mirrored once at this boundary.
      const targetPixel =
        (grainResolution - 1 - grainY) * grainResolution + grainX;
      const target = targetPixel * 4;
      const grainHash = deterministicCanvasGrainHash(
        sourceX,
        sourceY,
        1,
        this.grainSeed,
      );
      const grain = (grainHash & 255) / 255;
      image.data[target] = 248 + Math.round(grain * 7);
      image.data[target + 1] = 199 + Math.round(grain * 22);
      image.data[target + 2] = 42 + Math.round(grain * 30);
      image.data[target + 3] = deterministicCanvasGrainAlpha(
        density,
        grainX,
        grainY,
        0,
        this.grainSeed,
      );
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  private currentTextureShardsReady(): boolean {
    let requiredModeCount = 0;
    for (const modeId of this.readinessModeIds) {
      if (!modeId) continue;
      requiredModeCount += 1;
      if (!this.textureShardCache.isModeAvailable("sand-density", modeId)) {
        return false;
      }
    }
    if (requiredModeCount > 0) return true;
    return (
      this.loadingPolicy !== "mode-sharded-lazy-verified" &&
      this.textureShardCache.cachedShardCount("sand-density") > 0
    );
  }

  private paintAnalyticalFallback(
    modeId: string | null,
    presence: number,
    sandWeight: number,
    radius: number,
  ): void {
    const geometry = modeId
      ? (this.verifiedFallbackModeById.get(modeId) ??
        this.fallbackModeById.get(modeId))
      : undefined;
    if (!geometry) return;
    const context = this.context;
    const verified = "radialNodeIndex" in geometry ? geometry : null;
    const rings =
      "radialNodeIndex" in geometry ? 1 : Math.max(1, geometry.radialOrder);
    const spokes = Math.max(0, geometry.angularOrder);
    context.save();
    context.globalAlpha =
      sandVisibilityFromPresence(presence) *
      Math.max(0, Math.min(1, sandWeight));
    context.strokeStyle = "rgba(232, 204, 139, 0.9)";
    context.lineWidth = Math.max(0.8, radius * 0.006);
    for (let ring = 1; ring <= rings; ring += 1) {
      const ringRadius = verified
        ? radius *
          (verified.hubRadiusRatio +
            (verified.radialNodeIndex / verified.radialElementCount) *
              (1 - verified.hubRadiusRatio))
        : (radius * ring) / (rings + 1);
      context.beginPath();
      context.arc(0, 0, ringRadius, 0, TAU);
      context.stroke();
    }
    const angularPhase =
      verified?.symmetry === "sine" && spokes > 0 ? Math.PI / (2 * spokes) : 0;
    for (let spoke = 0; spoke < spokes; spoke += 1) {
      const angle = (spoke / spokes) * Math.PI + angularPhase;
      context.beginPath();
      context.moveTo(Math.cos(angle) * -radius, Math.sin(angle) * -radius);
      context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      context.stroke();
    }
    context.restore();
  }

  private updateStatus(
    patch: Partial<PlateRendererStatus>,
    notify = true,
  ): void {
    const ownedStatus = this.statusTracker.update(patch);
    if (notify) reportPlateRendererStatus(this.options, ownedStatus);
  }
}
