import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();

function productionSources(): readonly string[] {
  return [
    ...new Set(
      execFileSync(
        "git",
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          "packages",
          "app",
          "apps",
        ],
        { cwd: workspaceRoot, encoding: "utf8" },
      )
        .split("\0")
        .filter(
          (path) =>
            /\.(?:[cm]?[jt]sx?|svelte)$/.test(path) &&
            !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(path) &&
            !path.includes("/generated/") &&
            existsSync(resolve(workspaceRoot, path)),
        ),
    ),
  ].sort();
}

function sourceFile(path: string): ts.SourceFile {
  const absolute = resolve(workspaceRoot, path);
  const rawSource = readFileSync(absolute, "utf8");
  const parsedSource = path.endsWith(".svelte")
    ? [...rawSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1] ?? "")
        .join("\n")
    : rawSource;
  return ts.createSourceFile(
    path,
    parsedSource,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") || path.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : path.endsWith(".js") ||
          path.endsWith(".mjs") ||
          path.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS,
  );
}

function visit(
  source: ts.SourceFile,
  callback: (node: ts.Node) => void,
): void {
  const walk = (node: ts.Node) => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
}

function display(path: string, node: ts.Node): string {
  const { line, character } = node
    .getSourceFile()
    .getLineAndCharacterOfPosition(node.getStart());
  return `${path}:${line + 1}:${character + 1}`;
}

function importedSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  visit(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
  });
  return specifiers;
}

describe("handoff architecture boundaries", () => {
  const sources = productionSources();

  it("audits both core engines and both production UI implementations", () => {
    expect(sources).toEqual(
      expect.arrayContaining([
        "packages/dial-engine/src/dial-engine.ts",
        "packages/resonance-engine/src/resonance-engine.ts",
        "apps/react-ui/src/MandelHowlReactApp.tsx",
        "apps/svelte-ui/src/MandelHowlApp.svelte",
      ]),
    );
  });

  it("keeps dial/resonance core independent of browser and ambient clocks", () => {
    const violations: string[] = [];
    const forbiddenIdentifiers = new Set([
      "window",
      "document",
      "navigator",
      "self",
      "Date",
      "performance",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "setTimeout",
      "setInterval",
      "fetch",
      "WebSocket",
      "EventSource",
      "AudioContext",
      "OfflineAudioContext",
      "HTMLElement",
      "HTMLCanvasElement",
      "WebGLRenderingContext",
      "WebGL2RenderingContext",
    ]);
    for (const path of sources.filter(
      (candidate) =>
        candidate.startsWith("packages/dial-engine/src/") ||
        candidate.startsWith("packages/resonance-engine/src/"),
    )) {
      const source = sourceFile(path);
      visit(source, (node) => {
        if (
          ts.isIdentifier(node) &&
          forbiddenIdentifiers.has(node.text)
        ) {
          violations.push(`${display(path, node)} uses ${node.text}`);
        }
        if (ts.isPropertyAccessExpression(node)) {
          const owner = node.expression.getText(source);
          const member = node.name.text;
          if (
            (owner === "Math" && member === "random") ||
            (owner === "crypto" &&
              (member === "getRandomValues" ||
                member === "randomUUID"))
          ) {
            violations.push(
              `${display(path, node)} uses ${owner}.${member}`,
            );
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("enforces the canonical package dependency direction", () => {
    const allowedDependencies: Readonly<Record<string, readonly string[]>> =
      Object.freeze({
        "asset-runtime": Object.freeze(["contracts"]),
        "audio-engine": Object.freeze(["contracts"]),
        "browser-runtime": Object.freeze([
          "audio-engine",
          "contracts",
          "dial-engine",
          "render-engine",
          "resonance-engine",
        ]),
        contracts: Object.freeze([]),
        diagnostics: Object.freeze(["contracts"]),
        "dial-engine": Object.freeze(["contracts"]),
        "presentation-model": Object.freeze(["contracts"]),
        "render-engine": Object.freeze(["contracts", "diagnostics"]),
        "resonance-engine": Object.freeze(["contracts", "dial-engine"]),
      });
    const violations: string[] = [];

    for (const path of sources.filter((candidate) =>
      candidate.startsWith("packages/"),
    )) {
      const [, owner] = path.split("/");
      const allowed = allowedDependencies[owner];
      if (!allowed) {
        violations.push(`${path} belongs to an unregistered package ${owner}`);
        continue;
      }
      const source = sourceFile(path);
      for (const specifier of importedSpecifiers(source)) {
        const target = specifier.startsWith(".")
          ? relative(
              workspaceRoot,
              resolve(dirname(resolve(workspaceRoot, path)), specifier),
            )
              .split(sep)
              .join("/")
          : specifier;
        const match =
          /^(?:@\/)?packages\/([^/]+)(?:\/|$)/.exec(target) ??
          /^@mandelhowl\/([^/]+)(?:\/|$)/.exec(target);
        const dependency = match?.[1];
        if (
          dependency &&
          dependency !== owner &&
          !allowed.includes(dependency)
        ) {
          violations.push(
            `${path} imports disallowed package ${dependency} via ${specifier}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("forbids package source from importing app composition roots", () => {
    const violations: string[] = [];
    for (const path of sources.filter((candidate) =>
      candidate.startsWith("packages/"),
    )) {
      const source = sourceFile(path);
      for (const specifier of importedSpecifiers(source)) {
        const resolved = specifier.startsWith(".")
          ? resolve(dirname(resolve(workspaceRoot, path)), specifier)
          : null;
        const relativeTarget = resolved
          ? relative(workspaceRoot, resolved).split(sep).join("/")
          : specifier;
        if (
          relativeTarget === "app" ||
          relativeTarget.startsWith("app/") ||
          relativeTarget === "apps" ||
          relativeTarget.startsWith("apps/") ||
          relativeTarget.startsWith("@/app/") ||
          relativeTarget.startsWith("@/apps/")
        ) {
          violations.push(`${path} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps modal integration and virtual-volume mapping out of app views", () => {
    const violations: string[] = [];
    const forbiddenIdentifiers = new Set([
      "GENERATED_FEEDBACK_SPEC",
      "GENERATED_VOLUME_MAP_SPEC",
      "advanceResonance",
      "advanceResonanceScalars",
      "classifyResonanceRegime",
      "createResonanceState",
      "estimateOpenLoopMarginAtFrequency",
      "getResonanceSnapshot",
      "initResonance",
      "replaceResonanceDataset",
      "resetResonanceAfterPausedGap",
      "stepResonance",
      "volumeFromVirtualRms",
    ]);
    for (const path of sources.filter(
      (candidate) =>
        candidate.startsWith("app/") || candidate.startsWith("apps/"),
    )) {
      const source = sourceFile(path);
      visit(source, (node) => {
        if (
          ts.isIdentifier(node) &&
          forbiddenIdentifiers.has(node.text)
        ) {
          violations.push(`${display(path, node)} uses ${node.text}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("keeps virtual-volume ownership out of render and audio engines", () => {
    const violations: string[] = [];
    const forbiddenIdentifiers = new Set([
      "GENERATED_VOLUME_MAP_SPEC",
      "volumeFromVirtualRms",
      "noiseFloorRms",
      "saturationRms",
    ]);
    for (const path of sources.filter(
      (candidate) =>
        candidate.startsWith("packages/render-engine/src/") ||
        candidate.startsWith("packages/audio-engine/src/"),
    )) {
      const source = sourceFile(path);
      visit(source, (node) => {
        if (
          ts.isIdentifier(node) &&
          forbiddenIdentifiers.has(node.text)
        ) {
          violations.push(`${display(path, node)} uses ${node.text}`);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === "volume"
        ) {
          violations.push(`${display(path, node)} reads .volume`);
        }
        if (
          ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === "volume"
        ) {
          violations.push(`${display(path, node)} reads [\"volume\"]`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
