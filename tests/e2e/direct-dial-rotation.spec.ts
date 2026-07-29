import { expect, test } from "@playwright/test";
import { waitForRuntimeReady } from "./runtime-ready";

test("direct arc dragging changes the same dial value", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  const before = Number(await dial.getAttribute("aria-valuenow"));
  await dial.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const centreX = bounds.left + bounds.width / 2;
    const centreY = bounds.top + bounds.height / 2;
    const radius = Math.min(bounds.width, bounds.height) * 0.4;
    const pointerId = 17;
    const dispatch = (
      type: "pointerdown" | "pointermove" | "pointerup",
      angle: number,
      buttons: number,
    ) => {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "mouse",
          button: 0,
          buttons,
          clientX: centreX + Math.cos(angle) * radius,
          clientY: centreY + Math.sin(angle) * radius,
        }),
      );
    };

    dispatch("pointerdown", 0, 1);
    for (let step = 1; step <= 8; step += 1) {
      dispatch("pointermove", (Math.PI / 2) * (step / 8), 1);
    }
    dispatch("pointerup", Math.PI / 2, 0);
  });

  await expect
    .poll(async () => Number(await dial.getAttribute("aria-valuenow")))
    .not.toBe(before);
});
