import { expect, test } from "@playwright/test";

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
});
