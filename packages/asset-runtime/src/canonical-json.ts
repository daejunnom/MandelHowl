import type { ResonanceManifest } from "../../contracts/src";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * RFC 8785-compatible canonicalization for the JSON domain used by manifests:
 * object keys are code-point sorted, arrays preserve order and non-finite
 * numbers are rejected.
 */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON forbids non-finite numbers");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  const record = value as { readonly [key: string]: JsonValue };
  const pairs = Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeJson(record[key] as JsonValue)}`,
    );
  return `{${pairs.join(",")}}`;
}

/**
 * datasetId and directoryName both contain the resulting digest and are
 * omitted together to avoid a circular identity definition.
 */
export function manifestIdentityPayload(
  manifest: ResonanceManifest,
): JsonValue {
  const source = manifest as unknown as Record<string, JsonValue>;
  const contentAddressing = {
    ...(source.contentAddressing as Record<string, JsonValue>),
  };
  delete contentAddressing.directoryName;
  const payload: Record<string, JsonValue> = {
    ...source,
    contentAddressing,
  };
  delete payload.datasetId;
  return payload;
}
