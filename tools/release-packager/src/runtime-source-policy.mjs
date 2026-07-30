import typescript from "typescript";

const ts = typescript.default ?? typescript;

const DIRECT_RANDOM_REASON =
  "Math.random is forbidden in deterministic runtime source";
const COMPUTED_RANDOM_REASON =
  "computed Math.random is forbidden in deterministic runtime source";
const BEACON_REASON = "outbound beacon telemetry is forbidden";
const ABSOLUTE_FETCH_REASON =
  "absolute-origin runtime fetch is forbidden; use verified local assets";
const STATE_CHANGING_FETCH_REASON =
  "state-changing runtime fetch is forbidden; input traces must remain local";
const OUTPUT_LOOKUP_REASON =
  "per-value runtime output lookup tables are forbidden";
const OUTPUT_SWITCH_REASON = "per-value runtime output switches are forbidden";
const OUTPUT_EXCEPTION_REASON =
  "per-value runtime output exceptions are forbidden";
const OPERATING_SYSTEM_VOLUME_REASON =
  "operating-system or device master-volume control is forbidden";
const NATIVE_HOST_BRIDGE_REASON =
  "native host bridges capable of operating-system control are forbidden";
const NATIVE_EXECUTION_REASON =
  "native process and filesystem modules are forbidden in browser runtime";
const OFFLINE_TOOL_IMPORT_REASON =
  "offline baker and release tools are forbidden in browser runtime";

const NATIVE_EXECUTION_IMPORT =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:node:)?(?:child_process|cluster|worker_threads|fs(?:\/promises)?|net|tls|dgram|vm|module|os)["']/;
const NATIVE_EXECUTION_GLOBAL =
  /\b(?:Deno\s*(?:\?\.|\.)\s*(?:Command|run)|Bun\s*(?:\?\.|\.)\s*spawn(?:Sync)?|process\s*(?:\?\.|\.)\s*(?:binding|dlopen|getBuiltinModule|mainModule))\b/;
const COMPUTED_NATIVE_EXECUTION_GLOBAL =
  /\bprocess\s*(?:\?\.)?\[\s*["'](?:binding|dlopen|getBuiltinModule|mainModule)["']\s*\]/;
const OFFLINE_TOOL_IMPORT =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:[^"']*\/)?tools\//;

export const FORBIDDEN_RUNTIME_RULES = Object.freeze([
  Object.freeze({
    pattern: /\bMath\.random\s*\(/,
    reason: DIRECT_RANDOM_REASON,
  }),
  Object.freeze({
    pattern:
      /\bMath\s*(?:\?\.)?\[\s*["']random["']\s*\]\s*(?:\?\.)?\s*\(/,
    reason: COMPUTED_RANDOM_REASON,
  }),
  Object.freeze({
    pattern: /\bgetUserMedia\s*(?:\?\.)?\s*\(/,
    reason: "real microphone/camera permission is forbidden",
  }),
  Object.freeze({
    pattern:
      /\bnavigator\s*(?:\?\.|\.)\s*(?:mediaDevices|geolocation|permissions)\b/,
    reason: "runtime device/location permission APIs are forbidden",
  }),
  Object.freeze({
    pattern:
      /\bnavigator\s*(?:\?\.)?\[\s*["'](?:mediaDevices|geolocation|permissions)["']\s*\]/,
    reason: "computed runtime permission APIs are forbidden",
  }),
  Object.freeze({
    pattern:
      /\b(?:getCurrentPosition|watchPosition|getDisplayMedia|requestPermission)\s*(?:\?\.)?\s*\(/,
    reason: "runtime permission requests are forbidden",
  }),
  Object.freeze({
    pattern:
      /\b(?:IAudioEndpointVolume|SetMasterVolumeLevel(?:Scalar)?|AudioEndpointVolume|set(?:System|Master|Device)Volume|set_(?:system|master|device)_volume|AudioDeviceCmdlets|nircmd|pactl|wpctl|amixer)\b/i,
    reason: OPERATING_SYSTEM_VOLUME_REASON,
  }),
  Object.freeze({
    pattern:
      /(?:\bipcRenderer\b|\b__TAURI__\b|@tauri-apps\/api|\bwindow\s*(?:\?\.|\.)\s*(?:external|ReactNativeWebView)\b|\b(?:window\s*(?:\?\.|\.)\s*)?chrome\s*(?:\?\.|\.)\s*webview\b|\b(?:window\s*(?:\?\.|\.)\s*)?webkit\s*(?:\?\.|\.)\s*messageHandlers\b|\bcordova\b|\bCapacitor\s*(?:\?\.|\.)\s*Plugins\b)/,
    reason: NATIVE_HOST_BRIDGE_REASON,
  }),
  Object.freeze({
    pattern: /\b(?:navigator\s*\.\s*)?sendBeacon\s*(?:\?\.)?\s*\(/,
    reason: BEACON_REASON,
  }),
  Object.freeze({
    pattern: /\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\s*\(/,
    reason: "unversioned outbound runtime channels are forbidden",
  }),
  Object.freeze({
    pattern:
      /\bfetch\s*\(\s*(?:new\s+URL\s*\(\s*)?["'](?:https?:)?\/\//,
    reason: ABSOLUTE_FETCH_REASON,
  }),
  Object.freeze({
    pattern: /\bdangerouslySetInnerHTML\b/,
    reason: "external or untrusted HTML injection is forbidden",
  }),
  Object.freeze({
    pattern: /\{@html\b/,
    reason: "Svelte raw HTML injection is forbidden",
  }),
  Object.freeze({
    pattern:
      /\.(?:innerHTML|outerHTML)\s*=|\.insertAdjacentHTML\s*\(|\bdocument\.write\s*\(/,
    reason: "imperative HTML injection sinks are forbidden",
  }),
  Object.freeze({
    pattern:
      /\b(?:volume|volumeValue|settledVolume)\s*={2,3}\s*(?:[1-9]|[1-9]\d)\b/,
    reason: OUTPUT_EXCEPTION_REASON,
  }),
  Object.freeze({
    pattern: /\bswitch\s*\([^)]*\b(?:volume|settledVolume)\b[^)]*\)/,
    reason: OUTPUT_SWITCH_REASON,
  }),
  Object.freeze({
    pattern:
      /\b(?:volumeLookup|volumeTable|perValueMap|perValueLookup)\s*\[/i,
    reason: OUTPUT_LOOKUP_REASON,
  }),
]);

export function isRuntimeSourcePath(file) {
  return /\.(?:ts|tsx|js|mjs|svelte|yaml|json)$/.test(file);
}

function isBrowserRuntimeExecutionPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.includes("/generated/") ||
    normalized.includes("/scripts/")
  ) {
    return false;
  }
  return (
    normalized === "runtime.tsx" ||
    /^(?:app|apps|packages|worker)\//.test(normalized)
  );
}

function unwrap(expression) {
  if (!expression) return null;
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    (ts.isSatisfiesExpression?.(current) ?? false)
  ) {
    current = current.expression;
  }
  return current;
}

function sourceSegments(source, filePath) {
  if (!filePath?.endsWith(".svelte") && !/<script(?:\s|>)/i.test(source)) {
    return [source];
  }
  const segments = [];
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = scriptPattern.exec(source)) !== null) {
    segments.push(match[1] ?? "");
  }
  return segments;
}

function parseRuntimeSource(source) {
  return ts.createSourceFile(
    "runtime-source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function staticPropertyName(name, staticStrings) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return evaluateStaticString(name.expression, staticStrings);
  }
  return null;
}

function evaluateStaticString(expression, staticStrings) {
  if (!expression) return null;
  const node = unwrap(expression);
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isIdentifier(node)) {
    return staticStrings.get(node.text) ?? null;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateStaticString(node.left, staticStrings);
    const right = evaluateStaticString(node.right, staticStrings);
    return left === null || right === null ? null : left + right;
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "URL"
  ) {
    return evaluateStaticString(node.arguments?.[0], staticStrings);
  }
  return null;
}

function memberProperty(expression, staticStrings) {
  if (!expression) return null;
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    return evaluateStaticString(node.argumentExpression, staticStrings);
  }
  return null;
}

function memberObject(expression) {
  if (!expression) return null;
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return unwrap(node.expression);
  }
  return null;
}

function isGlobalObject(expression) {
  if (!expression) return false;
  const node = unwrap(expression);
  return (
    ts.isIdentifier(node) &&
    (node.text === "globalThis" || node.text === "window" || node.text === "self")
  );
}

function isNavigator(expression) {
  if (!expression) return false;
  const node = unwrap(expression);
  if (ts.isIdentifier(node) && node.text === "navigator") return true;
  return (
    isGlobalObject(memberObject(node)) &&
    memberProperty(node, new Map()) === "navigator"
  );
}

function isMathObject(expression, mathAliases, staticStrings) {
  if (!expression) return false;
  const node = unwrap(expression);
  if (
    ts.isIdentifier(node) &&
    (node.text === "Math" || mathAliases.has(node.text))
  ) {
    return true;
  }
  return (
    isGlobalObject(memberObject(node)) &&
    memberProperty(node, staticStrings) === "Math"
  );
}

function isReflectGetOf(expression, objectPredicate, property, staticStrings) {
  if (!expression) return false;
  const node = unwrap(expression);
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return (
    (ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)) &&
    ts.isIdentifier(unwrap(callee.expression)) &&
    unwrap(callee.expression).text === "Reflect" &&
    memberProperty(callee, staticStrings) === "get" &&
    Boolean(node.arguments[0] && objectPredicate(node.arguments[0])) &&
    evaluateStaticString(node.arguments[1], staticStrings) === property
  );
}

function isRandomReference(expression, mathAliases, staticStrings) {
  if (!expression) return false;
  const node = unwrap(expression);
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    memberProperty(node, staticStrings) === "random" &&
    isMathObject(node.expression, mathAliases, staticStrings)
  ) {
    return true;
  }
  return isReflectGetOf(
    node,
    (candidate) => isMathObject(candidate, mathAliases, staticStrings),
    "random",
    staticStrings,
  );
}

function isFetchReference(expression, fetchAliases, staticStrings) {
  if (!expression) return false;
  const node = unwrap(expression);
  if (
    ts.isIdentifier(node) &&
    (node.text === "fetch" || fetchAliases.has(node.text))
  ) {
    return true;
  }
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    memberProperty(node, staticStrings) === "fetch" &&
    isGlobalObject(node.expression)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(node) &&
    memberProperty(node.expression, staticStrings) === "bind"
  ) {
    const receiver = memberObject(node.expression);
    return Boolean(
      receiver && isFetchReference(receiver, fetchAliases, staticStrings),
    );
  }
  return isReflectGetOf(
    node,
    isGlobalObject,
    "fetch",
    staticStrings,
  );
}

function isSendBeaconReference(expression, beaconAliases, staticStrings) {
  if (!expression) return false;
  const node = unwrap(expression);
  if (ts.isIdentifier(node) && beaconAliases.has(node.text)) return true;
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    memberProperty(node, staticStrings) === "sendBeacon" &&
    isNavigator(node.expression)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(node) &&
    memberProperty(node.expression, staticStrings) === "bind"
  ) {
    const receiver = memberObject(node.expression);
    return Boolean(
      receiver &&
        isSendBeaconReference(receiver, beaconAliases, staticStrings),
    );
  }
  return isReflectGetOf(node, isNavigator, "sendBeacon", staticStrings);
}

function outputMemberPath(expression, staticStrings) {
  const path = [];
  let current = unwrap(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const property = memberProperty(current, staticStrings);
    if (property === null) return [];
    path.unshift(property);
    current = unwrap(current.expression);
  }
  if (ts.isIdentifier(current)) path.unshift(current.text);
  return path;
}

const DIRECT_OUTPUT_NAMES =
  /^(?:volume|volumeValue|settledVolume|lastSettledVolume|outputVolume|virtualVolume)$/i;

function isOutputValueExpression(expression, outputAliases, staticStrings) {
  if (!expression) return false;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    return (
      DIRECT_OUTPUT_NAMES.test(node.text) ||
      isOutputAliasIdentifier(node, outputAliases)
    );
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const path = outputMemberPath(node, staticStrings);
    const last = path.at(-1) ?? "";
    const lowerPath = path.map((part) => part.toLowerCase());
    if (DIRECT_OUTPUT_NAMES.test(last)) return true;
    if (
      lowerPath.includes("volume") &&
      (last === "value" || last === "lastSettledValue" || last === "progress")
    ) {
      return true;
    }
    return isOutputValueExpression(node.expression, outputAliases, staticStrings);
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    if (isOutputValueExpression(node.expression, outputAliases, staticStrings)) {
      return true;
    }
    return (
      node.arguments?.some((argument) =>
        isOutputValueExpression(argument, outputAliases, staticStrings),
      ) ?? false
    );
  }
  if (ts.isBinaryExpression(node)) {
    return (
      isOutputValueExpression(node.left, outputAliases, staticStrings) ||
      isOutputValueExpression(node.right, outputAliases, staticStrings)
    );
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isOutputValueExpression(node.condition, outputAliases, staticStrings) ||
      isOutputValueExpression(node.whenTrue, outputAliases, staticStrings) ||
      isOutputValueExpression(node.whenFalse, outputAliases, staticStrings)
    );
  }
  if (
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    ts.isAwaitExpression(node)
  ) {
    return isOutputValueExpression(node.operand, outputAliases, staticStrings);
  }
  return false;
}

function collectBindingIdentifiers(name, target) {
  if (ts.isIdentifier(name)) {
    target.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingIdentifiers(element.name, target);
    }
  }
}

function collectBindingIdentifierNodes(name, target) {
  if (ts.isIdentifier(name)) {
    target.push(name);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingIdentifierNodes(element.name, target);
    }
  }
}

function bindingScope(node) {
  let current = node.parent;
  while (
    current &&
    !ts.isSourceFile(current) &&
    !ts.isBlock(current) &&
    !ts.isFunctionLike(current)
  ) {
    current = current.parent;
  }
  return current;
}

function addBindingRecords(name, bindings) {
  const identifiers = [];
  collectBindingIdentifierNodes(name, identifiers);
  for (const identifier of identifiers) {
    const scope = bindingScope(identifier);
    if (!scope) continue;
    const records = bindings.get(identifier.text) ?? [];
    records.push({
      declaration: identifier,
      scope,
    });
    bindings.set(identifier.text, records);
  }
}

function resolveBinding(identifier, bindings) {
  const records = bindings.get(identifier.text) ?? [];
  let selected = null;
  let selectedSpan = Number.POSITIVE_INFINITY;
  let selectedStart = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (
      identifier.pos < record.scope.pos ||
      identifier.end > record.scope.end
    ) {
      continue;
    }
    const span = record.scope.end - record.scope.pos;
    const start = record.declaration.pos;
    if (
      span < selectedSpan ||
      (span === selectedSpan && start > selectedStart)
    ) {
      selected = record.declaration;
      selectedSpan = span;
      selectedStart = start;
    }
  }
  return selected;
}

function isOutputAliasIdentifier(identifier, outputAliases) {
  const declaration = resolveBinding(identifier, outputAliases.bindings);
  return Boolean(
    declaration && outputAliases.aliasedBindings.has(declaration),
  );
}

function addOutputAliasesFromBinding(name, outputAliases) {
  const identifiers = [];
  collectBindingIdentifierNodes(name, identifiers);
  let changed = false;
  for (const identifier of identifiers) {
    if (!outputAliases.aliasedBindings.has(identifier)) {
      outputAliases.aliasedBindings.add(identifier);
      changed = true;
    }
  }
  return changed;
}

function bindingIncludesProperty(name, property, staticStrings) {
  if (ts.isIdentifier(name)) return false;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const declaredProperty =
      staticPropertyName(element.propertyName, staticStrings) ??
      (ts.isIdentifier(element.name) ? element.name.text : null);
    if (declaredProperty === property) return true;
    if (bindingIncludesProperty(element.name, property, staticStrings)) {
      return true;
    }
  }
  return false;
}

function addAliasesFromBinding(name, target) {
  const names = [];
  collectBindingIdentifiers(name, names);
  let changed = false;
  for (const value of names) {
    if (!target.has(value)) {
      target.add(value);
      changed = true;
    }
  }
  return changed;
}

function collectAnalysisFacts(sourceFile) {
  const declarations = [];
  const assignments = [];
  const staticStrings = new Map();
  const mathAliases = new Set();
  const fetchAliases = new Set();
  const beaconAliases = new Set();
  const outputAliases = {
    aliasedBindings: new Set(),
    bindings: new Map(),
  };

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      addBindingRecords(node.name, outputAliases.bindings);
    }
    if (ts.isParameter(node)) {
      addBindingRecords(node.name, outputAliases.bindings);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrap(node.left))
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const maximumPasses = declarations.length + assignments.length + 2;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.initializer;
      if (ts.isIdentifier(declaration.name)) {
        const name = declaration.name.text;
        const staticValue = evaluateStaticString(initializer, staticStrings);
        if (
          staticValue !== null &&
          staticStrings.get(name) !== staticValue
        ) {
          staticStrings.set(name, staticValue);
          changed = true;
        }
        if (
          initializer &&
          isMathObject(initializer, mathAliases, staticStrings) &&
          !mathAliases.has(name)
        ) {
          mathAliases.add(name);
          changed = true;
        }
        if (
          initializer &&
          isFetchReference(initializer, fetchAliases, staticStrings) &&
          !fetchAliases.has(name)
        ) {
          fetchAliases.add(name);
          changed = true;
        }
        if (
          initializer &&
          isSendBeaconReference(initializer, beaconAliases, staticStrings) &&
          !beaconAliases.has(name)
        ) {
          beaconAliases.add(name);
          changed = true;
        }
        if (
          initializer &&
          isOutputValueExpression(initializer, outputAliases, staticStrings) &&
          !outputAliases.aliasedBindings.has(declaration.name)
        ) {
          outputAliases.aliasedBindings.add(declaration.name);
          changed = true;
        }
      } else if (initializer) {
        if (
          isMathObject(initializer, mathAliases, staticStrings) &&
          bindingIncludesProperty(declaration.name, "random", staticStrings)
        ) {
          changed = addAliasesFromBinding(declaration.name, mathAliases) || changed;
        }
        if (
          isGlobalObject(initializer) &&
          bindingIncludesProperty(declaration.name, "fetch", staticStrings)
        ) {
          changed = addAliasesFromBinding(declaration.name, fetchAliases) || changed;
        }
        if (
          isNavigator(initializer) &&
          bindingIncludesProperty(
            declaration.name,
            "sendBeacon",
            staticStrings,
          )
        ) {
          changed =
            addAliasesFromBinding(declaration.name, beaconAliases) || changed;
        }
        if (
          isOutputValueExpression(initializer, outputAliases, staticStrings) ||
          bindingIncludesProperty(declaration.name, "volume", staticStrings)
        ) {
          changed =
            addOutputAliasesFromBinding(declaration.name, outputAliases) ||
            changed;
        }
      }
    }
    for (const assignment of assignments) {
      const name = unwrap(assignment.left).text;
      if (
        isMathObject(assignment.right, mathAliases, staticStrings) &&
        !mathAliases.has(name)
      ) {
        mathAliases.add(name);
        changed = true;
      }
      if (
        isFetchReference(assignment.right, fetchAliases, staticStrings) &&
        !fetchAliases.has(name)
      ) {
        fetchAliases.add(name);
        changed = true;
      }
      if (
        isSendBeaconReference(
          assignment.right,
          beaconAliases,
          staticStrings,
        ) &&
        !beaconAliases.has(name)
      ) {
        beaconAliases.add(name);
        changed = true;
      }
      if (
        isOutputValueExpression(
          assignment.right,
          outputAliases,
          staticStrings,
        )
      ) {
        const binding = resolveBinding(
          unwrap(assignment.left),
          outputAliases.bindings,
        );
        if (binding && !outputAliases.aliasedBindings.has(binding)) {
          outputAliases.aliasedBindings.add(binding);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return {
    beaconAliases,
    fetchAliases,
    mathAliases,
    outputAliases,
    staticStrings,
  };
}

function objectPropertyValue(expression, property, staticStrings, initializers) {
  if (!expression) return null;
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) {
    const initializer = initializers.get(node.text);
    return initializer
      ? objectPropertyValue(initializer, property, staticStrings, initializers)
      : null;
  }
  if (!ts.isObjectLiteralExpression(node)) return null;
  for (const member of node.properties) {
    if (
      ts.isPropertyAssignment(member) &&
      staticPropertyName(member.name, staticStrings) === property
    ) {
      return member.initializer;
    }
    if (
      ts.isShorthandPropertyAssignment(member) &&
      member.name.text === property
    ) {
      return member.name;
    }
  }
  return null;
}

function fetchInvocation(call, facts) {
  const callee = unwrap(call.expression);
  if (isFetchReference(callee, facts.fetchAliases, facts.staticStrings)) {
    return { arguments: call.arguments };
  }
  const operation = memberProperty(callee, facts.staticStrings);
  const receiver = memberObject(callee);
  if (
    receiver &&
    (operation === "call" || operation === "apply") &&
    isFetchReference(receiver, facts.fetchAliases, facts.staticStrings)
  ) {
    if (operation === "call") {
      return { arguments: call.arguments.slice(1) };
    }
    return { arguments: null };
  }
  return null;
}

function isIntegerOutputException(expression) {
  const node = unwrap(expression);
  if (!ts.isNumericLiteral(node)) return false;
  const value = Number(node.text);
  return Number.isInteger(value) && value >= 1 && value <= 99;
}

function analyzeAst(source) {
  const reasons = new Set();
  const sourceFile = parseRuntimeSource(source);
  const facts = collectAnalysisFacts(sourceFile);
  const initializers = new Map();

  function collectInitializers(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectInitializers);
  }
  collectInitializers(sourceFile);

  function visit(node) {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isCallExpression(node)) &&
      isRandomReference(node, facts.mathAliases, facts.staticStrings)
    ) {
      reasons.add(
        ts.isElementAccessExpression(node)
          ? COMPUTED_RANDOM_REASON
          : ts.isCallExpression(node)
            ? COMPUTED_RANDOM_REASON
            : DIRECT_RANDOM_REASON,
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      !ts.isIdentifier(node.name) &&
      node.initializer &&
      isMathObject(node.initializer, facts.mathAliases, facts.staticStrings) &&
      bindingIncludesProperty(node.name, "random", facts.staticStrings)
    ) {
      reasons.add(DIRECT_RANDOM_REASON);
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isCallExpression(node)) &&
      isSendBeaconReference(node, facts.beaconAliases, facts.staticStrings)
    ) {
      reasons.add(BEACON_REASON);
    }
    if (
      ts.isVariableDeclaration(node) &&
      !ts.isIdentifier(node.name) &&
      node.initializer &&
      isNavigator(node.initializer) &&
      bindingIncludesProperty(node.name, "sendBeacon", facts.staticStrings)
    ) {
      reasons.add(BEACON_REASON);
    }

    if (
      ts.isElementAccessExpression(node) &&
      isOutputValueExpression(
        node.argumentExpression,
        facts.outputAliases,
        facts.staticStrings,
      )
    ) {
      reasons.add(OUTPUT_LOOKUP_REASON);
    }
    if (ts.isComputedPropertyName(node)) {
      if (
        isOutputValueExpression(
          node.expression,
          facts.outputAliases,
          facts.staticStrings,
        )
      ) {
        reasons.add(OUTPUT_LOOKUP_REASON);
      }
    }
    if (ts.isSwitchStatement(node)) {
      if (
        isOutputValueExpression(
          node.expression,
          facts.outputAliases,
          facts.staticStrings,
        )
      ) {
        reasons.add(OUTPUT_SWITCH_REASON);
      }
    }
    if (ts.isBinaryExpression(node)) {
      const equalityOperators = new Set([
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ]);
      if (
        equalityOperators.has(node.operatorToken.kind) &&
        ((isOutputValueExpression(
          node.left,
          facts.outputAliases,
          facts.staticStrings,
        ) &&
          isIntegerOutputException(node.right)) ||
          (isOutputValueExpression(
            node.right,
            facts.outputAliases,
            facts.staticStrings,
          ) &&
            isIntegerOutputException(node.left)))
      ) {
        reasons.add(OUTPUT_EXCEPTION_REASON);
      }
    }
    if (ts.isCallExpression(node)) {
      const operation = memberProperty(node.expression, facts.staticStrings);
      if (
        (operation === "get" || operation === "at" || operation === "has") &&
        node.arguments.some((argument) =>
          isOutputValueExpression(
            argument,
            facts.outputAliases,
            facts.staticStrings,
          ),
        )
      ) {
        reasons.add(OUTPUT_LOOKUP_REASON);
      }

      const invocation = fetchInvocation(node, facts);
      if (invocation) {
        if (invocation.arguments === null) {
          reasons.add(STATE_CHANGING_FETCH_REASON);
        } else {
          let [requestExpression, initExpression] = invocation.arguments;
          const request = requestExpression && unwrap(requestExpression);
          if (
            request &&
            ts.isNewExpression(request) &&
            ts.isIdentifier(request.expression) &&
            request.expression.text === "Request"
          ) {
            requestExpression = request.arguments?.[0];
            initExpression = request.arguments?.[1] ?? initExpression;
          }
          const url =
            evaluateStaticString(requestExpression, facts.staticStrings) ?? "";
          const methodExpression = objectPropertyValue(
            initExpression,
            "method",
            facts.staticStrings,
            initializers,
          );
          const method = (
            evaluateStaticString(methodExpression, facts.staticStrings) ?? "GET"
          ).toUpperCase();
          const body = objectPropertyValue(
            initExpression,
            "body",
            facts.staticStrings,
            initializers,
          );
          const traceLike = /(?:^|[/_-])(?:trace|telemetry|gesture|input-history|diagnostic|upload|collect)(?:[/_.-]|$)/i.test(
            url,
          );
          if (/^(?:https?:)?\/\//i.test(url)) {
            reasons.add(ABSOLUTE_FETCH_REASON);
          }
          if (
            !["GET", "HEAD", "OPTIONS"].includes(method) ||
            body !== null ||
            (traceLike && initExpression && methodExpression === null)
          ) {
            reasons.add(STATE_CHANGING_FETCH_REASON);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return reasons;
}

export function forbiddenRuntimeReasons(source, filePath = "runtime.tsx") {
  const reasons = new Set(
    FORBIDDEN_RUNTIME_RULES.filter((rule) => rule.pattern.test(source)).map(
      (rule) => rule.reason,
    ),
  );
  if (isBrowserRuntimeExecutionPath(filePath)) {
    if (
      NATIVE_EXECUTION_IMPORT.test(source) ||
      NATIVE_EXECUTION_GLOBAL.test(source) ||
      COMPUTED_NATIVE_EXECUTION_GLOBAL.test(source)
    ) {
      reasons.add(NATIVE_EXECUTION_REASON);
    }
    if (OFFLINE_TOOL_IMPORT.test(source)) {
      reasons.add(OFFLINE_TOOL_IMPORT_REASON);
    }
  }
  if (!/\.(?:json|ya?ml)$/i.test(filePath)) {
    for (const segment of sourceSegments(source, filePath)) {
      for (const reason of analyzeAst(segment)) reasons.add(reason);
    }
  }
  return [...reasons];
}
