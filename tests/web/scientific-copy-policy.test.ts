import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

const AUDIENCE_COPY_FILES = Object.freeze([
  "README.md",
  "app/mandelhowl-scene.tsx",
  "apps/react-ui/src/MandelHowlReactApp.tsx",
  "apps/svelte-ui/src/MandelHowlApp.svelte",
  "docs/audio-safety.md",
  "docs/feedback-model.md",
  "docs/interaction-contract.md",
  "docs/plate-model.md",
  "docs/scientific-basis.md",
]);

const FORBIDDEN_SCIENTIFIC_ASSERTIONS = Object.freeze([
  /만델브로\s*반복식이\s*소리를\s*직접\s*생성한다/iu,
  /모래가\s*반드시\s*만델브로\s*모양으로\s*배열된다/iu,
  /무한\s*정밀도의\s*만델브로\s*구조를\s*실제로\s*제작했다/iu,
  /프랙탈만으로\s*출력이\s*자동으로\s*0과\s*100으로\s*양극화된다/iu,
  /\bMandelbrot\s+(?:iteration|recurrence|formula)\b[^.!?\n]{0,80}\b(?:directly\s+)?(?:generates?|creates?|produces?)\s+(?:the\s+)?sound\b/iu,
  /\bsand\b[^.!?\n]{0,80}\b(?:always|necessarily|must)\b[^.!?\n]{0,80}\bMandelbrot\b[^.!?\n]{0,40}\b(?:shape|silhouette|pattern)\b/iu,
  /\b(?:built|fabricated|manufactured|made)\b[^.!?\n]{0,80}\binfinite[- ]precision\b[^.!?\n]{0,80}\bMandelbrot\b/iu,
  /\bfractal\b[^.!?\n]{0,80}\balone\b[^.!?\n]{0,80}\bautomatically\b[^.!?\n]{0,80}\b(?:0|zero)\b[^.!?\n]{0,40}\b(?:100|one hundred)\b/iu,
]);

async function audienceCopy(): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      AUDIENCE_COPY_FILES.map(async (path) => [
        path,
        await readFile(new URL(path, root), "utf8"),
      ] as const),
    ),
  );
}

describe("scientific and interaction copy policy", () => {
  it("rejects all four forbidden scientific claims from production UI and audience documentation", async () => {
    for (const [path, source] of await audienceCopy()) {
      for (const assertion of FORBIDDEN_SCIENTIFIC_ASSERTIONS) {
        expect(source, `${path}: ${assertion.source}`).not.toMatch(
          assertion,
        );
      }
    }
  });

  it("states the causal chain from encoded material through the solved plate and feedback loop", async () => {
    const [basis, reactScene, reactVersion, svelteVersion] =
      await Promise.all([
        readFile(new URL("docs/scientific-basis.md", root), "utf8"),
        readFile(new URL("app/mandelhowl-scene.tsx", root), "utf8"),
        readFile(
          new URL(
            "apps/react-ui/src/MandelHowlReactApp.tsx",
            root,
          ),
          "utf8",
        ),
        readFile(
          new URL("apps/svelte-ui/src/MandelHowlApp.svelte", root),
          "utf8",
        ),
      ]);

    expect(basis).toMatch(
      /encodes a Mandelbrot escape-time field into a bounded,\s+manufacturable thickness field/iu,
    );
    expect(basis).toMatch(
      /solves the resulting variable-property\s+plate/iu,
    );
    expect(basis).toMatch(
      /changes the physical model rather\s+than acting as a decorative overlay/iu,
    );
    expect(reactVersion).toMatch(/MandelHowlScene/);

    for (const implementation of [reactScene, svelteVersion]) {
      expect(implementation).toMatch(/speaker drives the/iu);
      expect(implementation).toMatch(/microphone returns the response/iu);
      expect(implementation).toMatch(/through the feedback loop/iu);
      expect(implementation).toContain("DRIVE FREQUENCY");
      expect(implementation).toContain("METAL PLATE + SAND");
      expect(implementation).toContain("VOLUME");
    }
  });

  it("keeps fractal exploration and gambling-style rewards out of the shipped experience", async () => {
    const forbiddenExperienceCopy = [
      /\b(?:fractal|Mandelbrot)\s+(?:background|explorer)\b/iu,
      /\b(?:score|scores|coin|coins|badge|badges|jackpot|streak|reward|rewards|gambling|near[- ]miss)\b/iu,
      /(?:점수|코인|배지|도박|가상\s*화폐|확률형\s*보상)/iu,
    ] as const;

    for (const [path, source] of await audienceCopy()) {
      for (const phrase of forbiddenExperienceCopy) {
        expect(source, `${path}: ${phrase.source}`).not.toMatch(phrase);
      }
    }
  });
});
