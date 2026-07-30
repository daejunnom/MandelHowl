import { expect, test } from "@playwright/test";
import { waitForRuntimeReady } from "./runtime-ready";

test("simulates before activation without constructing an audio graph", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  const before = await page.evaluate(
    () => window.__MANDELHOWL_HEALTH__?.getSnapshot(),
  );
  expect(before?.audio.lifecycle).toBe("idle");
  expect(before?.audio.contextState).toBe("none");
  expect(before?.audio.graphNodeCount).toBe(0);

  await page.waitForTimeout(250);
  const afterSimulation = await page.evaluate(
    () => window.__MANDELHOWL_HEALTH__?.getSnapshot(),
  );
  expect(afterSimulation?.animationFrames).toBeGreaterThan(
    before?.animationFrames ?? 0,
  );
  expect(afterSimulation?.audio.lifecycle).toBe("idle");
  expect(afterSimulation?.audio.contextState).toBe("none");
  expect(afterSimulation?.audio.graphNodeCount).toBe(0);

  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await dial.press("ArrowRight");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.lifecycle,
        ),
    )
    .toMatch(/^(running|unavailable)$/);
});

test("never requests a real microphone while activating safe monitor audio", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__microphoneRequested", {
      configurable: true,
      value: false,
      writable: true,
    });
    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => {
        (window as unknown as Window & { __microphoneRequested: boolean })
          .__microphoneRequested = true;
        return Promise.reject(new Error("Microphone access is forbidden."));
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
  });

  await page.goto("/");
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await dial.press("ArrowRight");

  const requested = await page.evaluate(
    () =>
      (window as Window & { __microphoneRequested?: boolean })
        .__microphoneRequested,
  );
  expect(requested).toBe(false);
});
