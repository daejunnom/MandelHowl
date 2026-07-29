import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("web snapshot boundary", () => {
  it("keeps render and audio consumers on the canonical runtime snapshot", async () => {
    const [renderSource, audioSource] = await Promise.all([
      readFile(
        new URL("../../packages/render-engine/src/render-types.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../packages/audio-engine/src/safe-audio-engine.ts", import.meta.url),
        "utf8",
      ),
    ]);

    expect(renderSource).toMatch(/RuntimeSnapshot/);
    expect(audioSource).toMatch(/applyRuntimeSnapshot\(snapshot: RuntimeSnapshot\)/);
    expect(audioSource).not.toMatch(/snapshot\.volume/);
  });
});
