import { expect, test, type Page } from "@playwright/test";
import {
  GENERATED_DIAL_SPEC,
  GENERATED_RENDER_QUALITY_TIERS_SPEC,
} from "../../packages/contracts/src";

const CANVAS_SCOPE_SAMPLE_COUNT =
  GENERATED_RENDER_QUALITY_TIERS_SPEC.tiers.find(
    (tier) => tier.id === "canvas-data",
  )?.oscilloscopeSamples;
if (CANVAS_SCOPE_SAMPLE_COUNT === undefined) {
  throw new Error("The generated Canvas quality tier is unavailable.");
}

async function readCanonicalDialFrequency(
  page: Page,
): Promise<number> {
  const value = Number(
    await page
      .getByRole("slider", { name: "Drive frequency" })
      .getAttribute("aria-valuenow"),
  );
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(
    GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
  );
  expect(value).toBeLessThanOrEqual(
    GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz,
  );
  return value;
}

test("all ordered degradation stages preserve the canonical snapshot and volume", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const observations: Array<{
    stage: number;
    renderer: string | null;
    quality: string | null;
    snapshot: string | null;
    pixel: string | null;
    scopeSamples: string | null;
    frequency: number;
    width: number;
    height: number;
  }> = [];

  for (let stage = 0; stage <= 6; stage += 1) {
    await page.goto(`/visual-fixture/runtime-pressure-${stage}`);
    const status = page.getByTestId("visual-renderer-status");
    await expect(status).toHaveAttribute("data-status", "ready", {
      timeout: 20_000,
    });
    await expect(status).toHaveAttribute(
      "data-degradation-stage",
      String(stage),
    );
    const frequency = await readCanonicalDialFrequency(page);
    await expect(page.locator(".mh-volume-readout > strong")).toHaveText(
      "050",
    );
    await expect(page.locator(".mh-shell")).toHaveAttribute(
      "data-regime",
      "critical",
    );
    observations.push({
      stage,
      renderer: await status.getAttribute("data-renderer"),
      quality: await status.getAttribute("data-render-quality"),
      snapshot: await status.getAttribute("data-snapshot-signature"),
      pixel: await status.getAttribute("data-pixel-signature"),
      scopeSamples: await page
        .locator(".mh-scope-screen")
        .getAttribute("data-sample-count"),
      frequency,
      width: Number(await status.getAttribute("data-canvas-width")),
      height: Number(await status.getAttribute("data-canvas-height")),
    });
  }

  expect(new Set(observations.map(({ snapshot }) => snapshot)).size).toBe(
    1,
  );
  expect(new Set(observations.map(({ frequency }) => frequency)).size).toBe(
    1,
  );
  expect(observations.slice(0, 6).map(({ renderer }) => renderer)).toEqual(
    Array.from({ length: 6 }, () => "webgl2"),
  );
  expect(observations[6].renderer).toBe("canvas2d");
  expect(observations.map(({ quality }) => quality)).toEqual([
    "high",
    "high",
    "balanced",
    "balanced",
    "reduced",
    "reduced",
    "canvas",
  ]);
  expect(observations[4].scopeSamples).toBe(
    String(CANVAS_SCOPE_SAMPLE_COUNT),
  );
  expect(observations[3].scopeSamples).not.toBe(
    observations[4].scopeSamples,
  );
  expect(observations[5].width).toBeLessThan(observations[4].width);
  expect(observations[5].height).toBeLessThan(
    observations[4].height,
  );
  expect(observations[2].pixel).not.toBe(observations[0].pixel);
  expect(observations[3].pixel).not.toBe(observations[2].pixel);
});

test("normal-resolution stage samples the generated mip chain", async ({
  context,
  page,
}) => {
  await page.goto("/visual-fixture/critical");
  const baselineStatus = page.getByTestId("visual-renderer-status");
  await expect(baselineStatus).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
  await expect(baselineStatus).toHaveAttribute(
    "data-degradation-stage",
    "0",
  );
  const baselineSignature = await baselineStatus.getAttribute(
    "data-pixel-signature",
  );

  const reducedPage = await context.newPage();
  try {
    await reducedPage.goto("/visual-fixture/runtime-pressure-normal");
    const reducedStatus = reducedPage.getByTestId(
      "visual-renderer-status",
    );
    await expect(reducedStatus).toHaveAttribute("data-status", "ready", {
      timeout: 20_000,
    });
    await expect(reducedStatus).toHaveAttribute(
      "data-degradation-stage",
      "2",
    );
    await expect(reducedStatus).toHaveAttribute(
      "data-pixel-signature",
      /^(?!pending|empty).+/,
    );
    expect(
      await reducedStatus.getAttribute("data-pixel-signature"),
    ).not.toBe(baselineSignature);
  } finally {
    await reducedPage.close();
  }
});

test("runtime pressure reaches Canvas2D only after presentation-only steps", async ({
  page,
}) => {
  await page.goto("/visual-fixture/runtime-pressure-canvas");
  const status = page.getByTestId("visual-renderer-status");
  await expect(status).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
  await expect(status).toHaveAttribute("data-renderer", "canvas2d");
  await expect(status).toHaveAttribute("data-degradation-stage", "6");
  await expect(status).toHaveAttribute("data-texture-ready", "true");

  await expect(page.locator(".mh-plate-canvas")).toHaveCount(1);
  await expect(page.locator(".mh-plate-canvas-suspended")).toHaveCount(1);
  await expect(page.locator(".mh-scope-screen")).toHaveAttribute(
    "data-sample-count",
    String(CANVAS_SCOPE_SAMPLE_COUNT),
  );
  await readCanonicalDialFrequency(page);
  await expect(page.locator(".mh-volume-readout > strong")).toHaveText("050");
  await expect(page.locator(".mh-shell")).toHaveAttribute(
    "data-regime",
    "critical",
  );
});
