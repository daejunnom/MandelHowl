import { createDiagnostic } from "../../diagnostics/src";
import { CanvasPlateRenderer } from "./canvas-plate-renderer";
import {
  PlateRendererStatusTracker,
  reportPlateRendererDiagnostic,
  reportPlateRendererStatus,
  selectRenderQuality,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateTextureSource,
} from "./render-types";
import { WebGlPlateRenderer } from "./webgl-plate-renderer";
import {
  RenderQualityGovernor,
  type RenderDegradationStage,
} from "./render-quality-governor";

class StaticPlateRenderer implements PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly statusTracker: PlateRendererStatusTracker;

  constructor(canvas: HTMLCanvasElement, options: PlateRendererOptions) {
    this.canvas = canvas;
    this.statusTracker = new PlateRendererStatusTracker({
      kind: "static",
      quality: selectRenderQuality("static", options.preferences),
      degradationStage: 6,
      datasetId: null,
      textureReady: false,
      materialSectionReady: false,
      contextLost: false,
      framesRendered: 0,
      lastSnapshotSequence: null,
    });
    canvas.style.opacity = "0";
    reportPlateRendererStatus(
      options,
      Object.freeze({ ...this.statusTracker.view }),
    );
  }

  get status(): PlateRendererStatus {
    return this.statusTracker.view;
  }

  async setTextureSource(): Promise<void> {
    // The surrounding CSS plate remains the explicit no-Canvas fallback.
  }

  render(snapshot: Parameters<PlateRenderer["render"]>[0]): void {
    this.statusTracker.recordFrame(snapshot.sequence);
  }
  recordFrameTiming(): void {}
  resize(): void {}
  dispose(): void {
    this.canvas.style.opacity = "";
  }
}

class InitialCanvasFallbackPlateRenderer implements PlateRenderer {
  private disposed = false;

  constructor(
    private readonly originalCanvas: HTMLCanvasElement,
    readonly canvas: HTMLCanvasElement,
    private readonly delegate: CanvasPlateRenderer,
    private readonly originalClassName: string,
    private readonly originalRole: string | null,
    private readonly originalLabel: string | null,
    private readonly originalAriaHidden: string | null,
  ) {}

  get status(): PlateRendererStatus {
    return this.delegate.status;
  }

  setTextureSource(source: PlateTextureSource | null): Promise<void> {
    return this.delegate.setTextureSource(source);
  }

  render(snapshot: Parameters<PlateRenderer["render"]>[0]): void {
    this.delegate.render(snapshot);
  }

  recordFrameTiming(frameWorkMs: number): void {
    void frameWorkMs;
    this.delegate.recordFrameTiming();
  }

  resize(): void {
    this.delegate.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.delegate.dispose();
    this.canvas.remove();
    this.originalCanvas.className = this.originalClassName;
    restoreAttribute(this.originalCanvas, "role", this.originalRole);
    restoreAttribute(this.originalCanvas, "aria-label", this.originalLabel);
    restoreAttribute(
      this.originalCanvas,
      "aria-hidden",
      this.originalAriaHidden,
    );
  }
}

function restoreAttribute(
  element: HTMLElement,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}

function createInitialCanvasFallback(
  originalCanvas: HTMLCanvasElement,
  options: PlateRendererOptions,
): PlateRenderer | null {
  const parent = originalCanvas.parentElement;
  if (!parent) return null;

  const fallbackCanvas =
    originalCanvas.ownerDocument.createElement("canvas");
  fallbackCanvas.className = originalCanvas.className;
  fallbackCanvas.setAttribute("data-render-pressure-fallback", "canvas2d");
  fallbackCanvas.setAttribute(
    "data-render-fallback-reason",
    "webgl-initialization-failed",
  );
  const role = originalCanvas.getAttribute("role");
  const label = originalCanvas.getAttribute("aria-label");
  const ariaHidden = originalCanvas.getAttribute("aria-hidden");
  if (role) fallbackCanvas.setAttribute("role", role);
  if (label) fallbackCanvas.setAttribute("aria-label", label);
  const context = fallbackCanvas.getContext("2d", { alpha: true });
  if (!context) return null;

  const originalClassName = originalCanvas.className;
  let delegate: CanvasPlateRenderer | null = null;
  try {
    originalCanvas.classList.remove("mh-plate-canvas");
    originalCanvas.classList.add("mh-plate-canvas-suspended");
    originalCanvas.setAttribute("aria-hidden", "true");
    originalCanvas.removeAttribute("role");
    originalCanvas.removeAttribute("aria-label");
    parent.insertBefore(fallbackCanvas, originalCanvas.nextSibling);
    delegate = new CanvasPlateRenderer(
      fallbackCanvas,
      context,
      options,
    );
    delegate.resize();
    return new InitialCanvasFallbackPlateRenderer(
      originalCanvas,
      fallbackCanvas,
      delegate,
      originalClassName,
      role,
      label,
      ariaHidden,
    );
  } catch (error) {
    try {
      delegate?.dispose();
    } catch {
      // Continue restoring the original static presentation even when the
      // partially constructed Canvas2D delegate cannot clean itself up.
    }
    fallbackCanvas.remove();
    originalCanvas.className = originalClassName;
    restoreAttribute(originalCanvas, "role", role);
    restoreAttribute(originalCanvas, "aria-label", label);
    restoreAttribute(originalCanvas, "aria-hidden", ariaHidden);
    reportPlateRendererDiagnostic(
      options,
      createDiagnostic({
        code: "MH-RENDER-CANVAS-FALLBACK-FAILED",
        severity: "warning",
        messageKey: "runtime.rendererFallback",
        evidence: [
          {
            key: "reason",
            value: error instanceof Error ? error.message : "unknown",
            source: "render-engine",
          },
        ],
      }),
    );
    return null;
  }
}

/**
 * Keeps the canonical snapshot lane intact while progressively reducing only
 * visual work. A fresh sibling canvas is used for the final Canvas2D step
 * because a browser canvas cannot acquire a 2D context after WebGL2.
 */
class AdaptivePlateRenderer implements PlateRenderer {
  private readonly originalCanvas: HTMLCanvasElement;
  private readonly options: PlateRendererOptions;
  private readonly primary: WebGlPlateRenderer;
  private readonly governor = new RenderQualityGovernor();
  private activeRenderer: PlateRenderer;
  private textureSource: PlateTextureSource | null = null;
  private fallbackCanvas: HTMLCanvasElement | null = null;
  private fallbackTextureInstall: Promise<void> | null = null;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    options: PlateRendererOptions,
  ) {
    this.originalCanvas = canvas;
    this.options = options;
    const childOptions: PlateRendererOptions = {
      ...options,
      onStatus: (status) => {
        if (this.activeRenderer === this.primary) {
          if (
            status.contextLost &&
            this.activateCanvasFallback("webgl-context-lost")
          ) {
            return;
          }
          if (
            this.primary.hasTextureInstallFailure &&
            this.activateCanvasFallback("webgl-texture-failed")
          ) {
            return;
          }
          reportPlateRendererStatus(options, status);
        }
      },
    };
    this.primary = new WebGlPlateRenderer(canvas, gl, childOptions);
    this.activeRenderer = this.primary;
  }

  get canvas(): HTMLCanvasElement {
    return this.activeRenderer.canvas;
  }

  get status(): PlateRendererStatus {
    return this.activeRenderer.status;
  }

  async setTextureSource(source: PlateTextureSource | null): Promise<void> {
    this.textureSource = source;
    const rendererAtStart = this.activeRenderer;
    await rendererAtStart.setTextureSource(source);
    if (
      source &&
      this.activeRenderer === this.primary &&
      this.primary.hasTextureInstallFailure
    ) {
      this.activateCanvasFallback("webgl-texture-failed");
    }
    if (
      rendererAtStart === this.primary &&
      this.activeRenderer !== this.primary
    ) {
      await this.fallbackTextureInstall;
    }
  }

  render(snapshot: Parameters<PlateRenderer["render"]>[0]): void {
    try {
      this.activeRenderer.render(snapshot);
    } catch (error) {
      if (
        this.activeRenderer === this.primary &&
        this.activateCanvasFallback("webgl-texture-failed")
      ) {
        reportPlateRendererDiagnostic(
          this.options,
          createDiagnostic({
            code: "MH-RENDER-WEBGL-RUNTIME",
            severity: "warning",
            messageKey: "runtime.rendererFallback",
            evidence: [
              {
                key: "reason",
                value: error instanceof Error ? error.message : "unknown",
                source: "render-engine",
              },
            ],
          }),
        );
        this.activeRenderer.render(snapshot);
        return;
      }
      throw error;
    }
  }

  recordFrameTiming(frameWorkMs: number): void {
    if (this.disposed || this.activeRenderer !== this.primary) return;
    const previous = this.governor.stage;
    const next = this.governor.record(frameWorkMs);
    if (next === previous) return;
    if (next < 6) {
      this.primary.setDegradationStage(next);
      return;
    }
    this.activateCanvasFallback("runtime-pressure");
  }

  resize(): void {
    this.activeRenderer.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeRenderer.dispose();
    if (this.activeRenderer !== this.primary) this.primary.dispose();
    this.restoreOriginalCanvas();
    this.textureSource = null;
    this.fallbackTextureInstall = null;
  }

  /**
   * Test/development seam for deterministic pressure verification. Production
   * calls only recordFrameTiming and can never skip an earlier stage.
   */
  setDegradationStageForTesting(stage: RenderDegradationStage): void {
    if (this.disposed || this.activeRenderer !== this.primary) return;
    if (stage < 6) {
      this.primary.setDegradationStage(stage);
    } else {
      this.activateCanvasFallback("runtime-pressure");
    }
  }

  private activateCanvasFallback(
    reason: "runtime-pressure" | "webgl-context-lost" | "webgl-texture-failed",
  ): boolean {
    if (this.disposed || this.activeRenderer !== this.primary) return false;
    const parent = this.originalCanvas.parentElement;
    if (!parent) {
      if (reason === "runtime-pressure") {
        this.primary.setDegradationStage(5);
      }
      return false;
    }

    const fallbackCanvas =
      this.originalCanvas.ownerDocument.createElement("canvas");
    fallbackCanvas.className = this.originalCanvas.className;
    fallbackCanvas.setAttribute("data-render-pressure-fallback", "canvas2d");
    fallbackCanvas.setAttribute("data-render-fallback-reason", reason);
    const role = this.originalCanvas.getAttribute("role");
    const label = this.originalCanvas.getAttribute("aria-label");
    if (role) fallbackCanvas.setAttribute("role", role);
    if (label) fallbackCanvas.setAttribute("aria-label", label);
    const context = fallbackCanvas.getContext("2d", { alpha: true });
    if (!context) {
      if (reason === "runtime-pressure") {
        this.primary.setDegradationStage(5);
      }
      return false;
    }

    this.originalCanvas.classList.remove("mh-plate-canvas");
    this.originalCanvas.classList.add("mh-plate-canvas-suspended");
    this.originalCanvas.setAttribute("aria-hidden", "true");
    this.originalCanvas.removeAttribute("role");
    this.originalCanvas.removeAttribute("aria-label");
    parent.insertBefore(fallbackCanvas, this.originalCanvas.nextSibling);

    const fallbackOptions: PlateRendererOptions = {
      ...this.options,
      onStatus: (status) => {
        if (this.activeRenderer.canvas === fallbackCanvas) {
          reportPlateRendererStatus(this.options, status);
        }
      },
    };
    const fallback = new CanvasPlateRenderer(
      fallbackCanvas,
      context,
      fallbackOptions,
    );
    this.fallbackCanvas = fallbackCanvas;
    this.activeRenderer = fallback;
    this.primary.dispose();
    fallback.resize();
    reportPlateRendererStatus(
      this.options,
      Object.freeze({ ...fallback.status }),
    );
    if (this.textureSource) {
      this.fallbackTextureInstall = fallback
        .setTextureSource(this.textureSource)
        .catch((error) => {
          reportPlateRendererDiagnostic(
            this.options,
            createDiagnostic({
              code: "MH-RENDER-CANVAS-FALLBACK-FAILED",
              severity: "warning",
              messageKey: "runtime.rendererFallback",
              evidence: [
                {
                  key: "reason",
                  value: error instanceof Error ? error.message : "unknown",
                  source: "render-quality-governor",
                },
              ],
            }),
          );
        });
    } else {
      this.fallbackTextureInstall = null;
    }
    return true;
  }

  private restoreOriginalCanvas(): void {
    this.fallbackCanvas?.remove();
    this.fallbackCanvas = null;
    this.fallbackTextureInstall = null;
    this.originalCanvas.classList.remove("mh-plate-canvas-suspended");
    this.originalCanvas.classList.add("mh-plate-canvas");
    this.originalCanvas.removeAttribute("aria-hidden");
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
      const renderer = new AdaptivePlateRenderer(canvas, gl, options);
      renderer.resize();
      return renderer;
    } catch (error) {
      reportPlateRendererDiagnostic(
        options,
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
      // A Canvas cannot switch context types once WebGL was acquired, so the
      // next fail-operational rung must use a sibling Canvas2D element.
      const fallback = createInitialCanvasFallback(canvas, options);
      if (fallback) return fallback;
      reportPlateRendererDiagnostic(
        options,
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
  }

  const context = canvas.getContext("2d", { alpha: true });
  if (context) {
    reportPlateRendererDiagnostic(
      options,
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

  reportPlateRendererDiagnostic(
    options,
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
