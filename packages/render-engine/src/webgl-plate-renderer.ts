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
  selectRenderQuality,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateTextureKind,
  type PlateTextureSource,
  type RenderQualityTier,
} from "./render-types";

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUv;
out vec4 outColor;

uniform sampler2DArray uSandAtlas;
uniform sampler2DArray uDisplacementAtlas;
uniform sampler2DArray uNormalAtlas;
uniform sampler2DArray uNodalAtlas;
uniform bool uHasSandAtlas;
uniform bool uHasDisplacementAtlas;
uniform bool uHasNormalAtlas;
uniform bool uHasNodalAtlas;
uniform float uSandLayer;
uniform float uDisplacementLayer;
uniform float uNormalLayer;
uniform float uNodalLayer;
uniform float uEnvelope;
uniform float uPhase;
uniform bool uHasAnalyticalShape;
uniform float uRadialOrder;
uniform float uAngularOrder;
uniform float uRegime;
uniform float uMotion;

void main() {
  vec2 centered = (vUv - 0.5) * 2.0;
  float radius = length(centered);
  if (radius > 1.0) {
    discard;
  }

  float edge = smoothstep(1.0, 0.88, radius);
  float brushed = sin((vUv.y + sin(vUv.x * 31.0) * 0.004) * 980.0) * 0.018;
  vec2 canonicalUv = vUv;
  float displacement = uHasDisplacementAtlas
    ? texture(uDisplacementAtlas, vec3(canonicalUv, uDisplacementLayer)).r * 2.0 - 1.0
    : 0.0;
  vec2 normalXY = uHasNormalAtlas
    ? texture(uNormalAtlas, vec3(canonicalUv, uNormalLayer)).rg * 2.0 - 1.0
    : centered * 0.2;
  float normalZ = sqrt(max(0.01, 1.0 - dot(normalXY, normalXY)));
  vec3 surfaceNormal = normalize(vec3(normalXY, normalZ));
  float light = 0.62 + dot(normalize(vec3(-0.45, -0.55, 0.8)), surfaceNormal) * 0.25;
  vec3 metal = mix(vec3(0.19, 0.22, 0.21), vec3(0.78, 0.79, 0.74), clamp(light + brushed, 0.0, 1.0));

  float pulse = sin(uPhase + radius * 15.0) * uEnvelope * 0.018 * uMotion *
    (0.35 + abs(displacement) * 0.65);
  float density;
  if (uHasSandAtlas) {
    // KTXorientation=ru and the plate contract both use negative-y at v=0.
    vec2 textureUv = vec2(vUv.x, vUv.y + pulse);
    density = texture(uSandAtlas, vec3(textureUv, uSandLayer)).r;
  } else {
    if (uHasAnalyticalShape) {
      float angle = atan(centered.y, centered.x);
      float angular = uAngularOrder < 0.5
        ? 1.0
        : cos(angle * uAngularOrder);
      float shape = sin(radius * 3.14159265 * uRadialOrder + uPhase * 0.12) *
        angular;
      density = 1.0 - smoothstep(0.035, 0.13, abs(shape));
    } else {
      density = 0.0;
    }
  }
  if (uHasNodalAtlas) {
    float nodal = texture(uNodalAtlas, vec3(canonicalUv, uNodalLayer)).r;
    density = max(density, nodal * (0.45 + uEnvelope * 0.45));
  }

  vec3 sand = vec3(0.91, 0.79, 0.50);
  float sandMix = density * (0.34 + uEnvelope * 0.62);
  vec3 colour = mix(metal, sand, sandMix);

  vec3 regimeTint =
    uRegime > 2.5 ? vec3(1.0, 0.17, 0.12) :
    uRegime > 1.5 ? vec3(1.0, 0.39, 0.16) :
    uRegime > 0.5 ? vec3(0.95, 0.73, 0.29) :
                    vec3(0.25, 0.72, 0.74);
  colour += regimeTint * uEnvelope * 0.075 * (1.0 - radius);
  colour *= 0.66 + edge * 0.34;

  float rim = smoothstep(0.93, 1.0, radius);
  colour = mix(colour, vec3(0.07, 0.09, 0.09), rim * 0.78);
  outColor = vec4(colour, 1.0);
}`;

function diagnostic(
  code: string,
  severity: "info" | "warning" | "fatal",
  messageKey: string,
  evidence: DiagnosticRecord["evidence"],
): DiagnosticRecord {
  return createDiagnostic({ code, severity, messageKey, evidence });
}

function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate a WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate a WebGL program.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown program error";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function regimeNumber(regime: RuntimeSnapshot["regime"]): number {
  if (regime === "saturated") return 3;
  if (regime === "growing") return 2;
  if (regime === "critical") return 1;
  return 0;
}

export class WebGlPlateRenderer implements PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly options: PlateRendererOptions;
  private readonly quality: RenderQualityTier;
  private program: WebGLProgram | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private positionLocation = -1;
  private uniformLocations = new Map<
    string,
    WebGLUniformLocation | null
  >();
  private textures = new Map<PlateTextureKind, WebGLTexture>();
  private decodedTextures = new Map<PlateTextureKind, DecodedKtx2Array>();
  private textureModeIds = new Map<PlateTextureKind, readonly string[]>();
  private abortController: AbortController | null = null;
  private disposed = false;
  private currentStatus: PlateRendererStatus;

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.updateStatus({ contextLost: true });
    this.options.onDiagnostic?.(
      diagnostic(
        "MH-RENDER-CONTEXT-LOST",
        "warning",
        "render.contextLost",
        [
          {
            key: "datasetId",
            value: this.currentStatus.datasetId,
            source: "webglcontextlost",
          },
        ],
      ),
    );
  };

  private readonly handleContextRestored = () => {
    if (this.disposed) return;
    try {
      this.initializeGraphics();
      for (const [kind, decoded] of this.decodedTextures) {
        this.uploadTexture(kind, decoded);
      }
      this.updateStatus({ contextLost: false });
    } catch (error) {
      this.options.onDiagnostic?.(
        diagnostic(
          "MH-RENDER-RESTORE-FAILED",
          "fatal",
          "render.restoreFailed",
          [
            {
              key: "reason",
              value: error instanceof Error ? error.message : "unknown",
              source: "webglcontextrestored",
            },
          ],
        ),
      );
    }
  };

  constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    options: PlateRendererOptions,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    this.options = options;
    this.quality = selectRenderQuality("webgl2", options.preferences, {
      logicalProcessors: options.logicalProcessors,
      deviceMemoryGb: options.deviceMemoryGb,
    });
    this.currentStatus = Object.freeze({
      kind: "webgl2",
      quality: this.quality,
      datasetId: null,
      textureReady: false,
      contextLost: false,
      framesRendered: 0,
    });
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    this.initializeGraphics();
  }

  get status(): PlateRendererStatus {
    return this.currentStatus;
  }

  async setTextureSource(source: PlateTextureSource | null): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.decodedTextures.clear();
    this.textureModeIds.clear();
    this.deleteTextures();

    if (!source) {
      this.updateStatus({ datasetId: null, textureReady: false });
      return;
    }

    if (!source.atlases.some((atlas) => atlas.kind === "sand-density")) {
      this.options.onDiagnostic?.(
        diagnostic(
          "MH-DATASET-INTEGRITY",
          "warning",
          "dataset.sandAtlasMissing",
          [
            {
              key: "datasetId",
              value: source.datasetId,
              source: "render-engine",
            },
          ],
        ),
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
      const decodedAtlases = await Promise.all(
        source.atlases.map(async (atlas) => {
          const decoded = atlas.bytes
            ? decodePortableKtx2(atlas.bytes.slice().buffer)
            : await fetchPortableKtx2(
                atlas.url,
                abortController.signal,
              );
          if (
            decoded.width !== atlas.width ||
            decoded.height !== atlas.height ||
            decoded.layers < atlas.layers
          ) {
            throw new Error(
              `Decoded ${atlas.kind} atlas dimensions do not match manifest.`,
            );
          }
          return { atlas, decoded };
        }),
      );
      if (this.disposed || abortController.signal.aborted) return;
      for (const { atlas, decoded } of decodedAtlases) {
        this.decodedTextures.set(atlas.kind, decoded);
        this.textureModeIds.set(atlas.kind, atlas.modeIds);
        this.uploadTexture(atlas.kind, decoded);
      }
      this.updateStatus({
        datasetId: source.datasetId,
        textureReady: this.textures.has("sand-density"),
      });
    } catch (error) {
      if (abortController.signal.aborted) return;
      this.deleteTextures();
      this.decodedTextures.clear();
      this.textureModeIds.clear();
      this.options.onDiagnostic?.(
        diagnostic(
          "MH-DATASET-INTEGRITY",
          "warning",
          "dataset.textureDecodeFailed",
          [
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
          ],
        ),
      );
      this.updateStatus({
        datasetId: source.datasetId,
        textureReady: false,
      });
    }
  }

  render(snapshot: RuntimeSnapshot): void {
    if (
      this.disposed ||
      this.currentStatus.contextLost ||
      !this.program ||
      !this.positionBuffer
    ) {
      return;
    }

    const gl = this.gl;
    const frame = frameFromSnapshot(snapshot);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);

    const position = this.positionLocation;
    if (position < 0) return;
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(
      this.uniform("uEnvelope"),
      frame.envelope,
    );
    gl.uniform1f(
      this.uniform("uPhase"),
      frame.dominantModePhase,
    );
    const analyticalGeometry = this.options.fallbackModes?.find(
      (mode) => mode.modeId === frame.dominantModeId,
    );
    gl.uniform1i(
      this.uniform("uHasAnalyticalShape"),
      analyticalGeometry ? 1 : 0,
    );
    gl.uniform1f(
      this.uniform("uRadialOrder"),
      analyticalGeometry?.radialOrder ?? 1,
    );
    gl.uniform1f(
      this.uniform("uAngularOrder"),
      analyticalGeometry?.angularOrder ?? 0,
    );
    gl.uniform1f(
      this.uniform("uRegime"),
      regimeNumber(snapshot.regime),
    );
    gl.uniform1f(
      this.uniform("uMotion"),
      this.options.preferences.reducedMotion ? 0 : 1,
    );
    this.bindAtlas(
      "sand-density",
      frame.dominantModeId,
      0,
      "uSandAtlas",
      "uHasSandAtlas",
      "uSandLayer",
    );
    this.bindAtlas(
      "signed-displacement",
      frame.dominantModeId,
      1,
      "uDisplacementAtlas",
      "uHasDisplacementAtlas",
      "uDisplacementLayer",
    );
    this.bindAtlas(
      "normal",
      frame.dominantModeId,
      2,
      "uNormalAtlas",
      "uHasNormalAtlas",
      "uNormalLayer",
    );
    this.bindAtlas(
      "nodal-mask",
      frame.dominantModeId,
      3,
      "uNodalAtlas",
      "uHasNodalAtlas",
      "uNodalLayer",
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(position);

    this.updateStatus(
      {
        framesRendered: this.currentStatus.framesRendered + 1,
      },
      false,
    );
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dprLimit =
      this.quality === "high" ? 2 : this.quality === "balanced" ? 1.5 : 1;
    const dpr = Math.min(window.devicePixelRatio || 1, dprLimit);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    this.deleteTextures();
    if (this.positionBuffer) this.gl.deleteBuffer(this.positionBuffer);
    if (this.program) this.gl.deleteProgram(this.program);
    this.positionBuffer = null;
    this.program = null;
    this.positionLocation = -1;
    this.uniformLocations.clear();
    this.decodedTextures.clear();
    this.textureModeIds.clear();
  }

  private initializeGraphics(): void {
    const gl = this.gl;
    this.program = createProgram(gl);
    this.uniformLocations.clear();
    this.positionLocation = gl.getAttribLocation(
      this.program,
      "aPosition",
    );
    this.positionBuffer = gl.createBuffer();
    if (!this.positionBuffer) {
      throw new Error("Unable to allocate the plate vertex buffer.");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private bindAtlas(
    kind: PlateTextureKind,
    modeId: string | null,
    unit: number,
    samplerUniform: string,
    presenceUniform: string,
    layerUniform: string,
  ): void {
    if (!this.program) return;
    const gl = this.gl;
    const texture = this.textures.get(kind) ?? null;
    const modeIds = this.textureModeIds.get(kind) ?? [];
    const layer = modeId ? modeIds.indexOf(modeId) : -1;
    const available = Boolean(texture && layer >= 0);
    gl.uniform1i(
      this.uniform(presenceUniform),
      available ? 1 : 0,
    );
    gl.uniform1f(
      this.uniform(layerUniform),
      Math.max(0, layer),
    );
    if (!available || !texture) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.uniform1i(this.uniform(samplerUniform), unit);
  }

  private uploadTexture(
    kind: PlateTextureKind,
    decoded: DecodedKtx2Array,
  ): void {
    const gl = this.gl;
    const existing = this.textures.get(kind);
    if (existing) gl.deleteTexture(existing);
    const texture = gl.createTexture();
    if (!texture) throw new Error(`Unable to allocate the ${kind} texture.`);

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const internalFormat =
      decoded.channels === 1
        ? gl.R8
        : decoded.channels === 2
          ? gl.RG8
          : decoded.srgb
            ? gl.SRGB8_ALPHA8
            : gl.RGBA8;
    const format =
      decoded.channels === 1
        ? gl.RED
        : decoded.channels === 2
          ? gl.RG
          : gl.RGBA;
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      internalFormat,
      decoded.width,
      decoded.height,
      decoded.layers,
      0,
      format,
      gl.UNSIGNED_BYTE,
      decoded.pixels,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_WRAP_S,
      gl.CLAMP_TO_EDGE,
    );
    gl.texParameteri(
      gl.TEXTURE_2D_ARRAY,
      gl.TEXTURE_WRAP_T,
      gl.CLAMP_TO_EDGE,
    );
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.textures.set(kind, texture);
  }

  private deleteTextures(): void {
    for (const texture of this.textures.values()) {
      this.gl.deleteTexture(texture);
    }
    this.textures.clear();
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (this.uniformLocations.has(name)) {
      return this.uniformLocations.get(name) ?? null;
    }
    const location = this.program
      ? this.gl.getUniformLocation(this.program, name)
      : null;
    this.uniformLocations.set(name, location);
    return location;
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
