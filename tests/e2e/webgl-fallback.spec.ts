import { expect, test } from "@playwright/test";

test("uses the Canvas data renderer when WebGL2 is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function (
        this: HTMLCanvasElement,
        contextId: string,
        ...args: unknown[]
      ) {
        if (contextId === "webgl2") return null;
        return Reflect.apply(original, this, [contextId, ...args]);
      },
    });
  });
  await page.goto("/");

  await expect(page.locator(".mh-plate-assembly figcaption")).toContainText(
    "CANVAS2D",
  );
  await expect(page.locator(".mh-volume-readout > strong")).toHaveText(
    /^\d{3}$/,
  );
});
