import { expect, test } from "@playwright/test";
import { waitForRuntimeReady } from "./runtime-ready";

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
  await expect(dial).toHaveAttribute("aria-valuenow", "6000");
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
  ).toHaveAttribute("aria-valuenow", "6000");
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

test("fails over when the active Svelte plate renderer loses its context", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-active-ui",
    "svelte5",
  );

  await page
    .locator('.mh-shell[data-ui-implementation="svelte5"] canvas.mh-plate-canvas')
    .dispatchEvent("webglcontextlost");

  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-active-ui",
    "react",
  );
  await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
    "data-ui-failover-count",
    "1",
  );
  await expect(
    page.locator('.mh-shell[data-ui-implementation="react19"]'),
  ).toBeVisible();
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
    await expect(dial).toHaveAttribute("aria-valuenow", "6000");
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
