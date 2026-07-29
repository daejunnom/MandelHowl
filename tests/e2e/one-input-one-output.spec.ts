import { expect, test } from "@playwright/test";

test("exposes one conceptual dial input and one integer result", async ({
  page,
}) => {
  await page.goto("/");

  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await expect(dial).toHaveCount(1);
  await expect(dial).toHaveAttribute("aria-valuemin", "45");
  await expect(dial).toHaveAttribute("aria-valuemax", "6000");

  await expect(page.locator("button, input, select, textarea")).toHaveCount(0);
  await expect(page.locator(".mh-volume-readout")).toContainText("VOLUME");
  await expect(page.locator(".mh-volume-readout > strong")).toHaveText(
    /^\d{3}$/,
  );
  await expect(page.getByText("ONE CONTROL / ONE RESULT / NO RANDOMNESS")).toBeVisible();
});

test("keeps a challenge target read-only", async ({ page }) => {
  await page.goto("/?target=50");
  await expect(page.getByText("READ-ONLY TARGET 050")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Drive frequency" })).toHaveCount(
    1,
  );
  await expect(page.locator("button, input, select, textarea")).toHaveCount(0);
});
