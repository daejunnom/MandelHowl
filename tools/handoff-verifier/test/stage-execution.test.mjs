import assert from "node:assert/strict";
import test from "node:test";

import { resolveStageInvocation } from "../src/stage-execution.mjs";

const windowsStage = Object.freeze({
  id: "implementation-unit",
  script: "test:unit",
  command: "npm.cmd",
  arguments: Object.freeze(["run", "test:unit"]),
});

test("Windows stages use Node plus npm-cli without a CMD wrapper", () => {
  const invocation = resolveStageInvocation({
    stage: windowsStage,
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    npmExecPath:
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  });

  assert.deepEqual(invocation, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    arguments: [
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "run",
      "test:unit",
    ],
    executionKind: "node-npm-cli-no-cmd-wrapper",
  });
  assert.equal(invocation.arguments.includes("cmd.exe"), false);
});

test("Windows stage execution rejects ambient or alternate CLI paths", () => {
  assert.throws(
    () =>
      resolveStageInvocation({
        stage: windowsStage,
        platform: "win32",
        nodeExecutable: "node.exe",
        npmExecPath: "npm-cli.js",
      }),
    /absolute path/u,
  );
  assert.throws(
    () =>
      resolveStageInvocation({
        stage: windowsStage,
        platform: "win32",
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath: "C:\\tools\\alternate-cli.js",
      }),
    /npm-cli\.js entrypoint/u,
  );
});

test("non-Windows stages preserve their direct executable contract", () => {
  assert.deepEqual(
    resolveStageInvocation({
      stage: {
        ...windowsStage,
        command: "npm",
      },
      platform: "linux",
      nodeExecutable: null,
      npmExecPath: null,
    }),
    {
      command: "npm",
      arguments: ["run", "test:unit"],
      executionKind: "direct",
    },
  );
});
