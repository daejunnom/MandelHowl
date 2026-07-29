import { expect, test } from "@playwright/test";
import { waitForRuntimeReady } from "./runtime-ready";

test("keyboard commands use the canonical 45..6000 Hz dial", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();

  const initial = Number(await dial.getAttribute("aria-valuenow"));
  await dial.press("ArrowRight");
  await expect
    .poll(async () => Number(await dial.getAttribute("aria-valuenow")))
    .toBeGreaterThan(initial);

  await dial.press("Home");
  await expect(dial).toHaveAttribute("aria-valuenow", "45");

  await dial.press("End");
  await expect(dial).toHaveAttribute("aria-valuenow", "6000");
});
