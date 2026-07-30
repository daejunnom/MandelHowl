import path from "node:path";

function requireAbsoluteExecutable(value, {
  label,
  platform,
}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !pathApi.isAbsolute(value)
  ) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return value;
}

export function resolveStageInvocation({
  stage,
  platform,
  nodeExecutable,
  npmExecPath,
}) {
  if (
    stage === null ||
    typeof stage !== "object" ||
    typeof stage.command !== "string" ||
    !Array.isArray(stage.arguments)
  ) {
    throw new Error("Verification stage invocation is invalid.");
  }
  if (platform !== "win32") {
    return Object.freeze({
      command: stage.command,
      arguments: Object.freeze([...stage.arguments]),
      executionKind: "direct",
    });
  }
  if (stage.command !== "npm.cmd") {
    throw new Error(
      `Windows verification stage ${stage.id ?? "<unknown>"} must be an npm.cmd plan stage.`,
    );
  }
  const trustedNodeExecutable = requireAbsoluteExecutable(
    nodeExecutable,
    {
      label: "Windows Node executable",
      platform,
    },
  );
  const trustedNpmExecPath = requireAbsoluteExecutable(npmExecPath, {
    label: "Windows npm CLI",
    platform,
  });
  if (
    path.win32.basename(trustedNpmExecPath).toLowerCase() !==
    "npm-cli.js"
  ) {
    throw new Error(
      "Windows npm CLI must resolve to the npm-cli.js entrypoint.",
    );
  }
  return Object.freeze({
    command: trustedNodeExecutable,
    arguments: Object.freeze([
      trustedNpmExecPath,
      ...stage.arguments,
    ]),
    executionKind: "node-npm-cli-no-cmd-wrapper",
  });
}
