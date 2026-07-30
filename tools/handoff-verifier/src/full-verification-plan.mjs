import { createHash } from "node:crypto";

export const WINDOWS_NATIVE_PROHIBITED_SCRIPTS = Object.freeze([
  "baker:rust:check",
  "baker:rust:build",
  "baker:rust:self-test",
  "baker:rust:test",
  "baker:nversion:self-test",
  "baker:nversion:validate",
  "baker:nversion:generate",
  "baker:container:release",
  "physics:validate",
  "physics:validate:strict",
]);

export const WINDOWS_EVIDENCE_ONLY_ENVIRONMENT_VARIABLE =
  "MANDELHOWL_EVIDENCE_ONLY_NO_NATIVE_SPAWN";

export const DELEGATED_NATIVE_EVIDENCE = Object.freeze({
  schemaVersion: "mandelhowl.delegated-native-evidence.v1",
  windowsExecutionMode: "evidence-only-no-native-spawn",
  linuxQualityWorkflow: ".github/workflows/verify.yml",
  linuxQualityJob: "native-baker-nversion",
  committedEvidence:
    "release/attestations/<dataset-id-hex>/attestation.json",
  replacementClaims: Object.freeze([
    "rust-fmt-clippy-and-unit-tests-run-on-linux",
    "strict-rust-python-validation-runs-on-linux",
    "full-dual-candidate-oci-bundle-is-committed",
    "container-envelope-binds-linux-image-id",
    "release-verifier-binds-rust-candidate-to-pinned-dataset",
    "current-source-tree-must-match-attested-source-tree",
  ]),
});

const NATIVE_COMMAND_PATTERNS = Object.freeze([
  /(?:^|[\s;&|])(?:[^\s;&|]*[\\/])?(?:cargo|rustc)(?:\.exe)?(?=$|[\s;&|])/iu,
  /(?:^|[\s;&|])[^\s;&|]+\.exe(?=$|[\s;&|])/iu,
  /\bMANDELHOWL_NATIVE_BAKER\b/u,
  /\bmandelhowl-baker-native(?:\.exe)?\b/iu,
  /tools[\\/]baker-supervisor[\\/]src[\\/]supervisor\.mjs\s+(?:self-test|validate|generate)\b/iu,
  /tools[\\/]release-packager[\\/]src[\\/]validate-pinned-dataset\.mjs\b/iu,
  /tools[\\/]container-baker-runner[\\/]src[\\/]runner\.mjs\s+run\b/iu,
]);

export const IMPLEMENTATION_VERIFICATION_SCRIPTS = Object.freeze([
  Object.freeze({ id: "contracts", script: "contracts:check" }),
  Object.freeze({ id: "typescript", script: "typecheck" }),
  Object.freeze({ id: "lint", script: "lint" }),
  Object.freeze({ id: "svelte-compiler", script: "svelte:check" }),
  Object.freeze({
    id: "baker-supervisor-policy",
    script: "baker:supervisor:test",
  }),
  Object.freeze({
    id: "container-baker-policy",
    script: "baker:container:test",
  }),
  Object.freeze({
    id: "dependency-security-audit",
    script: "security:audit",
  }),
  Object.freeze({
    id: "runtime-security-policy",
    script: "security:static",
  }),
  Object.freeze({ id: "unit", script: "test:unit" }),
  Object.freeze({ id: "web", script: "test:web" }),
  Object.freeze({ id: "integration", script: "test:integration" }),
  Object.freeze({ id: "science", script: "test:science" }),
  Object.freeze({ id: "production-build", script: "build" }),
  Object.freeze({ id: "ssr", script: "test:ssr" }),
  Object.freeze({ id: "e2e", script: "test:e2e" }),
  Object.freeze({ id: "visual", script: "test:visual" }),
  Object.freeze({ id: "performance", script: "test:performance" }),
]);

export const TEST_RUNNER_POLICY_PATHS = Object.freeze([
  "vitest.config.ts",
  "tests/web/vitest.config.ts",
  "tests/integration/vitest.config.ts",
  "playwright.config.ts",
]);

export function collectWholeHandoffClaims(contract) {
  if (contract === null || typeof contract !== "object") {
    throw new Error("Whole-handoff claim contract is missing.");
  }
  return Object.freeze([
    ...(contract.coverageGroups ?? []),
    ...(contract.criticalClaims ?? []),
    ...(contract.qualityCriteria ?? []).map((quality) =>
      Object.freeze({
        ...quality,
        id: `QUALITY-${quality.id}`,
      }),
    ),
    ...(contract.acceptanceCases ?? []),
    ...(contract.extensionGates ?? []),
  ]);
}

function uncommentConfiguration(source) {
  let result = "";
  let state = "code";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
        result += character;
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      } else if (character === "\n") {
        result += character;
      }
      continue;
    }
    if (state !== "code") {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (
        (state === "single-quote" && character === "'") ||
        (state === "double-quote" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else {
      result += character;
      if (character === "'") state = "single-quote";
      if (character === '"') state = "double-quote";
      if (character === "`") state = "template";
    }
  }
  if (state === "block-comment") {
    throw new Error("Test-runner policy file has an open block comment.");
  }
  return result;
}

function requireUniqueConfigurationProperty({
  source,
  path: configPath,
  property,
  value,
}) {
  const declarations = [
    ...source.matchAll(
      new RegExp(`^\\s*${property}\\s*:.*$`, "gmu"),
    ),
  ];
  if (
    declarations.length !== 1 ||
    declarations[0][0].trim() !== `${property}: ${value},`
  ) {
    throw new Error(
      `${configPath} must declare exactly one ${property}: ${value} policy.`,
    );
  }
}

export function verifyTestRunnerPolicy(configSources) {
  if (
    configSources === null ||
    typeof configSources !== "object" ||
    Array.isArray(configSources)
  ) {
    throw new Error("Test-runner configuration sources are missing.");
  }
  const normalizedSources = {};
  for (const configPath of TEST_RUNNER_POLICY_PATHS) {
    const source = configSources[configPath];
    if (typeof source !== "string" || source.length === 0) {
      throw new Error(
        `Test-runner configuration is missing: ${configPath}.`,
      );
    }
    normalizedSources[configPath] =
      uncommentConfiguration(source);
  }
  for (const configPath of TEST_RUNNER_POLICY_PATHS.slice(0, 3)) {
    requireUniqueConfigurationProperty({
      source: normalizedSources[configPath],
      path: configPath,
      property: "allowOnly",
      value: "false",
    });
  }
  requireUniqueConfigurationProperty({
    source: normalizedSources["playwright.config.ts"],
    path: "playwright.config.ts",
    property: "forbidOnly",
    value: "true",
  });
  const exactIncludes = {
    "vitest.config.ts": 'include: ["packages/**/*.test.ts"],',
    "tests/web/vitest.config.ts":
      'include: ["tests/web/**/*.test.ts"],',
    "tests/integration/vitest.config.ts":
      'include: ["tests/integration/**/*.test.ts"],',
  };
  for (const [configPath, exactInclude] of Object.entries(
    exactIncludes,
  )) {
    const includeDeclarations = [
      ...normalizedSources[configPath].matchAll(
        /^\s*include\s*:.*$/gmu,
      ),
    ];
    if (
      includeDeclarations.length !== 1 ||
      includeDeclarations[0][0].trim() !== exactInclude
    ) {
      throw new Error(
        `${configPath} does not own its exact test-anchor include surface.`,
      );
    }
  }
  const playwrightSource =
    normalizedSources["playwright.config.ts"];
  for (const requiredSelector of [
    'testDir: "./tests",',
    '"e2e/**/*.spec.ts",',
    '"visual/**/*.spec.ts",',
    '"performance/**/*.spec.ts",',
  ]) {
    if (!playwrightSource.includes(requiredSelector)) {
      throw new Error(
        `playwright.config.ts is missing test surface ${requiredSelector}.`,
      );
    }
  }
  return Object.freeze({
    schemaVersion: "mandelhowl.test-runner-policy.v1",
    focusedTestsForbidden: true,
    configurationPaths: TEST_RUNNER_POLICY_PATHS,
  });
}

function npmStage(id, script, trailingArguments, platform) {
  return Object.freeze({
    id,
    script,
    command: platform === "win32" ? "npm.cmd" : "npm",
    arguments: Object.freeze([
      "run",
      script,
      ...(trailingArguments.length > 0 ? ["--"] : []),
      ...trailingArguments,
    ]),
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function npmScriptReferences(command) {
  const references = new Set();
  const runPattern =
    /\bnpm(?:\.cmd)?\s+(?:--silent\s+)?run(?:-script)?\s+(?:--\s+)?["']?([A-Za-z0-9:_-]+)["']?/giu;
  for (const match of command.matchAll(runPattern)) {
    references.add(match[1]);
  }
  const lifecyclePattern =
    /\bnpm(?:\.cmd)?\s+(test|start|stop|restart)\b/giu;
  for (const match of command.matchAll(lifecyclePattern)) {
    references.add(match[1].toLowerCase());
  }
  return [...references].sort();
}

function canonicalScriptDag(entries) {
  return JSON.stringify(
    entries.map(({ script, command, dependencies }) => ({
      script,
      command,
      dependencies,
    })),
  );
}

export function verifyWindowsNpmScriptDag({
  stages,
  packageScripts,
  roots: configuredRoots,
  expectedSha256,
}) {
  if (
    packageScripts === null ||
    typeof packageScripts !== "object" ||
    Array.isArray(packageScripts)
  ) {
    throw new Error(
      "Windows full verification requires the package.json script registry.",
    );
  }
  const stageRoots = [...new Set(stages.map((stage) => stage.script))].sort();
  const roots = [...new Set(configuredRoots ?? stageRoots)].sort();
  if (stageRoots.some((script) => !roots.includes(script))) {
    throw new Error(
      "Windows full verification stage is outside the pinned npm DAG roots.",
    );
  }
  const pending = [...roots];
  const visited = new Set();
  const entries = [];
  while (pending.length > 0) {
    const script = pending.shift();
    if (visited.has(script)) continue;
    visited.add(script);
    const command = packageScripts[script];
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(
        `Windows full verification npm script is missing: ${script}.`,
      );
    }
    if (WINDOWS_NATIVE_PROHIBITED_SCRIPTS.includes(script)) {
      throw new Error(
        `Windows full verification transitive npm DAG must not execute ${script}.`,
      );
    }
    const commandViolation = NATIVE_COMMAND_PATTERNS.find((pattern) =>
      pattern.test(command),
    );
    if (commandViolation !== undefined) {
      throw new Error(
        `Windows full verification npm script ${script} exposes a native execution command.`,
      );
    }
    const dependencies = npmScriptReferences(command);
    for (const lifecycle of [`pre${script}`, `post${script}`]) {
      if (Object.hasOwn(packageScripts, lifecycle)) {
        dependencies.push(lifecycle);
      }
    }
    const exactDependencies = [...new Set(dependencies)].sort();
    entries.push({ script, command, dependencies: exactDependencies });
    for (const dependency of exactDependencies) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
    pending.sort();
  }
  entries.sort((left, right) =>
    left.script < right.script ? -1 : left.script > right.script ? 1 : 0,
  );
  const digest = sha256(canonicalScriptDag(entries));
  if (
    typeof expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    digest !== expectedSha256
  ) {
    throw new Error(
      `Windows full verification npm script DAG digest mismatch: ${digest}.`,
    );
  }
  return Object.freeze({
    schemaVersion: "mandelhowl.windows-npm-script-dag.v1",
    roots: Object.freeze(roots),
    scripts: Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          script: entry.script,
          commandSha256: sha256(entry.command),
          dependencies: Object.freeze(entry.dependencies),
        }),
      ),
    ),
    sha256: digest,
  });
}

export function assertNoWindowsNativeExecution(
  stages,
  {
    packageScripts,
    scriptDagRoots,
    expectedScriptDagSha256,
  } = {},
) {
  for (const stage of stages) {
    if (WINDOWS_NATIVE_PROHIBITED_SCRIPTS.includes(stage.script)) {
      throw new Error(
        `Windows full verification must not execute ${stage.script}.`,
      );
    }
    if (
      /(?:^|[\\/])(?:cargo|rustc)(?:\.exe)?$/iu.test(stage.command) ||
      stage.arguments.some((argument) =>
        /(?:^|[\\/])[^\\/]+\.exe$/iu.test(argument),
      )
    ) {
      throw new Error(
        `Windows full verification stage ${stage.id} exposes a native executable.`,
      );
    }
  }
  verifyWindowsNpmScriptDag({
    stages,
    packageScripts,
    roots: scriptDagRoots,
    expectedSha256: expectedScriptDagSha256,
  });
  return stages;
}

function suiteCommandScripts(command, suiteId) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`Acceptance suite ${suiteId} has no executable command.`);
  }
  const scripts = [];
  const commandParts = command.split(/\s*&&\s*/u);
  for (const part of commandParts) {
    const match =
      /^npm(?:\.cmd)?\s+run(?:-script)?\s+(?:--\s+)?["']?([A-Za-z0-9:_-]+)["']?$/u.exec(
        part.trim(),
      );
    if (match === null) {
      throw new Error(
        `Acceptance suite ${suiteId} must be a closed npm-run command chain.`,
      );
    }
    scripts.push(match[1]);
  }
  return Object.freeze([...new Set(scripts)]);
}

export function bindAcceptanceSuitesToStages({
  suiteRegistry,
  stages,
}) {
  if (
    suiteRegistry === null ||
    typeof suiteRegistry !== "object" ||
    Array.isArray(suiteRegistry)
  ) {
    throw new Error("Acceptance suite registry is missing.");
  }
  const stageScripts = new Set(stages.map(({ script }) => script));
  const bindings = [];
  for (const [suiteId, suite] of Object.entries(suiteRegistry)) {
    const scripts = suiteCommandScripts(suite?.command, suiteId);
    const missing = scripts.filter((script) => !stageScripts.has(script));
    if (missing.length > 0) {
      throw new Error(
        `Acceptance suite ${suiteId} has no dedicated stage for ${missing.join(", ")}.`,
      );
    }
    bindings.push(Object.freeze({ suiteId, scripts }));
  }
  return Object.freeze(bindings);
}

const TEST_ANCHOR_EXECUTION_SURFACES = Object.freeze([
  Object.freeze({
    pattern: /^packages\/.+\.test\.ts$/u,
    script: "test:unit",
  }),
  Object.freeze({
    pattern: /^tests\/web\/.+\.test\.ts$/u,
    script: "test:web",
  }),
  Object.freeze({
    pattern: /^tests\/integration\/.+\.test\.ts$/u,
    script: "test:integration",
  }),
  Object.freeze({
    pattern: /^tests\/science\/test_.+\.py$/u,
    script: "test:science",
  }),
  Object.freeze({
    pattern: /^tests\/e2e\/.+\.spec\.ts$/u,
    script: "test:e2e",
  }),
  Object.freeze({
    pattern: /^tests\/visual\/.+\.spec\.ts$/u,
    script: "test:visual",
  }),
  Object.freeze({
    pattern: /^tests\/performance\/.+\.spec\.ts$/u,
    script: "test:performance",
  }),
  Object.freeze({
    pattern: /^tests\/rendered-html\.test\.mjs$/u,
    script: "test:ssr",
  }),
  Object.freeze({
    pattern: /^tools\/baker-supervisor\/test\/.+\.test\.mjs$/u,
    script: "baker:supervisor:test",
  }),
  Object.freeze({
    pattern:
      /^tools\/container-baker-runner\/test\/.+\.test\.mjs$/u,
    script: "baker:container:test",
  }),
  Object.freeze({
    pattern: /^tools\/handoff-verifier\/test\/.+\.test\.mjs$/u,
    script: "handoff:test",
  }),
]);

function scriptClosure(rootScript, packageScripts) {
  const pending = [rootScript];
  const visited = new Set();
  while (pending.length > 0) {
    const script = pending.shift();
    if (visited.has(script)) continue;
    const command = packageScripts[script];
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(
        `Exact-test execution reaches missing npm script ${script}.`,
      );
    }
    visited.add(script);
    const dependencies = npmScriptReferences(command);
    for (const lifecycle of [`pre${script}`, `post${script}`]) {
      if (Object.hasOwn(packageScripts, lifecycle)) {
        dependencies.push(lifecycle);
      }
    }
    for (const dependency of [...new Set(dependencies)].sort()) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return visited;
}

function testExecutionScript(testPath) {
  if (typeof testPath !== "string" || testPath.length === 0) {
    throw new Error("Exact test anchor has no repository path.");
  }
  const normalized = testPath.replaceAll("\\", "/");
  const matches = TEST_ANCHOR_EXECUTION_SURFACES.filter(({ pattern }) =>
    pattern.test(normalized),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Exact test anchor ${normalized} has ${matches.length} execution-surface owners.`,
    );
  }
  return Object.freeze({
    path: normalized,
    script: matches[0].script,
  });
}

export function bindExactTestAnchorsToStages({
  claims,
  stages,
  packageScripts,
}) {
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error("Exact-test claim inventory is missing.");
  }
  if (
    packageScripts === null ||
    typeof packageScripts !== "object" ||
    Array.isArray(packageScripts)
  ) {
    throw new Error(
      "Exact-test execution requires the package.json script registry.",
    );
  }
  const stageClosures = stages.map((stage) => ({
    stage,
    scripts: scriptClosure(stage.script, packageScripts),
  }));
  const seenAnchorIds = new Set();
  const bindings = [];
  for (const claim of claims) {
    const claimId = String(claim?.id ?? "");
    if (claimId.length === 0) {
      throw new Error("Exact-test claim has no ID.");
    }
    for (const anchor of claim.claimAnchors ?? []) {
      if (anchor.kind !== "test") continue;
      const anchorId = String(anchor.id ?? "");
      if (anchorId.length === 0 || seenAnchorIds.has(anchorId)) {
        throw new Error(
          `Exact test anchor ID is missing or duplicated: ${anchorId}.`,
        );
      }
      seenAnchorIds.add(anchorId);
      if (
        typeof anchor.testId !== "string" ||
        anchor.testId.length === 0
      ) {
        throw new Error(`Exact test anchor ${anchorId} has no test ID.`);
      }
      const executionSurface = testExecutionScript(anchor.path);
      const stageIds = stageClosures
        .filter(({ scripts }) =>
          scripts.has(executionSurface.script),
        )
        .map(({ stage }) => stage.id);
      if (stageIds.length === 0) {
        throw new Error(
          `Exact test anchor ${anchorId} is not executed: ${executionSurface.path} requires ${executionSurface.script}.`,
        );
      }
      bindings.push(
        Object.freeze({
          anchorId,
          claimId,
          path: executionSurface.path,
          testId: anchor.testId,
          script: executionSurface.script,
          stageIds: Object.freeze(stageIds),
        }),
      );
    }
  }
  if (bindings.length === 0) {
    throw new Error("Exact-test claim inventory has no test anchors.");
  }
  return Object.freeze(bindings);
}

export function createFullVerificationStages({
  allowDirty,
  archive,
  nativeExecutionPolicy,
  packageScripts,
  platform,
  suiteRegistry,
}) {
  const stages = [
    npmStage(
      "handoff-obligation-and-conformance-contract",
      "handoff:check",
      [],
      platform,
    ),
    ...IMPLEMENTATION_VERIFICATION_SCRIPTS.map(({ id, script }) =>
      npmStage(`implementation-${id}`, script, [], platform),
    ),
    allowDirty
      ? npmStage(
          "pinned-oci-native-physics-and-release-evidence",
          "release:verify",
          ["--pinned-nversion-attestation"],
          platform,
        )
      : npmStage(
          "pinned-oci-native-physics-and-clean-release-evidence",
          "release:verify:attested",
          [],
          platform,
        ),
    ...(archive
      ? [
          npmStage(
            "deterministic-release-archive",
            "release:archive",
            [],
            platform,
          ),
          npmStage(
            "release-archive-recheck",
            "release:archive:check",
            [],
            platform,
          ),
        ]
      : []),
  ];
  if (platform === "win32") {
    assertNoWindowsNativeExecution(stages, {
      packageScripts,
      scriptDagRoots:
        nativeExecutionPolicy?.windowsFullVerification
          ?.scriptDagRoots,
      expectedScriptDagSha256:
        nativeExecutionPolicy?.windowsFullVerification
          ?.scriptDagSha256,
    });
  }
  const frozenStages = Object.freeze(stages);
  // Dirty/no-archive runs are explicitly diagnostic and must not claim that
  // the release acceptance suite was executed. The default clean+archive
  // path remains fail-closed and requires every suite to own a stage.
  if (!allowDirty && archive) {
    bindAcceptanceSuitesToStages({
      suiteRegistry,
      stages: frozenStages,
    });
  }
  return frozenStages;
}
