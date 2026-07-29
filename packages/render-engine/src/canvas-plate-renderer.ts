import type { DiagnosticRecord } from "../../contracts/src/diagnostic-record";
import type { RuntimeSnapshot } from "../../contracts/src/runtime-snapshot";
import { createDiagnostic } from "../../diagnostics/src";
import {
  decodePortableKtx2,
  fetchPortableKtx2,
  type DecodedKtx2Array,
} from "./ktx2-texture";
import {
  expectedPlateTextureChannels,
  ModalBlendTracker,
  RenderFrameTracker,
  sandVisibilityFromPresence,
  type ModalBlendSelection,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateTextureSource,
} from "./render-types";

const TAU = Math.PI * 2;

export function deterministicCanvasGrainAlpha(
  density: number,
  x: number,
  y: number,
  layer: number,
): number {
  const grainHash =
    ((x * 73_856_093) ^ (y * 19_349_663) ^ (layer * 83_492_791)) >>> 0;
  const grain = (grainHash & 255) / 255;
  const occupied = grain < (Math.max(0, Math.min(255, density)) / 255) * 0.88;
  return occupied ? Math.min(255, 204 + Math.round(density * 0.2)) : 0;
}

export function blendCanvasSandDensity(
  firstDensity: number,
  firstWeight: number,
  secondDensity: number,
  secondWeight: number,
): number {
  return (
    firstDensity * firstWeight + secondDensity * secondWeight
  );
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
  private readonly modalBlend = new ModalBlendTracker(2);
  private frameTracker: RenderFrameTracker | null = null;
  private texture: DecodedKtx2Array | null = null;
  private textureModeIds: readonly string[] = [];
  private sandBlendCanvas: HTMLCanvasElement | null = null;
  private sandBlendContext: CanvasRenderingContext2D | null = null;
  private sandBlendImage: ImageData | null = null;
  private metalGradient: CanvasGradient | null = null;
  private metalGradientRadius = -1;
  private abortController: AbortController | null = null;
  private disposed = false;
  private framesRendered = 0;
  private logicalWidth = 1;
  private logicalHeight = 1;
  private currentStatus: PlateRendererStatus = {
    kind: "canvas2d",
    quality: "canvas",
    datasetId: null,
    textureReady: false,
    contextLost: false,
    framesRendered: 0,
  };

  constructor(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    options: PlateRendererOptions,
  ) {
    this.canvas = canvas;
    this.context = context;
    this.options = options;
  }

  get status(): PlateRendererStatus {
    if (this.currentStatus.framesRendered !== this.framesRendered) {
      this.currentStatus = Object.freeze({
        ...this.currentStatus,
        framesRendered: this.framesRendered,
      });
    }
    return this.currentStatus;
  }

  async setTextureSource(source: PlateTextureSource | null): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    const sameDataset =
      source !== null && source.datasetId === this.currentStatus.datasetId;
    if (!sameDataset) {
      this.modalBlend.reset();
      this.texture = null;
      this.textureModeIds = [];
      this.sandBlendCanvas = null;
      this.sandBlendContext = null;
      this.sandBlendImage = null;
      this.updateStatus({
        datasetId: source?.datasetId ?? null,
        textureReady: false,
      });
    }

    if (!source) {
      this.updateStatus({
        datasetId: null,
        textureReady: false,
      });
      return;
    }

    const sandAtlas = source.atlases.find(
      (atlas) => atlas.kind === "sand-density",
    );
    if (!sandAtlas) {
      this.options.onDiagnostic?.(
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
    if (sameDataset && this.texture) {
      this.textureModeIds = sandAtlas.modeIds;
      this.updateStatus({
        datasetId: source.datasetId,
        textureReady: true,
      });
      return;
    }

    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      const decoded = sandAtlas.bytes
        ? decodePortableKtx2(sandAtlas.bytes)
        : await fetchPortableKtx2(sandAtlas.url, abortController.signal);
      if (this.disposed || abortController.signal.aborted) return;
      if (
        decoded.width !== sandAtlas.width ||
        decoded.height !== sandAtlas.height ||
        decoded.layers !== sandAtlas.layers ||
        decoded.channels !==
          expectedPlateTextureChannels(sandAtlas.kind)
      ) {
        throw new Error("Decoded sand atlas dimensions do not match manifest.");
      }
      this.texture = decoded;
      this.textureModeIds = sandAtlas.modeIds;
      this.updateStatus({
        datasetId: source.datasetId,
        textureReady: true,
      });
    } catch (error) {
      if (abortController.signal.aborted) return;
      this.options.onDiagnostic?.(
        diagnostic("MH-DATASET-INTEGRITY", "dataset.textureDecodeFailed", [
          {
            key: "datasetId",
            value: source.datasetId,
            source: "render-engine",
          },
          {
            key: "reason",
            value: error instanceof Error ? error.message : "unknown",
            source: "portable-ktx2-decoder",
          },
        ]),
      );
      this.updateStatus({
        datasetId: source.datasetId,
        textureReady: false,
      });
    }
  }

  render(snapshot: RuntimeSnapshot): void {
    if (this.disposed) return;
    this.frameTracker ??= new RenderFrameTracker(snapshot);
    const frame = this.frameTracker.update(snapshot);
    const blend = this.modalBlend.update(snapshot);
    const width = this.logicalWidth;
    const height = this.logicalHeight;
    const context = this.context;
    const radius = Math.min(width, height) * 0.46;
    const centerX = width * 0.5;
    const centerY = height * 0.5;
    const pulse = this.options.preferences.reducedMotion
      ? 0
      : Math.sin(
          snapshot.simulationTimeSeconds *
            Math.min(180, snapshot.dial.driveFrequencyHz) *
            0.032,
        ) *
        frame.envelope *
        1.3;

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
    } else {
      this.paintAnalyticalFallback(
        frame.dominantModeId,
        blend.presence,
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

    this.framesRendered += 1;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.logicalWidth = Math.max(1, rect.width);
    this.logicalHeight = Math.max(1, rect.height);
    this.metalGradient = null;
    this.metalGradientRadius = -1;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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
    this.abortController?.abort();
    this.abortController = null;
    this.texture = null;
    this.textureModeIds = [];
    this.sandBlendCanvas = null;
    this.sandBlendContext = null;
    this.sandBlendImage = null;
    this.metalGradient = null;
    this.metalGradientRadius = -1;
    this.modalBlend.reset();
    this.frameTracker = null;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private composeSandLayers(
    blend: ModalBlendSelection,
  ): HTMLCanvasElement | null {
    const texture = this.texture;
    if (!texture || blend.count < 1) return null;
    if (
      !this.sandBlendCanvas ||
      this.sandBlendCanvas.width !== texture.width ||
      this.sandBlendCanvas.height !== texture.height
    ) {
      this.sandBlendCanvas = document.createElement("canvas");
      this.sandBlendCanvas.width = texture.width;
      this.sandBlendCanvas.height = texture.height;
      this.sandBlendContext = this.sandBlendCanvas.getContext("2d");
      this.sandBlendImage = null;
    }
    const canvas = this.sandBlendCanvas;
    const context = this.sandBlendContext;
    if (!canvas || !context) return null;

    let firstLayer = -1;
    let firstWeight = 0;
    let secondLayer = -1;
    let secondWeight = 0;
    for (let slot = 0; slot < blend.count; slot += 1) {
      const modeId = blend.modeIds[slot] ?? null;
      const layer = modeId ? this.textureModeIds.indexOf(modeId) : -1;
      if (layer < 0 || layer >= texture.layers) continue;
      if (firstLayer < 0) {
        firstLayer = layer;
        firstWeight = blend.sandWeights[slot] ?? 0;
      } else {
        secondLayer = layer;
        secondWeight = blend.sandWeights[slot] ?? 0;
        break;
      }
    }
    if (firstLayer < 0) return null;

    this.sandBlendImage ??= context.createImageData(
      texture.width,
      texture.height,
    );
    const image = this.sandBlendImage;
    const pixelsPerLayer =
      texture.width * texture.height * texture.channels;
    const firstOffset = firstLayer * pixelsPerLayer;
    const secondOffset =
      secondLayer >= 0 ? secondLayer * pixelsPerLayer : 0;
    const pixelCount = texture.width * texture.height;

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const sourceX = pixel % texture.width;
      const sourceY = Math.floor(pixel / texture.width);
      const channelOffset = pixel * texture.channels;
      const firstDensity =
        texture.pixels[firstOffset + channelOffset] ?? 0;
      const secondDensity =
        secondLayer >= 0
          ? (texture.pixels[secondOffset + channelOffset] ?? 0)
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
        (texture.height - 1 - sourceY) * texture.width + sourceX;
      const target = targetPixel * 4;
      const grainHash =
        ((sourceX * 73_856_093) ^ (sourceY * 19_349_663)) >>> 0;
      const grain = (grainHash & 255) / 255;
      image.data[target] = 244 + Math.round(grain * 11);
      image.data[target + 1] = 203 + Math.round(grain * 18);
      image.data[target + 2] = 74 + Math.round(grain * 22);
      image.data[target + 3] = deterministicCanvasGrainAlpha(
        density,
        sourceX,
        sourceY,
        0,
      );
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  private paintAnalyticalFallback(
    modeId: string | null,
    envelope: number,
    radius: number,
  ): void {
    const geometry = this.options.fallbackModes?.find(
      (mode) => mode.modeId === modeId,
    );
    if (!geometry) return;
    const context = this.context;
    const rings = Math.max(1, geometry.radialOrder);
    const spokes = Math.max(0, geometry.angularOrder);
    context.save();
    context.strokeStyle = `rgba(232, 204, 139, ${0.34 + envelope * 0.45})`;
    context.lineWidth = Math.max(0.8, radius * 0.006);
    for (let ring = 1; ring <= rings; ring += 1) {
      context.beginPath();
      context.arc(0, 0, (radius * ring) / (rings + 1), 0, TAU);
      context.stroke();
    }
    for (let spoke = 0; spoke < spokes; spoke += 1) {
      const angle = (spoke / spokes) * Math.PI;
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
    this.currentStatus = Object.freeze({
      ...this.currentStatus,
      ...patch,
      framesRendered: this.framesRendered,
    });
    if (notify) this.options.onStatus?.(this.currentStatus);
  }
}
