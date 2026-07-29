import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

describe("web presentation contract", () => {
  it("preserves the last settled output while the measurement window is open", async () => {
    const [react, svelte] = await Promise.all([
      readFile(
        new URL("apps/react-ui/src/MandelHowlReactApp.tsx", root),
        "utf8",
      ),
      readFile(
        new URL("apps/svelte-ui/src/MandelHowlApp.svelte", root),
        "utf8",
      ),
    ]);
    for (const implementation of [react, svelte]) {
      expect(implementation).toMatch(
        /snapshot\.volume\.status === "settled"/,
      );
      expect(implementation).toMatch(
        /snapshot\.volume\.lastSettledValue \?\? 0/,
      );
    }
    expect(react).toMatch(
      /measurementStatus=\{snapshot\.volume\.status\}/,
    );
    expect(svelte).toMatch(
      /mh-measurement-\$\{snapshot\.volume\.status\}/,
    );
  });

  it("announces only settled volume and handles lost pointer capture", async () => {
    const scene = await readFile(
      new URL("app/mandelhowl-scene.tsx", root),
      "utf8",
    );
    expect(scene).toMatch(/stableAnnouncement/);
    expect(scene).toMatch(/Volume settled at/);
    expect(scene).toMatch(/onLostPointerCapture=\{onDialLostPointerCapture\}/);
    expect(scene).not.toMatch(
      /className="mh-volume-readout"\s+aria-live=/,
    );
  });

  it("keeps scientific provenance conditional on verified data", async () => {
    const scene = await readFile(
      new URL("app/mandelhowl-scene.tsx", root),
      "utf8",
    );
    expect(scene).toMatch(/VERIFIED THIN-PLATE BAKE/);
    expect(scene).toMatch(/ANALYTICAL PROTOTYPE/);
    expect(scene).toMatch(
      /isVerifiedDataset\s*\?\s*"verified Mandelbrot-encoded thin-plate bake"\s*:\s*"explicitly labelled analytical prototype plate"/,
    );
    expect(scene).not.toMatch(
      /aria-label=["{`][^]*speaker drives the Mandelbrot-encoded/,
    );
    expect(scene).not.toMatch(/FEM BAKE PENDING/);
  });

  it("retains reduced-motion, high-contrast and responsive fallbacks", async () => {
    const css = await readFile(
      new URL("app/mandelhowl.css", root),
      "utf8",
    );
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[^]*animation:\s*none\s*!important/,
    );
    expect(css).toMatch(/forced-colors:\s*active/);
    expect(css).toMatch(/prefers-contrast:\s*more/);
    expect(css).toMatch(/max-width:\s*520px/);
  });

  it("makes each lazy UI candidate report its own compiled contract identity", async () => {
    const [host, reactEntry, svelteEntry] = await Promise.all([
      readFile(new URL("app/mandelhowl-ui-host.tsx", root), "utf8"),
      readFile(new URL("apps/react-ui/src/entry.tsx", root), "utf8"),
      readFile(new URL("apps/svelte-ui/src/entry.ts", root), "utf8"),
    ]);
    for (const entry of [reactEntry, svelteEntry]) {
      expect(entry).toMatch(/import \{ N_VERSION_CONTRACT_DIGESTS \}/);
      expect(entry).toMatch(/_UI_IMPLEMENTATION_IDENTITY/);
      expect(entry).not.toMatch(/ImplementationIdentity/);
      expect(entry).not.toMatch(/identity\.scientificAlgorithmDigest/);
    }
    expect(host).toMatch(/createSvelteUiImplementation\(\)/);
    expect(host).toMatch(/createReactUiImplementation\(\)/);
  });
});
