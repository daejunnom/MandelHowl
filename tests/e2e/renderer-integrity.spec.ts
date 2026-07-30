import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_DIAL_SPEC,
} from "../../packages/contracts/src";
import { waitForRuntimeReady } from "./runtime-ready";

const DATASET_ID = GENERATED_DATASET_RELEASE_SPEC.datasetId;
const DIAL_MINIMUM = String(
  GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
);

interface CoreResult {
  readonly datasetId: string | null | undefined;
  readonly frequency: string | null;
  readonly volume: string | null;
  readonly measurement: string | null;
  readonly regime: string | null;
}

async function forceCanvasFallback(page: Page): Promise<void> {
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
}

async function collectCoreResult(
  browser: Browser,
  renderer: "webgl2" | "canvas2d",
): Promise<CoreResult> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
  });
  const page = await context.newPage();
  if (renderer === "canvas2d") await forceCanvasFallback(page);

  try {
    await page.goto("/");
    await waitForRuntimeReady(page);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const status = window.__MANDELHOWL_HEALTH__?.getSnapshot().renderer;
          return [status?.kind, status?.textureReady, status?.datasetId];
        }),
      )
      .toEqual([renderer, true, DATASET_ID]);
    await expect(page.locator(".mh-prototype-status")).toHaveText(
      "CONTENT-ADDRESSED / VERIFIED THIN-PLATE BAKE",
    );
    const plateCanvas = page.locator(".mh-plate-canvas");
    await expect(plateCanvas).toHaveAttribute(
      "data-material-section",
      "verified",
    );
    await expect(plateCanvas).toHaveAttribute(
      "aria-label",
      /precomputed Mandelbrot material thickness cutaway visible at the lower plate edge/u,
    );

    const dial = page.getByRole("slider", {
      name: "Drive frequency",
    });
    await dial.focus();
    await dial.press("Home");
    await expect(dial).toHaveAttribute("aria-valuenow", DIAL_MINIMUM);
    await expect(page.locator(".mh-output-state")).toHaveText("SETTLED", {
      timeout: 15_000,
    });
    await expect(page.locator(".mh-volume-readout > strong")).toHaveText("000");

    return await page.evaluate(() => ({
      datasetId:
        window.__MANDELHOWL_HEALTH__?.getSnapshot().renderer?.datasetId,
      frequency:
        document
          .querySelector('[role="slider"][aria-label="Drive frequency"]')
          ?.getAttribute("aria-valuenow") ?? null,
      volume:
        document.querySelector(".mh-volume-readout > strong")?.textContent ??
        null,
      measurement:
        document.querySelector(".mh-output-state")?.textContent ?? null,
      regime:
        document.querySelector(".mh-shell")?.getAttribute("data-regime") ??
        null,
    }));
  } finally {
    await context.close();
  }
}

test("WebGL2 and Canvas consume the same canonical core result", async ({
  browser,
}) => {
  const webgl = await collectCoreResult(browser, "webgl2");
  const canvas = await collectCoreResult(browser, "canvas2d");

  expect(webgl).toEqual({
    datasetId: DATASET_ID,
    frequency: DIAL_MINIMUM,
    volume: "000",
    measurement: "SETTLED",
    regime: "decaying",
  });
  expect(canvas).toEqual(webgl);
});

test("texture upload throw degrades to Canvas before making any verified claim", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    Object.defineProperty(prototype, "texImage3D", {
      configurable: true,
      value: () => {
        throw new Error("synthetic texture upload failure");
      },
    });
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto("/");
  await waitForRuntimeReady(page);

  await expect(
    page.getByText("MH-DATASET-INTEGRITY", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const renderer = window.__MANDELHOWL_HEALTH__?.getSnapshot().renderer;
        return [renderer?.kind, renderer?.contextLost];
      }),
    )
    .toEqual(["canvas2d", false]);
  await expect(
    page.locator(
      '.mh-shell[data-ui-implementation="svelte5"] canvas[data-render-fallback-reason="webgl-texture-failed"]',
    ),
  ).toBeVisible();
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-ui-failover-count",
    "0",
  );
  await expect(page.locator(".mh-prototype-status")).toContainText(
    "CONTENT-ADDRESSED",
  );
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await dial.press("Home");
  await expect(page.locator(".mh-output-state")).toHaveText("SETTLED", {
    timeout: 15_000,
  });
  await expect(
    page.locator(
      '.mh-shell[data-ui-implementation="svelte5"] canvas[data-render-fallback-reason="webgl-texture-failed"]',
    ),
  ).toHaveAttribute("data-settled-snapshot-sequence", /^\d+$/);
  expect(pageErrors).toEqual([]);
});

test("reported WebGL upload errors degrade to Canvas presentation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const originalUpload = prototype.texImage3D;
    const originalGetError = prototype.getError;
    let uploadErrorPending = false;
    Object.defineProperty(prototype, "texImage3D", {
      configurable: true,
      value: function (
        this: WebGL2RenderingContext,
        ...args: Parameters<WebGL2RenderingContext["texImage3D"]>
      ) {
        Reflect.apply(originalUpload, this, args);
        uploadErrorPending = true;
      },
    });
    Object.defineProperty(prototype, "getError", {
      configurable: true,
      value: function (this: WebGL2RenderingContext) {
        if (uploadErrorPending) {
          uploadErrorPending = false;
          return this.OUT_OF_MEMORY;
        }
        return Reflect.apply(originalGetError, this, []);
      },
    });
  });

  await page.goto("/");
  await waitForRuntimeReady(page);
  await expect(
    page.getByText("MH-DATASET-INTEGRITY", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const renderer = window.__MANDELHOWL_HEALTH__?.getSnapshot().renderer;
        return [renderer?.kind, renderer?.contextLost];
      }),
    )
    .toEqual(["canvas2d", false]);
  await expect(
    page.locator(
      'canvas[data-render-fallback-reason="webgl-texture-failed"]',
    ).last(),
  ).toBeVisible();
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-ui-failover-count",
    "0",
  );
});

test("context loss during active texture installation quarantines WebGL before Canvas promotion", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const originalUpload = prototype.texImage3D;
    let dispatched = false;
    Object.defineProperty(prototype, "texImage3D", {
      configurable: true,
      value: function (
        this: WebGL2RenderingContext,
        ...args: Parameters<WebGL2RenderingContext["texImage3D"]>
      ) {
        Reflect.apply(originalUpload, this, args);
        if (dispatched) return;
        const canvas = this.canvas as HTMLCanvasElement;
        if (
          !canvas.closest(
            '.mh-shell[data-ui-implementation="svelte5"]',
          )
        ) {
          return;
        }
        dispatched = true;
        queueMicrotask(() => {
          canvas.dispatchEvent(
            new Event("webglcontextlost", {
              bubbles: false,
              cancelable: true,
            }),
          );
        });
      },
    });
  });

  await page.goto("/");
  await waitForRuntimeReady(page);
  await expect(
    page.getByText("MH-RENDER-CONTEXT-LOST", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const renderer = window.__MANDELHOWL_HEALTH__?.getSnapshot().renderer;
        return [
          renderer?.kind,
          renderer?.contextLost,
          renderer?.textureReady,
          renderer?.datasetId,
        ];
      }),
    )
    .toEqual(["canvas2d", false, true, DATASET_ID]);
  await expect(
    page.locator(
      '.mh-shell[data-ui-implementation="svelte5"] canvas[data-render-fallback-reason="webgl-context-lost"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '.mh-shell[data-ui-implementation="svelte5"] canvas.mh-plate-canvas-suspended',
    ),
  ).toHaveAttribute("data-material-section", "unavailable");
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-ui-failover-count",
    "0",
  );
  await expect(page.locator(".mh-prototype-status")).toHaveText(
    "CONTENT-ADDRESSED / VERIFIED THIN-PLATE BAKE",
  );
});
