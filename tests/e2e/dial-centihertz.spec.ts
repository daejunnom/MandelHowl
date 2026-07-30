import { expect, test } from "@playwright/test";
import { waitForRuntimeReady } from "./runtime-ready";

test("keeps Shift+Arrow inert while displaying exact centihertz", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [url, implementation] of [
    ["/", "svelte5"],
    ["/?mh-ui=react", "react"],
  ] as const) {
    await page.goto(url);
    await waitForRuntimeReady(page);
    await expect(page.locator(".mh-ui-nversion-host")).toHaveAttribute(
      "data-active-ui",
      implementation,
    );

    const dial = page.getByRole("slider", {
      name: "Drive frequency",
    });
    await dial.focus();
    const initialState = await page.evaluate(() => {
      const snapshot = window.__MANDELHOWL_HEALTH__?.getSnapshot();
      return snapshot
        ? {
            frequencyCentiHz:
              snapshot.runtime.driveFrequencyCentiHz,
            audioLifecycle: snapshot.audio.lifecycle,
            audioContextState: snapshot.audio.contextState,
            graphNodeCount: snapshot.audio.graphNodeCount,
          }
        : null;
    });
    expect(initialState).not.toBeNull();
    expect(initialState?.audioLifecycle).toBe("idle");
    expect(initialState?.audioContextState).toBe("none");
    expect(initialState?.graphNodeCount).toBe(0);
    await expect(
      page.getByText("MONITOR MUTED", { exact: true }),
    ).toBeVisible();

    for (const key of [
      "Shift+ArrowLeft",
      "Shift+ArrowRight",
      "Shift+ArrowUp",
      "Shift+ArrowDown",
    ]) {
      await dial.press(key);
    }
    await page.waitForTimeout(250);
    const afterShiftState = await page.evaluate(() => {
      const snapshot = window.__MANDELHOWL_HEALTH__?.getSnapshot();
      return snapshot
        ? {
            frequencyCentiHz:
              snapshot.runtime.driveFrequencyCentiHz,
            audioLifecycle: snapshot.audio.lifecycle,
            audioContextState: snapshot.audio.contextState,
            graphNodeCount: snapshot.audio.graphNodeCount,
          }
        : null;
    });
    expect(afterShiftState?.frequencyCentiHz).toBe(
      initialState?.frequencyCentiHz,
    );
    expect(afterShiftState?.audioLifecycle).not.toBe("running");
    expect(afterShiftState?.audioContextState).toBe("none");
    expect(afterShiftState?.graphNodeCount).toBe(0);
    await expect(
      page.getByText("MONITOR MUTED", { exact: true }),
    ).toBeVisible();

    await dial.press("Home");
    await page.waitForTimeout(1_000);
    await expect(dial).toHaveAttribute("aria-valuenow", "45");
    await expect(dial).toHaveAttribute(
      "aria-valuetext",
      /^45\.00 Hz,/,
    );
    await expect(page.locator(".mh-dial-face > strong")).toHaveText(
      "45.00 Hz",
    );

    await dial.press("ArrowRight");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__MANDELHOWL_HEALTH__?.getSnapshot().runtime
              .driveFrequencyCentiHz,
        ),
      )
      .toBeGreaterThan(4_500);
    await expect(page.locator(".mh-dial-face > strong")).toHaveText(
      /^\d+\.\d{2} Hz$/,
    );

    await dial.press("End");
    await expect(dial).toHaveAttribute("aria-valuenow", "6000");
    await expect(dial).toHaveAttribute(
      "aria-valuetext",
      /^6000\.00 Hz,/,
    );
    await expect(page.locator(".mh-dial-face > strong")).toHaveText(
      "6000.00 Hz",
    );
    const readoutFitsFace = await page.locator(".mh-dial-face").evaluate(
      (face) => {
        const readout = face.querySelector("strong");
        if (!(readout instanceof HTMLElement)) return false;
        const faceBounds = face.getBoundingClientRect();
        const readoutBounds = readout.getBoundingClientRect();
        return (
          readoutBounds.left >= faceBounds.left &&
          readoutBounds.right <= faceBounds.right
        );
      },
    );
    expect(readoutFitsFace).toBe(true);
  }
});
