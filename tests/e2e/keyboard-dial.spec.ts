import { expect, test } from "@playwright/test";
import { GENERATED_DIAL_SPEC } from "../../packages/contracts/src";
import { waitForRuntimeReady } from "./runtime-ready";

const DIAL_MINIMUM = String(
  GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
);
const DIAL_MAXIMUM = String(
  GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz,
);

test("keyboard commands use the canonical generated frequency range", async ({
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

  const afterArrow = Number(await dial.getAttribute("aria-valuenow"));
  await dial.press("PageUp");
  await expect
    .poll(async () => Number(await dial.getAttribute("aria-valuenow")))
    .toBeGreaterThan(afterArrow);

  const afterPageUp = Number(await dial.getAttribute("aria-valuenow"));
  await dial.press("PageDown");
  await expect
    .poll(async () => Number(await dial.getAttribute("aria-valuenow")))
    .toBeLessThan(afterPageUp);

  const beforeReverse = Number(await dial.getAttribute("aria-valuenow"));
  await dial.press("ArrowLeft");
  await expect
    .poll(async () => Number(await dial.getAttribute("aria-valuenow")))
    .toBeLessThan(beforeReverse);

  await dial.press("Home");
  await expect(dial).toHaveAttribute("aria-valuenow", DIAL_MINIMUM);

  await dial.press("End");
  await expect(dial).toHaveAttribute("aria-valuenow", DIAL_MAXIMUM);
});
