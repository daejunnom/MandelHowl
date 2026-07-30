import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODE_PATTERN } from "./diagnostic-record";

interface RuntimeSnapshotSchema {
  readonly additionalProperties: boolean;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly $defs: {
    readonly mode: {
      readonly additionalProperties: boolean;
      readonly properties: Readonly<Record<string, unknown>>;
      readonly required: readonly string[];
    };
    readonly diagnostic: {
      readonly properties: {
        readonly code: { readonly pattern: string };
      };
    };
  };
}

const schema = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "packages/contracts/schemas/runtime-snapshot.schema.json",
    ),
    "utf8",
  ),
) as RuntimeSnapshotSchema;

function collectClosedObjectSchemas(
  value: unknown,
  path = "$",
  result: Array<{
    readonly path: string;
    readonly schema: {
      readonly additionalProperties?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: readonly string[];
      readonly type?: unknown;
    };
  }> = [],
): typeof result {
  if (value === null || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectClosedObjectSchemas(entry, `${path}[${index}]`, result),
    );
    return result;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.type === "object") {
    result.push({ path, schema: record });
  }
  for (const [key, child] of Object.entries(record)) {
    collectClosedObjectSchemas(child, `${path}.${key}`, result);
  }
  return result;
}

function productionConsumerPaths(): readonly string[] {
  return [
    ...readdirSync(resolve(process.cwd(), "packages/render-engine/src"))
      .filter(
        (name) =>
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts"),
      )
      .map((name) => `packages/render-engine/src/${name}`),
    ...readdirSync(resolve(process.cwd(), "packages/audio-engine/src"))
      .filter(
        (name) =>
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts"),
      )
      .map((name) => `packages/audio-engine/src/${name}`),
  ];
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function expressionRoot(expression: ts.Expression): ts.Expression {
  let current = unwrap(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrap(current.expression);
  }
  return current;
}

function rootsInSnapshot(expression: ts.Expression): boolean {
  const root = expressionRoot(expression);
  return ts.isIdentifier(root) && root.text === "snapshot";
}

function sourceLocation(
  path: string,
  source: ts.SourceFile,
  node: ts.Node,
): string {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${path}:${position.line + 1}:${position.character + 1}`;
}

describe("runtime snapshot wire contract", () => {
  it("closes every top-level and nested object with all properties required", () => {
    const objectSchemas = collectClosedObjectSchemas(schema);
    expect(objectSchemas.length).toBeGreaterThan(8);
    for (const { path, schema: objectSchema } of objectSchemas) {
      expect(
        objectSchema.additionalProperties,
        `${path}.additionalProperties`,
      ).toBe(false);
      expect(
        [...(objectSchema.required ?? [])].toSorted(),
        `${path}.required`,
      ).toEqual(
        Object.keys(objectSchema.properties ?? {}).toSorted(),
      );
    }
  });

  it("requires capture identity and audible modal evidence", () => {
    expect(schema.required).toContain("activeModeId");
    expect(schema.$defs.mode.required).toEqual(
      expect.arrayContaining([
        "modeId",
        "naturalFrequencyHz",
        "audibleWeightNormalized",
        "amplitudeNormalized",
        "phaseRad",
        "energyNormalized",
      ]),
    );
  });

  it("uses the same stable diagnostic-code language as producers", () => {
    expect(schema.$defs.diagnostic.properties.code.pattern).toBe(
      DIAGNOSTIC_CODE_PATTERN.source,
    );
    expect(
      new RegExp(
        schema.$defs.diagnostic.properties.code.pattern,
      ).test("MH-AUDIO-INVALID-SNAPSHOT"),
    ).toBe(true);
  });

  it("keeps every canonical snapshot field compile-time readonly", () => {
    const path = resolve(
      process.cwd(),
      "packages/contracts/src/runtime-snapshot.ts",
    );
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const contractNames = new Set([
      "DialSnapshot",
      "FeedbackSnapshot",
      "MicrophoneSnapshot",
      "ModalSnapshot",
      "RuntimeSnapshot",
      "VolumeSnapshot",
    ]);
    const violations: string[] = [];
    let checkedProperties = 0;

    for (const statement of source.statements) {
      if (
        (!ts.isInterfaceDeclaration(statement) &&
          !ts.isTypeAliasDeclaration(statement)) ||
        !contractNames.has(statement.name.text)
      ) {
        continue;
      }
      const inspect = (node: ts.Node): void => {
        if (ts.isPropertySignature(node)) {
          checkedProperties += 1;
          if (
            !node.modifiers?.some(
              (modifier) =>
                modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            )
          ) {
            violations.push(
              sourceLocation(
                "packages/contracts/src/runtime-snapshot.ts",
                source,
                node,
              ),
            );
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(statement);
    }

    expect(checkedProperties).toBeGreaterThan(30);
    expect(violations).toEqual([]);
  });

  it("keeps rendering and audio as read-only canonical snapshot consumers", () => {
    const mutatingMethods = new Set([
      "copyWithin",
      "fill",
      "pop",
      "push",
      "reverse",
      "shift",
      "sort",
      "splice",
      "unshift",
    ]);
    const assignmentKinds = new Set<number>();
    for (
      let kind = ts.SyntaxKind.FirstAssignment;
      kind <= ts.SyntaxKind.LastAssignment;
      kind += 1
    ) {
      assignmentKinds.add(kind);
    }
    const violations: string[] = [];

    for (const path of productionConsumerPaths()) {
      const source = ts.createSourceFile(
        path,
        readFileSync(join(process.cwd(), path), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        let reason: string | null = null;
        if (
          ts.isBinaryExpression(node) &&
          assignmentKinds.has(node.operatorToken.kind) &&
          rootsInSnapshot(node.left)
        ) {
          reason = "assigns into snapshot";
        } else if (
          (ts.isPrefixUnaryExpression(node) ||
            ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken) &&
          rootsInSnapshot(node.operand)
        ) {
          reason = "increments snapshot";
        } else if (
          ts.isDeleteExpression(node) &&
          rootsInSnapshot(node.expression)
        ) {
          reason = "deletes snapshot state";
        } else if (
          ts.isCallExpression(node) &&
          (ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression))
        ) {
          const callee = node.expression;
          const method = ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : callee.argumentExpression &&
                ts.isStringLiteral(callee.argumentExpression)
              ? callee.argumentExpression.text
              : null;
          if (
            method !== null &&
            mutatingMethods.has(method) &&
            rootsInSnapshot(callee.expression)
          ) {
            reason = `calls mutating ${method}`;
          }
        }
        if (
          reason === null &&
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ((node.expression.expression.getText(source) === "Object" &&
            node.expression.name.text === "assign") ||
            (node.expression.expression.getText(source) === "Reflect" &&
              node.expression.name.text === "set")) &&
          node.arguments[0] &&
          rootsInSnapshot(node.arguments[0])
        ) {
          reason = "uses a reflective snapshot write";
        }
        if (reason !== null) {
          violations.push(
            `${sourceLocation(path, source, node)} ${reason}`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
