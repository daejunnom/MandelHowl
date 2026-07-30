import type { DiagnosticRecord } from "../../contracts/src/diagnostic-record";
import type { RuntimeSnapshot } from "../../contracts/src/runtime-snapshot";
import {
  GENERATED_DIAL_SPEC,
  GENERATED_MOTION_SAFETY_SPEC,
  GENERATED_SCENE_SPEC,
} from "../../contracts/src";
import { createDiagnostic } from "../../diagnostics/src";
import {
  ACTIVE_CAPTURE_FLOOR,
  expectedPlateTextureChannels,
  localSaturationEnvelope,
  MATERIAL_SECTION_PROFILE_SAMPLE_COUNT,
  ModalBlendTracker,
  normalizeMaterialSectionProfile,
  plateDisplacementScale,
  PlateRendererStatusTracker,
  reportPlateRendererDiagnostic,
  reportPlateRendererStatus,
  renderSeedFromDatasetId,
  RenderFrameTracker,
  sandVisibilityFromPresence,
  SAND_MAX_OPACITY,
  selectRenderQuality,
  renderQualityConfiguration,
  type PlateRenderer,
  type PlateRendererOptions,
  type PlateRendererStatus,
  type PlateModePresentationMetadata,
  type PlateTextureAtlasSource,
  type PlateTextureKind,
  type PlateTextureSource,
  type RenderQualityTier,
} from "./render-types";
import type { RenderDegradationStage } from "./render-quality-governor";
import { sha256Utf8Hex } from "./shader-integrity";
import { TopKTextureLayerResidency } from "./texture-layer-residency";
import {
  nearestInBandTextureModeId,
  TextureShardCache,
} from "./texture-shard-cache";
import WEBGL_SHADER_ALLOWLIST from "../../../specs/visual/webgl-shader-allowlist.v1.json";

export const WEBGL_MODAL_CAPACITY =
  renderQualityConfiguration("high").maximumTextureModesResident;
const TAU = Math.PI * 2;
const CAMERA_PERSPECTIVE_SPREAD = Math.tan(
  (GENERATED_SCENE_SPEC.camera.fieldOfViewDegrees * Math.PI) / 360,
);
// The baker reserves byte 128 for exact zero at the clamped hub and outside
// the plate. A plain UNORM `sample * 2 - 1` would turn it into 1/255 motion.
const SIGNED_R8_DECODE_GLSL = `
float decodeSignedR8(float encoded) {
  float quantized = floor(encoded * 255.0 + 0.5);
  if (quantized == 128.0) {
    return 0.0;
  }
  return clamp(quantized / 127.5 - 1.0, -1.0, 1.0);
}
`;

const ANALYTICAL_BASIS_GLSL = `
float dominantFiniteStripRadialBasis(float radius) {
  if (radius <= uHubRadiusRatio || radius > 1.0) {
    return 0.0;
  }
  float normalizedRadius =
    (radius - uHubRadiusRatio) / max(0.0001, 1.0 - uHubRadiusRatio);
  float scaled = min(
    uRadialElementCount - 0.0001,
    normalizedRadius * uRadialElementCount
  );
  float elementIndex = floor(scaled);
  float xi = scaled - elementIndex;
  float xi2 = xi * xi;
  float xi3 = xi2 * xi;
  float radial = 0.0;
  if (abs(uRadialNodeIndex - elementIndex) < 0.25) {
    radial = uRadialDof < 0.5
      ? 1.0 - 3.0 * xi2 + 2.0 * xi3
      : (xi - 2.0 * xi2 + xi3) * 6.0;
  } else if (abs(uRadialNodeIndex - (elementIndex + 1.0)) < 0.25) {
    radial = uRadialDof < 0.5
      ? 3.0 * xi2 - 2.0 * xi3
      : (-xi2 + xi3) * 6.0;
  }
  return clamp(radial, -1.0, 1.0);
}

float analyticalBasis(vec2 centered) {
  float radius = length(centered);
  float angle = atan(centered.y, centered.x);
  if (uAnalyticalKind > 1.5) {
    float legacyAngular = uAngularOrder < 0.5
      ? 1.0
      : cos(angle * uAngularOrder);
    return sin(radius * 3.14159265 * uRadialOrder) * legacyAngular;
  }
  if (uAnalyticalKind < 0.5) {
    return 0.0;
  }
  float angular =
    uSymmetry < 0.5 ? 1.0 :
    uSymmetry < 1.5 ? cos(angle * uAngularOrder) :
                      sin(angle * uAngularOrder);
  return dominantFiniteStripRadialBasis(radius) * angular;
}
`;

export const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 aPosition;
out vec2 vUv;
out vec2 vLocalPosition;

uniform sampler2DArray uDisplacementAtlas;
uniform bool uHasDisplacementAtlas;
uniform float uDisplacementLayers[${WEBGL_MODAL_CAPACITY}];
uniform float uDisplacementWeights[${WEBGL_MODAL_CAPACITY}];
uniform float uMotion;
uniform float uMaximumDisplacementNdc;
uniform float uPerspectiveSpread;
uniform bool uHasAnalyticalShape;
uniform bool uUseAnalyticalDisplacement;
uniform float uAnalyticalKind;
uniform float uAnalyticalDisplacementWeight;
uniform float uRadialOrder;
uniform float uRadialNodeIndex;
uniform float uRadialElementCount;
uniform float uRadialDof;
uniform float uHubRadiusRatio;
uniform float uAngularOrder;
uniform float uSymmetry;
uniform float uRenderPass;
uniform float uPrimitiveKind;
uniform vec2 uSceneOffset;
uniform vec2 uSceneScale;
uniform float uApparatusMotion;

${SIGNED_R8_DECODE_GLSL}
${ANALYTICAL_BASIS_GLSL}

void main() {
  vUv = aPosition * 0.5 + 0.5;
  vLocalPosition = aPosition;
  if (uRenderPass > 0.5) {
    float motionScale =
      uPrimitiveKind > 1.5 && uPrimitiveKind < 2.5
        ? 1.0 + uApparatusMotion
        : 1.0;
    gl_Position = vec4(
      uSceneOffset + aPosition * uSceneScale * motionScale,
      0.0,
      1.0
    );
    return;
  }
  float displacement = 0.0;
  if (uHasDisplacementAtlas) {
    for (int index = 0; index < ${WEBGL_MODAL_CAPACITY}; index += 1) {
      float layer = uDisplacementLayers[index];
      if (layer >= 0.0) {
        float basis = decodeSignedR8(texture(
          uDisplacementAtlas,
          vec3(vUv, layer)
        ).r);
        displacement += basis * uDisplacementWeights[index];
      }
    }
  }
  // A resident residual mode must not hide the newly captured mode while its
  // verified shard is still in flight. Add only that missing dominant basis;
  // the flag is cleared as soon as the dominant displacement shard arrives.
  if (uHasAnalyticalShape && uUseAnalyticalDisplacement) {
    displacement +=
      analyticalBasis(aPosition) * uAnalyticalDisplacementWeight;
  }

  // The baked signed basis changes actual tessellated vertices. Projected
  // displacement is normalized before applying the canonical three-pixel
  // ceiling, so a four-mode sum cannot escape the motion-safety envelope.
  float deformation = clamp(displacement, -1.0, 1.0) * uMotion;
  vec2 radialDirection = length(aPosition) > 0.0001
    ? normalize(aPosition)
    : vec2(0.0, -1.0);
  vec2 projectedDirection = normalize(vec2(
    radialDirection.x * uPerspectiveSpread,
    radialDirection.y
  ));
  vec2 warped =
    uSceneOffset +
    aPosition * uSceneScale +
    projectedDirection * deformation * uMaximumDisplacementNdc;
  gl_Position = vec4(
    warped,
    deformation * uMaximumDisplacementNdc * 0.5,
    1.0
  );
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 vUv;
in vec2 vLocalPosition;
out vec4 outColor;

uniform sampler2DArray uSandAtlas;
uniform sampler2DArray uDisplacementAtlas;
uniform sampler2DArray uNormalAtlas;
uniform sampler2DArray uNodalAtlas;
uniform bool uHasSandAtlas;
uniform bool uHasDisplacementAtlas;
uniform bool uHasNormalAtlas;
uniform bool uHasNodalAtlas;
uniform float uSandLayers[${WEBGL_MODAL_CAPACITY}];
uniform float uDisplacementLayers[${WEBGL_MODAL_CAPACITY}];
uniform float uNormalLayers[${WEBGL_MODAL_CAPACITY}];
uniform float uNodalLayers[${WEBGL_MODAL_CAPACITY}];
uniform float uSandWeights[${WEBGL_MODAL_CAPACITY}];
uniform float uDisplacementWeights[${WEBGL_MODAL_CAPACITY}];
uniform float uModalPresence;
uniform float uSandVisibility;
uniform float uEnvelope;
uniform float uLocalSaturationEnvelope;
uniform bool uHasAnalyticalShape;
uniform bool uUseAnalyticalSand;
uniform float uAnalyticalSandWeight;
uniform float uRadialOrder;
uniform float uAnalyticalKind;
uniform float uAnalyticalDisplacementWeight;
uniform float uRadialNodeIndex;
uniform float uRadialElementCount;
uniform float uRadialDof;
uniform float uHubRadiusRatio;
uniform float uAngularOrder;
uniform float uSymmetry;
uniform float uRegime;
uniform float uMotion;
uniform float uNormalLod;
uniform float uNormalDetailStrength;
uniform bool uPostEffects;
uniform float uSandParticleGrid;
uniform uint uGrainSeed;
uniform bool uHasMaterialSection;
uniform float uMaterialSection[${MATERIAL_SECTION_PROFILE_SAMPLE_COUNT}];
uniform float uRenderPass;
uniform float uPrimitiveKind;
uniform float uPrimitiveIntensity;

${SIGNED_R8_DECODE_GLSL}
${ANALYTICAL_BASIS_GLSL}

uint grainHash(uvec2 cell, uint salt) {
  uint value =
    cell.x * 0x8da6b343u ^
    cell.y * 0xd8163841u ^
    salt ^
    uGrainSeed;
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
  if (uRenderPass > 0.5) {
    float radius = length(vLocalPosition);
    vec3 apparatusColour = vec3(0.11, 0.13, 0.13);
    float apparatusAlpha = clamp(uPrimitiveIntensity, 0.0, 1.0);
    if (uPrimitiveKind < 1.5) {
      float housingEdge = smoothstep(
        0.72,
        0.98,
        max(abs(vLocalPosition.x), abs(vLocalPosition.y))
      );
      apparatusColour = mix(
        vec3(0.08, 0.095, 0.095),
        vec3(0.36, 0.39, 0.38),
        1.0 - housingEdge
      );
    } else if (uPrimitiveKind < 2.5) {
      if (radius > 1.0) {
        discard;
      }
      float coneRing = 0.5 + sin(radius * 46.0) * 0.12;
      apparatusColour = mix(
        vec3(0.025, 0.03, 0.03),
        vec3(0.19, 0.22, 0.21),
        coneRing
      );
      float dustCap = 1.0 - smoothstep(0.16, 0.24, radius);
      apparatusColour = mix(
        apparatusColour,
        vec3(0.93, 0.38, 0.12),
        dustCap * (0.35 + apparatusAlpha * 0.55)
      );
    } else if (uPrimitiveKind < 3.5) {
      if (radius > 1.0) {
        discard;
      }
      float capsuleHighlight =
        0.35 + (1.0 - abs(vLocalPosition.x)) * 0.52;
      apparatusColour = mix(
        vec3(0.18, 0.21, 0.2),
        vec3(0.81, 0.83, 0.78),
        capsuleHighlight
      );
      float grille = step(
        0.70,
        fract((vLocalPosition.y + 1.0) * 13.0)
      );
      apparatusColour *= 0.76 + grille * 0.2;
    } else if (uPrimitiveKind < 4.5) {
      apparatusColour = vec3(0.045, 0.055, 0.055);
    } else if (uPrimitiveKind < 5.5) {
      if (radius > 1.0) {
        discard;
      }
      apparatusColour = vec3(1.0, 0.42, 0.12);
      apparatusAlpha *= 1.0 - smoothstep(0.55, 1.0, radius);
    } else if (uPrimitiveKind < 6.5) {
      if (radius > 1.0 || radius < 0.82) {
        discard;
      }
      apparatusColour = vec3(0.96, 0.42, 0.16);
      apparatusAlpha *=
        1.0 - smoothstep(0.82, 1.0, abs(radius - 0.9) * 5.0);
    } else {
      apparatusColour = mix(
        vec3(0.08, 0.095, 0.095),
        vec3(0.52, 0.56, 0.53),
        1.0 - abs(vLocalPosition.x) * 0.55
      );
    }
    outColor = vec4(apparatusColour, apparatusAlpha);
    return;
  }
  vec2 centered = (vUv - 0.5) * 2.0;
  float radius = length(centered);
  if (radius > 1.0) {
    discard;
  }

  float edge = 1.0 - smoothstep(0.88, 1.0, radius);
  vec2 canonicalUv = vUv;
  float displacement = 0.0;
  vec2 normalXY = vec2(0.0);
  for (int index = 0; index < ${WEBGL_MODAL_CAPACITY}; index += 1) {
    float displacementLayer = uDisplacementLayers[index];
    if (uHasDisplacementAtlas && displacementLayer >= 0.0) {
      float basis = decodeSignedR8(texture(
        uDisplacementAtlas,
        vec3(canonicalUv, displacementLayer)
      ).r);
      displacement += basis * uDisplacementWeights[index];
    }
    float normalLayer = uNormalLayers[index];
    if (uHasNormalAtlas && normalLayer >= 0.0) {
      float weight = uDisplacementWeights[index];
      vec2 encodedNormal = textureLod(
          uNormalAtlas,
          vec3(canonicalUv, normalLayer),
          uNormalLod
        ).rg;
      normalXY += vec2(
        decodeSignedR8(encodedNormal.x),
        decodeSignedR8(encodedNormal.y)
      ) * weight;
    }
  }
  if (!uHasNormalAtlas) {
    normalXY = centered * 0.2;
  }
  normalXY *= uNormalDetailStrength;
  float normalLength = length(normalXY);
  if (normalLength > 0.94) {
    normalXY *= 0.94 / normalLength;
  }
  float normalZ = sqrt(max(0.01, 1.0 - dot(normalXY, normalXY)));
  vec3 surfaceNormal = normalize(vec3(normalXY, normalZ));
  float light = 0.62 + dot(normalize(vec3(-0.45, -0.55, 0.8)), surfaceNormal) * 0.25;
  float brushedContribution = 0.0;
  float postHighlight = 0.0;
  if (uPostEffects) {
    // Stage 3 skips this nested high-frequency grain calculation entirely,
    // rather than evaluating it and merely multiplying its result by zero.
    brushedContribution =
      sin((vUv.y + sin(vUv.x * 31.0) * 0.004) * 980.0) * 0.018;
    postHighlight =
      (1.0 - smoothstep(0.12, 0.94, radius)) * 0.026;
  }
  vec3 metal = mix(
    vec3(0.19, 0.22, 0.21),
    vec3(0.78, 0.79, 0.74),
    clamp(light + brushedContribution + postHighlight, 0.0, 1.0)
  );

  // A narrow translucent cutaway at the lower rear edge reveals the exact
  // 64-sample, pre-baked Mandelbrot thickness profile. It is deliberately
  // composited below the front-surface sand so it cannot masquerade as a
  // modal density or alter the scientific texture.
  if (
    uHasMaterialSection &&
    canonicalUv.x >= 0.14 &&
    canonicalUv.x <= 0.86
  ) {
    float sectionCoordinate =
      (canonicalUv.x - 0.14) / (0.86 - 0.14);
    int sectionIndex = int(clamp(
      floor(
        sectionCoordinate *
        float(${MATERIAL_SECTION_PROFILE_SAMPLE_COUNT})
      ),
      0.0,
      float(${MATERIAL_SECTION_PROFILE_SAMPLE_COUNT - 1})
    ));
    float normalizedThickness = uMaterialSection[sectionIndex];
    float sectionBottom = 0.80;
    float sectionTop =
      sectionBottom - (0.025 + normalizedThickness * 0.055);
    float horizontalFeather =
      smoothstep(0.14, 0.17, canonicalUv.x) *
      (1.0 - smoothstep(0.83, 0.86, canonicalUv.x));
    float sectionBody =
      smoothstep(
        sectionTop - 0.0025,
        sectionTop + 0.0025,
        canonicalUv.y
      ) *
      (1.0 - smoothstep(
        sectionBottom - 0.003,
        sectionBottom + 0.002,
        canonicalUv.y
      )) *
      horizontalFeather;
    float sectionSurface =
      (1.0 - smoothstep(
        0.001,
        0.005,
        abs(canonicalUv.y - sectionTop)
      )) *
      horizontalFeather;
    metal = mix(
      metal,
      vec3(0.12, 0.55, 0.57),
      sectionBody * 0.38
    );
    metal +=
      vec3(0.36, 0.84, 0.82) *
      sectionSurface *
      0.17;
  }

  float density = 0.0;
  if (uHasSandAtlas) {
    // KTXorientation=ru and the plate contract both use negative-y at v=0.
    for (int index = 0; index < ${WEBGL_MODAL_CAPACITY}; index += 1) {
      float layer = uSandLayers[index];
      if (layer >= 0.0) {
        density += texture(
          uSandAtlas,
          vec3(canonicalUv, layer)
        ).r * uSandWeights[index];
      }
    }
  }
  // Keep already decoded residual layers, then overlay the exact normalized
  // active-mode weight only while that active sand shard remains unavailable.
  if (uHasAnalyticalShape && uUseAnalyticalSand) {
    float shape = analyticalBasis(centered);
    float analyticalDensity =
      1.0 - smoothstep(0.035, 0.13, abs(shape));
    density = clamp(
      density + analyticalDensity * uAnalyticalSandWeight,
      0.0,
      1.0
    );
  }
  float nodalDensity = 0.0;
  if (uHasNodalAtlas) {
    for (int index = 0; index < ${WEBGL_MODAL_CAPACITY}; index += 1) {
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

  vec3 sand = vec3(1.0, 0.78, 0.28);
  vec3 sandShadow = vec3(0.13, 0.075, 0.018);
  // Stable screen-space grain cells turn the baked target density into actual
  // separated particles. Density controls occupancy rather than only colour,
  // so even a saturated nodal band retains visible gaps between grains.
  vec2 grainCoordinate = canonicalUv * uSandParticleGrid;
  uvec2 grainCell = uvec2(floor(grainCoordinate));
  vec2 grainLocal = fract(grainCoordinate) - 0.5;
  float occupancy = density <= 0.0
    ? 0.0
    : step(
        1.0 - clamp(density * 0.68, 0.0, 0.68),
        grainNoise(grainCell, 0x68bc21ebu)
      );
  float grainRadius =
    0.29 + grainNoise(grainCell, 0x02e5be93u) * 0.11;
  float particle = 1.0 - smoothstep(
    grainRadius,
    grainRadius + 0.06,
    length(grainLocal)
  );
  float grainCoverage = occupancy * particle;
  float contactShadow = 0.0;
  if (uPostEffects) {
    contactShadow = occupancy * (
      1.0 - smoothstep(
        grainRadius + 0.025,
        grainRadius + 0.09,
        length(grainLocal + vec2(-0.025, -0.03))
      )
    );
  }
  float sandMix = clamp(
    grainCoverage * uSandVisibility,
    0.0,
    ${SAND_MAX_OPACITY.toFixed(2)}
  );
  vec3 colour = mix(
    metal,
    sandShadow,
    contactShadow * uSandVisibility * 0.27
  );
  colour = mix(colour, sand, sandMix);

  vec3 regimeTint =
    uRegime > 2.5 ? vec3(1.0, 0.17, 0.12) :
    uRegime > 1.5 ? vec3(1.0, 0.39, 0.16) :
    uRegime > 0.5 ? vec3(0.95, 0.73, 0.29) :
                    vec3(0.25, 0.72, 0.74);
  colour += regimeTint * uEnvelope * 0.075 * (1.0 - radius);
  // Provenance: localEmissive(x) =
  // modalEnergyWeightedNodalMask(x) * localSaturationEnvelope.
  // Luminance is capped below the full-field delta budget and remains local
  // to the computed nodal basis; no full-screen flash is introduced.
  float localEmissive =
    clamp(nodalDensity, 0.0, 1.0) * uLocalSaturationEnvelope;
  colour +=
    vec3(1.0, 0.72, 0.34) *
    localEmissive *
    ${GENERATED_MOTION_SAFETY_SPEC.limits.maximumFullFieldLuminanceDelta.toFixed(3)};
  colour *= 0.66 + edge * 0.34;

  float rim = smoothstep(0.93, 1.0, radius);
  colour = mix(colour, vec3(0.07, 0.09, 0.09), rim * 0.78);
  outColor = vec4(colour, 1.0);
}`;

function assertExactKeys(
  value: object,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} is not the closed shader allowlist contract.`);
  }
}

export function verifyEmbeddedWebglShaderIntegrity(): Readonly<{
  programId: string;
  vertexSha256: string;
  fragmentSha256: string;
}> {
  assertExactKeys(
    WEBGL_SHADER_ALLOWLIST,
    [
      "schemaVersion",
      "digestAlgorithm",
      "loadingPolicy",
      "networkShaderFetchAllowed",
      "programs",
    ],
    "WebGL shader allowlist",
  );
  const programs = WEBGL_SHADER_ALLOWLIST.programs;
  if (
    WEBGL_SHADER_ALLOWLIST.schemaVersion !==
      "mandelhowl.webgl-shader-allowlist.v1" ||
    WEBGL_SHADER_ALLOWLIST.digestAlgorithm !== "sha256" ||
    WEBGL_SHADER_ALLOWLIST.loadingPolicy !== "embedded-only-no-network-fetch" ||
    WEBGL_SHADER_ALLOWLIST.networkShaderFetchAllowed !== false ||
    programs.length !== 1
  ) {
    throw new Error("WebGL shader allowlist policy is invalid.");
  }
  const program = programs[0];
  assertExactKeys(
    program,
    ["id", "compileConstants", "vertex", "fragment"],
    "WebGL shader program",
  );
  assertExactKeys(
    program.compileConstants,
    [
      "maximumTextureModesResident",
      "materialSectionProfileSampleCount",
      "sandMaximumOpacity",
      "maximumFullFieldLuminanceDelta",
    ],
    "WebGL shader compile constants",
  );
  assertExactKeys(
    program.vertex,
    ["stage", "sourceExport", "sha256"],
    "WebGL vertex shader",
  );
  assertExactKeys(
    program.fragment,
    ["stage", "sourceExport", "sha256"],
    "WebGL fragment shader",
  );
  const constants = program.compileConstants;
  if (
    program.id !== "mandelhowl-plate-main" ||
    constants.maximumTextureModesResident !== WEBGL_MODAL_CAPACITY ||
    constants.materialSectionProfileSampleCount !==
      MATERIAL_SECTION_PROFILE_SAMPLE_COUNT ||
    constants.sandMaximumOpacity !== SAND_MAX_OPACITY ||
    constants.maximumFullFieldLuminanceDelta !==
      GENERATED_MOTION_SAFETY_SPEC.limits.maximumFullFieldLuminanceDelta ||
    program.vertex.stage !== "vertex" ||
    program.vertex.sourceExport !== "VERTEX_SHADER" ||
    program.fragment.stage !== "fragment" ||
    program.fragment.sourceExport !== "FRAGMENT_SHADER"
  ) {
    throw new Error(
      "WebGL shader allowlist does not match the runtime compile contract.",
    );
  }
  const vertexSha256 = sha256Utf8Hex(VERTEX_SHADER);
  const fragmentSha256 = sha256Utf8Hex(FRAGMENT_SHADER);
  if (
    vertexSha256 !== program.vertex.sha256 ||
    fragmentSha256 !== program.fragment.sha256
  ) {
    throw new Error(
      "Embedded WebGL shader source is outside the SHA-256 allowlist.",
    );
  }
  return Object.freeze({
    programId: program.id,
    vertexSha256,
    fragmentSha256,
  });
}

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
  verifyEmbeddedWebglShaderIntegrity();
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!program) throw new Error("Unable to allocate a WebGL program.");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "unknown program error";
      throw new Error(log);
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function regimeNumber(regime: RuntimeSnapshot["regime"]): number {
  if (regime === "saturated") return 3;
  if (regime === "growing") return 2;
  if (regime === "critical") return 1;
  return 0;
}

export const WEBGL_APPARATUS_MESH_IDS = Object.freeze([
  "speaker-cone",
  "plate",
  "microphone",
  "feedback-cable",
] as const);

export interface WebglApparatusMotion {
  readonly speakerConeExcursionNormalized: number;
  readonly microphoneLevelNormalized: number;
  readonly feedbackLevelNormalized: number;
  readonly microphoneRingPhase: number;
  readonly cablePulseProgress: number;
  readonly cablePulseTravelling: boolean;
}

type MutableWebglApparatusMotion = {
  -readonly [Key in keyof WebglApparatusMotion]: WebglApparatusMotion[Key];
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function fractional(value: number): number {
  return value - Math.floor(value);
}

/**
 * Allocation-free presentation projection for the literal D0 WebGL meshes.
 * Every moving part is derived from the same canonical runtime snapshot; the
 * projection is read-only and cannot feed values back into the simulation.
 */
export class WebglApparatusMotionTracker {
  private readonly output: MutableWebglApparatusMotion = {
    speakerConeExcursionNormalized: 0,
    microphoneLevelNormalized: 0,
    feedbackLevelNormalized: 0,
    microphoneRingPhase: 0.5,
    cablePulseProgress: 0.5,
    cablePulseTravelling: false,
  };

  update(
    snapshot: RuntimeSnapshot,
    reducedMotion: boolean,
  ): WebglApparatusMotion {
    const minimumHz = Math.max(
      1e-6,
      GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
    );
    const maximumHz = Math.max(
      minimumHz,
      GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz,
    );
    const frequencyHz = Math.min(
      maximumHz,
      Math.max(minimumHz, snapshot.dial.driveFrequencyHz),
    );
    const frequencySpan = Math.log(maximumHz / minimumHz);
    const normalizedFrequency =
      frequencySpan > 0 ? Math.log(frequencyHz / minimumHz) / frequencySpan : 0;
    const feedbackLevel = clampUnit(snapshot.feedback.envelopeNormalized);
    const microphoneLevel = clampUnit(snapshot.microphone.rmsNormalized);
    const minimumCycleSeconds =
      1 / GENERATED_MOTION_SAFETY_SPEC.limits.maximumCablePulseHz;
    const driveCycleSeconds =
      minimumCycleSeconds + (1 - normalizedFrequency) * 0.42;
    const feedbackCycleSeconds = Math.max(
      minimumCycleSeconds,
      2.6 - feedbackLevel * 1.75,
    );
    const speakerTravel = 0.08 + feedbackLevel * 0.92;
    const motionScale = plateDisplacementScale(reducedMotion);
    this.output.speakerConeExcursionNormalized =
      Math.sin((snapshot.simulationTimeSeconds / driveCycleSeconds) * TAU) *
      speakerTravel *
      motionScale;
    this.output.microphoneLevelNormalized = microphoneLevel;
    this.output.feedbackLevelNormalized = feedbackLevel;
    this.output.microphoneRingPhase = reducedMotion
      ? 0.5
      : fractional(
          snapshot.simulationTimeSeconds /
            (minimumCycleSeconds + (1 - normalizedFrequency) * 0.58),
        );
    this.output.cablePulseTravelling =
      !reducedMotion &&
      (snapshot.regime === "growing" || snapshot.regime === "saturated") &&
      feedbackLevel > 0;
    this.output.cablePulseProgress = this.output.cablePulseTravelling
      ? fractional(snapshot.simulationTimeSeconds / feedbackCycleSeconds)
      : 0.5;
    return this.output;
  }
}

type ApparatusComponent = "speaker" | "plate" | "microphone";

function canonicalClipPosition(
  component: ApparatusComponent,
): readonly [number, number] {
  const positions = [
    GENERATED_SCENE_SPEC.apparatus.speaker.position,
    GENERATED_SCENE_SPEC.apparatus.plate.position,
    GENERATED_SCENE_SPEC.apparatus.microphone.position,
  ] as const;
  const source = GENERATED_SCENE_SPEC.apparatus[component].position;
  const minimumX = Math.min(...positions.map((position) => position[0]));
  const maximumX = Math.max(...positions.map((position) => position[0]));
  const minimumY = Math.min(...positions.map((position) => position[1]));
  const maximumY = Math.max(...positions.map((position) => position[1]));
  const horizontal =
    0.1 + ((source[0] - minimumX) / Math.max(1e-6, maximumX - minimumX)) * 0.8;
  const vertical =
    0.35 + ((source[1] - minimumY) / Math.max(1e-6, maximumY - minimumY)) * 0.3;
  return Object.freeze([horizontal * 2 - 1, 1 - vertical * 2]);
}

export const WEBGL_APPARATUS_LAYOUT = Object.freeze({
  speaker: canonicalClipPosition("speaker"),
  plate: canonicalClipPosition("plate"),
  microphone: canonicalClipPosition("microphone"),
});

export function feedbackCablePoint(
  progress: number,
): readonly [number, number] {
  const bounded = clampUnit(progress);
  // Canonical signal direction: microphone down, return cable right-to-left,
  // then up into the speaker exciter.
  if (bounded < 0.24) {
    return [0.8, 0.2 - (bounded / 0.24) * 0.86];
  }
  if (bounded < 0.82) {
    return [0.8 - ((bounded - 0.24) / 0.58) * 1.6, -0.66];
  }
  return [-0.8, -0.66 + ((bounded - 0.82) / 0.18) * 0.36];
}

export function createDiscVertices(
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

export function createQuadVertices(): Float32Array {
  return Float32Array.from([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
}

export class WebGlPlateRenderer implements PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly options: PlateRendererOptions;
  private readonly quality: RenderQualityTier;
  private readonly modalBlend = new ModalBlendTracker(WEBGL_MODAL_CAPACITY);
  private readonly apparatusMotion = new WebglApparatusMotionTracker();
  private frameTracker: RenderFrameTracker | null = null;
  private readonly sandLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private readonly displacementLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private readonly normalLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private readonly nodalLayers = new Float32Array(WEBGL_MODAL_CAPACITY);
  private readonly requestedModeIds: (string | null)[] = Array.from(
    { length: WEBGL_MODAL_CAPACITY + 1 },
    () => null,
  );
  private readonly availableModeIds: (string | null)[] = Array.from(
    { length: WEBGL_MODAL_CAPACITY },
    () => null,
  );
  private readonly readinessModeIds: (string | null)[] = Array.from(
    { length: WEBGL_MODAL_CAPACITY },
    () => null,
  );
  private readonly materialSectionProfile = new Float32Array(
    MATERIAL_SECTION_PROFILE_SAMPLE_COUNT,
  );
  private hasMaterialSectionProfile = false;
  private program: WebGLProgram | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private apparatusDiscBuffer: WebGLBuffer | null = null;
  private apparatusQuadBuffer: WebGLBuffer | null = null;
  private vertexCount = 0;
  private apparatusDiscVertexCount = 0;
  private positionLocation = -1;
  private uniformLocations = new Map<string, WebGLUniformLocation | null>();
  private textures = new Map<PlateTextureKind, WebGLTexture>();
  private readonly textureShardCache: TextureShardCache;
  private textureAtlases = new Map<
    PlateTextureKind,
    readonly PlateTextureAtlasSource[]
  >();
  private textureModeIds = new Map<PlateTextureKind, readonly string[]>();
  private textureResidencies = new Map<
    PlateTextureKind,
    TopKTextureLayerResidency
  >();
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
  private disposed = false;
  private textureSourceGeneration = 0;
  private grainSeed = renderSeedFromDatasetId(null);
  private loadingPolicy: PlateTextureSource["loadingPolicy"] = "eager-verified";
  private textureInstallFailed = false;
  private readonly statusTracker: PlateRendererStatusTracker;
  private degradationStage: RenderDegradationStage = 0;
  private maximumDisplacementNdc = 0;

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.updateStatus({ contextLost: true });
    reportPlateRendererDiagnostic(
      this.options,
      diagnostic("MH-RENDER-CONTEXT-LOST", "warning", "render.contextLost", [
        {
          key: "datasetId",
          value: this.status.datasetId,
          source: "webglcontextlost",
        },
      ]),
    );
  };

  private readonly handleContextRestored = () => {
    if (this.disposed) return;
    try {
      this.initializeGraphics();
      for (const [kind, atlases] of this.textureAtlases) {
        const first = atlases[0];
        if (first) this.allocateTexture(kind, first);
      }
      this.updateStatus({ contextLost: false });
    } catch (error) {
      reportPlateRendererDiagnostic(
        this.options,
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
    for (const mode of options.fallbackModes ?? []) {
      this.fallbackModeById.set(mode.modeId, mode);
    }
    this.quality = selectRenderQuality("webgl2", options.preferences, {
      logicalProcessors: options.logicalProcessors,
      deviceMemoryGb: options.deviceMemoryGb,
    });
    this.statusTracker = new PlateRendererStatusTracker({
      kind: "webgl2",
      quality: this.quality,
      degradationStage: 0,
      datasetId: null,
      textureReady: false,
      materialSectionReady: false,
      contextLost: false,
      framesRendered: 0,
      lastSnapshotSequence: null,
    });
    this.textureShardCache = new TextureShardCache({
      maximumShardsPerKind: WEBGL_MODAL_CAPACITY + 1,
      onLoaded: (kind) => {
        this.resetTextureResidency(kind);
        this.updateStatus({
          textureReady: this.currentTextureShardsReady(),
        });
      },
      onError: (kind, source, error) => {
        this.textureInstallFailed = true;
        reportPlateRendererDiagnostic(
          this.options,
          diagnostic(
            "MH-DATASET-INTEGRITY",
            "warning",
            "dataset.textureDecodeFailed",
            [
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
            ],
          ),
        );
        this.updateStatus({ textureReady: false });
      },
    });
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    this.canvas.dataset.webglApparatusMeshes =
      WEBGL_APPARATUS_MESH_IDS.join(",");
    this.canvas.dataset.webglApparatusMotion = "canonical-snapshot";
    this.canvas.dataset.webglCableDirection =
      GENERATED_SCENE_SPEC.apparatus.cable.direction;
    this.canvas.dataset.webglReducedMotion = options.preferences.reducedMotion
      ? "level-preserved-travel-disabled"
      : "snapshot-signal-travel";
    try {
      this.initializeGraphics();
    } catch (error) {
      // Construction may fail after listeners, shaders, or buffers have been
      // installed. Release every partial resource before the factory selects
      // the sibling Canvas2D fail-operational path.
      this.dispose();
      throw error;
    }
  }

  get status(): PlateRendererStatus {
    return this.statusTracker.view;
  }

  /** Internal Adaptive-renderer signal; never grants dataset authority. */
  get hasTextureInstallFailure(): boolean {
    return this.textureInstallFailed;
  }

  async setTextureSource(source: PlateTextureSource | null): Promise<void> {
    if (this.disposed) return;
    const sourceGeneration = ++this.textureSourceGeneration;
    this.textureInstallFailed = false;
    this.grainSeed = renderSeedFromDatasetId(source?.datasetId ?? null);
    this.verifiedFallbackModeById.clear();
    for (const mode of source?.presentationModes ?? []) {
      this.verifiedFallbackModeById.set(mode.modeId, mode);
    }
    const materialSectionProfile = normalizeMaterialSectionProfile(
      source?.materialSectionProfile,
    );
    this.materialSectionProfile.fill(0);
    this.hasMaterialSectionProfile = materialSectionProfile !== null;
    if (materialSectionProfile) {
      this.materialSectionProfile.set(materialSectionProfile);
    } else if (source?.materialSectionProfile !== undefined) {
      reportPlateRendererDiagnostic(
        this.options,
        diagnostic(
          "MH-DATASET-INTEGRITY",
          "warning",
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
    this.canvas.dataset.materialSection = this.hasMaterialSectionProfile
      ? "verified"
      : "unavailable";
    this.updateStatus({
      materialSectionReady: this.hasMaterialSectionProfile,
    });
    this.modalBlend.reset();
    this.loadingPolicy = source?.loadingPolicy ?? "eager-verified";
    this.requestedModeIds.fill(null);
    this.readinessModeIds.fill(null);
    this.textureAtlases.clear();
    this.textureModeIds.clear();
    this.deleteTextures();
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

    if (!source.atlases.some((atlas) => atlas.kind === "sand-density")) {
      reportPlateRendererDiagnostic(
        this.options,
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

    try {
      for (const kind of [
        "signed-displacement",
        "normal",
        "nodal-mask",
        "sand-density",
      ] as const) {
        const atlases = source.atlases.filter((atlas) => atlas.kind === kind);
        if (atlases.length === 0) continue;
        this.textureAtlases.set(kind, Object.freeze(atlases));
        this.textureModeIds.set(
          kind,
          Object.freeze(atlases.flatMap((atlas) => atlas.modeIds)),
        );
        this.allocateTexture(kind, atlases[0]!);
      }
      if (source.loadingPolicy !== "mode-sharded-lazy-verified") {
        for (const [kind, modeIds] of this.textureModeIds) {
          this.textureShardCache.request(kind, modeIds);
        }
        await this.textureShardCache.waitForIdle();
      }
      if (this.disposed || sourceGeneration !== this.textureSourceGeneration) {
        return;
      }
      this.updateStatus({
        datasetId: source.datasetId,
        textureReady: this.currentTextureShardsReady(),
      });
    } catch (error) {
      if (this.disposed || sourceGeneration !== this.textureSourceGeneration) {
        return;
      }
      this.deleteTextures();
      this.textureAtlases.clear();
      this.textureModeIds.clear();
      this.textureInstallFailed = true;
      reportPlateRendererDiagnostic(
        this.options,
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
      this.status.contextLost ||
      !this.program ||
      !this.positionBuffer
    ) {
      return;
    }

    const gl = this.gl;
    this.frameTracker ??= new RenderFrameTracker(snapshot);
    const frame = this.frameTracker.update(snapshot);
    const blend = this.modalBlend.update(snapshot);
    const apparatusMotion = this.apparatusMotion.update(
      snapshot,
      this.options.preferences.reducedMotion,
    );
    for (let slot = 0; slot < WEBGL_MODAL_CAPACITY; slot += 1) {
      const modeId = blend.modeIds[slot] ?? null;
      this.requestedModeIds[slot] = modeId;
      this.readinessModeIds[slot] = modeId;
    }
    const nearestModeId = nearestInBandTextureModeId(snapshot);
    this.requestedModeIds[WEBGL_MODAL_CAPACITY] = nearestModeId;
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
    for (const kind of this.textureAtlases.keys()) {
      this.textureShardCache.request(kind, this.requestedModeIds);
    }
    const textureReady = this.currentTextureShardsReady();
    if (textureReady !== this.status.textureReady) {
      this.updateStatus({ textureReady });
    }
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
    gl.uniform1f(
      this.uniform("uSandVisibility"),
      sandVisibilityFromPresence(blend.presence),
    );
    gl.uniform1fv(this.uniform("uSandWeights[0]"), blend.sandWeights);
    gl.uniform1fv(
      this.uniform("uDisplacementWeights[0]"),
      blend.displacementWeights,
    );
    // Capture identity is available before its energy can overtake a residual
    // mode, so it must own the immediate fallback presentation.
    const analyticalModeId =
      snapshot.activeModeId ?? frame.dominantModeId ?? nearestModeId;
    const verifiedAnalyticalGeometry = analyticalModeId
      ? this.verifiedFallbackModeById.get(analyticalModeId)
      : undefined;
    const legacyAnalyticalGeometry =
      !verifiedAnalyticalGeometry && analyticalModeId
        ? this.fallbackModeById.get(analyticalModeId)
        : undefined;
    const analyticalGeometry =
      verifiedAnalyticalGeometry ?? legacyAnalyticalGeometry;
    let analyticalDisplacementWeight = 0;
    let analyticalSandWeight = 0;
    if (analyticalModeId) {
      for (let slot = 0; slot < blend.count; slot += 1) {
        if (blend.modeIds[slot] !== analyticalModeId) continue;
        analyticalDisplacementWeight = blend.displacementWeights[slot] ?? 0;
        analyticalSandWeight = blend.sandWeights[slot] ?? 0;
        break;
      }
    }
    if (
      analyticalModeId === snapshot.activeModeId &&
      Math.abs(analyticalDisplacementWeight) <= 1e-6
    ) {
      const activeMode = snapshot.modes.find(
        (mode) => mode.modeId === analyticalModeId,
      );
      if (activeMode) {
        analyticalDisplacementWeight =
          Math.sqrt(ACTIVE_CAPTURE_FLOOR) * Math.cos(activeMode.phaseRad);
      }
    }
    analyticalDisplacementWeight = Math.max(
      -1,
      Math.min(1, analyticalDisplacementWeight),
    );
    analyticalSandWeight = Math.max(0, Math.min(1, analyticalSandWeight));
    const useAnalyticalDisplacement = Boolean(
      analyticalGeometry &&
      analyticalModeId &&
      !this.textureShardCache.isModeAvailable(
        "signed-displacement",
        analyticalModeId,
      ),
    );
    const useAnalyticalSand = Boolean(
      analyticalGeometry &&
      analyticalModeId &&
      !this.textureShardCache.isModeAvailable("sand-density", analyticalModeId),
    );
    gl.uniform1i(
      this.uniform("uHasAnalyticalShape"),
      analyticalGeometry ? 1 : 0,
    );
    gl.uniform1i(
      this.uniform("uUseAnalyticalDisplacement"),
      useAnalyticalDisplacement ? 1 : 0,
    );
    gl.uniform1i(this.uniform("uUseAnalyticalSand"), useAnalyticalSand ? 1 : 0);
    gl.uniform1f(this.uniform("uAnalyticalSandWeight"), analyticalSandWeight);
    gl.uniform1f(
      this.uniform("uAnalyticalKind"),
      verifiedAnalyticalGeometry ? 1 : legacyAnalyticalGeometry ? 2 : 0,
    );
    gl.uniform1f(
      this.uniform("uAnalyticalDisplacementWeight"),
      analyticalDisplacementWeight,
    );
    gl.uniform1f(
      this.uniform("uRadialOrder"),
      legacyAnalyticalGeometry?.radialOrder ?? 1,
    );
    gl.uniform1f(
      this.uniform("uRadialNodeIndex"),
      verifiedAnalyticalGeometry?.radialNodeIndex ?? 1,
    );
    gl.uniform1f(
      this.uniform("uRadialElementCount"),
      verifiedAnalyticalGeometry?.radialElementCount ?? 1,
    );
    gl.uniform1f(
      this.uniform("uRadialDof"),
      verifiedAnalyticalGeometry?.radialDof === "slope" ? 1 : 0,
    );
    gl.uniform1f(
      this.uniform("uHubRadiusRatio"),
      verifiedAnalyticalGeometry?.hubRadiusRatio ?? 0,
    );
    gl.uniform1f(
      this.uniform("uAngularOrder"),
      analyticalGeometry?.angularOrder ?? 0,
    );
    gl.uniform1f(
      this.uniform("uSymmetry"),
      verifiedAnalyticalGeometry?.symmetry === "cosine"
        ? 1
        : verifiedAnalyticalGeometry?.symmetry === "sine"
          ? 2
          : 0,
    );
    gl.uniform1f(this.uniform("uRegime"), regimeNumber(snapshot.regime));
    gl.uniform1f(
      this.uniform("uLocalSaturationEnvelope"),
      localSaturationEnvelope(snapshot.regime, frame.envelope),
    );
    gl.uniform1f(
      this.uniform("uMotion"),
      plateDisplacementScale(this.options.preferences.reducedMotion),
    );
    gl.uniform1f(
      this.uniform("uMaximumDisplacementNdc"),
      this.maximumDisplacementNdc,
    );
    gl.uniform1f(this.uniform("uPerspectiveSpread"), CAMERA_PERSPECTIVE_SPREAD);
    gl.uniform1f(
      this.uniform("uNormalLod"),
      this.degradationStage >= 2 ? 2 : 0,
    );
    gl.uniform1f(
      this.uniform("uNormalDetailStrength"),
      this.degradationStage >= 2 ? 0.72 : 1,
    );
    gl.uniform1i(
      this.uniform("uPostEffects"),
      this.degradationStage >= 3 ? 0 : 1,
    );
    gl.uniform1f(
      this.uniform("uSandParticleGrid"),
      Math.sqrt(renderQualityConfiguration(this.quality).sandParticleBudget),
    );
    gl.uniform1ui(this.uniform("uGrainSeed"), this.grainSeed);
    gl.uniform1i(
      this.uniform("uHasMaterialSection"),
      this.hasMaterialSectionProfile ? 1 : 0,
    );
    gl.uniform1fv(
      this.uniform("uMaterialSection[0]"),
      this.materialSectionProfile,
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

    const aspect = Math.max(
      0.25,
      this.canvas.width / Math.max(1, this.canvas.height),
    );
    this.drawApparatusMeshes(apparatusMotion, aspect);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.uniform("uRenderPass"), 0);
    gl.uniform1f(this.uniform("uPrimitiveKind"), 0);
    gl.uniform1f(this.uniform("uPrimitiveIntensity"), 1);
    gl.uniform1f(this.uniform("uApparatusMotion"), 0);
    gl.uniform2f(
      this.uniform("uSceneOffset"),
      WEBGL_APPARATUS_LAYOUT.plate[0],
      WEBGL_APPARATUS_LAYOUT.plate[1],
    );
    gl.uniform2f(this.uniform("uSceneScale"), 0.64 / aspect, 0.64);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    gl.disableVertexAttribArray(position);

    this.statusTracker.recordFrame(snapshot.sequence);
  }

  recordFrameTiming(): void {
    // The createPlateRenderer facade owns whole-frame pressure and applies
    // ordered degradation through setDegradationStage.
  }

  setDegradationStage(stage: RenderDegradationStage): void {
    const bounded = Math.min(5, Math.max(0, stage)) as RenderDegradationStage;
    if (bounded === this.degradationStage) return;
    this.degradationStage = bounded;
    this.modalBlend.setReleaseSeconds(bounded >= 1 ? 0.24 : 0.58);
    const quality: RenderQualityTier =
      bounded >= 4
        ? "reduced"
        : bounded >= 2 && this.quality === "high"
          ? "balanced"
          : this.quality;
    this.updateStatus({
      quality,
      degradationStage: bounded,
    });
    if (bounded >= 5) this.resize(true);
  }

  resize(force = false): void {
    const rect = this.canvas.getBoundingClientRect();
    this.maximumDisplacementNdc =
      (2 * GENERATED_MOTION_SAFETY_SPEC.limits.maximumPlateDisplacementPx) /
      Math.max(1, rect.width, rect.height);
    const dprLimit = renderQualityConfiguration(
      this.quality,
    ).maximumDevicePixelRatio;
    const pressureScale = this.degradationStage >= 5 ? 0.7 : 1;
    const dpr =
      Math.min(window.devicePixelRatio || 1, dprLimit) * pressureScale;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (
      !force &&
      this.canvas.width === width &&
      this.canvas.height === height
    ) {
      return;
    }
    this.canvas.width = width;
    this.canvas.height = height;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textureSourceGeneration += 1;
    this.textureShardCache.dispose();
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    this.deleteTextures();
    if (this.positionBuffer) this.gl.deleteBuffer(this.positionBuffer);
    if (this.apparatusDiscBuffer) {
      this.gl.deleteBuffer(this.apparatusDiscBuffer);
    }
    if (this.apparatusQuadBuffer) {
      this.gl.deleteBuffer(this.apparatusQuadBuffer);
    }
    if (this.program) this.gl.deleteProgram(this.program);
    this.positionBuffer = null;
    this.apparatusDiscBuffer = null;
    this.apparatusQuadBuffer = null;
    this.program = null;
    this.positionLocation = -1;
    this.vertexCount = 0;
    this.modalBlend.reset();
    this.frameTracker = null;
    this.uniformLocations.clear();
    this.textureAtlases.clear();
    this.textureModeIds.clear();
    this.verifiedFallbackModeById.clear();
    this.materialSectionProfile.fill(0);
    this.hasMaterialSectionProfile = false;
    this.canvas.dataset.materialSection = "unavailable";
    delete this.canvas.dataset.webglApparatusMeshes;
    delete this.canvas.dataset.webglApparatusMotion;
    delete this.canvas.dataset.webglCableDirection;
    delete this.canvas.dataset.webglReducedMotion;
    this.textureResidencies.clear();
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
    const quality = renderQualityConfiguration(this.quality);
    const radialSegments = quality.plateRadialSegments;
    const angularSegments = quality.plateAngularSegments;
    const vertices = createDiscVertices(radialSegments, angularSegments);
    this.vertexCount = vertices.length / 2;
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.apparatusDiscBuffer = gl.createBuffer();
    this.apparatusQuadBuffer = gl.createBuffer();
    if (!this.apparatusDiscBuffer || !this.apparatusQuadBuffer) {
      throw new Error("Unable to allocate the WebGL apparatus buffers.");
    }
    const apparatusDiscVertices = createDiscVertices(2, 32);
    this.apparatusDiscVertexCount = apparatusDiscVertices.length / 2;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.apparatusDiscBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, apparatusDiscVertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.apparatusQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, createQuadVertices(), gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private drawApparatusMeshes(
    motion: WebglApparatusMotion,
    aspect: number,
  ): void {
    const speaker = WEBGL_APPARATUS_LAYOUT.speaker;
    const microphone = WEBGL_APPARATUS_LAYOUT.microphone;

    // Cable body is three joined low-cost meshes in the canonical
    // microphone → feedback → speaker direction.
    this.drawApparatusPrimitive(
      "quad",
      4,
      0.8,
      -0.23,
      0.008 / aspect,
      0.43,
      0.96,
    );
    this.drawApparatusPrimitive("quad", 4, 0, -0.66, 0.8, 0.008, 0.96);
    this.drawApparatusPrimitive(
      "quad",
      4,
      -0.8,
      -0.48,
      0.008 / aspect,
      0.18,
      0.96,
    );

    if (
      motion.feedbackLevelNormalized > 0.001 &&
      (motion.cablePulseTravelling || this.options.preferences.reducedMotion)
    ) {
      const pulse = feedbackCablePoint(motion.cablePulseProgress);
      this.drawApparatusPrimitive(
        "disc",
        5,
        pulse[0],
        pulse[1],
        0.026 / aspect,
        0.026,
        0.35 + motion.feedbackLevelNormalized * 0.65,
      );
    }

    // The fixed speaker housing and cone are separate meshes so only the
    // physically meaningful cone receives canonical snapshot motion.
    this.drawApparatusPrimitive(
      "quad",
      1,
      speaker[0],
      speaker[1],
      0.225 / aspect,
      0.18,
      1,
    );
    this.drawApparatusPrimitive(
      "disc",
      2,
      speaker[0],
      speaker[1],
      0.12 / aspect,
      0.12,
      0.72 + motion.feedbackLevelNormalized * 0.28,
      motion.speakerConeExcursionNormalized * 0.055,
    );

    const ringCount = this.options.preferences.reducedMotion ? 1 : 3;
    for (let index = 0; index < ringCount; index += 1) {
      const phase = this.options.preferences.reducedMotion
        ? 0.5
        : fractional(motion.microphoneRingPhase + index / ringCount);
      const ringRadius = 0.07 + phase * 0.13;
      const ringIntensity =
        motion.microphoneLevelNormalized *
        (this.options.preferences.reducedMotion ? 0.6 : (1 - phase) * 0.72);
      if (ringIntensity <= 0.001) continue;
      this.drawApparatusPrimitive(
        "disc",
        6,
        microphone[0] - 0.025,
        microphone[1],
        ringRadius / aspect,
        ringRadius,
        ringIntensity,
      );
    }

    // Capsule, stem, and base are literal microphone geometry. They remain
    // static; measured pressure is carried only by the rings above.
    this.drawApparatusPrimitive(
      "quad",
      7,
      microphone[0] - 0.012,
      microphone[1] - 0.15,
      0.016 / aspect,
      0.15,
      1,
    );
    this.drawApparatusPrimitive(
      "quad",
      7,
      microphone[0] - 0.012,
      microphone[1] - 0.3,
      0.09 / aspect,
      0.018,
      1,
    );
    this.drawApparatusPrimitive(
      "disc",
      3,
      microphone[0] - 0.055,
      microphone[1] + 0.025,
      0.052 / aspect,
      0.13,
      1,
    );
  }

  private drawApparatusPrimitive(
    geometry: "disc" | "quad",
    primitiveKind: number,
    offsetX: number,
    offsetY: number,
    scaleX: number,
    scaleY: number,
    intensity: number,
    motion = 0,
  ): void {
    const gl = this.gl;
    const buffer =
      geometry === "disc" ? this.apparatusDiscBuffer : this.apparatusQuadBuffer;
    if (!buffer || this.positionLocation < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(this.uniform("uRenderPass"), 1);
    gl.uniform1f(this.uniform("uPrimitiveKind"), primitiveKind);
    gl.uniform1f(
      this.uniform("uPrimitiveIntensity"),
      Math.min(1, Math.max(0, intensity)),
    );
    gl.uniform1f(this.uniform("uApparatusMotion"), motion);
    gl.uniform2f(this.uniform("uSceneOffset"), offsetX, offsetY);
    gl.uniform2f(this.uniform("uSceneScale"), scaleX, scaleY);
    gl.drawArrays(
      gl.TRIANGLES,
      0,
      geometry === "disc" ? this.apparatusDiscVertexCount : 6,
    );
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
    const residency = this.textureResidencies.get(kind) ?? null;
    for (let slot = 0; slot < this.availableModeIds.length; slot += 1) {
      const modeId = selectedModeIds[slot] ?? null;
      this.availableModeIds[slot] =
        modeId && this.textureShardCache.isModeAvailable(kind, modeId)
          ? modeId
          : null;
    }
    const assignment = residency?.update(this.availableModeIds) ?? null;
    if (texture && residency && assignment?.changedCount) {
      this.uploadResidentLayers(kind, texture, assignment);
    }
    let hasSelectedLayer = false;
    for (let slot = 0; slot < targetLayers.length; slot += 1) {
      const layer = assignment?.selectedResidentLayers[slot] ?? -1;
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

  private allocateTexture(
    kind: PlateTextureKind,
    source: PlateTextureAtlasSource,
  ): void {
    const gl = this.gl;
    const maximumTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const maximumArrayLayers = Number(
      gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    );
    const modeIds = this.textureModeIds.get(kind) ?? [];
    const residentCapacity = Math.min(WEBGL_MODAL_CAPACITY, modeIds.length);
    if (
      source.width > maximumTextureSize ||
      source.height > maximumTextureSize ||
      residentCapacity < 1 ||
      residentCapacity > maximumArrayLayers
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
    const channels = expectedPlateTextureChannels(kind);
    const internalFormat = channels === 1 ? gl.R8 : gl.RG8;
    const format = channels === 1 ? gl.RED : gl.RG;
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      internalFormat,
      source.width,
      source.height,
      residentCapacity,
      0,
      format,
      gl.UNSIGNED_BYTE,
      null,
    );
    if (kind === "normal") {
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(
        gl.TEXTURE_2D_ARRAY,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR_MIPMAP_LINEAR,
      );
    } else {
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
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
    this.textureResidencies.set(
      kind,
      new TopKTextureLayerResidency(modeIds, residentCapacity),
    );
  }

  private resetTextureResidency(kind: PlateTextureKind): void {
    const modeIds = this.textureModeIds.get(kind) ?? [];
    if (!this.textures.has(kind) || modeIds.length === 0) return;
    this.textureResidencies.set(
      kind,
      new TopKTextureLayerResidency(
        modeIds,
        Math.min(WEBGL_MODAL_CAPACITY, modeIds.length),
      ),
    );
  }

  private currentTextureShardsReady(): boolean {
    if (this.textureAtlases.size === 0) return false;
    let requiredModeCount = 0;
    for (const modeId of this.readinessModeIds) {
      if (!modeId) continue;
      requiredModeCount += 1;
      for (const kind of this.textureAtlases.keys()) {
        if (!this.textureShardCache.isModeAvailable(kind, modeId)) {
          return false;
        }
      }
    }
    if (requiredModeCount > 0) {
      return this.textureAtlases.has("sand-density");
    }
    if (this.loadingPolicy === "mode-sharded-lazy-verified") {
      return false;
    }
    for (const kind of this.textureAtlases.keys()) {
      if (this.textureShardCache.cachedShardCount(kind) < 1) {
        return false;
      }
    }
    return this.textureAtlases.has("sand-density");
  }

  private uploadResidentLayers(
    kind: PlateTextureKind,
    texture: WebGLTexture,
    assignment: ReturnType<TopKTextureLayerResidency["update"]>,
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let changed = 0; changed < assignment.changedCount; changed += 1) {
      const residentSlot = assignment.changedResidentSlots[changed] ?? -1;
      const modeId = assignment.residentModeIds[residentSlot] ?? null;
      const shard = modeId ? this.textureShardCache.find(kind, modeId) : null;
      const sourceLayer =
        modeId && shard ? shard.source.modeIds.indexOf(modeId) : -1;
      if (residentSlot < 0 || sourceLayer < 0 || !shard) continue;
      const { decoded } = shard;
      const format =
        decoded.channels === 1
          ? gl.RED
          : decoded.channels === 2
            ? gl.RG
            : gl.RGBA;
      const bytesPerLayer = decoded.width * decoded.height * decoded.channels;
      const sourceOffset = sourceLayer * bytesPerLayer;
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        residentSlot,
        decoded.width,
        decoded.height,
        1,
        format,
        gl.UNSIGNED_BYTE,
        decoded.pixels.subarray(sourceOffset, sourceOffset + bytesPerLayer),
      );
    }
    if (kind === "normal") {
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const uploadError = gl.getError();
    if (uploadError !== gl.NO_ERROR) {
      throw new Error(
        `${kind} resident layer upload failed with WebGL error 0x${uploadError.toString(16)}.`,
      );
    }
  }

  private deleteTextures(): void {
    for (const texture of this.textures.values()) {
      this.gl.deleteTexture(texture);
    }
    this.textures.clear();
    this.textureResidencies.clear();
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
    const ownedStatus = this.statusTracker.update(patch);
    if (notify) reportPlateRendererStatus(this.options, ownedStatus);
  }
}
