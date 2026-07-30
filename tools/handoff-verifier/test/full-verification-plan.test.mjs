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

import { resolvePinnedAttestation } from "../../release-packager/src/pinned-attestation.mjs";
import {
  IMPLEMENTATION_VERIFICATION_SCRIPTS,
  TEST_RUNNER_POLICY_PATHS,
  WINDOWS_NATIVE_PROHIBITED_SCRIPTS,
  assertNoWindowsNativeExecution,
  bindAcceptanceSuitesToStages,
  bindExactTestAnchorsToStages,
  collectWholeHandoffClaims,
  createFullVerificationStages,
  verifyTestRunnerPolicy,
  verifyWindowsNpmScriptDag,
} from "../src/full-verification-plan.mjs";
import { verifyNativeExecutionDelegation } from "../src/verification-core.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const packageScripts = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
).scripts;
const acceptanceContract = JSON.parse(
  readFileSync(
    path.join(
      projectRoot,
      "specs",
      "acceptance",
      "handoff-verification.v1.json",
    ),
    "utf8",
  ),
);

test("Windows whole-handoff plan verifies evidence without native Rust execution", () => {
  const stages = createFullVerificationStages({
    allowDirty: false,
    archive: true,
    nativeExecutionPolicy:
      acceptanceContract.nativeExecutionDelegation,
    packageScripts,
    platform: "win32",
    suiteRegistry: acceptanceContract.suites,
  });
  assert.deepEqual(
    stages.map((stage) => stage.script),
    [
      "handoff:check",
      ...IMPLEMENTATION_VERIFICATION_SCRIPTS.map(
        ({ script }) => script,
      ),
      "release:verify:attested",
      "release:archive",
      "release:archive:check",
    ],
  );
  assert.ok(stages.every((stage) => stage.command === "npm.cmd"));
  assert.ok(
    stages.every(
      (stage) =>
        !WINDOWS_NATIVE_PROHIBITED_SCRIPTS.includes(stage.script),
    ),
  );
  assert.equal(
    stages.some((stage) =>
      stage.arguments.some(
        (argument) =>
          argument.includes("--attestation") ||
          /(?:cargo|rustc|\.exe)/iu.test(argument),
      ),
    ),
    false,
  );

  const diagnostic = createFullVerificationStages({
    allowDirty: true,
    archive: false,
    nativeExecutionPolicy:
      acceptanceContract.nativeExecutionDelegation,
    packageScripts,
    platform: "win32",
    suiteRegistry: acceptanceContract.suites,
  });
  assert.deepEqual(diagnostic.at(-1).arguments, [
    "run",
    "release:verify",
    "--",
    "--pinned-nversion-attestation",
  ]);
});

test("whole-handoff plan gives every acceptance suite dedicated executable stages", () => {
  const stages = createFullVerificationStages({
    allowDirty: false,
    archive: true,
    nativeExecutionPolicy:
      acceptanceContract.nativeExecutionDelegation,
    packageScripts,
    platform: "linux",
    suiteRegistry: acceptanceContract.suites,
  });
  const bindings = bindAcceptanceSuitesToStages({
    suiteRegistry: acceptanceContract.suites,
    stages,
  });
  assert.equal(
    bindings.length,
    Object.keys(acceptanceContract.suites).length,
  );
  for (const binding of bindings) {
    assert.ok(binding.scripts.length > 0);
    assert.ok(
      binding.scripts.every((script) =>
        stages.some((stage) => stage.script === script),
      ),
    );
  }
  assert.throws(
    () =>
      bindAcceptanceSuitesToStages({
        suiteRegistry: acceptanceContract.suites,
        stages: stages.filter(
          ({ script }) => script !== "test:visual",
        ),
      }),
    /suite visual has no dedicated stage/u,
  );
});

test("whole-handoff plan executes every exact test anchor including all quality criteria", () => {
  const stages = createFullVerificationStages({
    allowDirty: false,
    archive: true,
    nativeExecutionPolicy:
      acceptanceContract.nativeExecutionDelegation,
    packageScripts,
    platform: "linux",
    suiteRegistry: acceptanceContract.suites,
  });
  const claims = collectWholeHandoffClaims(acceptanceContract);
  assert.deepEqual(
    claims
      .filter(({ id }) => /^QUALITY-\d+$/u.test(id))
      .map(({ id }) => id),
    Array.from({ length: 18 }, (_, index) => `QUALITY-${index + 1}`),
  );
  const expectedAnchorCount = claims.reduce(
    (count, claim) =>
      count +
      (claim.claimAnchors ?? []).filter(
        ({ kind }) => kind === "test",
      ).length,
    0,
  );
  const bindings = bindExactTestAnchorsToStages({
    claims,
    stages,
    packageScripts,
  });
  assert.equal(bindings.length, expectedAnchorCount);
  assert.ok(bindings.every(({ stageIds }) => stageIds.length > 0));

  const contractUnitAnchor = bindings.find(
    ({ claimId, script }) =>
      claimId === "AC-ARCH-CORE-BOUNDARY" &&
      script === "test:unit",
  );
  assert.ok(contractUnitAnchor);
  assert.deepEqual(contractUnitAnchor.stageIds, [
    "implementation-unit",
  ]);

  assert.throws(
    () =>
      bindExactTestAnchorsToStages({
        claims,
        stages: stages.filter(
          ({ id }) => id !== "implementation-unit",
        ),
        packageScripts,
      }),
    /requires test:unit/u,
  );

  const unknownSurface = structuredClone(claims);
  unknownSurface
    .find(({ claimAnchors }) =>
      claimAnchors?.some(({ kind }) => kind === "test"),
    )
    .claimAnchors.find(({ kind }) => kind === "test").path =
    "tests/not-collected/proof.test.ts";
  assert.throws(
    () =>
      bindExactTestAnchorsToStages({
        claims: unknownSurface,
        stages,
        packageScripts,
      }),
    /has 0 execution-surface owners/u,
  );
});

test("whole-handoff runners reject focused tests and pin their collection surfaces", () => {
  const sources = Object.fromEntries(
    TEST_RUNNER_POLICY_PATHS.map((configPath) => [
      configPath,
      readFileSync(path.join(projectRoot, configPath), "utf8"),
    ]),
  );
  assert.deepEqual(verifyTestRunnerPolicy(sources), {
    schemaVersion: "mandelhowl.test-runner-policy.v1",
    focusedTestsForbidden: true,
    configurationPaths: TEST_RUNNER_POLICY_PATHS,
  });

  for (const [configPath, before, after, expected] of [
    [
      "vitest.config.ts",
      "allowOnly: false,",
      "allowOnly: true,",
      /allowOnly: false/u,
    ],
    [
      "playwright.config.ts",
      "forbidOnly: true,",
      "forbidOnly: Boolean(process.env.CI),",
      /forbidOnly: true/u,
    ],
    [
      "tests/web/vitest.config.ts",
      'include: ["tests/web/**/*.test.ts"],',
      'include: ["tests/other/**/*.test.ts"],',
      /exact test-anchor include surface/u,
    ],
  ]) {
    const mutated = {
      ...sources,
      [configPath]: sources[configPath].replace(before, after),
    };
    assert.notEqual(mutated[configPath], sources[configPath]);
    assert.throws(() => verifyTestRunnerPolicy(mutated), expected);
  }
});

test("Windows plan fails closed if a prohibited native stage is reintroduced", () => {
  assert.throws(
    () =>
      assertNoWindowsNativeExecution([
        {
          id: "mutated-native-stage",
          script: "physics:validate:strict",
          command: "npm.cmd",
          arguments: ["run", "physics:validate:strict"],
        },
      ]),
    /must not execute physics:validate:strict/u,
  );
  assert.throws(
    () =>
      assertNoWindowsNativeExecution([
        {
          id: "mutated-pe-stage",
          script: "mutated",
          command: "cargo.exe",
          arguments: ["test"],
        },
      ]),
    /exposes a native executable/u,
  );
});

test("acceptance suites bind Linux native quality to committed OCI evidence", () => {
  const contract = acceptanceContract;
  assert.doesNotThrow(() =>
    verifyNativeExecutionDelegation({
      projectRoot,
      policy: contract.nativeExecutionDelegation,
      suiteRegistry: contract.suites,
    }),
  );

  const windowsMutation = structuredClone(
    contract.nativeExecutionDelegation,
  );
  windowsMutation.windowsFullVerification.nativeSpawnAllowed = true;
  assert.throws(
    () =>
      verifyNativeExecutionDelegation({
        projectRoot,
        policy: windowsMutation,
        suiteRegistry: contract.suites,
      }),
    /policy is missing or incomplete/u,
  );

  const suiteMutation = structuredClone(contract.suites);
  suiteMutation.physics.windowsNativeSpawnAllowed = true;
  assert.throws(
    () =>
      verifyNativeExecutionDelegation({
        projectRoot,
        policy: contract.nativeExecutionDelegation,
        suiteRegistry: suiteMutation,
      }),
    /suite physics/u,
  );

  const misplacedWindowsStage = structuredClone(
    contract.nativeExecutionDelegation,
  );
  misplacedWindowsStage.linuxQuality.requiredCommandFragments.push(
    "npm run handoff:verify --",
  );
  assert.throws(
    () =>
      verifyNativeExecutionDelegation({
        projectRoot,
        policy: misplacedWindowsStage,
        suiteRegistry: contract.suites,
      }),
    /policy is missing or incomplete/u,
  );
});

test("Windows npm script DAG rejects direct, indirect, lifecycle, and unpinned mutations", () => {
  const policy =
    acceptanceContract.nativeExecutionDelegation
      .windowsFullVerification;
  const stages = policy.scriptDagRoots.map((script) => ({ script }));
  const verify = (scripts) =>
    verifyWindowsNpmScriptDag({
      stages,
      packageScripts: scripts,
      roots: policy.scriptDagRoots,
      expectedSha256: policy.scriptDagSha256,
    });
  assert.doesNotThrow(() => verify(packageScripts));

  const direct = {
    ...packageScripts,
    typecheck: `${packageScripts.typecheck} && cargo test --workspace`,
  };
  assert.throws(
    () => verify(direct),
    /typecheck exposes a native execution command/u,
  );

  const indirect = {
    ...packageScripts,
    typecheck: `${packageScripts.typecheck} && npm run mutated:native`,
    "mutated:native":
      "node tools/baker-supervisor/src/supervisor.mjs validate",
  };
  assert.throws(
    () => verify(indirect),
    /mutated:native exposes a native execution command/u,
  );

  const lifecycle = {
    ...packageScripts,
    pretypecheck: "npm run physics:validate",
  };
  assert.throws(
    () => verify(lifecycle),
    /must not execute physics:validate/u,
  );

  const unpinned = {
    ...packageScripts,
    typecheck: `${packageScripts.typecheck} --extendedDiagnostics`,
  };
  assert.throws(
    () => verify(unpinned),
    /npm script DAG digest mismatch/u,
  );
});

test("workflow delegation is CRLF-safe and rejects native commands in the Windows job", () => {
  const contract = acceptanceContract;
  const workflow = readFileSync(
    path.join(projectRoot, ".github", "workflows", "verify.yml"),
    "utf8",
  );
  const fixtureRoot = mkdtempSync(
    path.join(os.tmpdir(), "mandelhowl-handoff-policy-"),
  );
  const fixtureWorkflowDirectory = path.join(
    fixtureRoot,
    ".github",
    "workflows",
  );
  mkdirSync(fixtureWorkflowDirectory, { recursive: true });
  const fixtureWorkflowPath = path.join(
    fixtureWorkflowDirectory,
    "verify.yml",
  );
  writeFileSync(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ scripts: packageScripts }, null, 2)}\n`,
    "utf8",
  );
  for (const relativePath of
    contract.nativeExecutionDelegation.windowsFullVerification
      .evidenceOnlyGuardSources) {
    const destination = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      readFileSync(path.join(projectRoot, relativePath)),
    );
  }

  try {
    writeFileSync(
      fixtureWorkflowPath,
      workflow.replace(/\r?\n/gu, "\r\n"),
      "utf8",
    );
    assert.doesNotThrow(() =>
      verifyNativeExecutionDelegation({
        projectRoot: fixtureRoot,
        policy: contract.nativeExecutionDelegation,
        suiteRegistry: contract.suites,
      }),
    );

    const mutatedWorkflow = workflow.replace(
      "      - name: Verify handoff against committed pinned OCI evidence",
      [
        "      - name: Mutated local Rust execution",
        "        run: cargo test --workspace --locked",
        "      - name: Verify handoff against committed pinned OCI evidence",
      ].join("\n"),
    );
    assert.notEqual(mutatedWorkflow, workflow);
    writeFileSync(fixtureWorkflowPath, mutatedWorkflow, "utf8");
    assert.throws(
      () =>
        verifyNativeExecutionDelegation({
          projectRoot: fixtureRoot,
          policy: contract.nativeExecutionDelegation,
          suiteRegistry: contract.suites,
        }),
      /Windows full verification exposes prohibited/u,
    );

    const mutatedNeeds = workflow.replace(
      "    needs: native-baker-nversion",
      "    needs: unrelated-job",
    );
    assert.notEqual(mutatedNeeds, workflow);
    writeFileSync(fixtureWorkflowPath, mutatedNeeds, "utf8");
    assert.throws(
      () =>
        verifyNativeExecutionDelegation({
          projectRoot: fixtureRoot,
          policy: contract.nativeExecutionDelegation,
          suiteRegistry: contract.suites,
        }),
      /not structurally gated/u,
    );

    const generationCommand =
      "          node tools/baker-supervisor/src/supervisor.mjs generate";
    const misplacedFreshGeneration = workflow
      .replace(generationCommand, "")
      .replace(
        "      - name: Verify handoff against committed pinned OCI evidence",
        [
          generationCommand,
          "      - name: Verify handoff against committed pinned OCI evidence",
        ].join("\n"),
      );
    assert.notEqual(misplacedFreshGeneration, workflow);
    writeFileSync(
      fixtureWorkflowPath,
      misplacedFreshGeneration,
      "utf8",
    );
    assert.throws(
      () =>
        verifyNativeExecutionDelegation({
          projectRoot: fixtureRoot,
          policy: contract.nativeExecutionDelegation,
          suiteRegistry: contract.suites,
        }),
      /exact strict fresh dual-generation stage/u,
    );

    const renamedCommittedStage = workflow.replace(
      "Verify handoff against committed pinned OCI evidence",
      "Verify handoff against arbitrary evidence",
    );
    assert.notEqual(renamedCommittedStage, workflow);
    writeFileSync(fixtureWorkflowPath, renamedCommittedStage, "utf8");
    assert.throws(
      () =>
        verifyNativeExecutionDelegation({
          projectRoot: fixtureRoot,
          policy: contract.nativeExecutionDelegation,
          suiteRegistry: contract.suites,
        }),
      /missing required evidence stage/u,
    );

    writeFileSync(fixtureWorkflowPath, workflow, "utf8");
    const backendGuardPath = path.join(
      fixtureRoot,
      contract.nativeExecutionDelegation.windowsFullVerification
        .evidenceOnlyGuardSources[1],
    );
    const backendGuard = readFileSync(backendGuardPath, "utf8");
    writeFileSync(
      backendGuardPath,
      backendGuard.replace(
        'process.env[EVIDENCE_ONLY_NO_NATIVE_SPAWN_ENV] === "1"',
        "false",
      ),
      "utf8",
    );
    assert.throws(
      () =>
        verifyNativeExecutionDelegation({
          projectRoot: fixtureRoot,
          policy: contract.nativeExecutionDelegation,
          suiteRegistry: contract.suites,
        }),
      /native pre-spawn guard is missing/u,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("pinned attestation path is derived only from the release lock", () => {
  const lock = {
    schemaVersion: "mandelhowl.dataset-lock.v1",
    datasetId: `sha256:${"a".repeat(64)}`,
    datasetDirectory: `assets/generated/${"a".repeat(64)}`,
    manifestSha256: "b".repeat(64),
  };
  const resolved = resolvePinnedAttestation({
    projectRoot,
    lock,
  });
  assert.equal(
    resolved.relativeReportPath,
    `release/attestations/${"a".repeat(64)}/attestation.json`,
  );
  assert.throws(
    () =>
      resolvePinnedAttestation({
        projectRoot,
        lock: { ...lock, datasetId: "sha256:../escape" },
      }),
    /content-addressed dataset ID/u,
  );
  assert.throws(
    () =>
      resolvePinnedAttestation({
        projectRoot,
        lock: {
          ...lock,
          datasetDirectory: "assets/generated/different",
        },
      }),
    /invalid dataset lock/u,
  );
});
