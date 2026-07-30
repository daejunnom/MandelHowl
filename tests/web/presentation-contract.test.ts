import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  resolveDatasetPresentationState,
  type MandelHowlUiSnapshot,
} from "../../packages/browser-runtime/src";

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
    expect(scene).toMatch(/VERIFIED BAKE \/ TEXTURES STREAMING/);
    expect(scene).toMatch(/ANALYTICAL PROTOTYPE/);
    expect(scene).toMatch(/plateProvenanceDescription/);
    expect(scene).not.toMatch(
      /aria-label=["{`][^]*speaker drives the Mandelbrot-encoded/,
    );
    expect(scene).not.toMatch(/FEM BAKE PENDING/);
  });

  it("gates verified claims on the current renderer shard in both UI versions", async () => {
    const datasetId = `sha256:${"a".repeat(64)}`;
    const presentation = {
      datasetStatus: "verified",
      runtime: { datasetId },
      renderer: {
        datasetId,
        textureReady: false,
        contextLost: false,
      },
    } as unknown as MandelHowlUiSnapshot;
    expect(resolveDatasetPresentationState(presentation)).toBe(
      "streaming",
    );
    expect(
      resolveDatasetPresentationState({
        ...presentation,
        renderer: {
          ...presentation.renderer!,
          textureReady: true,
        },
      }),
    ).toBe("verified");
    expect(
      resolveDatasetPresentationState({
        ...presentation,
        renderer: {
          ...presentation.renderer!,
          datasetId: `sha256:${"b".repeat(64)}`,
          textureReady: true,
        },
      }),
    ).toBe("streaming");

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
        /resolveDatasetPresentationState\(presentation\)/,
      );
    }
    expect(svelte).toMatch(/VERIFIED BAKE \/ TEXTURES STREAMING/);
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
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[^]*\.mh-air-waves span\s*\{[^}]*var\(--microphone-level\)/,
    );
    expect(css).toMatch(/forced-colors:\s*active/);
    expect(css).toMatch(/prefers-contrast:\s*more/);
    expect(css).toMatch(/max-width:\s*520px/);
  });

  it("keeps one instrument signal and derives causal motion in both views", async () => {
    const [reactScene, svelte, contractSource] = await Promise.all([
      readFile(new URL("app/mandelhowl-scene.tsx", root), "utf8"),
      readFile(
        new URL("apps/svelte-ui/src/MandelHowlApp.svelte", root),
        "utf8",
      ),
      readFile(
        new URL("specs/runtime/ui-nversion.v1.json", root),
        "utf8",
      ),
    ]);
    const contract = JSON.parse(contractSource) as {
      requiredSceneRegions: string[];
      sharedAlgorithms: Record<string, string>;
    };
    expect(contract.requiredSceneRegions).toContain(
      "oscilloscope-phase-emphasis",
    );
    expect(contract.requiredSceneRegions).not.toContain("phase-meter");
    expect(contract.sharedAlgorithms).toMatchObject({
      causalMotionPresentation:
        "packages/presentation-model/src/causal-motion-presenter.ts",
      instrumentOutputPresentation:
        "packages/presentation-model/src/instrument-output-presenter.ts",
      visualSpecProjection:
        "packages/contracts/src/generated/runtime-specs.generated.ts",
    });
    for (const implementation of [reactScene, svelte]) {
      expect(implementation).toMatch(/presentCausalMotion/);
      expect(implementation).toMatch(/formatVirtualVolume/);
      expect(implementation).toMatch(/measurementStatusLabel/);
      expect(implementation).toMatch(/--microphone-level/);
      expect(implementation).toMatch(/--feedback-level/);
      expect(implementation).toMatch(/mh-scope-phase-emphasis/);
      expect(implementation).not.toMatch(/mh-phase-meter/);
      expect(implementation).not.toMatch(/mh-phase-face/);
    }
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
