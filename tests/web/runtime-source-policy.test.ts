import { describe, expect, it } from "vitest";
import {
  forbiddenRuntimeReasons,
  isRuntimeSourcePath,
} from "../../tools/release-packager/src/runtime-source-policy.mjs";

describe("runtime source policy", () => {
  it("covers Svelte source and rejects raw HTML injection", () => {
    expect(isRuntimeSourcePath("apps/example/Control.svelte")).toBe(true);
    expect(forbiddenRuntimeReasons("<p>{@html untrusted}</p>")).toContain(
      "Svelte raw HTML injection is forbidden",
    );
  });

  it("applies the same deterministic and HTML rules to framework sources", () => {
    expect(
      forbiddenRuntimeReasons(
        "const value = Math.random(); const props = { dangerouslySetInnerHTML: html };",
      ),
    ).toEqual([
      "Math.random is forbidden in deterministic runtime source",
      "external or untrusted HTML injection is forbidden",
    ]);
    expect(forbiddenRuntimeReasons("<p>{safeText}</p>")).toEqual([]);
  });
});
