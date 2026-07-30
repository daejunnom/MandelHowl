import { expect, test } from "@playwright/test";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_DIAL_SPEC,
} from "../../packages/contracts/src";
import { waitForRuntimeReady } from "./runtime-ready";

const DIAL_MAXIMUM = String(
  GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz,
);

test("promotes the independent Svelte 5 scene as the primary UI", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-active-ui",
    "svelte5",
  );
  await expect(
    page.locator('.mh-shell[data-ui-implementation="svelte5"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Drive frequency" }),
  ).toHaveCount(1);
});

for (const fault of ["load", "mount"] as const) {
  test(`keeps React operational when Svelte ${fault} fails`, async ({
    page,
  }) => {
    await page.goto(`/?mh-ui-fault=${fault}`);
    await waitForRuntimeReady(page);
    await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
      "data-active-ui",
      "react",
    );
    await expect(
      page.locator('.mh-shell[data-ui-implementation="react19"]'),
    ).toBeVisible();
    await expect(
      page.locator(".mh-ui-nversion-host"),
    ).toHaveAttribute(
      "data-ui-diagnostic-code",
      "MH-UI-FAILOVER-ACTIVATED",
    );
  });
}

test("preserves canonical session state across an active-view failover", async ({
  page,
}) => {
  await page.goto("/?mh-ui-fault=runtime");
  await waitForRuntimeReady(page);
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-active-ui",
    "svelte5",
  );

  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await dial.press("End");
  await expect(dial).toHaveAttribute("aria-valuenow", DIAL_MAXIMUM);
  const graphNodeCountBefore = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.graphNodeCount ?? 0,
  );

  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-active-ui",
    "react",
  );
  await expect(
    page.getByRole("slider", { name: "Drive frequency" }),
  ).toHaveAttribute("aria-valuenow", DIAL_MAXIMUM);
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-ui-diagnostic-code",
    "MH-UI-FAILOVER-ACTIVATED",
  );
  const graphNodeCountAfter = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.graphNodeCount ?? 0,
  );
  expect(graphNodeCountAfter).toBe(graphNodeCountBefore);
});

test("degrades a lost Svelte WebGL context to Canvas without replacing the UI session", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-active-ui",
    "svelte5",
  );
  const frequencyBefore = await page
    .getByRole("slider", { name: "Drive frequency" })
    .getAttribute("aria-valuenow");
  const graphNodeCountBefore = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.graphNodeCount ?? 0,
  );

  await page
    .locator('.mh-shell[data-ui-implementation="svelte5"] canvas.mh-plate-canvas')
    .dispatchEvent("webglcontextlost");

  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-active-ui",
    "svelte5",
  );
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-ui-failover-count",
    "0",
  );
  await expect(
    page.locator(
      '.mh-shell[data-ui-implementation="svelte5"] canvas.mh-plate-canvas[data-render-fallback-reason="webgl-context-lost"]',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Drive frequency" }),
  ).toHaveAttribute("aria-valuenow", frequencyBefore ?? "");
  const graphNodeCountAfter = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.graphNodeCount ?? 0,
  );
  expect(graphNodeCountAfter).toBe(graphNodeCountBefore);
});

test("suspends audio when both presentation versions become unavailable", async ({
  page,
}) => {
  await page.goto(
    "/?mh-ui-fault=runtime&mh-ui-standby-fault=runtime",
  );
  await waitForRuntimeReady(page);

  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await dial.press("End");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.lifecycle,
      ),
    )
    .toBe("running");

  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-ui-phase",
    "unavailable",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.lifecycle,
      ),
    )
    .toBe("suspended");
  await expect(page.getByRole("alert")).toContainText(
    "audio was safely suspended",
  );
});

test("React and Svelte gestures enter the same canonical dial engine", async ({
  browser,
}) => {
  const reactContext = await browser.newContext();
  const svelteContext = await browser.newContext();
  const reactPage = await reactContext.newPage();
  const sveltePage = await svelteContext.newPage();
  await Promise.all([
    reactPage.goto("/?mh-ui=react"),
    sveltePage.goto("/"),
  ]);
  await Promise.all([
    waitForRuntimeReady(reactPage),
    waitForRuntimeReady(sveltePage),
  ]);

  for (const page of [reactPage, sveltePage]) {
    const dial = page.getByRole("slider", { name: "Drive frequency" });
    await dial.focus();
    await dial.press("Home");
    await dial.press("PageUp");
    await dial.press("ArrowRight");
    await dial.press("End");
    await expect(dial).toHaveAttribute("aria-valuenow", DIAL_MAXIMUM);
  }

  const frequencies = await Promise.all(
    [reactPage, sveltePage].map((page) =>
      page.evaluate(
        () =>
          window.__MANDELHOWL_HEALTH__?.getSnapshot().runtime
            .driveFrequencyHz,
      ),
    ),
  );
  expect(frequencies[0]).toBe(frequencies[1]);
  await reactContext.close();
  await svelteContext.close();
});

test("React standby preserves the full Svelte causal and accessibility scene", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  const [sveltePage, reactPage] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  await Promise.all([
    sveltePage.goto("/"),
    reactPage.goto("/?mh-ui=react"),
  ]);
  await Promise.all([
    waitForRuntimeReady(sveltePage),
    waitForRuntimeReady(reactPage),
  ]);
  await Promise.all(
    [sveltePage, reactPage].map((page) =>
      expect
        .poll(() =>
          page.evaluate(() => {
            const renderer =
              window.__MANDELHOWL_HEALTH__?.getSnapshot().renderer;
            return [
              renderer?.textureReady,
              renderer?.datasetId,
            ];
          }),
        )
        .toEqual([
          true,
          GENERATED_DATASET_RELEASE_SPEC.datasetId,
        ]),
    ),
  );

  const inventory = (page: typeof sveltePage) =>
    page.evaluate(() => {
      const dial = document.querySelector('[role="slider"]');
      const apparatus = document.querySelector(".mh-apparatus");
      return {
        regions: [
          ".mh-drive-panel",
          ".mh-apparatus-panel",
          ".mh-output-panel",
          ".mh-speaker",
          ".mh-plate-assembly",
          ".mh-microphone",
          ".mh-feedback-cable",
          ".mh-oscilloscope",
          ".mh-volume-readout",
        ].map((selector) => document.querySelectorAll(selector).length),
        sliderCount: document.querySelectorAll('[role="slider"]').length,
        sliderLabel: dial?.getAttribute("aria-label"),
        sliderMinimum: dial?.getAttribute("aria-valuemin"),
        sliderMaximum: dial?.getAttribute("aria-valuemax"),
        instrumentImages: document.querySelectorAll(
          '.mh-instrumentation [role="img"]',
        ).length,
        phaseMeters: document.querySelectorAll(".mh-phase-meter").length,
        sceneReadOrder: document
          .querySelector(".mh-shell")
          ?.getAttribute("data-scene-read-order"),
        conceptualInputs: document
          .querySelector(".mh-shell")
          ?.getAttribute("data-conceptual-input-count"),
        conceptualOutputs: document
          .querySelector(".mh-shell")
          ?.getAttribute("data-conceptual-output-count"),
        camera: [
          "data-camera-projection",
          "data-camera-fov",
          "data-camera-clip",
        ].map((attribute) =>
          document
            .querySelector(".mh-shell")
            ?.getAttribute(attribute),
        ),
        apparatusPositions: [
          ".mh-speaker",
          ".mh-plate-assembly",
          ".mh-microphone",
        ].map((selector) =>
          document
            .querySelector(selector)
            ?.getAttribute("data-apparatus-position"),
        ),
        signalDirection: document
          .querySelector(".mh-feedback-cable")
          ?.getAttribute("data-signal-direction"),
        outputText:
          document.querySelector(".mh-output-label")?.textContent,
        causalLabel: apparatus?.getAttribute("aria-label")
          ?.replace(/\b(?:DECAYING|CRITICAL|GROWING|LIMITING)\b/g, "REGIME")
          .replace(
            /Loop below threshold|Burst boundary|Feedback capture|Virtual ceiling/g,
            "STATE",
          ),
        footer:
          document.querySelector(".mh-footer p:first-child")?.textContent
            ?.replace(/\s+/g, "")
            .trim(),
      };
    });

  expect(await inventory(reactPage)).toEqual(await inventory(sveltePage));
  await Promise.all(contexts.map((context) => context.close()));
});
