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
  selectRenderQuality,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateTextureKind,
  type PlateTextureSource,
  type RenderQualityTier,
} from "./render-types";

const WEBGL_MODAL_CAPACITY = 4;

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 aPosition;
out vec2 vUv;

uniform sampler2DArray uDisplacementAtlas;
uniform bool uHasDisplacementAtlas;
uniform float uDisplacementLayers[4];
uniform float uDisplacementWeights[4];
uniform float uMotion;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  float displacement = 0.0;
  if (uHasDisplacementAtlas) {
    for (int index = 0; index < 4; index += 1) {
      float layer = uDisplacementLayers[index];
      if (layer >= 0.0) {
        float basis = texture(
          uDisplacementAtlas,
          vec3(vUv, layer)
        ).r * 2.0 - 1.0;
        displacement += basis * uDisplacementWeights[index];
      }
    }
  }

  // The baked signed basis now changes actual tessellated plate vertices.
  // A small radial strain plus projected lift keeps the deformation legible
  // without allowing the mesh to leave its circular fixture.
  float deformation = displacement * uMotion;
  vec2 warped = aPosition * (1.0 + deformation * 0.022);
  warped.y += deformation * 0.032;
  gl_Position = vec4(warped, deformation * 0.045, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
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
uniform float uSandLayers[4];
uniform float uDisplacementLayers[4];
uniform float uNormalLayers[4];
uniform float uNodalLayers[4];
uniform float uSandWeights[4];
uniform float uDisplacementWeights[4];
uniform float uModalPresence;
uniform float uEnvelope;
uniform bool uHasAnalyticalShape;
uniform float uRadialOrder;
uniform float uAngularOrder;
uniform float uRegime;
uniform float uMotion;

uint grainHash(uvec2 cell, uint salt) {
  uint value =
    cell.x * 0x8da6b343u ^
    cell.y * 0xd8163841u ^
    salt;
  value ^= value >> 16u;
  value *= 0x7feb352du;
  value ^= value >> 15u;
  value *= 0x846ca68bu;
  value ^= value >> 16u;
  return value;
}

float grainNoise(uvec2 cell, uint salt) {
  return float(grainHash(cell, salt) & 0x00ffffffu) / 16777215.0;
}

void main() {
  vec2 centered = (vUv - 0.5) * 2.0;
  float radius = length(centered);
  if (radius > 1.0) {
    discard;
  }

  float edge = 1.0 - smoothstep(0.88, 1.0, radius);
  float brushed = sin((vUv.y + sin(vUv.x * 31.0) * 0.004) * 980.0) * 0.018;
  vec2 canonicalUv = vUv;
  float displacement = 0.0;
  vec2 normalXY = vec2(0.0);
  for (int index = 0; index < 4; index += 1) {
    float displacementLayer = uDisplacementLayers[index];
    if (uHasDisplacementAtlas && displacementLayer >= 0.0) {
      float basis = texture(
        uDisplacementAtlas,
        vec3(canonicalUv, displacementLayer)
      ).r * 2.0 - 1.0;
      displacement += basis * uDisplacementWeights[index];
    }
    float normalLayer = uNormalLayers[index];
    if (uHasNormalAtlas && normalLayer >= 0.0) {
      float weight = uDisplacementWeights[index];
      normalXY += (
        texture(uNormalAtlas, vec3(canonicalUv, normalLayer)).rg *
        2.0 - 1.0
      ) * weight;
    }
  }
  if (!uHasNormalAtlas) {
    normalXY = centered * 0.2;
  }
  float normalLength = length(normalXY);
  if (normalLength > 0.94) {
    normalXY *= 0.94 / normalLength;
  }
  float normalZ = sqrt(max(0.01, 1.0 - dot(normalXY, normalXY)));
  vec3 surfaceNormal = normalize(vec3(normalXY, normalZ));
  float light = 0.62 + dot(normalize(vec3(-0.45, -0.55, 0.8)), surfaceNormal) * 0.25;
  vec3 metal = mix(vec3(0.19, 0.22, 0.21), vec3(0.78, 0.79, 0.74), clamp(light + brushed, 0.0, 1.0));

  float density = 0.0;
  if (uHasSandAtlas) {
    // KTXorientation=ru and the plate contract both use negative-y at v=0.
    for (int index = 0; index < 4; index += 1) {
      float layer = uSandLayers[index];
      if (layer >= 0.0) {
        density += texture(
          uSandAtlas,
          vec3(canonicalUv, layer)
        ).r * uSandWeights[index];
      }
    }
  } else {
    if (uHasAnalyticalShape) {
      float angle = atan(centered.y, centered.x);
      float angular = uAngularOrder < 0.5
        ? 1.0
        : cos(angle * uAngularOrder);
      float shape = sin(
        radius * 3.14159265 * uRadialOrder +
        displacement * 0.12
      ) *
        angular;
      density = 1.0 - smoothstep(0.035, 0.13, abs(shape));
    }
  }
  if (uHasNodalAtlas) {
    float nodalDensity = 0.0;
    for (int index = 0; index < 4; index += 1) {
      float layer = uNodalLayers[index];
      if (layer >= 0.0) {
        nodalDensity += texture(
          uNodalAtlas,
          vec3(canonicalUv, layer)
        ).r * uSandWeights[index];
      }
    }
    density = max(density, nodalDensity * (0.48 + uModalPresence * 0.42));
  }

  vec3 sand = vec3(0.91, 0.79, 0.50);
  // Stable screen-space grain cells turn the baked target density into actual
  // separated particles. Density controls occupancy rather than only colour,
  // so even a saturated nodal band retains visible gaps between grains.
  vec2 grainCoordinate = gl_FragCoord.xy * 0.72;
  uvec2 grainCell = uvec2(floor(grainCoordinate));
  vec2 grainLocal = fract(grainCoordinate) - 0.5;
  float occupancy = step(
    1.0 - clamp(density * 0.88, 0.0, 0.88),
    grainNoise(grainCell, 0x68bc21ebu)
  );
  float grainRadius =
    0.24 + grainNoise(grainCell, 0x02e5be93u) * 0.16;
  float particle = 1.0 - smoothstep(
    grainRadius,
    grainRadius + 0.075,
    length(grainLocal)
  );
  float grainCoverage = occupancy * particle;
  float sandMix = clamp(
    grainCoverage * uModalPresence * (0.42 + uModalPresence * 0.5),
    0.0,
    0.94
  );
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

function createDiscVertices(
  radialSegments: number,
  angularSegments: number,
): Float32Array {
  const triangleCount =
    angularSegments + (radialSegments - 1) * angularSegments * 2;
  const vertices = new Float32Array(triangleCount * 3 * 2);
  let offset = 0;
  const write = (radius: number, angle: number) => {
    vertices[offset] = Math.cos(angle) * radius;
    vertices[offset + 1] = Math.sin(angle) * radius;
    offset += 2;
  };

  for (let angular = 0; angular < angularSegments; angular += 1) {
    const angle0 = (angular / angularSegments) * Math.PI * 2;
    const angle1 = ((angular + 1) / angularSegments) * Math.PI * 2;
    write(0, 0);
    write(1 / radialSegments, angle0);
    write(1 / radialSegments, angle1);
  }
  for (let radial = 1; radial < radialSegments; radial += 1) {
    const inner = radial / radialSegments;
    const outer = (radial + 1) / radialSegments;
    for (let angular = 0; angular < angularSegments; angular += 1) {
      const angle0 = (angular / angularSegments) * Math.PI * 2;
      const angle1 = ((angular + 1) / angularSegments) * Math.PI * 2;
      write(inner, angle0);
      write(outer, angle0);
      write(outer, angle1);
      write(inner, angle0);
      write(outer, angle1);
      write(inner, angle1);
    }
  }
  return vertices;
}

export class WebGlPlateRenderer implements PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly options: PlateRendererOptions;
  private readonly quality: RenderQualityTier;
  private readonly modalBlend = new ModalBlendTracker(WEBGL_MODAL_CAPACITY);
  private frameTracker: RenderFrameTracker | null = null;
  private readonly sandLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private readonly displacementLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private readonly normalLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private readonly nodalLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private program: WebGLProgram | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private vertexCount = 0;
  private positionLocation = -1;
  private uniformLocations = new Map<string, WebGLUniformLocation | null>();
  private textures = new Map<PlateTextureKind, WebGLTexture>();
  private decodedTextures = new Map<PlateTextureKind, DecodedKtx2Array>();
  private textureModeIds = new Map<PlateTextureKind, readonly string[]>();
  private abortController: AbortController | null = null;
  private disposed = false;
  private framesRendered = 0;
  private currentStatus: PlateRendererStatus;

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.updateStatus({ contextLost: true });
    this.options.onDiagnostic?.(
      diagnostic("MH-RENDER-CONTEXT-LOST", "warning", "render.contextLost", [
        {
          key: "datasetId",
          value: this.currentStatus.datasetId,
          source: "webglcontextlost",
        },
      ]),
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
      this.decodedTextures.clear();
      this.textureModeIds.clear();
      this.deleteTextures();
      this.updateStatus({
        datasetId: source?.datasetId ?? null,
        textureReady: false,
      });
    }

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
          if (
            sameDataset &&
            this.decodedTextures.has(atlas.kind) &&
            this.textures.has(atlas.kind)
          ) {
            return { atlas, decoded: null };
          }
          const decoded = atlas.bytes
            ? decodePortableKtx2(atlas.bytes)
            : await fetchPortableKtx2(atlas.url, abortController.signal);
      if (
        decoded.width !== atlas.width ||
        decoded.height !== atlas.height ||
        decoded.layers !== atlas.layers ||
        decoded.channels !== expectedPlateTextureChannels(atlas.kind)
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
        this.textureModeIds.set(atlas.kind, atlas.modeIds);
        if (decoded) {
          this.decodedTextures.set(atlas.kind, decoded);
          this.uploadTexture(atlas.kind, decoded);
        }
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
    this.frameTracker ??= new RenderFrameTracker(snapshot);
    const frame = this.frameTracker.update(snapshot);
    const blend = this.modalBlend.update(snapshot);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);

    const position = this.positionLocation;
    if (position < 0) return;
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.uniform("uEnvelope"), frame.envelope);
    gl.uniform1f(this.uniform("uModalPresence"), blend.presence);
    gl.uniform1fv(this.uniform("uSandWeights[0]"), blend.sandWeights);
    gl.uniform1fv(
      this.uniform("uDisplacementWeights[0]"),
      blend.displacementWeights,
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
    gl.uniform1f(this.uniform("uRegime"), regimeNumber(snapshot.regime));
    gl.uniform1f(
      this.uniform("uMotion"),
      this.options.preferences.reducedMotion ? 0 : 1,
    );
    this.bindAtlas(
      "sand-density",
      0,
      "uSandAtlas",
      "uHasSandAtlas",
      "uSandLayers[0]",
      blend.modeIds,
      this.sandLayers,
    );
    this.bindAtlas(
      "signed-displacement",
      1,
      "uDisplacementAtlas",
      "uHasDisplacementAtlas",
      "uDisplacementLayers[0]",
      blend.modeIds,
      this.displacementLayers,
    );
    this.bindAtlas(
      "normal",
      2,
      "uNormalAtlas",
      "uHasNormalAtlas",
      "uNormalLayers[0]",
      blend.modeIds,
      this.normalLayers,
    );
    this.bindAtlas(
      "nodal-mask",
      3,
      "uNodalAtlas",
      "uHasNodalAtlas",
      "uNodalLayers[0]",
      blend.modeIds,
      this.nodalLayers,
    );

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    gl.disableVertexAttribArray(position);

    this.framesRendered += 1;
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
    this.vertexCount = 0;
    this.modalBlend.reset();
    this.frameTracker = null;
    this.uniformLocations.clear();
    this.decodedTextures.clear();
    this.textureModeIds.clear();
  }

  private initializeGraphics(): void {
    const gl = this.gl;
    this.program = createProgram(gl);
    this.uniformLocations.clear();
    this.positionLocation = gl.getAttribLocation(this.program, "aPosition");
    this.positionBuffer = gl.createBuffer();
    if (!this.positionBuffer) {
      throw new Error("Unable to allocate the plate vertex buffer.");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    const radialSegments =
      this.quality === "high" ? 32 : this.quality === "balanced" ? 24 : 16;
    const angularSegments =
      this.quality === "high" ? 96 : this.quality === "balanced" ? 72 : 48;
    const vertices = createDiscVertices(radialSegments, angularSegments);
    this.vertexCount = vertices.length / 2;
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private bindAtlas(
    kind: PlateTextureKind,
    unit: number,
    samplerUniform: string,
    presenceUniform: string,
    layersUniform: string,
    selectedModeIds: readonly (string | null)[],
    targetLayers: Float32Array,
  ): void {
    if (!this.program) return;
    const gl = this.gl;
    const texture = this.textures.get(kind) ?? null;
    const modeIds = this.textureModeIds.get(kind) ?? [];
    let hasSelectedLayer = false;
    for (let slot = 0; slot < targetLayers.length; slot += 1) {
      const modeId = selectedModeIds[slot] ?? null;
      const layer = modeId ? modeIds.indexOf(modeId) : -1;
      targetLayers[slot] = layer;
      if (layer >= 0) hasSelectedLayer = true;
    }
    const available = Boolean(texture && hasSelectedLayer);
    gl.uniform1i(this.uniform(presenceUniform), available ? 1 : 0);
    gl.uniform1fv(this.uniform(layersUniform), targetLayers);
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
    const maximumTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const maximumArrayLayers = Number(
      gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    );
    if (
      decoded.width > maximumTextureSize ||
      decoded.height > maximumTextureSize ||
      decoded.layers > maximumArrayLayers
    ) {
      throw new Error(`${kind} atlas exceeds this WebGL2 texture-array limit.`);
    }
    // Drain unrelated stale errors, then attribute the next error to this
    // upload transaction rather than silently claiming texture readiness.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (gl.getError() === gl.NO_ERROR) break;
    }
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
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const uploadError = gl.getError();
    if (uploadError !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      throw new Error(
        `${kind} texture upload failed with WebGL error 0x${uploadError.toString(16)}.`,
      );
    }
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
      framesRendered: this.framesRendered,
    });
    if (notify) this.options.onStatus?.(this.currentStatus);
  }
}
