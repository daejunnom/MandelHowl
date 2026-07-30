import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const BAKER_SOURCE_ROOTS = Object.freeze([
  "specs/acceptance",
  "specs/physics",
  "specs/plate",
  "specs/runtime",
  "specs/visual",
  "packages/contracts/schemas",
  "packages/contracts/src",
  "packages/asset-runtime/src",
  "packages/resonance-engine/src",
  "packages/render-engine/src",
  "tests/runtime",
  "tools/baker-supervisor",
  "tools/container-baker-runner",
  "tools/handoff-verifier",
  "tools/physics-baker",
  "tools/physics-baker-rs",
  "tools/reachability-generator",
  "tools/release-packager",
  ".dockerignore",
  "package.json",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".github/workflows",
]);

export const BAKER_SOURCE_EXCLUDED_PATHS = Object.freeze([
  "specs/runtime/dataset-release.v1.yaml",
  "packages/contracts/src/generated/dataset-release.generated.ts",
]);

export const BAKER_REQUIRED_PATHS = Object.freeze([
  "specs/acceptance/handoff-verification.v1.json",
  "specs/physics/baker-algorithm.v1.json",
  "specs/physics/baker-nversion.v1.json",
  "specs/plate/mandelbrot-plate.v1.yaml",
  "specs/runtime/dial.v1.yaml",
  "specs/runtime/feedback.v1.yaml",
  "specs/runtime/volume-map.v1.yaml",
  "specs/runtime/audio-safety.v1.yaml",
  "specs/runtime/ui-nversion.v1.json",
  "specs/visual/webgl-shader-allowlist.v1.json",
  "packages/contracts/schemas/coverage-report.schema.json",
  "packages/contracts/schemas/plate-spec.schema.json",
  "packages/contracts/schemas/resonance-manifest.schema.json",
  "packages/contracts/src/resonance-trajectory.ts",
  "packages/asset-runtime/src/binary-decoders.ts",
  "packages/resonance-engine/src/resonance-engine.ts",
  "packages/render-engine/src/shader-integrity.ts",
  "packages/render-engine/src/webgl-plate-renderer.ts",
  "tests/runtime/generate-reachability-report.ts",
  "tests/runtime/fixtures/reachability-report.json",
  ".dockerignore",
  "tools/baker-supervisor/src/supervisor.mjs",
  "tools/container-baker-runner/Dockerfile",
  "tools/container-baker-runner/src/attestation-envelope.mjs",
  "tools/container-baker-runner/src/runner.mjs",
  "tools/handoff-verifier/src/check-handoff-coverage.mjs",
  "tools/handoff-verifier/src/full-verification-plan.mjs",
  "tools/handoff-verifier/src/run-full-verification.mjs",
  "tools/handoff-verifier/src/verification-core.mjs",
  "tools/handoff-verifier/test/webgl-shader-integrity.test.mjs",
  "tools/physics-baker/bake.py",
  "tools/physics-baker-rs/Cargo.toml",
  "tools/physics-baker-rs/src/lib.rs",
  "tools/reachability-generator/src/trajectory-coverage.ts",
  "tools/release-packager/src/build-provenance.mjs",
  "tools/release-packager/src/pinned-attestation.mjs",
  "tools/release-packager/src/verify-forbidden-runtime.mjs",
  "tools/release-packager/src/verify-release.mjs",
  "tools/release-packager/src/webgl-shader-integrity.mjs",
  "package.json",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".github/workflows/verify.yml",
]);

const SENSITIVE_SOURCE_DIRECTORY_NAMES = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
]);
const SENSITIVE_SOURCE_FILE_PATTERN =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|.*service[-_]account.*\.json|credential.*\.json|.*credentials.*\.json|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*api[-_]key.*)$/i;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSensitiveBakerSourcePath(candidate) {
  const segments = candidate
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  return segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return (
      SENSITIVE_SOURCE_DIRECTORY_NAMES.has(normalized) ||
      SENSITIVE_SOURCE_FILE_PATTERN.test(segment)
    );
  });
}

function assertSafeBakerSourcePath(candidate) {
  if (!isSensitiveBakerSourcePath(candidate)) return;
  const error = new Error(
    "Baker source inventory contains a forbidden sensitive path",
  );
  error.code = "MH_BAKER_SOURCE_SENSITIVE_PATH";
  throw error;
}

export function digestBakerSourceInventory(files) {
  const normalized = files
    .map((file) => ({
      path: file.path.replaceAll("\\", "/"),
      sha256: file.sha256,
    }))
    .filter((file) => !BAKER_SOURCE_EXCLUDED_PATHS.includes(file.path))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  for (const file of normalized) {
    assertSafeBakerSourcePath(file.path);
  }
  const canonicalInventory = normalized
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join("");
  return Object.freeze({
    sourceTreeSha256: sha256(Buffer.from(canonicalInventory, "utf8")),
    sourceTreeFileCount: normalized.length,
  });
}

export function collectBakerSourceInventory(projectRoot) {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...BAKER_SOURCE_ROOTS,
    ],
    { cwd: projectRoot },
  );
  const candidates = output.toString("utf8").split("\0").filter(Boolean);
  const files = [];
  for (const candidate of new Set(candidates)) {
    const normalizedPath = candidate.replaceAll("\\", "/");
    if (BAKER_SOURCE_EXCLUDED_PATHS.includes(normalizedPath)) continue;
    assertSafeBakerSourcePath(normalizedPath);
    const absolutePath = path.join(projectRoot, normalizedPath);
    let metadata;
    try {
      metadata = lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `Baker N-version source must be a regular file: ${normalizedPath}`,
      );
    }
    files.push({
      path: normalizedPath,
      sha256: sha256(readFileSync(absolutePath)),
    });
  }
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const requiredPath of BAKER_REQUIRED_PATHS) {
    if (!files.some((file) => file.path === requiredPath)) {
      throw new Error(
        `Required Baker N-version source is missing: ${requiredPath}`,
      );
    }
  }
  const digest = digestBakerSourceInventory(files);
  return Object.freeze({
    schemaVersion: "mandelhowl.baker-source-tree.v1",
    digestAlgorithm: "sha256(path-nul-content-sha256-lf:v1)",
    roots: BAKER_SOURCE_ROOTS,
    excludedPaths: BAKER_SOURCE_EXCLUDED_PATHS,
    sha256: digest.sourceTreeSha256,
    fileCount: digest.sourceTreeFileCount,
    files: Object.freeze(
      files.map((file) => Object.freeze({ ...file })),
    ),
  });
}

export function collectBakerSourceTree(projectRoot) {
  const inventory = collectBakerSourceInventory(projectRoot);
  return Object.freeze({
    schemaVersion: inventory.schemaVersion,
    digestAlgorithm: inventory.digestAlgorithm,
    roots: inventory.roots,
    excludedPaths: inventory.excludedPaths,
    sourceTreeSha256: inventory.sha256,
    sourceTreeFileCount: inventory.fileCount,
  });
}
