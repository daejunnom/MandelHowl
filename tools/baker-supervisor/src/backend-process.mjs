import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const APPLICATION_CONTROL_PATTERN =
  /os error 4551|application control policy|app control policy|애플리케이션 제어 정책|응용 프로그램 제어 정책/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const EXPECTED_PROTOCOLS = {
  "rust-native": {
    contract: "mandelhowl.native-baker-capabilities.v1",
    "self-test": "mandelhowl.native-self-test.v1",
    generate: "mandelhowl.native-generation-result.v1",
    validate: "mandelhowl.native-semantic-report.v1",
    "semantic-digest": "mandelhowl.native-semantic-report.v1",
  },
  "python-stdlib": {
    contract: "mandelhowl.python-baker-capabilities.v1",
    "self-test": "mandelhowl.python-self-test.v1",
    generate: "mandelhowl.python-generation-result.v1",
    validate: "mandelhowl.python-semantic-report.v1",
  },
};

export function installedNativeBinaryPath({
  projectRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
}) {
  const explicit = env.MANDELHOWL_NATIVE_BAKER;
  if (explicit) {
    if (env.CI !== "true" && env.MANDELHOWL_MANAGED_INSTALL !== "1") {
      const error = new Error(
        "MANDELHOWL_NATIVE_BAKER is reserved for managed CI/installer injection",
      );
      error.code = "MH_BAKER_UNMANAGED_NATIVE_OVERRIDE";
      throw error;
    }
    if (!path.isAbsolute(explicit)) {
      const error = new Error(
        "managed MANDELHOWL_NATIVE_BAKER injection must be an absolute file path",
      );
      error.code = "MH_BAKER_NATIVE_PATH_NOT_ABSOLUTE";
      throw error;
    }
    return path.normalize(explicit);
  }
  const executable =
    platform === "win32"
      ? "mandelhowl-baker-native.exe"
      : "mandelhowl-baker-native";
  return path.join(
    projectRoot,
    "tools",
    "physics-baker-rs",
    "bin",
    `${platform}-${arch}`,
    executable,
  );
}

function parseDiagnostic(stderr) {
  const source = stderr.trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    for (const line of source.split(/\r?\n/).toReversed()) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue looking for the final structured diagnostic line.
      }
    }
  }
  return null;
}

export function classifyProcessResult({
  backend,
  executable,
  result,
  durationMs = 0,
}) {
  const stdout = result.stdout?.toString?.() ?? "";
  const stderr = result.stderr?.toString?.() ?? "";
  const errorText = [result.error?.message ?? "", stdout, stderr].join("\n");
  const diagnostic = parseDiagnostic(stderr);
  const common = {
    backend,
    executable,
    durationMs: Math.round(durationMs),
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    stdout,
    stderr,
  };
  if (
    result.error?.code === "ETIMEDOUT" ||
    result.signal === "SIGTERM" ||
    result.signal === "SIGKILL"
  ) {
    return {
      ...common,
      status: "timeout",
      availabilityFailure: true,
      code: "MH_BAKER_TIMEOUT",
      scientificFailure: false,
    };
  }
  if (APPLICATION_CONTROL_PATTERN.test(errorText)) {
    return {
      ...common,
      status: "blocked",
      availabilityFailure: true,
      code: "MH_BAKER_APPLICATION_CONTROL_4551",
      scientificFailure: false,
    };
  }
  if (result.error?.code === "ENOENT") {
    return {
      ...common,
      status: "missing",
      availabilityFailure: true,
      code: "MH_BAKER_EXECUTABLE_MISSING",
      scientificFailure: false,
    };
  }
  if (result.error) {
    return {
      ...common,
      status: "unavailable",
      availabilityFailure: true,
      code: "MH_BAKER_SPAWN_FAILED",
      error: result.error.message,
      scientificFailure: false,
    };
  }
  if (result.status === 0) {
    return {
      ...common,
      status: "success",
      availabilityFailure: false,
      code: "MH_BAKER_OK",
      scientificFailure: false,
    };
  }
  if (result.status === 2) {
    const diagnosticCode =
      typeof diagnostic?.code === "string" ? diagnostic.code : null;
    const inputFailure = new Set([
      "MH_NATIVE_USAGE_INVALID",
      "MH_NATIVE_INPUT_MISSING",
      "PHYSICS_INPUT_MISSING",
      "PHYSICS_IO_FAILED",
      "PHYSICS_SCHEMA_INVALID",
    ]).has(diagnosticCode);
    return {
      ...common,
      status: inputFailure ? "input-error" : "rejected",
      availabilityFailure: false,
      scientificFailure: !inputFailure,
      code: inputFailure
        ? "MH_BAKER_INPUT_REJECTED"
        : "MH_BAKER_SCIENTIFIC_REJECTION",
      diagnosticCode,
    };
  }
  return {
    ...common,
    status: "crashed",
    availabilityFailure: false,
    code: "MH_BAKER_PROCESS_CRASHED",
    scientificFailure: false,
  };
}

export function runBackendProcess({
  backend,
  executable,
  args,
  projectRoot,
  timeoutMs,
  env = process.env,
}) {
  const started = performance.now();
  const result = spawnSync(executable, args, {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return classifyProcessResult({
    backend,
    executable,
    result,
    durationMs: performance.now() - started,
  });
}

function attachJson(protocolResult) {
  if (protocolResult.status !== "success") {
    return protocolResult;
  }
  const source = protocolResult.stdout.trim();
  try {
    return { ...protocolResult, output: JSON.parse(source) };
  } catch (error) {
    return {
      ...protocolResult,
      status: "protocol-error",
      availabilityFailure: false,
      code: "MH_BAKER_PROTOCOL_INVALID",
      error: `backend stdout was not one JSON document: ${error.message}`,
    };
  }
}

function rejectProtocol(result, message) {
  return {
    ...result,
    status: "protocol-error",
    availabilityFailure: false,
    scientificFailure: false,
    code: "MH_BAKER_PROTOCOL_INVALID",
    error: message,
  };
}

function enforceProtocol(result, backend, command) {
  if (result.status !== "success") return result;
  const output = result.output;
  const expectedSchema = EXPECTED_PROTOCOLS[backend]?.[command];
  if (!expectedSchema || output?.schemaVersion !== expectedSchema) {
    return rejectProtocol(
      result,
      `${backend} ${command} returned an unsupported schemaVersion`,
    );
  }
  if (
    output.backend !== backend ||
    typeof output.algorithmRevision !== "string" ||
    !SHA256_PATTERN.test(output.algorithmContractSha256 ?? "")
  ) {
    return rejectProtocol(
      result,
      `${backend} ${command} omitted its backend or algorithm identity`,
    );
  }
  if (
    (command === "generate" || command === "validate") &&
    (!/^sha256:[a-f0-9]{64}$/.test(output.datasetId ?? "") ||
      !SHA256_PATTERN.test(output.manifestSha256 ?? ""))
  ) {
    return rejectProtocol(
      result,
      `${backend} ${command} omitted its dataset or manifest identity`,
    );
  }
  if (
    backend === "python-stdlib" &&
    (typeof output.pythonImplementation !== "string" ||
      typeof output.pythonVersion !== "string" ||
      !path.isAbsolute(output.pythonExecutable ?? "") ||
      !SHA256_PATTERN.test(output.pythonExecutableSha256 ?? ""))
  ) {
    return rejectProtocol(
      result,
      "Python backend omitted its absolute interpreter identity and version",
    );
  }
  return result;
}

export function runRustBackend({
  projectRoot,
  args,
  timeoutMs,
  env = process.env,
}) {
  let executable;
  try {
    executable = installedNativeBinaryPath({ projectRoot, env });
  } catch (error) {
    return {
      backend: "rust-native",
      executable: null,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      status: "unmanaged-override",
      availabilityFailure: true,
      scientificFailure: false,
      code: error.code ?? "MH_BAKER_NATIVE_CONFIGURATION_INVALID",
      error: error.message,
    };
  }
  if (!existsSync(executable)) {
    return {
      backend: "rust-native",
      executable,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      status: "missing",
      availabilityFailure: true,
      code: "MH_BAKER_EXECUTABLE_MISSING",
      scientificFailure: false,
    };
  }
  let executableStat;
  try {
    executableStat = statSync(executable);
  } catch (error) {
    return {
      backend: "rust-native",
      executable,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      status: "unavailable",
      availabilityFailure: true,
      scientificFailure: false,
      code: "MH_BAKER_NATIVE_ARTIFACT_UNREADABLE",
      error: error.message,
    };
  }
  if (!executableStat.isFile()) {
    return {
      backend: "rust-native",
      executable,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      status: "invalid-artifact",
      availabilityFailure: true,
      scientificFailure: false,
      code: "MH_BAKER_NATIVE_ARTIFACT_NOT_FILE",
    };
  }
  const ciSourceBuildOverride =
    env.CI === "true" && Boolean(env.MANDELHOWL_NATIVE_BAKER);
  const sidecarPath = `${executable}.sha256`;
  let approvedSha256 = null;
  if (!ciSourceBuildOverride) {
    if (!existsSync(sidecarPath)) {
      return {
        backend: "rust-native",
        executable,
        durationMs: 0,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        status: "unavailable",
        availabilityFailure: true,
        scientificFailure: false,
        code: "MH_BAKER_NATIVE_ATTESTATION_MISSING",
        error: `approved SHA-256 sidecar is missing: ${sidecarPath}`,
      };
    }
    try {
      approvedSha256 = readFileSync(sidecarPath, "utf8")
        .trim()
        .split(/\s+/, 1)[0]
        .toLowerCase();
    } catch (error) {
      return {
        backend: "rust-native",
        executable,
        durationMs: 0,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        status: "unavailable",
        availabilityFailure: true,
        scientificFailure: false,
        code: "MH_BAKER_NATIVE_ATTESTATION_UNREADABLE",
        error: error.message,
      };
    }
    if (!SHA256_PATTERN.test(approvedSha256)) {
      return {
        backend: "rust-native",
        executable,
        durationMs: 0,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        status: "unavailable",
        availabilityFailure: true,
        scientificFailure: false,
        code: "MH_BAKER_NATIVE_ATTESTATION_INVALID",
        error: "approved native SHA-256 sidecar is malformed",
      };
    }
  }
  let executableSha256;
  try {
    executableSha256 = createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex");
  } catch (error) {
    return {
      backend: "rust-native",
      executable,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      status: "unavailable",
      availabilityFailure: true,
      scientificFailure: false,
      code: "MH_BAKER_NATIVE_ARTIFACT_UNREADABLE",
      error: error.message,
    };
  }
  if (approvedSha256 !== null && executableSha256 !== approvedSha256) {
    return {
      backend: "rust-native",
      executable,
      executableSha256,
      approvedSha256,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      status: "unavailable",
      availabilityFailure: true,
      scientificFailure: false,
      code: "MH_BAKER_NATIVE_ATTESTATION_MISMATCH",
      error: "native executable SHA-256 does not match its approved sidecar",
    };
  }
  const command = args[0];
  const processResult = runBackendProcess({
    backend: "rust-native",
    executable,
    args,
    projectRoot,
    timeoutMs,
    env,
  });
  let postRunSha256;
  try {
    postRunSha256 = createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex");
  } catch (error) {
    return {
      ...processResult,
      status: "unavailable",
      availabilityFailure: true,
      scientificFailure: false,
      code: "MH_BAKER_NATIVE_ARTIFACT_POSTRUN_UNREADABLE",
      error: error.message,
      preRunExecutableSha256: executableSha256,
    };
  }
  if (postRunSha256 !== executableSha256) {
    return {
      ...processResult,
      status: "unavailable",
      availabilityFailure: true,
      scientificFailure: false,
      code: "MH_BAKER_NATIVE_ARTIFACT_CHANGED",
      error: "native executable changed while the backend process was running",
      preRunExecutableSha256: executableSha256,
      postRunExecutableSha256: postRunSha256,
    };
  }
  const result = enforceProtocol(
    attachJson(processResult),
    "rust-native",
    command,
  );
  return {
    ...result,
    executableSha256,
    preRunExecutableSha256: executableSha256,
    postRunExecutableSha256: postRunSha256,
    executableAttestation: ciSourceBuildOverride
      ? {
          kind: "ci-source-build-override",
          sha256: executableSha256,
        }
      : {
          kind: "approved-sha256-sidecar",
          sidecar: sidecarPath,
          sha256: approvedSha256,
        },
  };
}

export function runPythonBackend({
  projectRoot,
  args,
  timeoutMs,
  env = process.env,
}) {
  const executable = env.MANDELHOWL_PYTHON ?? "python";
  const result = enforceProtocol(
    attachJson(
      runBackendProcess({
        backend: "python-stdlib",
        executable,
        args: ["tools/physics-baker/bake.py", ...args],
        projectRoot,
        timeoutMs,
        env,
      }),
    ),
    "python-stdlib",
    args[0],
  );
  if (result.status !== "success") return result;
  return {
    ...result,
    interpreterIdentity: {
      implementation: result.output.pythonImplementation,
      version: result.output.pythonVersion,
      executable: result.output.pythonExecutable,
      executableSha256: result.output.pythonExecutableSha256,
    },
  };
}

export function publicBackendResult(result) {
  const publicResult = { ...result };
  delete publicResult.stdout;
  delete publicResult.stderr;
  if (result.stderr) {
    publicResult.diagnostic = result.stderr.trim().slice(0, 4_096);
  }
  return publicResult;
}
