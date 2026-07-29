import type { Page } from "@playwright/test";

export async function waitForRuntimeReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const health = window.__MANDELHOWL_HEALTH__?.getSnapshot();
      return (
        health?.presentationFanout.consumerCount === 3 &&
        health.hotPathFanout.consumerCount === 2
      );
    },
  );
}
