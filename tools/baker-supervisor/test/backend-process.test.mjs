import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyProcessResult,
  installedNativeBinaryPath,
  runPythonBackend,
  runRustBackend,
} from "../src/backend-process.mjs";

test("default native path is a stable installed artifact, never Cargo target", () => {
  const selected = installedNativeBinaryPath({
    projectRoot: path.resolve("C:/workspace"),
    env: {},
    platform: "win32",
    arch: "x64",
  });
  assert.match(
    selected.replaceAll("\\", "/"),
    /tools\/physics-baker-rs\/bin\/win32-x64\/mandelhowl-baker-native\.exe$/,
  );
  assert.doesNotMatch(selected.replaceAll("\\", "/"), /\/target\//);
});

test("Application Control 4551 is a structured availability failure", () => {
  const classified = classifyProcessResult({
    backend: "rust-native",
    executable: "native.exe",
    result: {
      status: null,
      signal: null,
      stdout: "",
      stderr: "An Application Control policy has blocked this file (os error 4551)",
      error: new Error("spawn failed"),
    },
  });
  assert.equal(classified.status, "blocked");
  assert.equal(classified.availabilityFailure, true);
  assert.equal(classified.code, "MH_BAKER_APPLICATION_CONTROL_4551");
});

test("exit code 2 remains a scientific rejection", () => {
  const classified = classifyProcessResult({
    backend: "rust-native",
    executable: "native.exe",
    result: {
      status: 2,
      signal: null,
      stdout: "",
      stderr: '{"code":"MH_NATIVE_SOLVER_FAILED"}',
      error: undefined,
    },
  });
  assert.equal(classified.status, "rejected");
  assert.equal(classified.availabilityFailure, false);
  assert.equal(classified.scientificFailure, true);
});

test("structured missing-input exit 2 is not a scientific rejection", () => {
  const classified = classifyProcessResult({
    backend: "rust-native",
    executable: "native.exe",
    result: {
      status: 2,
      signal: null,
      stdout: "",
      stderr: JSON.stringify({ code: "MH_NATIVE_INPUT_MISSING" }),
      error: undefined,
    },
  });
  assert.equal(classified.status, "input-error");
  assert.equal(classified.scientificFailure, false);
  assert.equal(classified.diagnosticCode, "MH_NATIVE_INPUT_MISSING");
});

test("managed native override must be absolute", () => {
  assert.throws(
    () =>
      installedNativeBinaryPath({
        projectRoot: path.resolve("C:/workspace"),
        env: {
          CI: "true",
          MANDELHOWL_NATIVE_BAKER: "target/release/native.exe",
        },
        platform: "win32",
        arch: "x64",
      }),
    /absolute file path/,
  );
});

test("directory native override is rejected without spawning", () => {
  const result = runRustBackend({
    projectRoot: process.cwd(),
    args: ["self-test"],
    timeoutMs: 1_000,
    env: {
      ...process.env,
      MANDELHOWL_MANAGED_INSTALL: "1",
      MANDELHOWL_NATIVE_BAKER: process.cwd(),
    },
  });
  assert.equal(result.status, "invalid-artifact");
  assert.equal(result.code, "MH_BAKER_NATIVE_ARTIFACT_NOT_FILE");
});

test("managed native artifacts require an approved SHA-256 sidecar", () => {
  const temporary = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-native-sidecar-"),
  );
  const executable = path.join(temporary, "native-artifact");
  try {
    writeFileSync(executable, "not executed");
    const result = runRustBackend({
      projectRoot: process.cwd(),
      args: ["self-test"],
      timeoutMs: 1_000,
      env: {
        ...process.env,
        CI: "false",
        MANDELHOWL_MANAGED_INSTALL: "1",
        MANDELHOWL_NATIVE_BAKER: executable,
      },
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.code, "MH_BAKER_NATIVE_ATTESTATION_MISSING");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Python protocol binds interpreter identity without an extra probe", () => {
  const result = runPythonBackend({
    projectRoot: process.cwd(),
    args: ["self-test"],
    timeoutMs: 10_000,
    env: process.env,
  });
  assert.equal(result.status, "success");
  assert.equal(result.output.backend, "python-stdlib");
  assert.match(result.interpreterIdentity.version, /^\d+\.\d+\.\d+/);
  assert.ok(path.isAbsolute(result.interpreterIdentity.executable));
  assert.match(
    result.interpreterIdentity.executableSha256,
    /^[a-f0-9]{64}$/,
  );
});

test("native reports preserve matching pre-run and post-run digests", () => {
  const result = runRustBackend({
    projectRoot: process.cwd(),
    args: ["--version"],
    timeoutMs: 10_000,
    env: {
      ...process.env,
      CI: "true",
      MANDELHOWL_NATIVE_BAKER: process.execPath,
    },
  });
  assert.equal(result.status, "protocol-error");
  assert.match(result.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    result.preRunExecutableSha256,
    result.executableSha256,
  );
  assert.equal(
    result.postRunExecutableSha256,
    result.executableSha256,
  );
});
