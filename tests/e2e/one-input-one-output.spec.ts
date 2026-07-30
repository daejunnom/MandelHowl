import { expect, test } from "@playwright/test";
import { GENERATED_DIAL_SPEC } from "../../packages/contracts/src";

const DIAL_MINIMUM = String(
  GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
);
const DIAL_MAXIMUM = String(
  GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz,
);

test("exposes one conceptual dial input and one integer result", async ({
  page,
}) => {
  await page.goto("/");

  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await expect(dial).toHaveCount(1);
  await expect(dial).toHaveAttribute("aria-valuemin", DIAL_MINIMUM);
  await expect(dial).toHaveAttribute("aria-valuemax", DIAL_MAXIMUM);

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
