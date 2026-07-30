import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const WEBGL_SHADER_ALLOWLIST_PATH =
  "specs/visual/webgl-shader-allowlist.v1.json";
export const WEBGL_SHADER_IMPLEMENTATION_PATH =
  "packages/render-engine/src/webgl-plate-renderer.ts";
export const WEBGL_SHADER_RUNTIME_HASHER_PATH =
  "packages/render-engine/src/shader-integrity.ts";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields are not the closed contract`);
  }
}

function readRegularFile(projectRoot, relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const metadata = lstatSync(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `WebGL shader integrity input is not a regular file: ${relativePath}`,
    );
  }
  return readFileSync(absolutePath);
}

function extractTemplate(source, name) {
  const pattern = new RegExp(
    "(?:export\\s+)?const\\s+" +
      name +
      "\\s*=\\s*`([\\s\\S]*?)`;",
    "gu",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `WebGL shader implementation must define exactly one ${name} template`,
    );
  }
  return matches[0][1];
}

function compileEmbeddedShader(source, name, constants) {
  const replacements = new Map([
    [
      "SIGNED_R8_DECODE_GLSL",
      extractTemplate(source, "SIGNED_R8_DECODE_GLSL"),
    ],
    [
      "ANALYTICAL_BASIS_GLSL",
      extractTemplate(source, "ANALYTICAL_BASIS_GLSL"),
    ],
    [
      "WEBGL_MODAL_CAPACITY",
      String(constants.maximumTextureModesResident),
    ],
    [
      "MATERIAL_SECTION_PROFILE_SAMPLE_COUNT",
      String(constants.materialSectionProfileSampleCount),
    ],
    [
      "MATERIAL_SECTION_PROFILE_SAMPLE_COUNT - 1",
      String(constants.materialSectionProfileSampleCount - 1),
    ],
    [
      "SAND_MAX_OPACITY.toFixed(2)",
      constants.sandMaximumOpacity.toFixed(2),
    ],
    [
      "GENERATED_MOTION_SAFETY_SPEC.limits.maximumFullFieldLuminanceDelta.toFixed(3)",
      constants.maximumFullFieldLuminanceDelta.toFixed(3),
    ],
  ]);
  const compiled = extractTemplate(source, name).replace(
    /\$\{([^}]+)\}/gu,
    (_match, expression) => {
      const key = expression.trim();
      if (!replacements.has(key)) {
        throw new Error(
          `WebGL shader template uses an unapproved interpolation: ${key}`,
        );
      }
      return replacements.get(key);
    },
  );
  if (compiled.includes("${")) {
    throw new Error("WebGL shader template contains unresolved source");
  }
  return compiled;
}

export function verifyWebglShaderIntegrity(projectRoot) {
  const specBytes = readRegularFile(
    projectRoot,
    WEBGL_SHADER_ALLOWLIST_PATH,
  );
  const implementationBytes = readRegularFile(
    projectRoot,
    WEBGL_SHADER_IMPLEMENTATION_PATH,
  );
  const runtimeHasherBytes = readRegularFile(
    projectRoot,
    WEBGL_SHADER_RUNTIME_HASHER_PATH,
  );
  const spec = JSON.parse(specBytes.toString("utf8"));
  assertExactKeys(
    spec,
    [
      "schemaVersion",
      "digestAlgorithm",
      "loadingPolicy",
      "networkShaderFetchAllowed",
      "programs",
    ],
    "WebGL shader allowlist",
  );
  if (
    spec.schemaVersion !==
      "mandelhowl.webgl-shader-allowlist.v1" ||
    spec.digestAlgorithm !== "sha256" ||
    spec.loadingPolicy !== "embedded-only-no-network-fetch" ||
    spec.networkShaderFetchAllowed !== false ||
    !Array.isArray(spec.programs) ||
    spec.programs.length !== 1
  ) {
    throw new Error("WebGL shader allowlist policy is invalid");
  }
  const program = spec.programs[0];
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
  for (const [stage, sourceExport] of [
    ["vertex", "VERTEX_SHADER"],
    ["fragment", "FRAGMENT_SHADER"],
  ]) {
    assertExactKeys(
      program[stage],
      ["stage", "sourceExport", "sha256"],
      `WebGL ${stage} shader`,
    );
    if (
      program[stage].stage !== stage ||
      program[stage].sourceExport !== sourceExport ||
      !/^[a-f0-9]{64}$/u.test(program[stage].sha256 ?? "")
    ) {
      throw new Error(`WebGL ${stage} shader allowlist entry is invalid`);
    }
  }
  if (
    program.id !== "mandelhowl-plate-main" ||
    program.compileConstants.maximumTextureModesResident !== 4 ||
    program.compileConstants.materialSectionProfileSampleCount !== 64 ||
    program.compileConstants.sandMaximumOpacity !== 0.95 ||
    program.compileConstants.maximumFullFieldLuminanceDelta !== 0.18
  ) {
    throw new Error("WebGL shader compile constants are not canonical");
  }

  const implementation = implementationBytes.toString("utf8");
  const vertex = compileEmbeddedShader(
    implementation,
    "VERTEX_SHADER",
    program.compileConstants,
  );
  const fragment = compileEmbeddedShader(
    implementation,
    "FRAGMENT_SHADER",
    program.compileConstants,
  );
  const vertexSha256 = sha256(Buffer.from(vertex, "utf8"));
  const fragmentSha256 = sha256(Buffer.from(fragment, "utf8"));
  if (
    vertexSha256 !== program.vertex.sha256 ||
    fragmentSha256 !== program.fragment.sha256
  ) {
    throw new Error(
      "Embedded WebGL shader source is outside the canonical allowlist",
    );
  }
  for (const requiredRuntimeFragment of [
    'import WEBGL_SHADER_ALLOWLIST from "../../../specs/visual/webgl-shader-allowlist.v1.json";',
    "sha256Utf8Hex(VERTEX_SHADER)",
    "sha256Utf8Hex(FRAGMENT_SHADER)",
    "verifyEmbeddedWebglShaderIntegrity();",
    "gl.shaderSource(shader, source);",
  ]) {
    if (!implementation.includes(requiredRuntimeFragment)) {
      throw new Error(
        `WebGL shader runtime integrity gate is missing: ${requiredRuntimeFragment}`,
      );
    }
  }

  return Object.freeze({
    schemaVersion: "mandelhowl.release-webgl-shader-integrity.v1",
    allowlistPath: WEBGL_SHADER_ALLOWLIST_PATH,
    allowlistSha256: sha256(specBytes),
    implementationPath: WEBGL_SHADER_IMPLEMENTATION_PATH,
    implementationSha256: sha256(implementationBytes),
    runtimeHasherPath: WEBGL_SHADER_RUNTIME_HASHER_PATH,
    runtimeHasherSha256: sha256(runtimeHasherBytes),
    loadingPolicy: spec.loadingPolicy,
    networkShaderFetchAllowed: spec.networkShaderFetchAllowed,
    program: Object.freeze({
      id: program.id,
      vertexSha256,
      fragmentSha256,
    }),
  });
}
