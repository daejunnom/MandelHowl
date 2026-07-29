import { createDiagnostic } from "../../diagnostics/src";
import { CanvasPlateRenderer } from "./canvas-plate-renderer";
import {
  selectRenderQuality,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
} from "./render-types";
import { WebGlPlateRenderer } from "./webgl-plate-renderer";

class StaticPlateRenderer implements PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly status: PlateRendererStatus;

  constructor(canvas: HTMLCanvasElement, options: PlateRendererOptions) {
    this.canvas = canvas;
    this.status = Object.freeze({
      kind: "static",
      quality: selectRenderQuality("static", options.preferences),
      datasetId: null,
      textureReady: false,
      contextLost: false,
      framesRendered: 0,
    });
    canvas.style.opacity = "0";
    options.onStatus?.(this.status);
  }

  async setTextureSource(): Promise<void> {
    // The surrounding CSS plate remains the explicit no-Canvas fallback.
  }

  render(): void {}
  resize(): void {}
  dispose(): void {
    this.canvas.style.opacity = "";
  }
}

export function createPlateRenderer(
  canvas: HTMLCanvasElement,
  options: PlateRendererOptions,
): PlateRenderer {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: options.preferences.preferredQuality !== "reduced",
    depth: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  if (gl) {
    try {
      const renderer = new WebGlPlateRenderer(canvas, gl, options);
      renderer.resize();
      return renderer;
    } catch (error) {
      options.onDiagnostic?.(
        createDiagnostic({
          code: "MH-RENDER-WEBGL-INIT",
          severity: "warning",
          messageKey: "render.webglInitializationFailed",
          evidence: [
            {
              key: "reason",
              value: error instanceof Error ? error.message : "unknown",
              source: "render-engine",
            },
          ],
        }),
      );
      // A Canvas cannot switch context types once WebGL was acquired. The
      // static metal plate underneath remains visible for this rare init path.
      return new StaticPlateRenderer(canvas, options);
    }
  }

  const context = canvas.getContext("2d", { alpha: true });
  if (context) {
    options.onDiagnostic?.(
      createDiagnostic({
        code: "MH-CAP-WEBGL2-UNAVAILABLE",
        severity: "warning",
        messageKey: "render.webgl2Unavailable",
        evidence: [
          {
            key: "selectedRenderer",
            value: "canvas2d",
            source: "render-engine",
          },
        ],
      }),
    );
    const renderer = new CanvasPlateRenderer(canvas, context, options);
    renderer.resize();
    return renderer;
  }

  options.onDiagnostic?.(
    createDiagnostic({
      code: "MH-CAP-CANVAS-UNAVAILABLE",
      severity: "fatal",
      messageKey: "render.canvasUnavailable",
      evidence: [
        {
          key: "selectedRenderer",
          value: "static-css",
          source: "render-engine",
        },
      ],
    }),
  );
  return new StaticPlateRenderer(canvas, options);
}
