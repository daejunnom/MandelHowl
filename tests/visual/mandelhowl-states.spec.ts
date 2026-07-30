import { expect, test } from "@playwright/test";

const states = [
  "decayed",
  "weak-nonresonant",
  "critical",
  "burst",
  "growing",
  "saturated",
  "reverse-reverb",
  "reduced-motion",
  "canvas-fallback",
] as const;

for (const state of states) {
  test(`fixed presenter state: ${state}`, async ({ page }) => {
    if (state === "reduced-motion") {
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    await page.goto(`/visual-fixture/${state}`);
    const rendererStatus = page.getByTestId("visual-renderer-status");
    await expect(rendererStatus).toHaveAttribute("data-status", "ready", {
      timeout: 20_000,
    });
    await expect(rendererStatus).toHaveAttribute(
      "data-renderer",
      state === "canvas-fallback" ? "canvas2d" : "webgl2",
    );
    await expect(rendererStatus).toHaveAttribute(
      "data-texture-ready",
      // A fully decayed, out-of-band snapshot has no modal basis to request.
      // `textureReady` reports current shard residency, not dataset validity.
      state === "decayed" ? "false" : "true",
    );
    await expect(page.getByRole("heading", { name: "MandelHowl" })).toBeVisible();
    await expect(page.locator(".mh-shell")).toHaveScreenshot(
      `${state}.png`,
      {
        animations: "disabled",
        caret: "hide",
        maxDiffPixelRatio: 0.005,
      },
    );
  });
}
