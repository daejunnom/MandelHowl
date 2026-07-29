export const FORBIDDEN_RUNTIME_RULES = Object.freeze([
  Object.freeze({
    pattern: /\bMath\.random\s*\(/,
    reason: "Math.random is forbidden in deterministic runtime source",
  }),
  Object.freeze({
    pattern: /\bgetUserMedia\s*\(/,
    reason: "real microphone/camera permission is forbidden",
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
      /\b(?:volume|volumeValue|settledVolume)\s*={2,3}\s*(?:[1-9]|[1-9]\d)\b/,
    reason: "per-value runtime output exceptions are forbidden",
  }),
  Object.freeze({
    pattern: /\bswitch\s*\([^)]*\b(?:volume|settledVolume)\b[^)]*\)/,
    reason: "per-value runtime output switches are forbidden",
  }),
]);

export function isRuntimeSourcePath(file) {
  return /\.(?:ts|tsx|js|mjs|svelte|yaml|json)$/.test(file);
}

export function forbiddenRuntimeReasons(source) {
  return FORBIDDEN_RUNTIME_RULES.filter((rule) => rule.pattern.test(source)).map(
    (rule) => rule.reason,
  );
}
