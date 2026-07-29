import type { Page } from "@playwright/test";

export async function waitForRuntimeReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const health = window.__MANDELHOWL_HEALTH__?.getSnapshot();
      const ui = window.__MANDELHOWL_UI_HEALTH__?.getSnapshot();
      return (
        health !== undefined &&
        health.runtime.sequence >= 0 &&
        ui?.phase === "active" &&
        ui.activeImplementationId !== null
      );
    },
  );
}
