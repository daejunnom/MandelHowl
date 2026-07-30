import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createContainerPlan,
  diagnoseContainerEngine,
  parseContainerRunnerArguments,
  parseImageInspection,
  resolveSafeOutputDirectory,
  runContainerBake,
} from "../src/runner.mjs";
import {
  CONTAINER_ENVELOPE_NAME,
  NATIVE_BAKER_PATH,
  PINNED_BASE_IMAGES,
  REPORT_NAME,
  RUNNER_ATTESTATION_NAME,
  TARGET_PLATFORM,
  verifyContainerAttestationEnvelope,
} from "../src/attestation-envelope.mjs";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("OCI context excludes secrets and heavy outputs while bases are digest-pinned", () => {
  const dockerignore = readFileSync(
    new URL("../../../.dockerignore", import.meta.url),
    "utf8",
  );
  for (const required of [
    "**",
    "!tools/container-baker-runner/**",
    "!tools/handoff-verifier/**",
    "!tools/reachability-generator/**",
    "!specs/acceptance/**",
    "!specs/visual/**",
    "!packages/render-engine/src/**",
    ".env",
    ".env.*",
    "**/*.key",
    "**/.ssh/**",
    "**/.npmrc",
    "**/node_modules",
    "**/dist",
    "**/dist-server",
    "**/build",
    "**/coverage",
    "**/models",
    "**/checkpoints",
    "**/.cache",
    "specs/runtime/dataset-release.v1.yaml",
    "packages/contracts/src/generated/dataset-release.generated.ts",
  ]) {
    assert.ok(dockerignore.split(/\r?\n/).includes(required), required);
  }
  assert.equal(
    dockerignore
      .split(/\r?\n/)
      .includes(
        "packages/contracts/src/generated/runtime-specs.generated.ts",
      ),
    false,
    "scientific/runtime generated constants must remain image inputs",
  );
  const dockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(
    dockerfile,
    /node:22\.19\.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90/,
  );
  assert.match(
    dockerfile,
    /rust:1\.96\.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc/,
  );
  const buildStages = dockerfile.match(/^FROM .+$/gm);
  assert.equal(buildStages?.length, 2);
  assert.match(buildStages[0], /^FROM rust:.+ AS native-builder$/);
  assert.match(buildStages[1], /^FROM node:/);
  assert.match(
    dockerfile,
    /RUSTUP_TOOLCHAIN=1\.96\.0 rustc --version/,
  );
  assert.doesNotMatch(dockerfile, /^COPY \. \/workspace$/m);
  assert.doesNotMatch(dockerfile, /\/opt\/mandelhowl-build/);
  assert.match(dockerfile, /^WORKDIR \/workspace$/m);
  assert.match(
    dockerfile,
    /^COPY tools\/baker-supervisor \/workspace\/tools\/baker-supervisor$/m,
  );
  assert.match(
    dockerfile,
    /^COPY tools\/release-packager \/workspace\/tools\/release-packager$/m,
  );
  assert.match(
    dockerfile,
    /^COPY tools\/handoff-verifier \/workspace\/tools\/handoff-verifier$/m,
  );
  assert.match(
    dockerfile,
    /^COPY tools\/reachability-generator \/workspace\/tools\/reachability-generator$/m,
  );
  assert.match(
    dockerfile,
    /^COPY specs\/acceptance \/workspace\/specs\/acceptance$/m,
  );
  assert.match(
    dockerfile,
    /^COPY tests\/runtime \/workspace\/tests\/runtime$/m,
  );
  assert.match(
    dockerfile,
    /^COPY packages\/resonance-engine\/src \/workspace\/packages\/resonance-engine\/src$/m,
  );
  assert.match(
    dockerfile,
    /^COPY packages\/render-engine\/src \/workspace\/packages\/render-engine\/src$/m,
  );
  assert.match(
    dockerfile,
    /^COPY specs\/visual \/workspace\/specs\/visual$/m,
  );
});

function temporaryProject() {
  const root = mkdtempSync(path.join(tmpdir(), "mandelhowl-container-test-"));
  mkdirSync(path.join(root, "tools", "container-baker-runner"), {
    recursive: true,
  });
  return root;
}

test("CLI accepts only a narrow fixed release envelope", () => {
  assert.deepEqual(
    parseContainerRunnerArguments([
      "run",
      "--dry-run",
      "--engine",
      "podman",
      "--output-dir",
      "candidate-01",
    ]),
    {
      command: "run",
      dryRun: true,
      engine: "podman",
      imageTag: "mandelhowl-baker-release:local",
      outputLeaf: "candidate-01",
      stageReleaseEvidence: false,
      timeoutMs: 2_520_000,
    },
  );
  assert.equal(
    parseContainerRunnerArguments([
      "run",
      "--stage-release-evidence",
    ]).stageReleaseEvidence,
    true,
  );
  assert.throws(
    () =>
      parseContainerRunnerArguments([
        "run",
        "--output-dir",
        "../outside",
      ]),
    { code: "MH_CONTAINER_OUTPUT_PATH_INVALID" },
  );
  for (const unsafeLeaf of ["NUL", "COM1.log", "trailing."]) {
    assert.throws(
      () =>
        parseContainerRunnerArguments([
          "run",
          "--output-dir",
          unsafeLeaf,
        ]),
      { code: "MH_CONTAINER_OUTPUT_PATH_INVALID" },
    );
  }
  assert.throws(
    () =>
      parseContainerRunnerArguments([
        "run",
        "--tag",
        "safe; touch injected",
      ]),
    { code: "MH_CONTAINER_IMAGE_TAG_INVALID" },
  );
  assert.throws(
    () => parseContainerRunnerArguments(["run", "--", "sh", "-c", "id"]),
    { code: "MH_CONTAINER_ARGUMENT_INVALID" },
  );
  assert.throws(
    () =>
      parseContainerRunnerArguments([
        "doctor",
        "--output-dir",
        "ignored",
      ]),
    { code: "MH_CONTAINER_ARGUMENT_INVALID" },
  );
  assert.throws(
    () =>
      parseContainerRunnerArguments([
        "doctor",
        "--stage-release-evidence",
      ]),
    { code: "MH_CONTAINER_ARGUMENT_INVALID" },
  );
});

test("output is constrained to a real directory below work", () => {
  const root = temporaryProject();
  try {
    const output = resolveSafeOutputDirectory(root, "release-01", {
      create: true,
    });
    assert.equal(
      output,
      path.join(
        realPath(root),
        "work",
        "container-baker-runs",
        "release-01",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output setup rejects a work-directory link before writing through it", () => {
  const root = temporaryProject();
  const outside = mkdtempSync(
    path.join(tmpdir(), "mandelhowl-container-outside-"),
  );
  try {
    symlinkSync(
      outside,
      path.join(root, "work"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () =>
        resolveSafeOutputDirectory(root, "release-escape", {
          create: true,
        }),
      { code: "MH_CONTAINER_OUTPUT_PATH_INVALID" },
    );
    assert.equal(
      existsSync(path.join(outside, "container-baker-runs")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("dry-run neither contacts the OCI engine nor creates output", () => {
  const root = temporaryProject();
  try {
    const output = path.join(
      root,
      "work",
      "container-baker-runs",
      "dry-run",
    );
    const result = runContainerBake({
      options: parseContainerRunnerArguments([
        "run",
        "--dry-run",
        "--output-dir",
        "dry-run",
      ]),
      projectRoot: root,
      spawn: () => {
        throw new Error("dry-run contacted the OCI engine");
      },
    });
    assert.equal(result.executed, false);
    assert.equal(result.plan.imageId, "<sha256-image-id-after-build>");
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real execution refuses any preexisting output before engine access", () => {
  const root = temporaryProject();
  try {
    const output = resolveSafeOutputDirectory(root, "not-fresh", {
      create: true,
    });
    mkdirSync(path.join(output, "residue"));
    assert.throws(
      () =>
        runContainerBake({
          options: parseContainerRunnerArguments([
            "run",
            "--output-dir",
            "not-fresh",
          ]),
          projectRoot: root,
          spawn: () => {
            throw new Error("non-fresh run contacted the OCI engine");
          },
        }),
      { code: "MH_CONTAINER_OUTPUT_NOT_FRESH" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed strict generation preserves the supervisor diagnostic report", () => {
  const root = temporaryProject();
  try {
    const output = path.join(
      root,
      "work",
      "container-baker-runs",
      "failed-report",
    );
    const spawn = (_executable, arguments_) => {
      if (arguments_[0] === "info") {
        return { status: 0, stdout: "linux\n", stderr: "" };
      }
      if (arguments_[0] === "version") {
        return { status: 0, stdout: "29.4.3\n", stderr: "" };
      }
      if (arguments_[0] === "build") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (arguments_[0] === "image") {
        return {
          status: 0,
          stdout: `linux|amd64|${IMAGE_ID}\n`,
          stderr: "",
        };
      }
      if (arguments_[0] === "run") {
        const bundle = path.join(
          output,
          "baker-nversion-attestation",
        );
        mkdirSync(bundle, { recursive: true });
        writeFileSync(
          path.join(bundle, "attestation.json"),
          `${JSON.stringify({
            schemaVersion:
              "mandelhowl.baker-supervisor-result.v1",
            command: "generate",
            state: "unavailable",
            backends: {
              rust: { status: "missing" },
              python: { status: "missing" },
            },
            attestationBundle: null,
            attestationBundleDiagnostic: {
              code: "MH_BAKER_ATTESTATION_DUAL_REQUIRED",
            },
          })}\n`,
        );
        return { status: 1, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected fake OCI call: ${arguments_[0]}`);
    };
    assert.throws(
      () =>
        runContainerBake({
          options: parseContainerRunnerArguments([
            "run",
            "--output-dir",
            "failed-report",
          ]),
          projectRoot: root,
          spawn,
        }),
      (error) => {
        assert.equal(error.code, "MH_CONTAINER_BAKE_FAILED");
        assert.equal(error.evidence.state, "unavailable");
        assert.equal(error.evidence.rustStatus, "missing");
        assert.equal(error.evidence.pythonStatus, "missing");
        assert.equal(
          error.evidence.attestationBundleDiagnostic.code,
          "MH_BAKER_ATTESTATION_DUAL_REQUIRED",
        );
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function realPath(value) {
  return path.resolve(value);
}

test("image inspection requires the actual Linux sha256 image ID", () => {
  assert.deepEqual(parseImageInspection(`linux|amd64|${IMAGE_ID}\n`), {
    os: "linux",
    architecture: "amd64",
    imageId: IMAGE_ID,
  });
  assert.throws(
    () => parseImageInspection("windows|sha256:not-a-digest"),
    { code: "MH_CONTAINER_IMAGE_ID_INVALID" },
  );
});

function containerEnvelopeFixture({
  runnerMutation = null,
  envelopeMutation = null,
} = {}) {
  const root = temporaryProject();
  const bundle = path.join(root, "bundle");
  mkdirSync(bundle);
  const report = {
    schemaVersion: "mandelhowl.baker-supervisor-result.v1",
    command: "generate",
    state: "dual-verified",
    promotionAllowed: true,
    releaseEligible: true,
  };
  const reportBytes = Buffer.from(
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(path.join(bundle, REPORT_NAME), reportBytes);
  const runner = {
    schemaVersion:
      "mandelhowl.container-baker-runner-attestation.v1",
    releaseOnly: true,
    executionSurface:
      "offline-release-only-oci-envelope-not-browser-runtime",
    engine: {
      name: "docker",
      serverVersion: "29.4.3",
      operatingSystem: "linux",
    },
    image: {
      id: IMAGE_ID,
      identitySource: "docker image inspect .Id",
      targetPlatform: TARGET_PLATFORM,
      pinnedBaseImages: PINNED_BASE_IMAGES,
    },
    isolation: {
      network: "none",
      rootFilesystem: "read-only",
      capabilities: "all-dropped",
      noNewPrivileges: true,
      sourceMount: "not-mounted-filtered-image-snapshot",
      outputMount: "read-write",
    },
    injectedEnvironment: {
      MANDELHOWL_CONTAINER_IMAGE_DIGEST: IMAGE_ID,
      MANDELHOWL_CONTAINER_RUNNER_ATTESTED: "1",
      MANDELHOWL_MANAGED_INSTALL: "1",
      MANDELHOWL_NATIVE_BAKER: NATIVE_BAKER_PATH,
      MANDELHOWL_PYTHON: "/usr/bin/python3",
    },
    containerExitCode: 0,
    supervisorReport: {
      path: REPORT_NAME,
      sha256: sha256(reportBytes),
      state: "dual-verified",
      releaseEligible: true,
      promotionAllowed: true,
    },
  };
  runnerMutation?.(runner);
  const runnerBytes = Buffer.from(
    `${JSON.stringify(runner, null, 2)}\n`,
  );
  writeFileSync(
    path.join(bundle, RUNNER_ATTESTATION_NAME),
    runnerBytes,
  );
  const envelope = {
    schemaVersion:
      "mandelhowl.container-baker-attestation-bundle.v1",
    releaseOnly: true,
    artifacts: [
      { path: REPORT_NAME, sha256: sha256(reportBytes) },
      {
        path: RUNNER_ATTESTATION_NAME,
        sha256: sha256(runnerBytes),
      },
    ],
    imageId: IMAGE_ID,
    supervisorState: "dual-verified",
    releaseEligible: true,
  };
  envelopeMutation?.(envelope);
  writeFileSync(
    path.join(bundle, CONTAINER_ENVELOPE_NAME),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  return {
    root,
    report,
    reportBytes,
    reportPath: path.join(bundle, REPORT_NAME),
    manifest: {
      solverProvenance: {
        executionKind: "oci-container",
        containerImageDigest: IMAGE_ID,
      },
    },
  };
}

test("container envelope binds the pinned OCI manifest without re-execution", () => {
  const fixture = containerEnvelopeFixture();
  try {
    const verified = verifyContainerAttestationEnvelope({
      reportPath: fixture.reportPath,
      reportBytes: fixture.reportBytes,
      report: fixture.report,
      expectedManifest: fixture.manifest,
    });
    assert.equal(verified.imageId, IMAGE_ID);
    assert.equal(verified.executionKind, "oci-container");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("container envelope rejects platform, digest, and artifact mutations", () => {
  const windows = containerEnvelopeFixture({
    runnerMutation: (runner) => {
      runner.engine.operatingSystem = "windows";
    },
  });
  try {
    assert.throws(
      () =>
        verifyContainerAttestationEnvelope({
          reportPath: windows.reportPath,
          reportBytes: windows.reportBytes,
          report: windows.report,
          expectedManifest: windows.manifest,
        }),
      /container runner attestation is invalid/u,
    );
  } finally {
    rmSync(windows.root, { recursive: true, force: true });
  }

  const artifact = containerEnvelopeFixture({
    envelopeMutation: (envelope) => {
      envelope.artifacts[0].sha256 = "0".repeat(64);
    },
  });
  try {
    assert.throws(
      () =>
        verifyContainerAttestationEnvelope({
          reportPath: artifact.reportPath,
          reportBytes: artifact.reportBytes,
          report: artifact.report,
          expectedManifest: artifact.manifest,
        }),
      /container envelope attestation is invalid/u,
    );
  } finally {
    rmSync(artifact.root, { recursive: true, force: true });
  }

  const digest = containerEnvelopeFixture();
  try {
    assert.throws(
      () =>
        verifyContainerAttestationEnvelope({
          reportPath: digest.reportPath,
          reportBytes: digest.reportBytes,
          report: digest.report,
          expectedManifest: {
            solverProvenance: {
              executionKind: "oci-container",
              containerImageDigest: `sha256:${"b".repeat(64)}`,
            },
          },
        }),
      /image identity disagree/u,
    );
  } finally {
    rmSync(digest.root, { recursive: true, force: true });
  }

  const reportObject = containerEnvelopeFixture();
  try {
    assert.throws(
      () =>
        verifyContainerAttestationEnvelope({
          reportPath: reportObject.reportPath,
          reportBytes: reportObject.reportBytes,
          report: {
            ...reportObject.report,
            releaseEligible: false,
          },
          expectedManifest: reportObject.manifest,
        }),
      /report object does not match its bound bytes/u,
    );
  } finally {
    rmSync(reportObject.root, { recursive: true, force: true });
  }
});

test("run plan injects only attested fixed paths and hardens OCI execution", () => {
  const root = temporaryProject();
  try {
    const output = resolveSafeOutputDirectory(root, "release-02", {
      create: true,
    });
    const plan = createContainerPlan({
      projectRoot: root,
      outputDirectory: output,
      imageId: IMAGE_ID,
      containerUser: "123:456",
    });
    assert.equal(
      plan.environment.MANDELHOWL_CONTAINER_IMAGE_DIGEST,
      IMAGE_ID,
    );
    assert.equal(
      plan.environment.MANDELHOWL_CONTAINER_RUNNER_ATTESTED,
      "1",
    );
    assert.equal(
      plan.environment.MANDELHOWL_NATIVE_BAKER,
      "/opt/mandelhowl/bin/mandelhowl-baker-native",
    );
    assert.equal(plan.targetPlatform, "linux/amd64");
    assert.deepEqual(plan.pinnedBaseImages, [
      "node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90",
      "rust:1.96.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc",
    ]);
    assert.ok(plan.buildArguments.includes("linux/amd64"));
    assert.deepEqual(plan.inspectArguments.slice(0, 4), [
      "image",
      "inspect",
      "--platform",
      "linux/amd64",
    ]);
    assert.ok(plan.runArguments.includes("linux/amd64"));
    assert.deepEqual(Object.keys(plan.environment).sort(), [
      "MANDELHOWL_CONTAINER_IMAGE_DIGEST",
      "MANDELHOWL_CONTAINER_RUNNER_ATTESTED",
      "MANDELHOWL_MANAGED_INSTALL",
      "MANDELHOWL_NATIVE_BAKER",
      "MANDELHOWL_PYTHON",
    ]);
    assert.ok(plan.runArguments.includes("none"));
    assert.ok(plan.runArguments.includes("--read-only"));
    assert.ok(plan.runArguments.includes("ALL"));
    assert.ok(plan.runArguments.includes("no-new-privileges"));
    assert.equal(
      plan.runArguments.some((value) => value.includes("target=/workspace")),
      false,
    );
    assert.ok(
      plan.runArguments.some((value) => value.includes("target=/out")),
    );
    assert.deepEqual(plan.runArguments.slice(-13), [
      "generate",
      "--strict",
      "--release",
      "--coverage-report",
      "tests/runtime/fixtures/reachability-report.json",
      "--timeout-ms",
      "2400000",
      "--output-root",
      "/out/datasets",
      "--attestation-bundle",
      "/out/baker-nversion-attestation",
      "--report-file",
      "/out/baker-nversion-attestation/attestation.json",
    ]);
    assert.equal(plan.runArguments.includes("sh"), false);
    assert.equal(plan.runArguments.includes("-c"), false);
    const podmanPlan = createContainerPlan({
      projectRoot: root,
      outputDirectory: output,
      engine: "podman",
      imageId: IMAGE_ID,
      containerUser: null,
    });
    assert.equal(podmanPlan.inspectArguments.includes("--platform"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("availability doctor distinguishes Linux, non-Linux and missing engines", () => {
  const calls = [];
  const linux = diagnoseContainerEngine({
    spawn: (_executable, arguments_) => {
      calls.push(arguments_);
      return {
        status: 0,
        stdout:
          arguments_[0] === "info" ? "linux\n" : "27.5.1\n",
        stderr: "",
      };
    },
  });
  assert.equal(linux.available, true);
  assert.equal(linux.operatingSystem, "linux");
  assert.equal(linux.serverVersion, "27.5.1");
  assert.equal(calls.length, 2);

  const windows = diagnoseContainerEngine({
    spawn: () => ({ status: 0, stdout: "windows\n", stderr: "" }),
  });
  assert.equal(windows.available, false);
  assert.equal(windows.code, "MH_CONTAINER_ENGINE_NOT_LINUX");

  const missing = diagnoseContainerEngine({
    spawn: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("missing"), { code: "ENOENT" }),
    }),
  });
  assert.equal(missing.available, false);
  assert.equal(missing.code, "MH_CONTAINER_ENGINE_MISSING");
});
