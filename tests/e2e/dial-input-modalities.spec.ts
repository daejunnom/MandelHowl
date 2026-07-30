import { expect, test } from "@playwright/test";
import { waitForRuntimeReady } from "./runtime-ready";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
});

test("touch pointer rotation uses the canonical dial path", async ({
  page,
}) => {
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  const before = Number(await dial.getAttribute("aria-valuenow"));

  await dial.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const centreX = bounds.left + bounds.width / 2;
    const centreY = bounds.top + bounds.height / 2;
    const radius = Math.min(bounds.width, bounds.height) * 0.4;
    const pointerId = 41;
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
          pointerType: "touch",
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

test("wheel input changes the same accessible dial value", async ({
  page,
}) => {
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  const bounds = await dial.boundingBox();
  expect(bounds).not.toBeNull();
  const before = Number(await dial.getAttribute("aria-valuenow"));

  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.wheel(0, -240);

  await expect
    .poll(async () => Number(await dial.getAttribute("aria-valuenow")))
    .not.toBe(before);
});

test("lost pointer capture closes the active gesture", async ({ page }) => {
  const dial = page.getByRole("slider", { name: "Drive frequency" });

  await dial.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const pointerId = 57;
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: "touch",
        button: 0,
        buttons: 1,
        clientX: bounds.right - bounds.width * 0.1,
        clientY: bounds.top + bounds.height / 2,
      }),
    );
  });
  await expect(page.locator(".mh-shell")).toHaveClass(
    /mh-is-dragging/,
  );

  await dial.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent("lostpointercapture", {
        bubbles: true,
        pointerId: 57,
        pointerType: "touch",
      }),
    );
  });

  await expect(page.locator(".mh-shell")).not.toHaveClass(
    /mh-is-dragging/,
  );
  await expect(dial).toContainText("DRAG · KEYS · WHEEL");
});

test("a secondary touch cannot steal the active dial gesture", async ({
  page,
}) => {
  const dial = page.getByRole("slider", { name: "Drive frequency" });

  await dial.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const dispatch = (
      type: "pointerdown" | "pointerup" | "lostpointercapture",
      pointerId: number,
      clientX: number,
    ) => {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "touch",
          button: 0,
          buttons: type === "pointerdown" ? 1 : 0,
          clientX,
          clientY: bounds.top + bounds.height / 2,
        }),
      );
    };
    dispatch("pointerdown", 71, bounds.right - bounds.width * 0.1);
    dispatch("pointerdown", 72, bounds.left + bounds.width * 0.1);
    dispatch("pointerup", 72, bounds.left + bounds.width * 0.1);
  });

  await expect(page.locator(".mh-shell")).toHaveClass(/mh-is-dragging/);

  await dial.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent("lostpointercapture", {
        bubbles: true,
        pointerId: 71,
        pointerType: "touch",
      }),
    );
  });
  await expect(page.locator(".mh-shell")).not.toHaveClass(
    /mh-is-dragging/,
  );
});
