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
import {
  HandoffVerificationError,
  buildObligationLedger,
  parseHandoff,
  verifyExecutableSuiteRegistry,
  verifyObligationLedgerPin,
  verifyReleaseBlockingAssertions,
  verifyStandaloneClaims,
  verifyValidationSuiteRequirements,
} from "../src/verification-core.mjs";

function fixture() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "mh-handoff-verifier-"),
  );
  mkdirSync(path.join(root, "tests"), { recursive: true });
  mkdirSync(path.join(root, "specs", "physics"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "tests", "root.test.mjs"),
    [
      'test("proves the root obligation", () => { assert.equal(1, 1); });',
      'test("proves one conceptual dial input", () => { assert.equal(1, 1); });',
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(root, "tests", "validation.test.mjs"),
    'test("proves physics validation", () => { assert.equal(1, 1); });\n',
  );
  writeFileSync(
    path.join(root, "tests", "gate.test.mjs"),
    'test("proves the implementation gate", () => { assert.equal(1, 1); });\n',
  );
  writeFileSync(
    path.join(root, "specs", "physics", "algorithm.json"),
    `${JSON.stringify(
      {
        handoffConformance: {
          finiteElementAssemblyUsed: true,
          analysisSurfaceElementMeshCoupledToEigenproblem: true,
          strictLiteralConformance: true,
        },
      },
      null,
      2,
    )}\n`,
  );
  const markdown = [
    "## 1. Root",
    "- root obligation",
    "### 16.1 Physics validation",
    "- validate physics",
    "### A0. Contract gate",
    "- implement the contract",
    "",
  ].join("\n");
  const suites = {
    unit: { command: "node --test" },
    science: { command: "node --test" },
  };
  const coverageGroups = [
    {
      id: "root",
      headings: ["1"],
      suites: ["unit"],
      evidence: ["tests/root.test.mjs"],
      claimAnchors: [
        {
          id: "ROOT-CLAIM",
          kind: "test",
          path: "tests/root.test.mjs",
          testId: "proves the root obligation",
        },
      ],
    },
    {
      id: "validation",
      headings: ["16.1"],
      suites: ["science"],
      evidence: ["tests/validation.test.mjs"],
      claimAnchors: [
        {
          id: "VALIDATION-GROUP-CLAIM",
          kind: "test",
          path: "tests/validation.test.mjs",
          testId: "proves physics validation",
        },
      ],
    },
    {
      id: "gates",
      headings: ["A0"],
      suites: ["unit"],
      evidence: ["tests/gate.test.mjs"],
      claimAnchors: [
        {
          id: "GATE-GROUP-CLAIM",
          kind: "test",
          path: "tests/gate.test.mjs",
          testId: "proves the implementation gate",
        },
      ],
    },
  ];
  const criticalClaims = [
    {
      id: "VALIDATION-16.1",
      heading: "16.1",
      suites: ["science"],
      claimAnchors: [
        {
          id: "VALIDATION-16-1-CLAIM",
          kind: "test",
          path: "tests/validation.test.mjs",
          testId: "proves physics validation",
        },
      ],
    },
    {
      id: "GATE-A0",
      heading: "A0",
      suites: ["unit"],
      claimAnchors: [
        {
          id: "GATE-A0-CLAIM",
          kind: "test",
          path: "tests/gate.test.mjs",
          testId: "proves the implementation gate",
        },
      ],
    },
  ];
  const acceptanceCases = [
    {
      id: "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      suites: ["unit"],
      claimAnchors: [
        {
          id: "ROOT-DIRECT-CLAIM",
          kind: "test",
          path: "tests/root.test.mjs",
          testId: "proves the root obligation",
        },
      ],
    },
    {
      id: "AC-PHYSICS-FEM-CONVERGENCE",
      suites: ["science"],
      claimAnchors: [
        {
          id: "PHYSICS-DIRECT-CLAIM",
          kind: "test",
          path: "tests/validation.test.mjs",
          testId: "proves physics validation",
        },
      ],
    },
    {
      id: "AC-DATA-SCHEMA-HASH",
      suites: ["unit"],
      claimAnchors: [
        {
          id: "CONTRACT-DIRECT-CLAIM",
          kind: "test",
          path: "tests/gate.test.mjs",
          testId: "proves the implementation gate",
        },
      ],
    },
  ];
  const parsed = parseHandoff(markdown);
  const obligationClaims = [
    {
      obligationId: parsed.obligations[0].id,
      caseIds: [
        "group:root",
        "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      ],
    },
    {
      obligationId: parsed.obligations[1].id,
      caseIds: [
        "VALIDATION-16.1",
        "AC-PHYSICS-FEM-CONVERGENCE",
      ],
    },
    {
      obligationId: parsed.obligations[2].id,
      caseIds: ["GATE-A0", "AC-DATA-SCHEMA-HASH"],
    },
  ];
  return {
    root,
    markdown,
    suites,
    coverageGroups,
    criticalClaims,
    acceptanceCases,
    obligationClaims,
  };
}

function cleanup(root) {
  const normalized = path.resolve(root);
  assert.match(
    path.basename(normalized),
    /^mh-handoff-verifier-/u,
  );
  rmSync(normalized, { recursive: true, force: true });
}

test("emits stable line-bound obligation IDs and exact ownership", () => {
  const value = fixture();
  try {
    const parsed = parseHandoff(value.markdown);
    const ledger = buildObligationLedger({
      projectRoot: value.root,
      parsed,
      coverageGroups: value.coverageGroups,
      criticalClaims: value.criticalClaims,
      acceptanceCases: value.acceptanceCases,
      obligationClaims: value.obligationClaims,
      suiteRegistry: value.suites,
    });
    assert.equal(ledger.sourceObligationCount, 3);
    assert.equal(ledger.mappedObligationCount, 3);
    assert.match(ledger.entries[0].id, /^MH-HO-1-001-[a-f0-9]{12}$/u);
    assert.equal(ledger.entries[0].sourceLine, 2);
    assert.deepEqual(ledger.entries[1].caseIds, [
      "VALIDATION-16.1",
      "AC-PHYSICS-FEM-CONVERGENCE",
    ]);
    assert.deepEqual(ledger.entries[2].caseIds, [
      "GATE-A0",
      "AC-DATA-SCHEMA-HASH",
    ]);
    verifyObligationLedgerPin(ledger, {
      expectedCount: 3,
      expectedLedgerSha256: ledger.ledgerSha256,
    });
  } finally {
    cleanup(value.root);
  }
});

test("parses list, narrative, table, blockquote, and code-flow obligations with stable lines", () => {
  const markdown = [
    "## 6. Roles",
    "Module ownership must remain singular.",
    "| component | role |",
    "|---|---|",
    "| renderer | snapshot read-only |",
    "- bullet contract",
    "1. ordered contract",
    "```text",
    "speaker drive",
    "→ plate response",
    "```",
    "## 21. Final",
    "> Causality remains immediately legible.",
    "",
  ].join("\n");
  const parsed = parseHandoff(markdown);
  assert.deepEqual(
    parsed.obligations.map(({ marker, sourceLine, text }) => ({
      marker,
      sourceLine,
      text,
    })),
    [
      {
        marker: "narrative",
        sourceLine: 2,
        text: "Module ownership must remain singular.",
      },
      {
        marker: "table-row",
        sourceLine: 5,
        text: "renderer: snapshot read-only",
      },
      {
        marker: "bullet",
        sourceLine: 6,
        text: "bullet contract",
      },
      {
        marker: "ordered",
        sourceLine: 7,
        text: "ordered contract",
      },
      {
        marker: "code-flow",
        sourceLine: 9,
        text: "speaker drive → plate response",
      },
      {
        marker: "blockquote",
        sourceLine: 13,
        text: "Causality remains immediately legible.",
      },
    ],
  );
  assert.deepEqual(
    parseHandoff(markdown.replaceAll("\n", "\r\n")).obligations.map(
      ({ id, sourceLine }) => ({ id, sourceLine }),
    ),
    parsed.obligations.map(({ id, sourceLine }) => ({ id, sourceLine })),
  );
  assert.throws(
    () => parseHandoff("## 9. Runtime\n```text\nunclosed"),
    /unclosed code fence at line 2/u,
  );
});

test("rejects a release-blocking false conformance value", () => {
  const value = fixture();
  try {
    const assertions = [
      {
        id: "B1",
        gate: "B1",
        releaseBlocking: true,
        source: "specs/physics/algorithm.json",
        claims: [
          {
            pointer:
              "/handoffConformance/finiteElementAssemblyUsed",
            equals: true,
          },
          {
            pointer:
              "/handoffConformance/analysisSurfaceElementMeshCoupledToEigenproblem",
            equals: true,
          },
          {
            pointer:
              "/handoffConformance/strictLiteralConformance",
            equals: true,
          },
          {
            pointer: "/handoffConformance/deviationCode",
            exists: false,
          },
        ],
      },
    ];
    assert.equal(
      verifyReleaseBlockingAssertions({
        projectRoot: value.root,
        assertions,
      }).length,
      1,
    );
    writeFileSync(
      path.join(value.root, "specs", "physics", "algorithm.json"),
      `${JSON.stringify({
        handoffConformance: {
          finiteElementAssemblyUsed: false,
          analysisSurfaceElementMeshCoupledToEigenproblem: true,
          strictLiteralConformance: true,
        },
      })}\n`,
    );
    assert.throws(
      () =>
        verifyReleaseBlockingAssertions({
          projectRoot: value.root,
          assertions,
        }),
      (error) =>
        error instanceof HandoffVerificationError &&
        /finiteElementAssemblyUsed/u.test(error.message),
    );
  } finally {
    cleanup(value.root);
  }
});

test("rejects an obligation whose heading lost its one-to-one owner", () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        buildObligationLedger({
          projectRoot: value.root,
          parsed: parseHandoff(value.markdown),
          coverageGroups: value.coverageGroups.slice(1),
          criticalClaims: value.criticalClaims,
          acceptanceCases: value.acceptanceCases,
          obligationClaims: value.obligationClaims,
          suiteRegistry: value.suites,
        }),
      (error) =>
        error instanceof HandoffVerificationError &&
        /unknown acceptance case group:root/u.test(error.message),
    );
  } finally {
    cleanup(value.root);
  }
});

test("rejects empty and unrelated evidence anchors", () => {
  const value = fixture();
  try {
    const empty = structuredClone(value.coverageGroups);
    empty[0].claimAnchors = [];
    assert.throws(
      () =>
        buildObligationLedger({
          projectRoot: value.root,
          parsed: parseHandoff(value.markdown),
          coverageGroups: empty,
          criticalClaims: value.criticalClaims,
          acceptanceCases: value.acceptanceCases,
          obligationClaims: value.obligationClaims,
          suiteRegistry: value.suites,
        }),
      /no semantic claim anchors/u,
    );

    const unrelated = structuredClone(value.coverageGroups);
    unrelated[0].claimAnchors[0].testId =
      "this unrelated test ID is absent";
    assert.throws(
      () =>
        buildObligationLedger({
          projectRoot: value.root,
          parsed: parseHandoff(value.markdown),
          coverageGroups: unrelated,
          criticalClaims: value.criticalClaims,
          acceptanceCases: value.acceptanceCases,
          obligationClaims: value.obligationClaims,
          suiteRegistry: value.suites,
        }),
      /resolved 0 times/u,
    );
  } finally {
    cleanup(value.root);
  }
});

test("rejects a directory presented as semantic evidence", () => {
  const value = fixture();
  try {
    const directory = structuredClone(value.coverageGroups);
    directory[0].evidence = ["tests"];
    directory[0].claimAnchors[0].path = "tests";
    assert.throws(
      () =>
        buildObligationLedger({
          projectRoot: value.root,
          parsed: parseHandoff(value.markdown),
          coverageGroups: directory,
          criticalClaims: value.criticalClaims,
          acceptanceCases: value.acceptanceCases,
          obligationClaims: value.obligationClaims,
          suiteRegistry: value.suites,
        }),
      /concrete file, not a directory/u,
    );
  } finally {
    cleanup(value.root);
  }
});

test("rejects a changed or incomplete obligation ledger pin", () => {
  const value = fixture();
  try {
    const ledger = buildObligationLedger({
      projectRoot: value.root,
      parsed: parseHandoff(value.markdown),
      coverageGroups: value.coverageGroups,
      criticalClaims: value.criticalClaims,
      acceptanceCases: value.acceptanceCases,
      obligationClaims: value.obligationClaims,
      suiteRegistry: value.suites,
    });
    assert.throws(
      () =>
        verifyObligationLedgerPin(ledger, {
          expectedCount: 2,
          expectedLedgerSha256: ledger.ledgerSha256,
        }),
      /obligation count mismatch/u,
    );
    assert.throws(
      () =>
        verifyObligationLedgerPin(ledger, {
          expectedCount: 3,
          expectedLedgerSha256: "0".repeat(64),
        }),
      /ownership ledger changed/u,
    );
  } finally {
    cleanup(value.root);
  }
});

test("rejects validation suites swapped between handoff subsections", () => {
  const validationSubsections = ["16.4", "16.5"];
  const requirements = {
    "16.4": ["unit", "e2e"],
    "16.5": ["e2e", "visual"],
  };
  const claims = [
    { heading: "16.4", suites: ["unit", "e2e"] },
    { heading: "16.5", suites: ["e2e", "visual"] },
  ];

  assert.doesNotThrow(() =>
    verifyValidationSuiteRequirements({
      validationSubsections,
      requirements,
      criticalClaims: claims,
    }),
  );

  const swapped = structuredClone(claims);
  [swapped[0].suites, swapped[1].suites] = [
    swapped[1].suites,
    swapped[0].suites,
  ];
  assert.throws(
    () =>
      verifyValidationSuiteRequirements({
        validationSubsections,
        requirements,
        criticalClaims: swapped,
      }),
    /16\.4 suite mapping mismatch/u,
  );
});

test("requires every obligation to bind a direct semantic case beyond its broad group", () => {
  const value = fixture();
  try {
    const parsed = parseHandoff(value.markdown);
    assert.throws(
      () =>
        buildObligationLedger({
          projectRoot: value.root,
          parsed,
          coverageGroups: value.coverageGroups,
          criticalClaims: value.criticalClaims,
          acceptanceCases: value.acceptanceCases,
          suiteRegistry: value.suites,
        }),
      /must directly inventory all 3 obligations/u,
    );

    const reordered = structuredClone(value.obligationClaims);
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    assert.throws(
      () =>
        buildObligationLedger({
          projectRoot: value.root,
          parsed,
          coverageGroups: value.coverageGroups,
          criticalClaims: value.criticalClaims,
          acceptanceCases: value.acceptanceCases,
          obligationClaims: reordered,
          suiteRegistry: value.suites,
        }),
      /must directly bind/u,
    );

    const groupOnly = structuredClone(value.obligationClaims);
    groupOnly[0].caseIds = ["group:root"];
    assert.throws(
      () =>
        buildObligationLedger({
          projectRoot: value.root,
          parsed,
          coverageGroups: value.coverageGroups,
          criticalClaims: value.criticalClaims,
          acceptanceCases: value.acceptanceCases,
          obligationClaims: groupOnly,
          suiteRegistry: value.suites,
        }),
      /relies only on broad coverage groups/u,
    );
  } finally {
    cleanup(value.root);
  }
});

test("rejects a heading-wide blanket bundle when a sibling adds a distinct semantic concept", () => {
  const value = fixture();
  try {
    const markdown = value.markdown.replace(
      "- root obligation",
      "- root obligation\n- 개념적 입력은 다이얼 하나",
    );
    const parsed = parseHandoff(markdown);
    const secondCase = {
      id: "AC-ONE-CONTROL-RESULT",
      suites: ["unit"],
      claimAnchors: [
        {
          id: "ROOT-DIRECT-B-CLAIM",
          kind: "test",
          path: "tests/root.test.mjs",
          testId: "proves one conceptual dial input",
        },
      ],
    };
    const collapsed = [
      {
        obligationId: parsed.obligations[0].id,
        caseIds: [
          "group:root",
          "AC-EXPERIENCE-CAUSAL-DYNAMICS",
        ],
      },
      {
        obligationId: parsed.obligations[1].id,
        caseIds: [
          "group:root",
          "AC-EXPERIENCE-CAUSAL-DYNAMICS",
        ],
      },
      {
        obligationId: parsed.obligations[2].id,
        caseIds: [
          "VALIDATION-16.1",
          "AC-PHYSICS-FEM-CONVERGENCE",
        ],
      },
      {
        obligationId: parsed.obligations[3].id,
        caseIds: ["GATE-A0", "AC-DATA-SCHEMA-HASH"],
      },
    ];
    const input = {
      projectRoot: value.root,
      parsed,
      coverageGroups: value.coverageGroups,
      criticalClaims: value.criticalClaims,
      acceptanceCases: [...value.acceptanceCases, secondCase],
      suiteRegistry: value.suites,
    };
    assert.throws(
      () =>
        buildObligationLedger({
          ...input,
          obligationClaims: collapsed,
        }),
      /semantic concept single-control/u,
    );
    const differentiated = structuredClone(collapsed);
    differentiated[1].caseIds = [
      "group:root",
      "AC-ONE-CONTROL-RESULT",
    ];
    assert.doesNotThrow(() =>
      buildObligationLedger({
        ...input,
        obligationClaims: differentiated,
      }),
    );
  } finally {
    cleanup(value.root);
  }
});

test("rejects representative cyclic semantic mis-mappings and an unrelated executable anchor", () => {
  const projectRoot = process.cwd();
  const contract = JSON.parse(
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
  const parsed = parseHandoff(
    readFileSync(
      path.join(projectRoot, "MandelHowl_핸드오프.md"),
      "utf8",
    ),
  );
  const qualityCases = contract.qualityCriteria.map((quality) => ({
    ...quality,
    id: `QUALITY-${quality.id}`,
  }));
  const input = {
    projectRoot,
    parsed,
    coverageGroups: contract.coverageGroups,
    criticalClaims: contract.criticalClaims,
    acceptanceCases: [
      ...qualityCases,
      ...contract.acceptanceCases,
    ],
    suiteRegistry: contract.suites,
  };
  assert.doesNotThrow(() =>
    buildObligationLedger({
      ...input,
      obligationClaims: contract.obligationClaims,
    }),
  );

  const mutations = [
    {
      source: /`Hz`가 표시된 원형 다이얼/u,
      replacedCaseIds: [
        "AC-DIAL-RANGE",
        "AC-DIAL-HZ-UNOBSTRUCTED",
      ],
      wrongCaseId: "AC-RUNTIME-CRITICAL",
      expected: /semantic concept dial-range/u,
    },
    {
      source: /`VOLUME` 또는 `dB` 미터/u,
      replacedCaseIds: ["AC-OUTPUT-INTEGER-DOMAIN"],
      wrongCaseId: "AC-RUNTIME-RESIDUAL",
      expected:
        /without matching semantic evidence; expected concepts: .*integer-output/u,
    },
    {
      source: /스피커–마이크 폐루프/u,
      replacedCaseIds: ["AC-RUNTIME-MODAL-DYNAMICS"],
      wrongCaseId: "AC-FEM-MATRIX",
      expected: /semantic concept feedback-loop/u,
    },
    {
      source: /리미터가 성장한 신호/u,
      replacedCaseIds: ["AC-RUNTIME-MODAL-DYNAMICS"],
      wrongCaseId: "AC-MODAL-ORTHOGONALITY",
      expected: /semantic concept nonlinear-runtime/u,
    },
    {
      source: /WebGL 렌더러: 판, 모래, 스피커/u,
      replacedCaseIds: ["AC-SCENE-ROLES-CAUSAL"],
      wrongCaseId: "AC-AUDIO-ONE-CHAIN",
      expected: /semantic concept scene-layout/u,
    },
  ];
  for (const mutation of mutations) {
    const obligationIndex = parsed.obligations.findIndex((obligation) =>
      mutation.source.test(obligation.text),
    );
    assert.notEqual(
      obligationIndex,
      -1,
      `missing mutation source ${mutation.source}`,
    );
    const claims = structuredClone(contract.obligationClaims);
    claims[obligationIndex].caseIds = [
      ...claims[obligationIndex].caseIds.filter(
        (caseId) =>
          !mutation.replacedCaseIds.includes(caseId),
      ),
      mutation.wrongCaseId,
    ];
    assert.throws(
      () =>
        buildObligationLedger({
          ...input,
          obligationClaims: claims,
        }),
      mutation.expected,
    );
  }

  const unrelatedEvidenceContract = structuredClone(contract);
  const dialVisibilityCase =
    unrelatedEvidenceContract.acceptanceCases.find(
      ({ id }) => id === "AC-DIAL-HZ-UNOBSTRUCTED",
    );
  assert.ok(dialVisibilityCase);
  dialVisibilityCase.claimAnchors[0].testId =
    "apparatus motion is driven by canonical frequency, microphone, and feedback values";
  assert.throws(
    () =>
      buildObligationLedger({
        ...input,
        acceptanceCases: [
          ...qualityCases,
          ...unrelatedEvidenceContract.acceptanceCases,
        ],
        obligationClaims:
          unrelatedEvidenceContract.obligationClaims,
      }),
    /semantic concept dial-hz-visibility is not supported by matching executable evidence/u,
  );
});

test("rejects skipped, focused, ambiguous, and assertion-free test anchors", () => {
  const value = fixture();
  const rootTestPath = path.join(
    value.root,
    "tests",
    "root.test.mjs",
  );
  const build = () =>
    buildObligationLedger({
      projectRoot: value.root,
      parsed: parseHandoff(value.markdown),
      coverageGroups: value.coverageGroups,
      criticalClaims: value.criticalClaims,
      acceptanceCases: value.acceptanceCases,
      obligationClaims: value.obligationClaims,
      suiteRegistry: value.suites,
    });
  try {
    for (const [source, expected] of [
      [
        'test.skip("proves the root obligation", () => { assert.equal(1, 1); });\n',
        /is skip, not runnable/u,
      ],
      [
        'test.todo("proves the root obligation");\n',
        /is todo, not runnable/u,
      ],
      [
        'test.only("proves the root obligation", () => { assert.equal(1, 1); });\n',
        /contains \.only\/focused tests/u,
      ],
      [
        'describe.skip("disabled suite", () => { test("proves the root obligation", () => { assert.equal(1, 1); }); });\n',
        /is skip, not runnable/u,
      ],
      [
        'test.describe.only("focused suite", () => { test("proves the root obligation", () => { assert.equal(1, 1); }); });\n',
        /contains \.only\/focused tests/u,
      ],
      [
        'test("proves the root obligation", () => {});\n',
        /has no executable assertion/u,
      ],
      [
        'test("proves the root obligation", () => { assert.equal(1, 1); });\ntest("proves the root obligation", () => { assert.equal(2, 2); });\n',
        /resolved 2 times/u,
      ],
    ]) {
      writeFileSync(rootTestPath, source);
      assert.throws(build, expected);
    }
  } finally {
    cleanup(value.root);
  }
});

test("binds exact anchor source and test-body bytes into the ledger digest", () => {
  const value = fixture();
  try {
    const input = {
      projectRoot: value.root,
      parsed: parseHandoff(value.markdown),
      coverageGroups: value.coverageGroups,
      criticalClaims: value.criticalClaims,
      acceptanceCases: value.acceptanceCases,
      obligationClaims: value.obligationClaims,
      suiteRegistry: value.suites,
    };
    const before = buildObligationLedger(input);
    writeFileSync(
      path.join(value.root, "tests", "root.test.mjs"),
      'test("proves the root obligation", () => { assert.equal(2, 2); });\n',
    );
    const after = buildObligationLedger(input);
    assert.notEqual(after.ledgerSha256, before.ledgerSha256);
    assert.notEqual(
      after.entries[0].claimAnchors[0].sourceSha256,
      before.entries[0].claimAnchors[0].sourceSha256,
    );
    assert.notEqual(
      after.entries[0].claimAnchors[0].bodySha256,
      before.entries[0].claimAnchors[0].bodySha256,
    );
  } finally {
    cleanup(value.root);
  }
});

test("expands exact template test identities from inline const loops", () => {
  const value = fixture();
  try {
    writeFileSync(
      path.join(value.root, "tests", "inline-loop.test.ts"),
      [
        'for (const fault of ["load", "mount"] as const) {',
        "  test(`survives ${fault}`, () => { assert.equal(fault.length > 0, true); });",
        "}",
        "",
      ].join("\n"),
    );
    const claims = ["load", "mount"].map((fault) => ({
      id: `INLINE-${fault}`,
      suites: ["unit"],
      claimAnchors: [
        {
          id: `INLINE-${fault}-EXACT`,
          kind: "test",
          path: "tests/inline-loop.test.ts",
          testId: `survives ${fault}`,
        },
      ],
    }));
    assert.equal(
      verifyStandaloneClaims({
        projectRoot: value.root,
        claims,
        suiteRegistry: value.suites,
        label: "inline loop",
      }).length,
      2,
    );
  } finally {
    cleanup(value.root);
  }
});

test("discovers exact asserted Python and Rust test identities", () => {
  const value = fixture();
  try {
    writeFileSync(
      path.join(value.root, "tests", "science.py"),
      "def test_exact_science_contract():\n    assert 2 + 2 == 4\n",
    );
    writeFileSync(
      path.join(value.root, "tests", "native.rs"),
      "#[test]\nfn exact_native_contract() {\n    assert_eq!(2 + 2, 4);\n}\n",
    );
    const claims = [
      {
        id: "PYTHON",
        suites: ["science"],
        claimAnchors: [
          {
            id: "PYTHON-EXACT",
            kind: "test",
            path: "tests/science.py",
            testId: "test_exact_science_contract",
          },
        ],
      },
      {
        id: "RUST",
        suites: ["unit"],
        claimAnchors: [
          {
            id: "RUST-EXACT",
            kind: "test",
            path: "tests/native.rs",
            testId: "exact_native_contract",
          },
        ],
      },
    ];
    assert.equal(
      verifyStandaloneClaims({
        projectRoot: value.root,
        claims,
        suiteRegistry: value.suites,
        label: "language",
      }).length,
      2,
    );
  } finally {
    cleanup(value.root);
  }
});

test("accepts only executable npm suite roots with a closed script DAG", () => {
  const packageScripts = {
    "test:unit": "node --test",
    verify: "npm run test:unit",
  };
  assert.deepEqual(
    verifyExecutableSuiteRegistry({
      suiteRegistry: {
        unit: { command: "npm run test:unit" },
        verify: { command: "npm run verify -- --reporter=spec" },
      },
      packageScripts,
    }),
    [
      { id: "unit", scripts: ["test:unit"] },
      { id: "verify", scripts: ["verify"] },
    ],
  );
  assert.throws(
    () =>
      verifyExecutableSuiteRegistry({
        suiteRegistry: {
          physics: {
            command: "Linux CI quality gate + npm run verify",
          },
        },
        packageScripts,
      }),
    /only executable npm run stages/u,
  );
  assert.throws(
    () =>
      verifyExecutableSuiteRegistry({
        suiteRegistry: {
          verify: { command: "npm run verify" },
        },
        packageScripts: {
          verify: "npm run missing",
        },
      }),
    /npm script missing is missing or non-executable/u,
  );
  assert.throws(
    () =>
      verifyExecutableSuiteRegistry({
        suiteRegistry: {
          verify: { command: "npm run verify" },
        },
        packageScripts: {
          verify: "npm run verify",
        },
      }),
    /dependency cycle/u,
  );
});
