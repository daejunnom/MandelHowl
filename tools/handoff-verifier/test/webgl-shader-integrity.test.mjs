import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  verifyWebglShaderIntegrity,
  WEBGL_SHADER_ALLOWLIST_PATH,
  WEBGL_SHADER_IMPLEMENTATION_PATH,
  WEBGL_SHADER_RUNTIME_HASHER_PATH,
} from "../../release-packager/src/webgl-shader-integrity.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function shaderIntegrityFixture() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "mandelhowl-shader-integrity-"),
  );
  for (const relativePath of [
    WEBGL_SHADER_ALLOWLIST_PATH,
    WEBGL_SHADER_IMPLEMENTATION_PATH,
    WEBGL_SHADER_RUNTIME_HASHER_PATH,
  ]) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      readFileSync(path.join(projectRoot, relativePath)),
    );
  }
  return root;
}

test("release binds the exact embedded WebGL shader allowlist", () => {
  const verified = verifyWebglShaderIntegrity(projectRoot);
  assert.equal(
    verified.schemaVersion,
    "mandelhowl.release-webgl-shader-integrity.v1",
  );
  assert.equal(verified.loadingPolicy, "embedded-only-no-network-fetch");
  assert.equal(verified.networkShaderFetchAllowed, false);
  assert.match(verified.program.vertexSha256, /^[a-f0-9]{64}$/u);
  assert.match(verified.program.fragmentSha256, /^[a-f0-9]{64}$/u);
});

test("release shader integrity rejects source and network-policy mutations", () => {
  const fixtureRoot = shaderIntegrityFixture();
  try {
    const implementationPath = path.join(
      fixtureRoot,
      WEBGL_SHADER_IMPLEMENTATION_PATH,
    );
    const implementation = readFileSync(implementationPath, "utf8");
    const mutatedImplementation = implementation.replace(
      "precision highp float;",
      "precision mediump float;",
    );
    assert.notEqual(mutatedImplementation, implementation);
    writeFileSync(implementationPath, mutatedImplementation, "utf8");
    assert.throws(
      () => verifyWebglShaderIntegrity(fixtureRoot),
      /outside the canonical allowlist/u,
    );

    writeFileSync(implementationPath, implementation, "utf8");
    const allowlistPath = path.join(
      fixtureRoot,
      WEBGL_SHADER_ALLOWLIST_PATH,
    );
    const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
    allowlist.networkShaderFetchAllowed = true;
    writeFileSync(
      allowlistPath,
      `${JSON.stringify(allowlist, null, 2)}\n`,
      "utf8",
    );
    assert.throws(
      () => verifyWebglShaderIntegrity(fixtureRoot),
      /allowlist policy is invalid/u,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
