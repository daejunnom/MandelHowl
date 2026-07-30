import { expect, test } from "@playwright/test";

test("reduced motion preserves the exact snapshot and output while scaling presentation", async ({
  page,
}) => {
  const collectFixture = async (
    state: "critical" | "reduced-motion",
  ) => {
    await page.goto(`/visual-fixture/${state}`);
    const status = page.getByTestId("visual-renderer-status");
    await expect(status).toHaveAttribute("data-status", "ready", {
      timeout: 20_000,
    });
    return {
      snapshot: await status.getAttribute("data-snapshot-signature"),
      pixel: await status.getAttribute("data-pixel-signature"),
      quality: await status.getAttribute("data-render-quality"),
      frequency: await page
        .getByRole("slider", { name: "Drive frequency" })
        .getAttribute("aria-valuenow"),
      volume: await page.locator(".mh-volume-readout > strong").textContent(),
      regime: await page.locator(".mh-shell").getAttribute("data-regime"),
    };
  };

  const normal = await collectFixture("critical");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await collectFixture("reduced-motion");

  expect({
    snapshot: reduced.snapshot,
    frequency: reduced.frequency,
    volume: reduced.volume,
    regime: reduced.regime,
  }).toEqual({
    snapshot: normal.snapshot,
    frequency: normal.frequency,
    volume: normal.volume,
    regime: normal.regime,
  });
  expect(normal.quality).toBe("high");
  expect(reduced.quality).toBe("reduced");
  expect(reduced.pixel).not.toBe(normal.pixel);
});

test("preserves state and result while suppressing travel motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.locator(".mh-regime-card")).toBeVisible();
  await expect(page.locator(".mh-volume-readout > strong")).toHaveText(
    /^\d{3}$/,
  );
  const cableAnimation = await page
    .locator(".mh-feedback-flow")
    .first()
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(cableAnimation).toBe("none");
  for (const selector of [
    ".mh-speaker-cone",
    ".mh-drive-waves span",
    ".mh-air-waves span",
  ]) {
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
  }
  await expect(page.locator(".mh-shell")).toHaveAttribute(
    "data-regime",
    /decaying|critical|growing|saturated/,
  );
  await expect(page.locator(".mh-measurement")).toContainText("ENVELOPE");
  await expect(
    page.getByRole("slider", { name: "Drive frequency" }),
  ).toHaveAttribute("aria-valuetext", /Hz|kHz/);
});
