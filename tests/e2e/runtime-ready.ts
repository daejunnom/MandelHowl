import type { Page } from "@playwright/test";

export async function waitForRuntimeReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().fanout.consumerCount === 5,
  );
}
