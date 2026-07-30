import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  WINDOWS_EVIDENCE_ONLY_ENVIRONMENT_VARIABLE,
  WINDOWS_NATIVE_PROHIBITED_SCRIPTS,
  verifyWindowsNpmScriptDag,
} from "./full-verification-plan.mjs";

export class HandoffVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "HandoffVerificationError";
  }
}

function fail(message) {
  throw new HandoffVerificationError(message);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resolveSafeProjectFile(projectRoot, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    fail(`${label} must be a non-empty path`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    path.isAbsolute(relativePath) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    fail(`${label} escapes the project root: ${relativePath}`);
  }
  const secretSegments = normalized.toLowerCase().split("/");
  if (
    secretSegments.some(
      (segment) =>
        segment === ".env" ||
        segment.startsWith(".env.") ||
        segment.includes("credential") ||
        segment.includes("private-key") ||
        segment.includes("service-account"),
    )
  ) {
    fail(`${label} points at a forbidden secret path: ${relativePath}`);
  }
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relativeToRoot = path.relative(projectRoot, absolutePath);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    fail(`${label} resolves outside the project root: ${relativePath}`);
  }
  return absolutePath;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
}

export function valueAtJsonPointer(root, pointer, label) {
  if (pointer === "") {
    return { exists: true, value: root };
  }
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    fail(`${label} must use an RFC 6901 JSON pointer`);
  }
  let current = root;
  for (const encodedComponent of pointer.slice(1).split("/")) {
    const component = encodedComponent
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, component)
    ) {
      return { exists: false, value: undefined };
    }
    current = current[component];
  }
  return { exists: true, value: current };
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function verifyReleaseBlockingAssertions({
  projectRoot,
  assertions,
}) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    fail("releaseBlockingAssertions must contain at least one assertion group");
  }
  const seenIds = new Set();
  const results = [];
  for (const group of assertions) {
    if (
      typeof group?.id !== "string" ||
      group.id.length === 0 ||
      seenIds.has(group.id)
    ) {
      fail(
        `release-blocking assertion ID is missing or duplicated: ${String(group?.id)}`,
      );
    }
    seenIds.add(group.id);
    if (group.releaseBlocking !== true) {
      fail(`release-blocking assertion ${group.id} is not fail-closed`);
    }
    const sourcePath = resolveSafeProjectFile(
      projectRoot,
      group.source,
      `${group.id}.source`,
    );
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      fail(
        `release-blocking assertion ${group.id} source is not a file: ${group.source}`,
      );
    }
    const source = readJson(sourcePath, `${group.id}.source`);
    if (!Array.isArray(group.claims) || group.claims.length === 0) {
      fail(`release-blocking assertion ${group.id} has no JSON claims`);
    }
    const claimResults = [];
    for (const [index, claim] of group.claims.entries()) {
      const label = `${group.id}.claims[${index}]`;
      const located = valueAtJsonPointer(source, claim.pointer, label);
      const comparatorCount = [
        Object.hasOwn(claim, "equals"),
        Object.hasOwn(claim, "notEquals"),
        Object.hasOwn(claim, "exists"),
      ].filter(Boolean).length;
      if (comparatorCount !== 1) {
        fail(`${label} must declare exactly one comparator`);
      }
      let passed = false;
      let expectation;
      if (Object.hasOwn(claim, "equals")) {
        expectation = { equals: claim.equals };
        passed = located.exists && deepEqual(located.value, claim.equals);
      } else if (Object.hasOwn(claim, "notEquals")) {
        expectation = { notEquals: claim.notEquals };
        passed =
          located.exists && !deepEqual(located.value, claim.notEquals);
      } else {
        expectation = { exists: claim.exists };
        if (typeof claim.exists !== "boolean") {
          fail(`${label}.exists must be boolean`);
        }
        passed = located.exists === claim.exists;
      }
      if (!passed) {
        fail(
          `release-blocking assertion ${group.id} failed at ${claim.pointer}; expected ${canonicalJson(
            expectation,
          )}, received ${
            located.exists ? canonicalJson(located.value) : "<missing>"
          }`,
        );
      }
      claimResults.push({
        pointer: claim.pointer,
        expectation,
        actualDigest: located.exists
          ? sha256(canonicalJson(located.value))
          : null,
      });
    }
    results.push({
      id: group.id,
      gate: group.gate ?? null,
      source: group.source,
      sourceSha256: sha256(readFileSync(sourcePath)),
      claims: claimResults,
    });
  }
  return results;
}

function normalizeObligationText(text) {
  return text.trim().replace(/\s+/gu, " ");
}

function unwrapTypeScriptExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringArray(expression) {
  const value = unwrapTypeScriptExpression(expression);
  if (!ts.isArrayLiteralExpression(value)) return null;
  const strings = [];
  for (const element of value.elements) {
    const item = unwrapTypeScriptExpression(element);
    if (
      !ts.isStringLiteral(item) &&
      !ts.isNoSubstitutionTemplateLiteral(item)
    ) {
      return null;
    }
    strings.push(item.text);
  }
  return strings;
}

function testCallKind(expression) {
  const components = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) {
    components.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  components.unshift(current.text);
  const root = components[0];
  if (!["test", "it", "describe"].includes(root)) return null;

  let family = root === "describe" ? "describe" : root;
  let disposition = "run";
  for (const component of components.slice(1)) {
    if (component === "describe" && root === "test") {
      family = "describe";
    } else if (["skip", "todo", "only"].includes(component)) {
      disposition = component;
    } else {
      return null;
    }
  }
  return { family, disposition };
}

function typeScriptTestTitle(argument, variables) {
  if (
    ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument)
  ) {
    return argument.text;
  }
  if (!ts.isTemplateExpression(argument)) return null;
  let title = argument.head.text;
  for (const span of argument.templateSpans) {
    const expression = unwrapTypeScriptExpression(span.expression);
    if (!ts.isIdentifier(expression) || !variables.has(expression.text)) {
      return null;
    }
    title += variables.get(expression.text);
    title += span.literal.text;
  }
  return title;
}

function isAssertionCall(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text === "expect" || expression.text === "assert";
  }
  if (!ts.isPropertyAccessExpression(expression)) return false;
  let root = expression.expression;
  while (ts.isPropertyAccessExpression(root)) {
    root = root.expression;
  }
  if (ts.isCallExpression(root)) {
    root = root.expression;
  }
  return (
    ts.isIdentifier(root) &&
    (root.text === "expect" || root.text === "assert")
  );
}

function typeScriptBodyHasAssertion(body) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isThrowStatement(node) ||
      (ts.isCallExpression(node) && isAssertionCall(node.expression))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function discoverTypeScriptTests(content, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const scriptKind =
    extension === ".tsx"
      ? ts.ScriptKind.TSX
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : extension === ".ts"
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS;
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (source.parseDiagnostics.length > 0) {
    fail(
      `${filePath} cannot be parsed for exact test identities: ${source.parseDiagnostics[0].messageText}`,
    );
  }

  const arrays = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined
      ) {
        continue;
      }
      const values = staticStringArray(declaration.initializer);
      if (values !== null) arrays.set(declaration.name.text, values);
    }
  }

  const tests = [];
  let focusedTestCount = 0;
  const walk = (
    node,
    {
      describeTitles = [],
      inheritedDisposition = "run",
      variables = new Map(),
    } = {},
  ) => {
    if (ts.isForOfStatement(node)) {
      const initializer = node.initializer;
      const expression = unwrapTypeScriptExpression(node.expression);
      const inlineValues = staticStringArray(expression);
      const loopValues =
        inlineValues ??
        (ts.isIdentifier(expression)
          ? arrays.get(expression.text) ?? null
          : null);
      if (
        ts.isVariableDeclarationList(initializer) &&
        initializer.declarations.length === 1 &&
        ts.isIdentifier(initializer.declarations[0].name) &&
        loopValues !== null
      ) {
        const variableName = initializer.declarations[0].name.text;
        for (const value of loopValues) {
          const nextVariables = new Map(variables);
          nextVariables.set(variableName, value);
          walk(node.statement, {
            describeTitles,
            inheritedDisposition,
            variables: nextVariables,
          });
        }
        return;
      }
    }

    if (ts.isCallExpression(node)) {
      const kind = testCallKind(node.expression);
      if (kind !== null && node.arguments.length > 0) {
        const title = typeScriptTestTitle(node.arguments[0], variables);
        const disposition =
          inheritedDisposition === "run"
            ? kind.disposition
            : inheritedDisposition;
        const callback = [...node.arguments]
          .reverse()
          .find(
            (argument) =>
              ts.isArrowFunction(argument) ||
              ts.isFunctionExpression(argument),
          );
        if (kind.family === "describe") {
          if (kind.disposition === "only") focusedTestCount += 1;
          if (title !== null && callback !== undefined) {
            walk(callback.body, {
              describeTitles: [...describeTitles, title],
              inheritedDisposition: disposition,
              variables,
            });
          }
          return;
        }
        if (kind.disposition === "only") focusedTestCount += 1;
        if (title !== null) {
          const body =
            callback === undefined
              ? ""
              : content.slice(callback.body.pos, callback.body.end);
          tests.push({
            testId: title,
            fullTestId: [...describeTitles, title].join(" > "),
            disposition,
            hasAssertion:
              callback !== undefined &&
              typeScriptBodyHasAssertion(callback.body),
            bodySha256: sha256(`${title}\0${body}`),
          });
        }
        return;
      }
    }
    ts.forEachChild(node, (child) =>
      walk(child, {
        describeTitles,
        inheritedDisposition,
        variables,
      }),
    );
  };
  walk(source);
  return { tests, focusedTestCount };
}

function pythonBodyHasAssertion(body) {
  return /(?:\bassert\s+|self\.assert[A-Za-z0-9_]*\s*\(|pytest\.raises\s*\()/u.test(
    body,
  );
}

function discoverPythonTests(content) {
  const lines = content.split(/\r?\n/u);
  const tests = [];
  let focusedTestCount = 0;
  let pendingDecorators = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const decorator = /^\s*@(.+?)\s*$/u.exec(line);
    if (decorator) {
      pendingDecorators.push(decorator[1]);
      continue;
    }
    const declaration = /^(\s*)def\s+(test_[A-Za-z0-9_]+)\s*\(/u.exec(line);
    if (!declaration) {
      if (line.trim().length > 0 && !line.trimStart().startsWith("#")) {
        pendingDecorators = [];
      }
      continue;
    }
    const indentation = declaration[1].length;
    const testId = declaration[2];
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end];
      if (candidate.trim().length === 0) {
        end += 1;
        continue;
      }
      const candidateIndent = /^\s*/u.exec(candidate)[0].length;
      if (
        candidateIndent <= indentation &&
        /^(?:\s*)(?:def|class)\s+/u.test(candidate)
      ) {
        break;
      }
      end += 1;
    }
    const body = lines.slice(index + 1, end).join("\n");
    const skipped = pendingDecorators.some((value) =>
      /(?:^|\.)(?:skip|skipIf|skipUnless)(?:\(|$)/u.test(value),
    );
    const focused = pendingDecorators.some((value) =>
      /(?:^|\.)(?:only|focus)(?:\(|$)/u.test(value),
    );
    if (focused) focusedTestCount += 1;
    tests.push({
      testId,
      fullTestId: testId,
      disposition: skipped ? "skip" : focused ? "only" : "run",
      hasAssertion: pythonBodyHasAssertion(body),
      bodySha256: sha256(`${testId}\0${body}`),
    });
    pendingDecorators = [];
    index = end - 1;
  }
  return { tests, focusedTestCount };
}

function discoverRustTests(content) {
  const tests = [];
  let focusedTestCount = 0;
  const expression =
    /((?:\s*#\[[^\]]+\]\s*)+)\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gu;
  for (const match of content.matchAll(expression)) {
    const attributes = match[1];
    if (!/#\[test\]/u.test(attributes)) continue;
    const testId = match[2];
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < content.length && depth > 0) {
      if (content[cursor] === "{") depth += 1;
      else if (content[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = content.slice(
      match.index + match[0].length,
      Math.max(match.index + match[0].length, cursor - 1),
    );
    tests.push({
      testId,
      fullTestId: testId,
      disposition: /#\[ignore(?:\([^)]*\))?\]/u.test(attributes)
        ? "skip"
        : "run",
      hasAssertion:
        /\b(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne)!\s*\(/u.test(
          body,
        ),
      bodySha256: sha256(`${testId}\0${body}`),
    });
  }
  return { tests, focusedTestCount };
}

function discoverExactTests(content, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".py") return discoverPythonTests(content);
  if (extension === ".rs") return discoverRustTests(content);
  if (
    [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)
  ) {
    return discoverTypeScriptTests(content, filePath);
  }
  fail(`test anchor uses an unsupported source language: ${filePath}`);
}

export function parseHandoff(markdown) {
  const headings = [];
  const obligations = [];
  const obligationsByHeading = new Map();
  const lines = markdown.split(/\r?\n/u);
  let activeHeading = null;
  let codeFence = null;

  const appendObligation = ({
    text,
    sourceLine,
    marker,
  }) => {
    if (activeHeading === null) return;
    const normalizedText = normalizeObligationText(text);
    if (normalizedText.length === 0) return;
    const headingObligations =
      obligationsByHeading.get(activeHeading) ?? [];
    const ordinalInHeading = headingObligations.length + 1;
    const textDigest = sha256(normalizedText);
    const stableHeading = activeHeading.replaceAll(".", "-");
    const obligation = {
      id: `MH-HO-${stableHeading}-${String(ordinalInHeading).padStart(
        3,
        "0",
      )}-${textDigest.slice(0, 12)}`,
      headingId: activeHeading,
      ordinalInHeading,
      sourceLine,
      sourceDigest: textDigest,
      marker,
      text: normalizedText,
    };
    headingObligations.push(obligation);
    obligationsByHeading.set(activeHeading, headingObligations);
    obligations.push(obligation);
  };

  for (const [zeroBasedLine, line] of lines.entries()) {
    if (codeFence !== null) {
      if (/^\s*```\s*$/u.test(line)) {
        appendObligation({
          text: codeFence.lines.join(" "),
          sourceLine: codeFence.sourceLine,
          marker: "code-flow",
        });
        codeFence = null;
      } else if (line.trim().length > 0) {
        codeFence.lines.push(line.trim());
      }
      continue;
    }

    const heading =
      /^(##|###)\s+((?:\d+(?:\.\d+)?)|(?:[A-G]\d))(?:\.)?\s+/u.exec(
        line,
      );
    if (heading) {
      activeHeading = heading[2];
      headings.push({
        id: activeHeading,
        level: heading[1].length,
        line: zeroBasedLine + 1,
      });
      if (!obligationsByHeading.has(activeHeading)) {
        obligationsByHeading.set(activeHeading, []);
      }
      continue;
    }

    if (activeHeading === null) {
      continue;
    }
    if (/^\s*```/u.test(line)) {
      codeFence = {
        sourceLine: zeroBasedLine + 2,
        lines: [],
      };
      continue;
    }
    if (
      line.trim().length === 0 ||
      /^\s*---+\s*$/u.test(line)
    ) {
      continue;
    }

    const listItem = /^\s*(?:-\s+|(\d+)\.\s+)(\S.*)$/u.exec(line);
    if (listItem) {
      appendObligation({
        text: listItem[2],
        sourceLine: zeroBasedLine + 1,
        marker: listItem[1] === undefined ? "bullet" : "ordered",
      });
      continue;
    }

    if (/^\s*\|.*\|\s*$/u.test(line)) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      const nextLine = lines[zeroBasedLine + 1] ?? "";
      const nextCells = /^\s*\|.*\|\s*$/u.test(nextLine)
        ? nextLine
            .trim()
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim())
        : [];
      const isDelimiter = cells.every((cell) =>
        /^:?-{3,}:?$/u.test(cell),
      );
      const isHeader =
        nextCells.length === cells.length &&
        nextCells.every((cell) => /^:?-{3,}:?$/u.test(cell));
      if (!isDelimiter && !isHeader) {
        appendObligation({
          text: cells.join(": "),
          sourceLine: zeroBasedLine + 1,
          marker: "table-row",
        });
      }
      continue;
    }

    const quote = /^\s*>\s*(\S.*)$/u.exec(line);
    appendObligation({
      text: quote?.[1] ?? line,
      sourceLine: zeroBasedLine + 1,
      marker: quote === null ? "narrative" : "blockquote",
    });
  }

  if (codeFence !== null) {
    fail(
      `handoff contains an unclosed code fence at line ${codeFence.sourceLine - 1}`,
    );
  }

  return {
    headings,
    obligations,
    obligationsByHeading,
    lines,
  };
}

/*
 * A line-count ledger proves that every handoff sentence has an owner, but it
 * cannot by itself prove that the selected test is about the same requirement.
 * Keep this deliberately small semantic vocabulary between the Korean handoff
 * and the executable acceptance cases. The classifier below derives concepts
 * from the source heading and normative text; obligationClaims are only valid
 * when their non-structural acceptance cases cover every derived concept.
 */
const SEMANTIC_ACCEPTANCE_CONCEPTS = Object.freeze({
  "project-causality": {
    preferredCaseId: "AC-EXPERIENCE-CAUSAL-DYNAMICS",
    compatibleCaseIds: [
      "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      "AC-SCENE-ROLES-CAUSAL",
      "AC-SCIENTIFIC-COPY-CAUSAL",
      "AC-ONE-CONTROL-RESULT",
      "AC-WHOLE-VERIFICATION-DAG",
      "QUALITY-1",
    ],
  },
  "single-control": {
    preferredCaseId: "AC-ONE-CONTROL-RESULT",
    compatibleCaseIds: [
      "AC-ONE-CONTROL-RESULT",
      "AC-INPUT-MODALITIES-DYNAMICS",
      "AC-INPUT-UNIFIED",
      "AC-EXPLICIT-NONSCOPE",
      "QUALITY-2",
    ],
  },
  "integer-output": {
    preferredCaseId: "AC-OUTPUT-INTEGER-DOMAIN",
    compatibleCaseIds: [
      "AC-ONE-CONTROL-RESULT",
      "AC-OUTPUT-INTEGER-DOMAIN",
      "AC-OUTPUT-SETTLED",
      "AC-OUTPUT-READONLY",
      "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      "QUALITY-3",
    ],
  },
  "settled-output": {
    preferredCaseId: "AC-OUTPUT-SETTLED",
    compatibleCaseIds: [
      "AC-OUTPUT-SETTLED",
      "AC-OUTPUT-READONLY",
      "AC-SNAPSHOT-ONE-FANOUT",
      "AC-ARCH-DIAGNOSTICS-FANOUT",
    ],
  },
  "extreme-distribution": {
    preferredCaseId: "AC-E0-FULL-REPLAY-STATIC",
    compatibleCaseIds: [
      "AC-E0-FULL-REPLAY-STATIC",
      "AC-RUNTIME-MODAL-DYNAMICS",
      "AC-RUNTIME-GROWTH",
      "AC-RUNTIME-DECAY",
      "AC-RUNTIME-CRITICAL",
      "AC-RUNTIME-THRESHOLDS",
      "AC-RUNTIME-COMPLETE-REPLAY",
      "QUALITY-4",
      "QUALITY-5",
    ],
  },
  reachability: {
    preferredCaseId: "AC-RUNTIME-COMPLETE-REPLAY",
    compatibleCaseIds: [
      "AC-E0-FULL-REPLAY-STATIC",
      "AC-RUNTIME-COMPLETE-REPLAY",
      "AC-RUNTIME-DETERMINISTIC",
      "QUALITY-5",
    ],
  },
  "scientific-causal-copy": {
    preferredCaseId: "AC-SCIENTIFIC-COPY-CAUSAL",
    compatibleCaseIds: [
      "AC-SCIENTIFIC-COPY-CAUSAL",
      "AC-SCIENCE-MATERIAL-MODES",
      "AC-SCIENTIFIC-COPY-FORBIDDEN",
      "QUALITY-8",
      "QUALITY-9",
    ],
  },
  "scientific-forbidden-copy": {
    preferredCaseId: "AC-SCIENTIFIC-COPY-FORBIDDEN",
    compatibleCaseIds: [
      "AC-SCIENTIFIC-COPY-FORBIDDEN",
      "AC-SCIENTIFIC-NONSCOPE",
      "QUALITY-9",
    ],
  },
  "scientific-nonscope": {
    preferredCaseId: "AC-SCIENTIFIC-NONSCOPE",
    compatibleCaseIds: [
      "AC-SCIENTIFIC-NONSCOPE",
      "AC-EXPLICIT-NONSCOPE",
      "AC-SCIENTIFIC-COPY-FORBIDDEN",
    ],
  },
  "material-field": {
    preferredCaseId: "AC-SCIENCE-MATERIAL-MODES",
    compatibleCaseIds: [
      "AC-SCIENCE-MATERIAL-MODES",
      "AC-MATERIAL-MANDELBROT",
      "AC-MATERIAL-BOUNDS",
      "AC-MATERIAL-CROSS-FIELD",
      "QUALITY-8",
    ],
  },
  "material-limits": {
    preferredCaseId: "AC-MATERIAL-CROSS-FIELD",
    compatibleCaseIds: [
      "AC-SCIENCE-MATERIAL-MODES",
      "AC-MATERIAL-BOUNDS",
      "AC-MATERIAL-CROSS-FIELD",
    ],
  },
  "plate-contract": {
    preferredCaseId: "AC-MATERIAL-CROSS-FIELD",
    compatibleCaseIds: [
      "AC-MATERIAL-CROSS-FIELD",
      "AC-SCIENCE-MATERIAL-MODES",
      "AC-FEM-CLAMPED-HUB",
      "AC-VISUAL-POLAR-DISC",
    ],
  },
  "fem-solver": {
    preferredCaseId: "AC-PHYSICS-FEM-CONVERGENCE",
    compatibleCaseIds: [
      "AC-PHYSICS-FEM-CONVERGENCE",
      "AC-FEM-CLAMPED-HUB",
      "AC-FEM-MATRIX",
      "AC-MODAL-ORTHOGONALITY",
      "AC-RESPONSE-COUPLING",
    ],
  },
  "solver-diagnostic": {
    preferredCaseId: "AC-SOLVER-STRUCTURED-ERROR",
    compatibleCaseIds: [
      "AC-SOLVER-STRUCTURED-ERROR",
      "AC-ARCH-DIAGNOSTICS-FANOUT",
      "AC-DIAGNOSTIC-CODES",
    ],
  },
  "mode-postprocess": {
    preferredCaseId: "AC-PHYSICS-POSTPROCESS-TEXTURES",
    compatibleCaseIds: [
      "AC-PHYSICS-POSTPROCESS-TEXTURES",
      "AC-POSTPROCESS-MODE-LINK",
      "AC-SAND-PLATE-MASK",
      "AC-RESPONSE-COUPLING",
      "AC-MODAL-ORTHOGONALITY",
    ],
  },
  "sand-physics": {
    preferredCaseId: "AC-PHYSICS-POSTPROCESS-TEXTURES",
    compatibleCaseIds: [
      "AC-PHYSICS-POSTPROCESS-TEXTURES",
      "AC-POSTPROCESS-MODE-LINK",
      "AC-SAND-PLATE-MASK",
      "AC-VISUAL-SAND-MOTION",
      "QUALITY-7",
    ],
  },
  "generated-assets": {
    preferredCaseId: "AC-GENERATED-ASSET-IMMUTABLE",
    compatibleCaseIds: [
      "AC-GENERATED-ASSET-IMMUTABLE",
      "AC-GENERATED-ASSET-SOURCE-IDENTITY",
      "AC-GENERATED-ASSET-NO-DIRECT-EDIT",
      "AC-DATA-SCHEMA-HASH",
    ],
  },
  "dataset-package": {
    preferredCaseId: "AC-DATA-SCHEMA-HASH",
    compatibleCaseIds: [
      "AC-DATA-SCHEMA-HASH",
      "AC-DATASET-CONTENT-HASH",
      "AC-DATASET-CANONICAL-PIN",
      "AC-SHARD-PACKAGED-4X12X4",
      "AC-KTX2-CONTRACT",
      "AC-SECURITY-VERIFIED-ASSETS",
    ],
  },
  "dial-range": {
    preferredCaseId: "AC-DIAL-RANGE",
    compatibleCaseIds: [
      "AC-DIAL-RANGE",
      "AC-INPUT-MODALITIES-DYNAMICS",
      "AC-ONE-CONTROL-RESULT",
    ],
  },
  "dial-geometry": {
    preferredCaseId: "AC-DIAL-WRAP",
    compatibleCaseIds: [
      "AC-DIAL-WRAP",
      "AC-DIAL-DEAD-ZONE",
      "AC-INPUT-MODALITIES-DYNAMICS",
    ],
  },
  "dial-dead-zone": {
    preferredCaseId: "AC-DIAL-DEAD-ZONE",
    compatibleCaseIds: [
      "AC-DIAL-DEAD-ZONE",
      "AC-INPUT-MODALITIES-DYNAMICS",
    ],
  },
  "dial-endstop": {
    preferredCaseId: "AC-DIAL-ENDSTOP",
    compatibleCaseIds: [
      "AC-DIAL-ENDSTOP",
      "AC-INPUT-MODALITIES-DYNAMICS",
    ],
  },
  "dial-dynamics": {
    preferredCaseId: "AC-DIAL-VELOCITY",
    compatibleCaseIds: [
      "AC-DIAL-VELOCITY",
      "AC-DIAL-ENDSTOP",
      "AC-DIAL-HISTORY",
      "AC-INPUT-MODALITIES-DYNAMICS",
    ],
  },
  "dial-history": {
    preferredCaseId: "AC-DIAL-HISTORY",
    compatibleCaseIds: [
      "AC-DIAL-HISTORY",
      "AC-INPUT-MODALITIES-DYNAMICS",
      "AC-RUNTIME-DETERMINISTIC",
    ],
  },
  "pointer-capture": {
    preferredCaseId: "AC-POINTER-CAPTURE-LIFECYCLE",
    compatibleCaseIds: [
      "AC-POINTER-CAPTURE-LIFECYCLE",
      "AC-INPUT-MODALITIES-DYNAMICS",
    ],
  },
  "input-accessibility": {
    preferredCaseId: "AC-INPUT-MODALITIES-DYNAMICS",
    compatibleCaseIds: [
      "AC-INPUT-MODALITIES-DYNAMICS",
      "AC-INPUT-UNIFIED",
      "AC-ACCESSIBILITY-FALLBACKS",
      "QUALITY-16",
    ],
  },
  "history-determinism": {
    preferredCaseId: "AC-RUNTIME-DETERMINISTIC",
    compatibleCaseIds: [
      "AC-RUNTIME-DETERMINISTIC",
      "AC-DIAL-HISTORY",
      "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      "AC-RUNTIME-CAPTURE-IDENTITY",
      "AC-RUNTIME-MODAL-DYNAMICS",
      "QUALITY-6",
      "QUALITY-12",
    ],
  },
  "feedback-loop": {
    preferredCaseId: "AC-RUNTIME-MODAL-DYNAMICS",
    compatibleCaseIds: [
      "AC-RUNTIME-MODAL-DYNAMICS",
      "AC-RUNTIME-BIQUAD",
      "AC-RUNTIME-MIC-RETURN-SUM",
      "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      "AC-SCENE-ROLES-CAUSAL",
    ],
  },
  "nonlinear-runtime": {
    preferredCaseId: "AC-RUNTIME-MODAL-DYNAMICS",
    compatibleCaseIds: [
      "AC-RUNTIME-MODAL-DYNAMICS",
      "AC-RUNTIME-GROWTH",
      "AC-RUNTIME-DECAY",
      "AC-RUNTIME-CRITICAL",
      "AC-RUNTIME-THRESHOLDS",
      "AC-RUNTIME-RESIDUAL",
    ],
  },
  "residual-capture": {
    preferredCaseId: "AC-EXPERIENCE-CAUSAL-DYNAMICS",
    compatibleCaseIds: [
      "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      "AC-RUNTIME-CAPTURE-IDENTITY",
      "AC-RUNTIME-RESIDUAL",
      "AC-RUNTIME-GROWTH",
      "AC-VISUAL-IMMEDIATE-CAPTURE",
      "AC-VISUAL-RESIDUAL",
    ],
  },
  "fixed-step": {
    preferredCaseId: "AC-RUNTIME-FRAME-INDEPENDENT",
    compatibleCaseIds: [
      "AC-RUNTIME-FRAME-INDEPENDENT",
      "AC-RUNTIME-DETERMINISTIC",
      "AC-RUNTIME-MODAL-DYNAMICS",
      "AC-RUNTIME-HOTPATH",
      "QUALITY-12",
    ],
  },
  "pause-resume": {
    preferredCaseId: "AC-RUNTIME-PAUSE-RESUME",
    compatibleCaseIds: [
      "AC-RUNTIME-PAUSE-RESUME",
      "AC-RUNTIME-FRAME-INDEPENDENT",
      "AC-RUNTIME-MODAL-DYNAMICS",
    ],
  },
  "snapshot-fanout": {
    preferredCaseId: "AC-ARCH-DIAGNOSTICS-FANOUT",
    compatibleCaseIds: [
      "AC-ARCH-DIAGNOSTICS-FANOUT",
      "AC-SNAPSHOT-ONE-FANOUT",
      "AC-SNAPSHOT-CLOSED-SCHEMA",
      "AC-SNAPSHOT-READONLY",
      "AC-SNAPSHOT-READONLY-CONSUMERS",
      "AC-OUTPUT-SETTLED",
    ],
  },
  "scene-layout": {
    preferredCaseId: "AC-SCENE-ROLES-CAUSAL",
    compatibleCaseIds: [
      "AC-SCENE-ROLES-CAUSAL",
      "AC-SCENE-SOURCE-ORDER",
      "AC-EXPERIENCE-CAUSAL-DYNAMICS",
      "QUALITY-1",
    ],
  },
  "apparatus-motion": {
    preferredCaseId: "AC-SCENE-ROLES-CAUSAL",
    compatibleCaseIds: [
      "AC-SCENE-ROLES-CAUSAL",
      "AC-SCENE-SIGNAL-MOTION",
      "AC-EXPERIENCE-CAUSAL-DYNAMICS",
    ],
  },
  oscilloscope: {
    preferredCaseId: "AC-SCOPE-LEGIBILITY",
    compatibleCaseIds: [
      "AC-SCOPE-LEGIBILITY",
      "AC-SCENE-ROLES-CAUSAL",
    ],
  },
  "dial-hz-visibility": {
    preferredCaseId: "AC-DIAL-HZ-UNOBSTRUCTED",
    compatibleCaseIds: [
      "AC-DIAL-HZ-UNOBSTRUCTED",
      "AC-DIAL-RANGE",
    ],
  },
  "plate-visual": {
    preferredCaseId: "AC-VISUAL-SAND-MOTION",
    compatibleCaseIds: [
      "AC-VISUAL-SAND-MOTION",
      "AC-VISUAL-POLAR-DISC",
      "AC-VISUAL-MULTIMODE",
      "AC-VISUAL-GRAINS",
      "AC-VISUAL-IMMEDIATE-CAPTURE",
      "AC-VISUAL-RESIDUAL",
      "AC-PHYSICS-POSTPROCESS-TEXTURES",
      "QUALITY-7",
    ],
  },
  "ddd-physical": {
    preferredCaseId: "AC-VISUAL-NINE-STATES",
    compatibleCaseIds: [
      "AC-VISUAL-NINE-STATES",
      "AC-VISUAL-SAND-MOTION",
      "AC-SCENE-ROLES-CAUSAL",
      "AC-SCIENTIFIC-NONSCOPE",
    ],
  },
  "motion-safety": {
    preferredCaseId: "AC-ACCESSIBILITY-FALLBACKS",
    compatibleCaseIds: [
      "AC-ACCESSIBILITY-FALLBACKS",
      "AC-VISUAL-NINE-STATES",
      "AC-VISUAL-SAND-MOTION",
      "QUALITY-17",
    ],
  },
  "audio-synthesis": {
    preferredCaseId: "AC-AUDIO-SAFETY-SIGNAL",
    compatibleCaseIds: [
      "AC-AUDIO-SAFETY-SIGNAL",
      "AC-AUDIO-SOURCE-BUDGET",
      "AC-AUDIO-ONE-CHAIN",
    ],
  },
  "audio-activation": {
    preferredCaseId: "AC-AUDIO-ACTIVATION-LIFECYCLE",
    compatibleCaseIds: [
      "AC-AUDIO-ACTIVATION-LIFECYCLE",
      "AC-AUDIO-ACTIVATION",
    ],
  },
  "audio-safety": {
    preferredCaseId: "AC-AUDIO-SAFETY-SIGNAL",
    compatibleCaseIds: [
      "AC-AUDIO-SAFETY-SIGNAL",
      "AC-AUDIO-SOURCE-BUDGET",
      "AC-AUDIO-TWO-SECOND-RAMP",
      "AC-AUDIO-ONE-CHAIN",
      "AC-AUDIO-ACTIVATION-LIFECYCLE",
      "QUALITY-10",
    ],
  },
  "audio-lifecycle-fade": {
    preferredCaseId: "AC-AUDIO-HIDDEN-FADE",
    compatibleCaseIds: [
      "AC-AUDIO-HIDDEN-FADE",
      "AC-AUDIO-ACTIVATION-LIFECYCLE",
      "AC-AUDIO-SAFETY-SIGNAL",
    ],
  },
  "no-microphone": {
    preferredCaseId: "AC-AUDIO-NO-MIC",
    compatibleCaseIds: [
      "AC-AUDIO-NO-MIC",
      "AC-AUDIO-ACTIVATION-LIFECYCLE",
      "AC-SECURITY-PRIVACY-BOUNDARIES",
      "QUALITY-11",
    ],
  },
  ownership: {
    preferredCaseId: "AC-ARCH-DIAGNOSTICS-FANOUT",
    compatibleCaseIds: [
      "AC-ARCH-DIAGNOSTICS-FANOUT",
      "AC-ARCH-OWNERSHIP",
      "AC-GENERATED-ASSET-IMMUTABLE",
      "AC-GENERATED-ASSET-SOURCE-IDENTITY",
      "AC-GENERATED-ASSET-NO-DIRECT-EDIT",
    ],
  },
  "architecture-boundary": {
    preferredCaseId: "AC-ARCH-CORE-BOUNDARY",
    compatibleCaseIds: [
      "AC-ARCH-CORE-BOUNDARY",
      "AC-ARCH-DIAGNOSTICS-FANOUT",
      "AC-ARCH-OWNERSHIP",
      "AC-SNAPSHOT-READONLY-CONSUMERS",
    ],
  },
  diagnostics: {
    preferredCaseId: "AC-ARCH-DIAGNOSTICS-FANOUT",
    compatibleCaseIds: [
      "AC-ARCH-DIAGNOSTICS-FANOUT",
      "AC-DIAGNOSTIC-CODES",
      "AC-DIAGNOSTIC-REDACTION",
      "AC-KTX2-CONTRACT",
      "QUALITY-15",
    ],
  },
  "schema-contract": {
    preferredCaseId: "AC-DATA-SCHEMA-HASH",
    compatibleCaseIds: [
      "AC-DATA-SCHEMA-HASH",
      "AC-SNAPSHOT-CLOSED-SCHEMA",
      "AC-SNAPSHOT-READONLY",
      "AC-SNAPSHOT-READONLY-CONSUMERS",
      "AC-KTX2-CONTRACT",
      "AC-DATASET-CONTENT-HASH",
    ],
  },
  hotpath: {
    preferredCaseId: "AC-PERFORMANCE-HOTPATH-GOVERNOR",
    compatibleCaseIds: [
      "AC-PERFORMANCE-HOTPATH-GOVERNOR",
      "AC-RUNTIME-HOTPATH",
      "AC-PERFORMANCE-GOVERNOR",
      "AC-RUNTIME-FRAME-INDEPENDENT",
    ],
  },
  "lazy-assets": {
    preferredCaseId: "AC-SHARD-LAZY-VERIFIED-RESIDENCY",
    compatibleCaseIds: [
      "AC-SHARD-LAZY-VERIFIED-RESIDENCY",
      "AC-SHARD-PACKAGED-4X12X4",
      "AC-KTX2-CONTRACT",
      "AC-ORDERED-DEGRADATION",
    ],
  },
  degradation: {
    preferredCaseId: "AC-ORDERED-DEGRADATION",
    compatibleCaseIds: [
      "AC-ORDERED-DEGRADATION",
      "AC-PERFORMANCE-GOVERNOR",
      "AC-PERFORMANCE-HOTPATH-GOVERNOR",
      "AC-ACCESSIBILITY-FALLBACKS",
      "QUALITY-13",
    ],
  },
  "visual-regression": {
    preferredCaseId: "AC-VISUAL-NINE-STATES",
    compatibleCaseIds: [
      "AC-VISUAL-NINE-STATES",
      "AC-VISUAL-SAND-MOTION",
      "AC-ORDERED-DEGRADATION",
    ],
  },
  soak: {
    preferredCaseId: "AC-PERFORMANCE-SOAK",
    compatibleCaseIds: [
      "AC-PERFORMANCE-SOAK",
      "AC-PERFORMANCE-HOTPATH-GOVERNOR",
      "QUALITY-18",
    ],
  },
  "security-privacy": {
    preferredCaseId: "AC-SECURITY-PRIVACY-BOUNDARIES",
    compatibleCaseIds: [
      "AC-SECURITY-PRIVACY-BOUNDARIES",
      "AC-SECURITY-RUNTIME-SURFACE",
      "AC-RUNTIME-NO-MASTER-VOLUME",
      "AC-RELEASE-CSP",
      "AC-DIAGNOSTIC-REDACTION",
    ],
  },
  "master-volume": {
    preferredCaseId: "AC-RUNTIME-NO-MASTER-VOLUME",
    compatibleCaseIds: [
      "AC-RUNTIME-NO-MASTER-VOLUME",
      "AC-EXPLICIT-NONSCOPE",
    ],
  },
  "verified-assets": {
    preferredCaseId: "AC-SECURITY-VERIFIED-ASSETS",
    compatibleCaseIds: [
      "AC-SECURITY-VERIFIED-ASSETS",
      "AC-DATA-SCHEMA-HASH",
      "AC-DATASET-CONTENT-HASH",
      "AC-SHADER-ALLOWLIST",
    ],
  },
  "release-provenance": {
    preferredCaseId: "AC-RELEASE-PROVENANCE",
    compatibleCaseIds: [
      "AC-RELEASE-PROVENANCE",
      "AC-NVERSION-FULL-OCI-ATTESTATION",
      "AC-SECURITY-PINNED-OCI",
      "AC-WHOLE-VERIFICATION-DAG",
      "QUALITY-14",
    ],
  },
  "release-license": {
    preferredCaseId: "AC-LICENSE-INVENTORY",
    compatibleCaseIds: [
      "AC-LICENSE-INVENTORY",
      "AC-RELEASE-SECURITY-DIGESTS",
    ],
  },
  "release-security": {
    preferredCaseId: "AC-RELEASE-CSP",
    compatibleCaseIds: [
      "AC-RELEASE-CSP",
      "AC-RELEASE-SECURITY-DIGESTS",
      "AC-SHADER-ALLOWLIST",
      "AC-SECURITY-PINNED-OCI",
    ],
  },
  "explicit-nonscope": {
    preferredCaseId: "AC-EXPLICIT-NONSCOPE",
    compatibleCaseIds: [
      "AC-EXPLICIT-NONSCOPE",
      "AC-SCIENTIFIC-NONSCOPE",
      "AC-RUNTIME-NO-MASTER-VOLUME",
      "AC-AUDIO-NO-MIC",
      "AC-SECURITY-RUNTIME-SURFACE",
    ],
  },
  "challenge-readonly": {
    preferredCaseId: "AC-OUTPUT-READONLY",
    compatibleCaseIds: [
      "AC-OUTPUT-READONLY",
      "AC-ONE-CONTROL-RESULT",
    ],
  },
});

const SEMANTIC_EVIDENCE_PATTERNS = Object.freeze({
  "project-causality":
    /causal|one conceptual dial|whole-handoff|speaker, plate, and microphone|root obligation/u,
  "single-control":
    /one conceptual dial|same canonical dial|accepted keyboard language/u,
  "integer-output":
    /integer result|integer result domain|settled integer|read-only target/u,
  "settled-output":
    /settled output|settled number|same object|canonical runtime snapshot/u,
  "extreme-distribution":
    /uniform static extreme|0\.\.100 trajectory|virtual limiter|decays to zero|critical behavior|growth-slope/u,
  reachability: /0\.\.100 trajectory|every generated 0\.\.100/u,
  "scientific-causal-copy":
    /causal chain|mandelbrot|material.*eigenproblem|scientific provenance/u,
  "scientific-forbidden-copy":
    /forbidden scientific claims|scientific provenance conditional|fractal exploration/u,
  "scientific-nonscope":
    /fractal exploration|gambling-style|one conceptual dial|real microphone|reachability search/u,
  "material-field":
    /mandelbrot|material|cross field|eigenproblem|symmetry and limits/u,
  "material-limits":
    /bounds|cross field|symmetry and limits|data-backed and bounded/u,
  "plate-contract":
    /cross field|clamped hub|tessellated polar|plate contract/u,
  "fem-solver":
    /finite element|finite-strip|hermite|mass and stiffness|orthogonality|convergence|modal coupling|physics validation/u,
  "solver-diagnostic": /solver failures.*structured/u,
  "mode-postprocess":
    /nodal and sand|channel layout|material section|modal coupling|orthogonality|ktx2/u,
  "sand-physics": /sand|nodal|chladni/u,
  "generated-assets":
    /baked package immutable|source identity|direct generated-byte|canonical yaml/u,
  "dataset-package":
    /content-addressed|manifest-relative|canonical release pin|ktx2|shard|dataset/u,
  "dial-range":
    /generated 45\.\.6000|frequency range|conceptual dial/u,
  "dial-geometry": /unwrap|pointer geometry|canonical dial path/u,
  "dial-dead-zone": /dead zone/u,
  "dial-endstop": /end stop|overscrolled/u,
  "dial-dynamics":
    /velocity|end stop|gesture trace|fast, slow|sweep history/u,
  "dial-history": /gesture trace|sweep history|deterministic/u,
  "pointer-capture": /lost pointer capture|gesture owner/u,
  "input-accessibility":
    /keyboard|touch|wheel|screen|react and svelte|accessible dial/u,
  "history-determinism":
    /deterministic|gesture trace|capture histories|captured mode identity|frame-rate independent/u,
  "feedback-loop":
    /biquad|microphone returns|feedback|causal|virtual limiter/u,
  "nonlinear-runtime":
    /grows|decays|critical|threshold|residual|modal dynamics|virtual limiter/u,
  "residual-capture":
    /capture|captured|residual|speed- and direction-dependent/u,
  "fixed-step":
    /frame-rate independent|deterministic|hot-path|paused-tab gap/u,
  "pause-resume": /paused-tab gap|delayed transients|safe resume/u,
  "snapshot-fanout":
    /canonical runtime snapshot|same object|read-only canonical snapshot|settled output|exact same object/u,
  "scene-layout":
    /speaker, plate, and microphone|apparatus|scene read order|causal motion/u,
  "apparatus-motion":
    /microphone and feedback motion|apparatus motion|speaker, plate, microphone, and cable/u,
  oscilloscope:
    /waveform legible|oscilloscope signal|microphone scope/u,
  "dial-hz-visibility": /dial hand cover hz|frequency unobstructed/u,
  "plate-visual":
    /tessellated polar|modal layers|grains|baked sand|captured mode|residual|nodal and sand|plate paints/u,
  "ddd-physical":
    /fixed presenter state|plate paints|causal motion|sand motion/u,
  "motion-safety":
    /reduced motion|reduced-motion|accessibility|fallbacks/u,
  "audio-synthesis":
    /source budget|signed phase|modal frequencies|one limiter chain/u,
  "audio-activation":
    /audiocontext|simulates before activation|audio graph|activation gesture|hide, resume/u,
  "audio-safety":
    /safe maximum|peak and rms|limiter|gain|exposure|hidden fade|audio chain/u,
  "audio-lifecycle-fade":
    /hidden fade|hide, resume|fade-out|runtime audiocontext error/u,
  "no-microphone": /never requests a real microphone/u,
  ownership:
    /dependency direction|ownership|baked package immutable|source identity|virtual-volume ownership/u,
  "architecture-boundary":
    /core independent|dependency direction|modal integration.*out of app|read-only canonical snapshot consumers/u,
  diagnostics:
    /diagnostic|codes|fallbacks|redacts|stable codes|fails closed/u,
  "schema-contract":
    /canonical yaml|closed schema|snapshot field|ktx2|manifest-relative|content-addressed|implementation gate/u,
  hotpath:
    /hot-path|object graph|render projection|renderer status|performance budget|allocation-free/u,
  "lazy-assets":
    /zero eager|shard|prefetch|least-recently-used|in-band|canvas texture/u,
  degradation:
    /degradation order|ordered degradation|quality without changing|canvas2d|webgl2 and canvas/u,
  "visual-regression": /fixed presenter state|canvas fallback|reduced motion/u,
  soak: /soak|bounded during/u,
  "security-privacy":
    /randomness, permission apis and html|outbound channels|master-volume|redacts|csp/u,
  "master-volume": /master-volume/u,
  "verified-assets": /verified loadbytes|hash pass|shader allowlist|content-addressed/u,
  "release-provenance":
    /release provenance|attestation|pinned oci|whole-handoff|release lock|manifest frequency and solver/u,
  "release-license": /licenses:check|license inventory/u,
  "release-security": /release csp|security-header|shader allowlist|oci context/u,
  "explicit-nonscope":
    /one conceptual dial|real microphone|fractal exploration|reachability search|master-volume|quality without changing/u,
  "challenge-readonly": /challenge target read-only|read-only target/u,
});

function semanticEvidenceText(acceptanceCase) {
  const source = acceptanceCase.claim.anchors
    .map((anchor) => canonicalJson(anchor.selector))
    .join("\n")
    .toLowerCase();
  return `${source}\n${source.replace(/[_-]+/gu, " ")}`;
}

function addMatchingConcepts(target, text, rules) {
  for (const [conceptId, expression] of rules) {
    if (expression.test(text)) target.add(conceptId);
  }
}

export function semanticConceptsForObligation(obligation) {
  const concepts = new Set();
  const heading = obligation.headingId;
  const text = obligation.text;
  const headingNumber = Number.parseInt(heading, 10);

  if (["1", "2", "3", "4", "21"].includes(heading)) {
    concepts.add("project-causality");
    addMatchingConcepts(concepts, text, [
      ["single-control", /개념적 입력|입력은 하나|다이얼 하나|별도의 조절|DRIVE FREQUENCY/u],
      ["integer-output", /개념적 출력|0~100|0\.\.100|VOLUME|dB 미터|볼륨/u],
      ["extreme-distribution", /대부분|임계|1[~.]{1,2}99|볼륨 0|볼륨 100|폭주/u],
      ["feedback-loop", /피드백|스피커.?[–-]?마이크|마이크.*되돌/u],
      ["material-field", /만델브로|질량|두께|물성/u],
      ["scene-layout", /화면 중앙|금속판|스피커|마이크|케이블|오실로스코프|모래/u],
      ["dial-range", /Hz|주파수 다이얼/u],
      ["dial-hz-visibility", /`Hz`가 표시|`Hz` 다이얼|Hz.*다이얼|다이얼.*Hz/u],
      ["history-determinism", /접근 방향|회전 속도|직전 잔향|숨겨진 랜덤/u],
      ["residual-capture", /잔류 진동|잔향/u],
    ]);
  } else if (heading.startsWith("5.")) {
    concepts.add("scientific-causal-copy");
    addMatchingConcepts(concepts, text, [
      ["scientific-forbidden-copy", /사용하지 않는다|“|무한 정밀|반드시|직접 생성|프랙탈만/u],
      ["material-field", /만델브로|물성|두께|질량|밀도|강성|재료/u],
      ["material-limits", /최소 특징|최소 연결|제작 가능|유한 해상도/u],
      ["plate-contract", /평평한 원형|원형 전면|고정 허브|외곽 경계|가진점|마이크 측정점/u],
      ["fem-solver", /판의 고유|고유값|고유모드|탄성판|경계|고정 허브|수렴성|솔버|메시/u],
      ["mode-postprocess", /고유진동수|변위장|속도|가속도|결합 계수|전달응답|텍스처|provenance/u],
      ["sand-physics", /Chladni|모래|마디/u],
      ["feedback-loop", /스피커.?[–-]?마이크|폐루프|피드백|위상/u],
      ["nonlinear-runtime", /리미터|포화|비팅|간섭/u],
      ["architecture-boundary", /브라우저 런타임.*풀지 않는다/u],
      ["plate-visual", /런타임 시각화|입자 이동|조명|잔상|발광/u],
    ]);
  } else if (heading === "6") {
    concepts.add("ownership");
    addMatchingConcepts(concepts, text, [
      ["material-field", /만델브로 수치장/u],
      ["fem-solver", /탄성판 고유모드/u],
      ["sand-physics", /Chladni 모래/u],
      ["feedback-loop", /^(?:가상 스피커|가상 마이크|피드백 엔진):/u],
      ["nonlinear-runtime", /리미터|볼륨 매퍼/u],
      ["integer-output", /볼륨 매퍼.*0~100 정수/u],
      ["scene-layout", /WebGL 렌더러/u],
      ["audio-synthesis", /Web Audio/u],
      ["dial-dynamics", /다이얼 엔진/u],
    ]);
  } else if (heading.startsWith("7.")) {
    if (heading === "7.3") {
      concepts.add("input-accessibility");
    } else if (heading === "7.4") {
      concepts.add("history-determinism");
      concepts.add("dial-history");
    }
    addMatchingConcepts(concepts, text, [
      ["dial-range", /로그 스케일|최소 주파수|최대 주파수|DRIVE FREQUENCY/u],
      ["dial-geometry", /unwrapped|한 바퀴|시작 각도|최단 각도|회전량/u],
      ["dial-dead-zone", /중심에 너무 가까|중심 가까이|데드존/u],
      ["dial-endstop", /끝단/u],
      ["dial-dynamics", /관성|각속도|회전 마찰|회전 속도|접근 방향/u],
      ["input-accessibility", /포인터 캡처|마우스|화살표|PageUp|PageDown|Home|End|휠|터치|스크린 리더|role="slider"|키보드/u],
      ["pointer-capture", /포인터 캡처/u],
      ["residual-capture", /모드별 진폭|모드별.*위상|잔류 진동/u],
      ["feedback-loop", /피드백 리미터|포락선/u],
    ]);
  } else if (heading.startsWith("8.")) {
    concepts.add("integer-output");
    addMatchingConcepts(concepts, text, [
      ["settled-output", /최근 측정창|계산 중|MEASURING|같은 프레임|값 확정/u],
      ["extreme-distribution", /노이즈 플로어|리미터 상한|1[~.]{1,2}99|간헐적|비팅/u],
      ["audio-safety", /실제 오디오|실제 청취|기기|하드 리미터|RMS|게인/u],
      ["challenge-readonly", /챌린지 호스트|읽기 전용 기준선/u],
      ["snapshot-fanout", /숫자, 바늘, 판|같은 프레임/u],
    ]);
  } else if (heading.startsWith("9.")) {
    if (heading === "9.2") {
      concepts.add("feedback-loop");
    } else if (heading === "9.3") {
      concepts.add("nonlinear-runtime");
    } else if (heading === "9.4") {
      concepts.add("residual-capture");
      concepts.add("history-determinism");
    } else {
      concepts.add("extreme-distribution");
    }
    addMatchingConcepts(concepts, text, [
      ["feedback-loop", /마이크|피드백|지연|필터|이득|위상|귀환|drive\(t\)/u],
      ["history-determinism", /동일한 입력|Math\.random|결정|숨은 주파수별|하드코딩/u],
      ["fixed-step", /프레임률|고정 시간 스텝|적분|시간 점프|이산화/u],
      ["mode-postprocess", /오프라인 자산|각 모드|ω|ζ|결합 계수|모드 텍스처|모드 부호|복소 진폭|2차 상태|모달 응답/u],
      ["nonlinear-runtime", /시간 스텝으로 갱신|qᵢ|노이즈 게이트|클리핑|리미터|포락선|최대 변위|임계값/u],
      ["snapshot-fanout", /시각화와 오디오.*canonical modal state/u],
      ["residual-capture", /잔류|접근|sweep|포획|잔향|에너지와 위상/u],
      ["extreme-distribution", /극단값|0과 100|대부분|중간값|희귀|임계 영역/u],
      ["reachability", /도달 가능|입력 궤적|검증 도구/u],
      ["security-privacy", /비밀 lookup|결과 강제 분기/u],
    ]);
  } else if (heading.startsWith("10.")) {
    concepts.add("generated-assets");
    addMatchingConcepts(concepts, text, [
      ["material-field", /판 외곽|전면 형상|두께|재료|만델브로|escape|탈출 횟수|distance estimate|물성|복소평면|질량|강성|무게중심/u],
      ["material-limits", /최소 특징|제조 가능|최소 두께|제한을 검증/u],
      ["plate-contract", /판 외곽|전면 형상|허브 크기|가진점|마이크점|중앙 고정|자유 외곽/u],
      ["fem-solver", /메시|유한요소|고유값|고유벡터|솔버|경계|수렴|교차검증|정규화/u],
      ["solver-diagnostic", /솔버 오류|구조화 진단/u],
      ["mode-postprocess", /모드 수|감쇠 모델|표면 변위|속도|결합 계수|방사 효율|주파수 간격|좌표계|부호/u],
      ["sand-physics", /모래|마디선|입자|저속 영역|1픽셀 선/u],
      ["dataset-package", /텍스처 해상도|포맷|content-addressed|manifest|plate-spec|modes\.bin|response\.bin|ktx2|provenance|report|checksums|해시 검증|파일명/u],
      ["plate-visual", /모달 에너지에 따라 혼합|전환 속도|잔류 입자/u],
      ["scientific-forbidden-copy", /무한 프랙탈을 주장하지 않는다/u],
      ["release-provenance", /컨테이너 이미지 digest|provenance\.json/u],
    ]);
  } else if (heading.startsWith("11.")) {
    if (heading === "11.6") concepts.add("motion-safety");
    else if (heading === "11.5") concepts.add("ddd-physical");
    else concepts.add("scene-layout");
    addMatchingConcepts(concepts, text, [
      ["apparatus-motion", /왕복|파동 링|펄스|신호 흐름|케이블 애니메이션/u],
      ["oscilloscope", /오실로스코프|마이크 파형|피드백 포락선|위상 차|그래프/u],
      ["dial-hz-visibility", /`Hz` 다이얼|Hz.*다이얼|다이얼.*Hz/u],
      ["integer-output", /VOLUME|미터 바늘|계기판/u],
      ["plate-visual", /금속 Chladni 판|전면은 실제 금속판|판 표현|단면|X-ray|모래|마디선|판 변위|조명 반사/u],
      ["material-field", /만델브로 물성/u],
      ["scientific-nonscope", /프랙탈 탐색기|도박식|점수|코인|배지/u],
      ["nonlinear-runtime", /공진|성장|감쇠|포화|리미터|비팅/u],
      ["residual-capture", /모드 포획|잔향/u],
      ["motion-safety", /번쩍임|감소된 모션|카메라 흔들림|색상만|플래시|국소 발광/u],
    ]);
  } else if (heading.startsWith("12.")) {
    concepts.add("audio-synthesis");
    addMatchingConcepts(concepts, text, [
      ["audio-safety", /안전|청취|상한|실제 기기|0 dBFS|고주파|귀에|DC 제거|대역 제한|클리퍼|RMS|피크|게인|페이지 숨김|오류/u],
      ["audio-activation", /자동재생|AudioContext|제스처|시작 전|비활성/u],
      ["audio-lifecycle-fade", /탭 비활성|페이지 숨김|종료|오류 발생|fade-out/u],
      ["no-microphone", /마이크 권한|실제 마이크/u],
      ["feedback-loop", /피드백 성장|피드백은 내부 모델/u],
      ["mode-postprocess", /모달 응답|선택된 모드/u],
      ["integer-output", /VOLUME 100|100에서도/u],
    ]);
  } else if (heading.startsWith("13.")) {
    if (heading === "13.4") concepts.add("diagnostics");
    else if (heading === "13.3") concepts.add("history-determinism");
    else concepts.add("ownership");
    addMatchingConcepts(concepts, text, [
      ["architecture-boundary", /의존성|DOM|WebGL 객체|공식을 재구현|JSON Schema|Python.*TypeScript/u],
      ["snapshot-fanout", /snapshot|렌더러와 오디오/u],
      ["generated-assets", /생성된 데이터셋|파생 값|생성기/u],
      ["security-privacy", /시각적 노이즈|고정 시드|Math\.random/u],
      ["fixed-step", /시계|애니메이션 프레임|벽시계/u],
      ["diagnostics", /진단|confirmed|needs_evidence|inconclusive|해시 불일치|미지원|디코딩 실패|거부|누락/u],
    ]);
  } else if (heading.startsWith("14.")) {
    concepts.add("schema-contract");
    addMatchingConcepts(concepts, text, [
      ["dataset-package", /데이터셋|manifest|해시|atlas|바이너리|보고서 위치|런타임 호환/u],
      ["snapshot-fanout", /snapshot|렌더러와 오디오|시뮬레이션 시간|다이얼 각도|모드별|RMS|피크|포락선|상태 분류|볼륨|진행도|진단 상태|수정하지 않는다/u],
      ["ownership", /수정하지 않는다/u],
    ]);
  } else if (heading.startsWith("15.")) {
    concepts.add("hotpath");
    addMatchingConcepts(concepts, text, [
      ["architecture-boundary", /PDE|메시 해석|고유값 계산.*런타임/u],
      ["fixed-step", /고정 스텝|렌더링 프레임/u],
      ["lazy-assets", /KTX2|지연 로드|자산 로딩|UI shell|atlas|물리 자산/u],
      ["degradation", /품질 저하|30 FPS|잔상 감소|노멀 해상도|후처리|샘플 밀도|내부 해상도|Canvas2D|표현만 줄인다/u],
      ["snapshot-fanout", /모달 상태, 피드백 계산, 최종 볼륨/u],
      ["audio-safety", /오디오 callback/u],
      ["soak", /장시간 작업/u],
    ]);
  } else if (heading.startsWith("16.")) {
    if (heading === "16.1") {
      concepts.add("fem-solver");
      addMatchingConcepts(concepts, text, [
        ["material-limits", /판 질량|두께/u],
        ["mode-postprocess", /모드 정규화|부호|직교성|결합 계수|텍스처.*좌표계/u],
      ]);
    } else if (heading === "16.2") {
      concepts.add("nonlinear-runtime");
      addMatchingConcepts(concepts, text, [
        ["history-determinism", /동일 입력 trace|동일 출력/u],
        ["fixed-step", /프레임률|탭 정지|재개/u],
        ["pause-resume", /탭 정지|재개/u],
        ["extreme-distribution", /0 상태|100 상태|임계 영역/u],
        ["reachability", /1~99|도달/u],
      ]);
    } else if (heading === "16.3") {
      concepts.add("input-accessibility");
      addMatchingConcepts(concepts, text, [
        ["dial-geometry", /0\/360|포인터 캡처/u],
        ["pointer-capture", /포인터 캡처/u],
        ["dial-dynamics", /빠른 회전|느린 회전|역회전|속도/u],
        ["snapshot-fanout", /같은 snapshot/u],
        ["challenge-readonly", /목표.*읽기 전용/u],
      ]);
    } else if (heading === "16.4") {
      concepts.add("audio-safety");
      addMatchingConcepts(concepts, text, [
        ["audio-activation", /AudioContext/u],
        ["audio-lifecycle-fade", /페이지 숨김|종료|fade-out|AudioContext 오류/u],
        ["dataset-package", /dataset 값/u],
      ]);
    } else {
      concepts.add("visual-regression");
      addMatchingConcepts(concepts, text, [
        ["motion-safety", /감소된 모션/u],
        ["degradation", /Canvas fallback/u],
        ["residual-capture", /잔향 중 역회전/u],
      ]);
    }
  } else if (heading === "17") {
    concepts.add("security-privacy");
    addMatchingConcepts(concepts, text, [
      ["no-microphone", /실제 마이크|카메라|위치 권한/u],
      ["verified-assets", /데이터셋|셰이더|allowlist|해시/u],
      ["release-security", /Content Security Policy|외부 HTML/u],
      ["release-license", /제3자 라이선스/u],
      ["release-provenance", /provenance/u],
      ["diagnostics", /오류 보고서/u],
    ]);
  } else if (heading === "18") {
    concepts.add("project-causality");
  } else if (/^[A-G]\d$/u.test(heading)) {
    const defaults = {
      A0: "schema-contract",
      A1: "dial-dynamics",
      A2: "nonlinear-runtime",
      B0: "material-field",
      B1: "fem-solver",
      B2: "fem-solver",
      C0: "mode-postprocess",
      C1: "dataset-package",
      D0: "scene-layout",
      D1: "snapshot-fanout",
      D2: "audio-safety",
      E0: "reachability",
      E1: "ddd-physical",
      F0: "diagnostics",
      F1: null,
      G0: "release-provenance",
    };
    if (defaults[heading] !== null) {
      concepts.add(defaults[heading]);
    }
    addMatchingConcepts(concepts, text, [
      ["project-causality", /프로젝트 명칭|인과/u],
      ["ownership", /canonical ownership|원본 사양/u],
      ["history-determinism", /결정성|gesture trace/u],
      ["dial-geometry", /unwrapped|이상치/u],
      ["dial-range", /로그 주파수/u],
      ["dial-dynamics", /각속도|관성|끝단/u],
      ["input-accessibility", /키보드|터치|스크린 리더/u],
      ["feedback-loop", /마이크 합산|피드백 지연|필터/u],
      ["fixed-step", /고정 스텝|tick loop/u],
      ["extreme-distribution", /게이트|소프트 클리핑|리미터|0~100 매핑|상태 분류|정적 주파수 분포|전역 이득/u],
      ["material-limits", /제조 가능|전체 질량|최소 특징/u],
      ["plate-visual", /단면 메타데이터|모래|판 변위|셰이더/u],
      ["solver-diagnostic", /솔버 오류|구조화 진단/u],
      ["release-provenance", /provenance|generation report|해시 연결|release artifact|라이선스|솔버·컨테이너·옵션/u],
      ["sand-physics", /마디선|모래 밀도/u],
      ["generated-assets", /생성물|파생/u],
      ["lazy-assets", /자산 로딩|capability probe/u],
      ["audio-activation", /AudioContext|사용자 제스처|페이지 수명주기|오류 복구/u],
      ["audio-synthesis", /모달 음색|피드백 포락선/u],
      ["residual-capture", /모드에 잠기는|잔향/u],
      ["motion-safety", /감소된 모션/u],
      ["verified-assets", /데이터셋 무결성|schema·해시·좌표/u],
      ["degradation", /Canvas fallback|fallback/u],
      ["soak", /장시간 메모리|성능/u],
      ["challenge-readonly", /목표값.*챌린지/u],
      ["release-security", /보안 헤더/u],
      ["oscilloscope", /오실로스코프/u],
      ["apparatus-motion", /신호 흐름 애니메이션|케이블 순환 신호/u],
      ["integer-output", /계기판 presenter/u],
      ["security-privacy", /비밀 per-value/u],
      ["visual-regression", /시각 회귀/u],
      ["audio-safety", /오디오 안전/u],
      ["fem-solver", /physics asset/u],
      ["release-license", /제3자 라이선스/u],
      ["audio-lifecycle-fade", /탭 비활성|오류 시 fade-out/u],
    ]);
  } else if (heading === "19") {
    concepts.add("project-causality");
    addMatchingConcepts(concepts, text, [
      ["single-control", /조절 입력.*다이얼/u],
      ["integer-output", /볼륨 출력.*0~100/u],
      ["extreme-distribution", /안정 입력.*0 또는 100/u],
      ["reachability", /1~99.*도달/u],
      ["history-determinism", /임의 난수|lookup table|동일 데이터셋|결정적/u],
      ["sand-physics", /Chladni 무늬/u],
      ["material-field", /만델브로 정보/u],
      ["scientific-forbidden-copy", /모래 무늬.*만델브로 실루엣/u],
      ["audio-safety", /가상 볼륨 100|기기 최대 음량/u],
      ["no-microphone", /마이크 권한/u],
      ["degradation", /WebGL 품질 저하|fallback/u],
      ["release-provenance", /데이터셋.*provenance/u],
      ["diagnostics", /오류.*진단 코드/u],
      ["input-accessibility", /키보드|터치|스크린 리더/u],
      ["motion-safety", /감소된 모션/u],
      ["soak", /장시간|메모리|오디오 노드/u],
    ]);
  } else if (heading === "20") {
    concepts.add("explicit-nonscope");
    addMatchingConcepts(concepts, text, [
      ["no-microphone", /실제 마이크/u],
      ["single-control", /다중 입력 UI/u],
      ["scientific-nonscope", /만델브로 좌표 직접 탐색기|점수|가상 화폐|광고|확률형/u],
      ["architecture-boundary", /실시간 범용 유한요소|CAD UI/u],
      ["security-privacy", /계정|서버 저장|소셜|개인정보/u],
      ["scientific-forbidden-copy", /검증되지 않은 효과/u],
      ["master-volume", /운영체제 마스터 볼륨/u],
    ]);
  }

  if (concepts.size === 0 || Number.isNaN(headingNumber) && !/^[A-G]\d$/u.test(heading)) {
    fail(
      `obligation ${obligation.id} has no derived semantic acceptance concept`,
    );
  }
  for (const conceptId of concepts) {
    if (SEMANTIC_ACCEPTANCE_CONCEPTS[conceptId] === undefined) {
      fail(
        `obligation ${obligation.id} derived unknown semantic concept ${conceptId}`,
      );
    }
  }
  return [...concepts];
}

export function preferredSemanticCaseIdsForObligation(obligation) {
  return [
    ...new Set(
      semanticConceptsForObligation(obligation).map(
        (conceptId) =>
          SEMANTIC_ACCEPTANCE_CONCEPTS[conceptId].preferredCaseId,
      ),
    ),
  ];
}

function validateAnchor({
  projectRoot,
  anchor,
  label,
  seenAnchorIds,
}) {
  if (
    typeof anchor?.id !== "string" ||
    anchor.id.length === 0 ||
    seenAnchorIds.has(anchor.id)
  ) {
    fail(
      `${label} anchor ID is missing or duplicated: ${String(anchor?.id)}`,
    );
  }
  seenAnchorIds.add(anchor.id);
  if (
    !["test", "source", "spec", "workflow", "report"].includes(
      anchor.kind,
    )
  ) {
    fail(`${label}.${anchor.id} has unsupported kind ${String(anchor.kind)}`);
  }
  const anchorPath = resolveSafeProjectFile(
    projectRoot,
    anchor.path,
    `${label}.${anchor.id}.path`,
  );
  if (!existsSync(anchorPath) || !statSync(anchorPath).isFile()) {
    fail(
      `${label}.${anchor.id} must resolve to a concrete file, not a directory: ${anchor.path}`,
    );
  }
  const bytes = readFileSync(anchorPath);
  const content = bytes.toString("utf8");
  if (anchor.kind === "test") {
    if (
      typeof anchor.testId !== "string" ||
      anchor.testId.length < 3 ||
      Object.hasOwn(anchor, "contains") ||
      Object.hasOwn(anchor, "matches") ||
      Object.hasOwn(anchor, "json")
    ) {
      fail(
        `${label}.${anchor.id} test anchor must declare exactly one exact testId`,
      );
    }
    const discovery = discoverExactTests(content, anchor.path);
    if (discovery.focusedTestCount > 0) {
      fail(
        `${label}.${anchor.id} cannot prove acceptance while ${anchor.path} contains .only/focused tests`,
      );
    }
    const matches = discovery.tests.filter(
      (test) =>
        test.testId === anchor.testId ||
        test.fullTestId === anchor.testId,
    );
    if (matches.length !== 1) {
      fail(
        `${label}.${anchor.id} exact testId ${JSON.stringify(
          anchor.testId,
        )} resolved ${matches.length} times in ${anchor.path}`,
      );
    }
    const test = matches[0];
    if (test.disposition !== "run") {
      fail(
        `${label}.${anchor.id} exact testId ${JSON.stringify(
          anchor.testId,
        )} is ${test.disposition}, not runnable`,
      );
    }
    if (!test.hasAssertion) {
      fail(
        `${label}.${anchor.id} exact testId ${JSON.stringify(
          anchor.testId,
        )} has no executable assertion`,
      );
    }
    return {
      id: anchor.id,
      kind: anchor.kind,
      path: anchor.path.replaceAll("\\", "/"),
      sourceSha256: sha256(bytes),
      bodySha256: test.bodySha256,
      selector: { testId: anchor.testId },
    };
  }
  const selectorCount = [
    Object.hasOwn(anchor, "contains"),
    Object.hasOwn(anchor, "matches"),
    Object.hasOwn(anchor, "json"),
  ].filter(Boolean).length;
  if (selectorCount !== 1) {
    fail(`${label}.${anchor.id} must declare exactly one semantic selector`);
  }
  let selector;
  if (Object.hasOwn(anchor, "contains")) {
    if (typeof anchor.contains !== "string" || anchor.contains.length < 3) {
      fail(`${label}.${anchor.id}.contains is too weak`);
    }
    if (!content.includes(anchor.contains)) {
      fail(
        `${label}.${anchor.id} selector was not found in ${anchor.path}`,
      );
    }
    selector = { contains: anchor.contains };
  } else if (Object.hasOwn(anchor, "matches")) {
    if (typeof anchor.matches !== "string" || anchor.matches.length < 3) {
      fail(`${label}.${anchor.id}.matches is too weak`);
    }
    let expression;
    try {
      expression = new RegExp(anchor.matches, "u");
    } catch (error) {
      fail(`${label}.${anchor.id}.matches is invalid: ${error.message}`);
    }
    if (!expression.test(content)) {
      fail(
        `${label}.${anchor.id} regex did not match ${anchor.path}`,
      );
    }
    selector = { matches: anchor.matches };
  } else {
    if (
      anchor.json === null ||
      typeof anchor.json !== "object" ||
      Array.isArray(anchor.json)
    ) {
      fail(`${label}.${anchor.id}.json must be an object`);
    }
    const source = readJson(anchorPath, `${label}.${anchor.id}.path`);
    const located = valueAtJsonPointer(
      source,
      anchor.json.pointer,
      `${label}.${anchor.id}.json.pointer`,
    );
    if (
      !Object.hasOwn(anchor.json, "equals") ||
      !located.exists ||
      !deepEqual(located.value, anchor.json.equals)
    ) {
      fail(
        `${label}.${anchor.id} JSON assertion failed at ${anchor.json.pointer}`,
      );
    }
    selector = {
      json: {
        pointer: anchor.json.pointer,
        equals: anchor.json.equals,
      },
    };
  }
  return {
    id: anchor.id,
    kind: anchor.kind,
    path: anchor.path.replaceAll("\\", "/"),
    sourceSha256: sha256(bytes),
    bodySha256: null,
    selector,
  };
}

function validateClaim({
  projectRoot,
  claim,
  label,
  suiteRegistry,
  requiredSuiteSubset,
  seenAnchorIds,
}) {
  if (!Array.isArray(claim.suites) || claim.suites.length === 0) {
    fail(`${label} has no executable suites`);
  }
  for (const suiteId of claim.suites) {
    if (suiteRegistry[suiteId] === undefined) {
      fail(`${label} references unknown suite ${suiteId}`);
    }
    if (
      requiredSuiteSubset !== null &&
      !requiredSuiteSubset.includes(suiteId)
    ) {
      fail(
        `${label} suite ${suiteId} is not owned by its coverage group`,
      );
    }
  }
  if (!Array.isArray(claim.claimAnchors) || claim.claimAnchors.length === 0) {
    fail(`${label} has no semantic claim anchors`);
  }
  const anchors = claim.claimAnchors.map((anchor) =>
    validateAnchor({
      projectRoot,
      anchor,
      label,
      seenAnchorIds,
    }),
  );
  if (Array.isArray(claim.evidence)) {
    const evidencePaths = new Set(
      claim.evidence.map((evidencePath) =>
        String(evidencePath).replaceAll("\\", "/"),
      ),
    );
    for (const anchor of anchors) {
      if (!evidencePaths.has(anchor.path)) {
        fail(
          `${label} anchor ${anchor.id} is not declared in its evidence inventory`,
        );
      }
    }
  }
  if (
    !anchors.some(
      ({ kind }) => kind === "test" || kind === "workflow",
    )
  ) {
    fail(`${label} has no executable test or workflow anchor`);
  }
  return {
    suites: [...claim.suites],
    anchors,
  };
}

export function verifyValidationSuiteRequirements({
  validationSubsections,
  requirements,
  criticalClaims,
}) {
  if (
    !Array.isArray(validationSubsections) ||
    validationSubsections.length === 0
  ) {
    fail("validationSubsections must not be empty");
  }
  if (
    requirements === null ||
    typeof requirements !== "object" ||
    Array.isArray(requirements)
  ) {
    fail("validationSuiteRequirements must be an object");
  }
  const requirementHeadings = Object.keys(requirements);
  if (
    requirementHeadings.length !== validationSubsections.length ||
    requirementHeadings.some(
      (heading, index) => heading !== validationSubsections[index],
    )
  ) {
    fail(
      "validationSuiteRequirements must exactly follow validationSubsections",
    );
  }
  const claimsByHeading = new Map(
    (criticalClaims ?? []).map((claim) => [claim.heading, claim]),
  );
  for (const heading of validationSubsections) {
    const expectedSuites = requirements[heading];
    const claim = claimsByHeading.get(heading);
    if (!Array.isArray(expectedSuites) || expectedSuites.length === 0) {
      fail(`validation suite requirement ${heading} is empty`);
    }
    if (!claim) {
      fail(`validation subsection ${heading} has no critical claim`);
    }
    const actualSuites = claim.suites;
    if (
      !Array.isArray(actualSuites) ||
      actualSuites.length !== expectedSuites.length ||
      actualSuites.some(
        (suite, index) => suite !== expectedSuites[index],
      )
    ) {
      fail(
        `validation subsection ${heading} suite mapping mismatch; expected ${expectedSuites.join(
          ", ",
        )}, received ${(actualSuites ?? []).join(", ")}`,
      );
    }
  }
}

export function verifyExecutableSuiteRegistry({
  suiteRegistry,
  packageScripts,
}) {
  if (
    suiteRegistry === null ||
    typeof suiteRegistry !== "object" ||
    Array.isArray(suiteRegistry)
  ) {
    fail("suite registry is missing");
  }
  if (
    packageScripts === null ||
    typeof packageScripts !== "object" ||
    Array.isArray(packageScripts)
  ) {
    fail("package script registry is missing");
  }

  const verifiedScripts = new Set();
  const visiting = new Set();
  const verifyScript = (scriptId) => {
    if (verifiedScripts.has(scriptId)) return;
    if (visiting.has(scriptId)) {
      fail(`npm script dependency cycle reaches ${scriptId}`);
    }
    const body = packageScripts[scriptId];
    if (typeof body !== "string" || body.trim().length === 0) {
      fail(`npm script ${scriptId} is missing or non-executable`);
    }
    visiting.add(scriptId);
    for (const match of body.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/gu)) {
      verifyScript(match[1]);
    }
    visiting.delete(scriptId);
    verifiedScripts.add(scriptId);
  };

  const results = [];
  for (const [suiteId, suite] of Object.entries(suiteRegistry)) {
    if (typeof suite?.command !== "string") {
      fail(`suite ${suiteId} has no executable npm command`);
    }
    const segments = suite.command
      .split(/\s*&&\s*/u)
      .map((segment) => segment.trim());
    if (
      segments.length === 0 ||
      segments.some(
        (segment) =>
          !/^npm run [a-zA-Z0-9:_-]+(?:\s+--(?:\s+.+)?)?$/u.test(
            segment,
          ),
      )
    ) {
      fail(
        `suite ${suiteId} command must contain only executable npm run stages`,
      );
    }
    const scripts = segments.map(
      (segment) =>
        /^npm run ([a-zA-Z0-9:_-]+)/u.exec(segment)[1],
    );
    for (const scriptId of scripts) verifyScript(scriptId);
    results.push({ id: suiteId, scripts });
  }
  return results;
}

export function verifyNativeExecutionDelegation({
  projectRoot,
  policy,
  suiteRegistry,
}) {
  if (
    policy?.schemaVersion !==
      "mandelhowl.native-execution-delegation.v1" ||
    policy?.windowsFullVerification?.workflowJob !==
      "full-verification" ||
    policy?.windowsFullVerification?.needsJob !==
      "native-baker-nversion" ||
    policy?.windowsFullVerification?.mode !==
      "evidence-only-no-native-spawn" ||
    policy.windowsFullVerification.nativeSpawnAllowed !== false ||
    policy.windowsFullVerification.evidenceOnlyEnvironmentVariable !==
      WINDOWS_EVIDENCE_ONLY_ENVIRONMENT_VARIABLE ||
    !deepEqual(
      policy.windowsFullVerification.evidenceOnlyGuardSources,
      [
        "tools/handoff-verifier/src/run-full-verification.mjs",
        "tools/baker-supervisor/src/backend-process.mjs",
      ],
    ) ||
    !deepEqual(
      policy.windowsFullVerification.scriptDagRoots,
      [
        "handoff:check",
        "contracts:check",
        "typecheck",
        "lint",
        "svelte:check",
        "baker:supervisor:test",
        "baker:container:test",
        "security:audit",
        "security:static",
        "test:unit",
        "test:web",
        "test:integration",
        "test:science",
        "build",
        "test:ssr",
        "test:e2e",
        "test:visual",
        "test:performance",
        "release:verify",
        "release:verify:attested",
        "release:archive",
        "release:archive:check",
      ],
    ) ||
    !/^[a-f0-9]{64}$/u.test(
      policy.windowsFullVerification.scriptDagSha256 ?? "",
    ) ||
    !deepEqual(
      policy.windowsFullVerification.prohibitedNpmScripts,
      WINDOWS_NATIVE_PROHIBITED_SCRIPTS,
    ) ||
    !deepEqual(
      policy.windowsFullVerification.prohibitedCommandFragments,
      [
        "cargo ",
        "MANDELHOWL_NATIVE_BAKER",
        "actions/download-artifact",
        "--attestation ",
      ],
    ) ||
    !deepEqual(
      policy.windowsFullVerification.requiredCommandFragments,
      [
        "npm run handoff:verify --",
        "Verify handoff against committed pinned OCI evidence",
      ],
    ) ||
    policy?.linuxQuality?.workflow !== ".github/workflows/verify.yml" ||
    policy.linuxQuality.job !== "native-baker-nversion" ||
    !deepEqual(
      policy.linuxQuality.requiredCommandFragments,
      [
        "cargo fmt --all -- --check",
        "cargo clippy --workspace --all-targets --locked -- -D warnings",
        "cargo test --workspace --locked",
        "cargo build --release --locked -p mandelhowl-baker-native --bin mandelhowl-baker-native",
        "node tools/baker-supervisor/src/supervisor.mjs validate --strict",
        "node tools/baker-supervisor/src/supervisor.mjs generate",
      ],
    ) ||
    policy?.committedReleaseEvidence?.relativePathPattern !==
      "release/attestations/<dataset-id-hex>/attestation.json" ||
    policy.committedReleaseEvidence.executionKind !== "oci-container" ||
    policy.committedReleaseEvidence.fullCandidateCopiesRequired !== true ||
    policy.committedReleaseEvidence.containerEnvelopeRequired !== true ||
    policy.committedReleaseEvidence.exactPinnedRustCandidateRequired !==
      true ||
    policy.committedReleaseEvidence.sourceTreeMismatchDisposition !==
      "fail-closed"
  ) {
    fail("native execution delegation policy is missing or incomplete");
  }
  const workflowPath = resolveSafeProjectFile(
    projectRoot,
    policy.linuxQuality.workflow,
    "nativeExecutionDelegation.linuxQuality.workflow",
  );
  if (!existsSync(workflowPath) || !statSync(workflowPath).isFile()) {
    fail("native execution delegation Linux workflow is missing");
  }
  const workflowBytes = readFileSync(workflowPath);
  const workflow = workflowBytes.toString("utf8").replace(/\r\n/gu, "\n");
  const jobSections = [...workflow.matchAll(/^  [A-Za-z0-9_-]+:\n/gmu)];
  const sectionFor = (job) => {
    const marker = `  ${job}:\n`;
    const selected = jobSections.find((match) => match[0] === marker);
    if (selected === undefined) return null;
    const next = jobSections.find(
      (match) => match.index > selected.index,
    );
    return workflow.slice(selected.index, next?.index ?? workflow.length);
  };
  const linuxWorkflow = sectionFor(policy.linuxQuality.job);
  const windowsWorkflow = sectionFor(
    policy.windowsFullVerification.workflowJob,
  );
  if (linuxWorkflow === null || windowsWorkflow === null) {
    fail("native execution delegation workflow job order is invalid");
  }
  if (
    !new RegExp(
      `^    needs: ${policy.windowsFullVerification.needsJob}$`,
      "mu",
    ).test(windowsWorkflow)
  ) {
    fail(
      "Windows full verification is not structurally gated by the Linux native job",
    );
  }
  for (const fragment of
    policy.linuxQuality.requiredCommandFragments.slice(0, -1)) {
    if (
      typeof fragment !== "string" ||
      fragment.length < 8 ||
      !linuxWorkflow.includes(`      - run: ${fragment}\n`)
    ) {
      fail(
        `native execution delegation workflow is missing required evidence stage: ${String(fragment)}`,
      );
    }
  }
  const freshLinuxStage = [
    "      - name: Fresh Linux native dual-generation quality evidence",
    "        run: >-",
    `          ${policy.linuxQuality.requiredCommandFragments.at(-1)}`,
    "          --strict",
    "          --coverage-report tests/runtime/fixtures/reachability-report.json",
    "          --timeout-ms 2400000",
    '          --output-root "${{ runner.temp }}/mandelhowl-nversion-output"',
    '          --attestation-bundle "${{ runner.temp }}/baker-nversion-attestation"',
    '          --report-file "${{ runner.temp }}/baker-nversion-attestation/attestation.json"',
    "        env:",
    "          MANDELHOWL_NATIVE_BAKER: ${{ github.workspace }}/target/release/mandelhowl-baker-native",
  ].join("\n");
  if (!linuxWorkflow.includes(freshLinuxStage)) {
    fail(
      "native execution delegation workflow is missing the exact strict fresh dual-generation stage",
    );
  }
  for (const fragment of
    policy.windowsFullVerification.requiredCommandFragments) {
    if (!windowsWorkflow.includes(fragment)) {
      fail(
        `Windows full verification is missing required evidence stage: ${fragment}`,
      );
    }
  }
  const committedEvidenceStage = [
    "      - name: Verify handoff against committed pinned OCI evidence",
    "        run: >-",
    "          npm run handoff:verify --",
    '          --report "${{ runner.temp }}/mandelhowl-handoff-verification.json"',
  ].join("\n");
  if (!windowsWorkflow.includes(committedEvidenceStage)) {
    fail(
      "Windows full verification is missing the exact committed-evidence stage",
    );
  }
  for (const fragment of
    policy.windowsFullVerification.prohibitedCommandFragments) {
    if (windowsWorkflow.includes(fragment)) {
      fail(
        `Windows full verification exposes prohibited native evidence input: ${fragment}`,
      );
    }
  }
  const packageJsonPath = resolveSafeProjectFile(
    projectRoot,
    "package.json",
    "nativeExecutionDelegation.packageJson",
  );
  const packageJson = readJson(
    packageJsonPath,
    "nativeExecutionDelegation.packageJson",
  );
  let windowsScriptDag;
  try {
    windowsScriptDag = verifyWindowsNpmScriptDag({
      stages: policy.windowsFullVerification.scriptDagRoots.map(
        (script) => ({ script }),
      ),
      packageScripts: packageJson.scripts,
      roots: policy.windowsFullVerification.scriptDagRoots,
      expectedSha256:
        policy.windowsFullVerification.scriptDagSha256,
    });
  } catch (error) {
    fail(`Windows npm script DAG is not evidence-only: ${error.message}`);
  }
  const fullVerifierSource = readFileSync(
    resolveSafeProjectFile(
      projectRoot,
      policy.windowsFullVerification.evidenceOnlyGuardSources[0],
      "nativeExecutionDelegation.fullVerifierGuard",
    ),
    "utf8",
  );
  for (const fragment of [
    '[WINDOWS_EVIDENCE_ONLY_ENVIRONMENT_VARIABLE]: "1"',
    "delete verificationEnvironment.MANDELHOWL_NATIVE_BAKER",
    "delete verificationEnvironment.MANDELHOWL_MANAGED_INSTALL",
    "env: verificationEnvironment",
  ]) {
    if (!fullVerifierSource.includes(fragment)) {
      fail(
        `Windows evidence-only child environment guard is missing: ${fragment}`,
      );
    }
  }
  const backendSource = readFileSync(
    resolveSafeProjectFile(
      projectRoot,
      policy.windowsFullVerification.evidenceOnlyGuardSources[1],
      "nativeExecutionDelegation.backendGuard",
    ),
    "utf8",
  );
  const inheritedGuard =
    'process.env[EVIDENCE_ONLY_NO_NATIVE_SPAWN_ENV] === "1"';
  const childGuard =
    'env[EVIDENCE_ONLY_NO_NATIVE_SPAWN_ENV] === "1"';
  const inheritedGuardIndex = backendSource.indexOf(inheritedGuard);
  const childGuardIndex = backendSource.indexOf(
    childGuard,
    inheritedGuardIndex + inheritedGuard.length,
  );
  const nativeSpawnIndex = backendSource.indexOf(
    "const processResult = runBackendProcess({",
    Math.max(inheritedGuardIndex, childGuardIndex),
  );
  if (
    inheritedGuardIndex < 0 ||
    childGuardIndex < 0 ||
    nativeSpawnIndex < 0 ||
    inheritedGuardIndex >= nativeSpawnIndex ||
    childGuardIndex >= nativeSpawnIndex ||
    !backendSource.includes(
      'code: "MH_BAKER_EVIDENCE_ONLY_NO_NATIVE_SPAWN"',
    )
  ) {
    fail(
      "Baker evidence-only native pre-spawn guard is missing or misplaced",
    );
  }
  for (const suiteId of ["physics", "baker-nversion", "release"]) {
    const suite = suiteRegistry?.[suiteId];
    if (
      suite?.nativeExecutionSurface !==
        "linux-ci-or-linux-oci-only" ||
      suite?.windowsNativeSpawnAllowed !== false ||
      suite?.delegatedEvidencePolicy !== policy.schemaVersion ||
      typeof suite?.command !== "string" ||
      policy.windowsFullVerification.prohibitedNpmScripts.some(
        (script) => suite.command.includes(`npm run ${script}`),
      )
    ) {
      fail(
        `suite ${suiteId} does not declare evidence-only Windows verification`,
      );
    }
  }
  return {
    schemaVersion: policy.schemaVersion,
    windowsMode: policy.windowsFullVerification.mode,
    linuxWorkflow: policy.linuxQuality.workflow,
    linuxWorkflowSha256: sha256(workflowBytes),
    windowsScriptDagSha256: windowsScriptDag.sha256,
    committedEvidencePattern:
      policy.committedReleaseEvidence.relativePathPattern,
  };
}

export function buildObligationLedger({
  projectRoot,
  parsed,
  coverageGroups,
  criticalClaims,
  acceptanceCases = [],
  obligationClaims = [],
  suiteRegistry,
}) {
  if (!Array.isArray(coverageGroups) || coverageGroups.length === 0) {
    fail("coverageGroups must not be empty");
  }
  const seenGroupIds = new Set();
  const headingOwners = new Map();
  const validatedGroups = new Map();
  const casesById = new Map();
  const semanticConceptsByObligationId = new Map();
  const seenAnchorIds = new Set();
  for (const group of coverageGroups) {
    if (
      typeof group?.id !== "string" ||
      group.id.length === 0 ||
      seenGroupIds.has(group.id)
    ) {
      fail(
        `coverage group ID is missing or duplicated: ${String(group?.id)}`,
      );
    }
    seenGroupIds.add(group.id);
    if (!Array.isArray(group.headings) || group.headings.length === 0) {
      fail(`coverage group ${group.id} has no source headings`);
    }
    for (const headingId of group.headings) {
      if (headingOwners.has(headingId)) {
        fail(
          `source heading ${headingId} has multiple coverage owners: ${headingOwners.get(
            headingId,
          )}, ${group.id}`,
        );
      }
      headingOwners.set(headingId, group.id);
    }
    const claim = validateClaim({
      projectRoot,
      claim: group,
      label: `coverage group ${group.id}`,
      suiteRegistry,
      requiredSuiteSubset: null,
      seenAnchorIds,
    });
    validatedGroups.set(group.id, { group, claim });
    casesById.set(`group:${group.id}`, {
      id: `group:${group.id}`,
      claim,
    });
  }

  const criticalByHeading = new Map();
  const seenCriticalIds = new Set();
  for (const critical of criticalClaims ?? []) {
    if (
      typeof critical?.id !== "string" ||
      critical.id.length === 0 ||
      seenCriticalIds.has(critical.id)
    ) {
      fail(
        `critical claim ID is missing or duplicated: ${String(critical?.id)}`,
      );
    }
    seenCriticalIds.add(critical.id);
    if (
      typeof critical.heading !== "string" ||
      criticalByHeading.has(critical.heading)
    ) {
      fail(
        `critical heading claim is missing or duplicated: ${String(
          critical.heading,
        )}`,
      );
    }
    const groupId = headingOwners.get(critical.heading);
    if (groupId === undefined) {
      fail(
        `critical claim ${critical.id} has no coverage group for heading ${critical.heading}`,
      );
    }
    const owner = validatedGroups.get(groupId);
    const claim = validateClaim({
      projectRoot,
      claim: critical,
      label: `critical claim ${critical.id}`,
      suiteRegistry,
      requiredSuiteSubset: owner.group.suites,
      seenAnchorIds,
    });
    const ownerEvidence = new Set(
      (owner.group.evidence ?? []).map((evidencePath) =>
        String(evidencePath).replaceAll("\\", "/"),
      ),
    );
    for (const anchor of claim.anchors) {
      if (!ownerEvidence.has(anchor.path)) {
        fail(
          `critical claim ${critical.id} anchor ${anchor.id} is not inventoried by coverage group ${groupId}`,
        );
      }
    }
    criticalByHeading.set(critical.heading, {
      id: critical.id,
      groupId,
      claim,
    });
    if (casesById.has(critical.id)) {
      fail(`acceptance case ID is duplicated: ${critical.id}`);
    }
    casesById.set(critical.id, { id: critical.id, claim });
  }

  const seenAcceptanceCaseIds = new Set();
  for (const acceptanceCase of acceptanceCases) {
    if (
      typeof acceptanceCase?.id !== "string" ||
      acceptanceCase.id.length === 0 ||
      seenAcceptanceCaseIds.has(acceptanceCase.id) ||
      casesById.has(acceptanceCase.id)
    ) {
      fail(
        `acceptance case ID is missing or duplicated: ${String(
          acceptanceCase?.id,
        )}`,
      );
    }
    seenAcceptanceCaseIds.add(acceptanceCase.id);
    const claim = validateClaim({
      projectRoot,
      claim: acceptanceCase,
      label: `acceptance case ${acceptanceCase.id}`,
      suiteRegistry,
      requiredSuiteSubset: null,
      seenAnchorIds,
    });
    casesById.set(acceptanceCase.id, {
      id: acceptanceCase.id,
      claim,
    });
  }

  if (
    !Array.isArray(obligationClaims) ||
    obligationClaims.length !== parsed.obligations.length
  ) {
    fail(
      `obligationClaims must directly inventory all ${parsed.obligations.length} obligations`,
    );
  }
  const directClaimsById = new Map();
  for (const [index, direct] of obligationClaims.entries()) {
    const expected = parsed.obligations[index];
    if (
      direct === null ||
      typeof direct !== "object" ||
      Array.isArray(direct) ||
      direct.obligationId !== expected.id ||
      !Array.isArray(direct.caseIds) ||
      direct.caseIds.length === 0 ||
      new Set(direct.caseIds).size !== direct.caseIds.length
    ) {
      fail(
        `obligationClaims[${index}] must directly bind ${expected.id} to unique caseIds`,
      );
    }
    for (const caseId of direct.caseIds) {
      if (typeof caseId !== "string" || !casesById.has(caseId)) {
        fail(
          `obligation ${expected.id} references unknown acceptance case ${String(
            caseId,
          )}`,
        );
      }
    }
    if (direct.caseIds.every((caseId) => caseId.startsWith("group:"))) {
      fail(
        `obligation ${expected.id} relies only on broad coverage groups; bind at least one semantic acceptance case`,
      );
    }
    const semanticConcepts =
      semanticConceptsForObligation(expected);
    const directCaseIds = direct.caseIds.filter(
      (caseId) => !caseId.startsWith("group:"),
    );
    const structuralCriticalCaseId =
      criticalByHeading.get(expected.headingId)?.id ?? null;
    for (const conceptId of semanticConcepts) {
      const compatible = new Set(
        SEMANTIC_ACCEPTANCE_CONCEPTS[conceptId]
          .compatibleCaseIds,
      );
      const evidencePattern =
        SEMANTIC_EVIDENCE_PATTERNS[conceptId];
      if (
        evidencePattern === undefined ||
        !directCaseIds.some((caseId) => {
          if (!compatible.has(caseId)) return false;
          const selectedCase = casesById.get(caseId);
          return (
            selectedCase !== undefined &&
            evidencePattern.test(
              semanticEvidenceText(selectedCase),
            )
          );
        })
      ) {
        fail(
          `obligation ${expected.id} (${expected.headingId}:${expected.sourceLine}) semantic concept ${conceptId} is not supported by matching executable evidence in its direct cases: ${directCaseIds.join(
            ", ",
          )}`,
        );
      }
    }
    for (const caseId of directCaseIds) {
      if (
        caseId === structuralCriticalCaseId
      ) {
        continue;
      }
      const selectedCase = casesById.get(caseId);
      const matchingConcept = semanticConcepts.find(
        (conceptId) =>
          SEMANTIC_ACCEPTANCE_CONCEPTS[
            conceptId
          ].compatibleCaseIds.includes(caseId) &&
          SEMANTIC_EVIDENCE_PATTERNS[conceptId].test(
            semanticEvidenceText(selectedCase),
          ),
      );
      if (matchingConcept === undefined) {
        fail(
          `obligation ${expected.id} (${expected.headingId}:${expected.sourceLine}) uses case ${caseId} without matching semantic evidence; expected concepts: ${semanticConcepts.join(
            ", ",
          )}`,
        );
      }
    }
    semanticConceptsByObligationId.set(
      expected.id,
      semanticConcepts,
    );
    directClaimsById.set(expected.id, [...direct.caseIds]);
  }

  const entries = parsed.obligations.map((obligation) => {
    const groupId = headingOwners.get(obligation.headingId);
    if (groupId === undefined) {
      fail(
        `obligation ${obligation.id} has no coverage owner for heading ${obligation.headingId}`,
      );
    }
    const caseIds = directClaimsById.get(obligation.id);
    if (caseIds === undefined) {
      fail(`obligation ${obligation.id} has no direct acceptance cases`);
    }
    const selectedCases = caseIds.map((caseId) => casesById.get(caseId));
    const suites = [
      ...new Set(
        selectedCases.flatMap(({ claim }) => claim.suites),
      ),
    ];
    const anchors = selectedCases.flatMap(({ claim }) => claim.anchors);
    return {
      ...obligation,
      coverageGroupId: groupId,
      caseIds,
      semanticConcepts:
        semanticConceptsByObligationId.get(obligation.id),
      suites,
      claimAnchors: anchors.map(
        ({
          id,
          kind,
          path,
          sourceSha256,
          bodySha256,
          selector,
        }) => ({
          id,
          kind,
          path,
          sourceSha256,
          bodySha256,
          selector,
        }),
      ),
    };
  });
  const entryIds = new Set(entries.map(({ id }) => id));
  if (entryIds.size !== parsed.obligations.length) {
    fail("obligation stable IDs are not unique");
  }
  if (entries.length !== parsed.obligations.length) {
    fail("not every parsed obligation was assigned exactly once");
  }
  const ownershipProjection = entries.map((entry) => ({
    id: entry.id,
    headingId: entry.headingId,
    ordinalInHeading: entry.ordinalInHeading,
    sourceLine: entry.sourceLine,
    sourceDigest: entry.sourceDigest,
    coverageGroupId: entry.coverageGroupId,
    caseIds: entry.caseIds,
    semanticConcepts: entry.semanticConcepts,
    suites: entry.suites,
    claimAnchors: entry.claimAnchors.map(
      ({
        id,
        kind,
        path,
        sourceSha256,
        bodySha256,
        selector,
      }) => ({
        id,
        kind,
        path,
        sourceSha256,
        bodySha256,
        selector,
      }),
    ),
  }));
  const digest = sha256(canonicalJson(ownershipProjection));
  return {
    schemaVersion: "mandelhowl.handoff-obligation-ledger.v1",
    sourceObligationCount: parsed.obligations.length,
    mappedObligationCount: entries.length,
    ledgerSha256: digest,
    entries,
    criticalClaims: [...criticalByHeading.entries()].map(
      ([heading, value]) => ({
        heading,
        id: value.id,
        coverageGroupId: value.groupId,
      }),
    ),
    obligationClaims: entries.map(({ id, caseIds }) => ({
      obligationId: id,
      caseIds,
    })),
  };
}

export function verifyStandaloneClaims({
  projectRoot,
  claims,
  suiteRegistry,
  label,
}) {
  if (!Array.isArray(claims) || claims.length === 0) {
    fail(`${label} claim collection is empty`);
  }
  const seenClaimIds = new Set();
  const seenAnchorIds = new Set();
  return claims.map((claim, index) => {
    const claimId = String(claim.id ?? "");
    if (claimId.length === 0 || seenClaimIds.has(claimId)) {
      fail(
        `${label} claim ID is missing or duplicated at index ${index}: ${claimId}`,
      );
    }
    seenClaimIds.add(claimId);
    const validated = validateClaim({
      projectRoot,
      claim,
      label: `${label} ${claimId}`,
      suiteRegistry,
      requiredSuiteSubset: null,
      seenAnchorIds,
    });
    return {
      id: claimId,
      suites: validated.suites,
      anchors: validated.anchors,
    };
  });
}

export function verifyObligationLedgerPin(ledger, obligationContract) {
  if (
    obligationContract === null ||
    typeof obligationContract !== "object" ||
    Array.isArray(obligationContract)
  ) {
    fail("handoff.obligations contract is missing");
  }
  if (
    !Number.isInteger(obligationContract.expectedCount) ||
    obligationContract.expectedCount <= 0
  ) {
    fail("handoff.obligations.expectedCount must be positive");
  }
  if (ledger.sourceObligationCount !== obligationContract.expectedCount) {
    fail(
      `obligation count mismatch; expected ${obligationContract.expectedCount}, received ${ledger.sourceObligationCount}`,
    );
  }
  if (
    typeof obligationContract.expectedLedgerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(
      obligationContract.expectedLedgerSha256,
    )
  ) {
    fail("handoff.obligations.expectedLedgerSha256 is invalid");
  }
  if (
    ledger.ledgerSha256 !==
    obligationContract.expectedLedgerSha256
  ) {
    fail(
      `obligation ownership ledger changed; expected ${obligationContract.expectedLedgerSha256}, received ${ledger.ledgerSha256}`,
    );
  }
}
