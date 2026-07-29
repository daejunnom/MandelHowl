import type { DiagnosticRecord } from "../../contracts/src/diagnostic-record";
import type { RuntimeSnapshot } from "../../contracts/src/runtime-snapshot";
import { createDiagnostic } from "../../diagnostics/src";
import {
  decodePortableKtx2,
  fetchPortableKtx2,
  type DecodedKtx2Array,
} from "./ktx2-texture";
import {
  frameFromSnapshot,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateTextureSource,
} from "./render-types";

const TAU = Math.PI * 2;

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
  private texture: DecodedKtx2Array | null = null;
  private textureModeIds: readonly string[] = [];
  private layerCanvases = new Map<number, HTMLCanvasElement>();
  private abortController: AbortController | null = null;
  private disposed = false;
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
    return this.currentStatus;
  }

  async setTextureSource(source: PlateTextureSource | null): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.texture = null;
    this.textureModeIds = [];
    this.layerCanvases.clear();

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

    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      const decoded = sandAtlas.bytes
        ? decodePortableKtx2(sandAtlas.bytes.slice().buffer)
        : await fetchPortableKtx2(
            sandAtlas.url,
            abortController.signal,
          );
      if (this.disposed || abortController.signal.aborted) return;
      if (
        decoded.width !== sandAtlas.width ||
        decoded.height !== sandAtlas.height ||
        decoded.layers < sandAtlas.layers
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
    const frame = frameFromSnapshot(snapshot);
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

    const metal = context.createRadialGradient(
      -radius * 0.3,
      -radius * 0.35,
      radius * 0.02,
      0,
      0,
      radius,
    );
    metal.addColorStop(0, "#f3efe0");
    metal.addColorStop(0.32, "#b9bbb0");
    metal.addColorStop(0.76, "#656b67");
    metal.addColorStop(1, "#111817");
    context.fillStyle = metal;
    context.fillRect(-radius, -radius, radius * 2, radius * 2);

    const layer = frame.dominantModeId
      ? this.textureModeIds.indexOf(frame.dominantModeId)
      : -1;
    const layerCanvas = layer >= 0 ? this.getLayerCanvas(layer) : null;
    if (layerCanvas) {
      context.save();
      context.globalAlpha = 0.42 + frame.envelope * 0.5;
      context.globalCompositeOperation = "screen";
      context.drawImage(
        layerCanvas,
        -radius,
        -radius,
        radius * 2,
        radius * 2,
      );
      context.restore();
    } else {
      this.paintAnalyticalFallback(
        frame.dominantModeId,
        frame.envelope,
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

    this.updateStatus(
      {
        framesRendered: this.currentStatus.framesRendered + 1,
      },
      false,
    );
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.logicalWidth = Math.max(1, rect.width);
    this.logicalHeight = Math.max(1, rect.height);
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
    this.layerCanvases.clear();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private getLayerCanvas(layer: number): HTMLCanvasElement | null {
    const existing = this.layerCanvases.get(layer);
    if (existing) return existing;
    const texture = this.texture;
    if (!texture || layer < 0 || layer >= texture.layers) return null;

    const canvas = document.createElement("canvas");
    canvas.width = texture.width;
    canvas.height = texture.height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const pixelsPerLayer =
      texture.width * texture.height * texture.channels;
    const sourceOffset = layer * pixelsPerLayer;
    const image = context.createImageData(texture.width, texture.height);
    for (let pixel = 0; pixel < texture.width * texture.height; pixel += 1) {
      const sourceX = pixel % texture.width;
      const sourceY = Math.floor(pixel / texture.width);
      const source = sourceOffset + pixel * texture.channels;
      const density = texture.pixels[source] ?? 0;
      // Canonical KTXorientation=ru stores row zero at negative-y. Canvas
      // ImageData is top-down, so rows are mirrored once at this boundary.
      const targetPixel =
        (texture.height - 1 - sourceY) * texture.width + sourceX;
      const target = targetPixel * 4;
      image.data[target] = 229;
      image.data[target + 1] = 201;
      image.data[target + 2] = 135;
      image.data[target + 3] = density;
    }
    context.putImageData(image, 0, 0);
    this.layerCanvases.set(layer, canvas);
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
      context.moveTo(
        Math.cos(angle) * -radius,
        Math.sin(angle) * -radius,
      );
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
    });
    if (notify) this.options.onStatus?.(this.currentStatus);
  }
}
