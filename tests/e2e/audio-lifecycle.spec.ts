import { expect, test } from "@playwright/test";
import { GENERATED_AUDIO_SAFETY_SPEC } from "../../packages/contracts/src";
import { waitForRuntimeReady } from "./runtime-ready";

test("reuses one audio graph across hide, resume and teardown cycles", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => visibility === "hidden",
    });
    Object.defineProperty(window, "__setMandelHowlTestVisibility", {
      configurable: true,
      value: (next: DocumentVisibilityState) => {
        visibility = next;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  });
  await page.goto("/");
  await waitForRuntimeReady(page);
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
    .toBe("running");
  const initialNodeCount = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.graphNodeCount,
  );
  expect(initialNodeCount).toBe(
    10 +
      2 *
        (1 +
          GENERATED_AUDIO_SAFETY_SPEC.modalTimbre.maximumVoices),
  );
  const initialPausedGapResets = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().pausedGapResets ?? 0,
  );

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.evaluate(() => {
      (
        window as typeof window & {
          __setMandelHowlTestVisibility: (
            state: DocumentVisibilityState,
          ) => void;
        }
      ).__setMandelHowlTestVisibility("hidden");
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.lifecycle,
          ),
      )
      .toBe("suspended");

    await page.evaluate(() => {
      (
        window as typeof window & {
          __setMandelHowlTestVisibility: (
            state: DocumentVisibilityState,
          ) => void;
        }
      ).__setMandelHowlTestVisibility("visible");
    });
    await dial.press("ArrowRight");
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.lifecycle,
          ),
      )
      .toBe("running");
    expect(
      await page.evaluate(
        () =>
          window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.graphNodeCount,
      ),
    ).toBe(initialNodeCount);
  }

  expect(
    await page.evaluate(
      () =>
        window.__MANDELHOWL_HEALTH__?.getSnapshot().pausedGapResets,
    ),
  ).toBe(initialPausedGapResets + 3);

  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: false }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const audio =
          window.__MANDELHOWL_HEALTH__?.getSnapshot().audio;
        return [audio?.lifecycle, audio?.graphNodeCount];
      }),
    )
    .toEqual(["disposed", 0]);
});

test("fails closed when browser audio graph construction throws", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    const FailingAudioContext = function () {
      const context = new NativeAudioContext();
      Object.defineProperty(context, "createGain", {
        configurable: true,
        value: () => {
          throw new Error("synthetic graph allocation failure");
        },
      });
      return context;
    } as unknown as typeof AudioContext;
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FailingAudioContext,
    });
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/");
  await waitForRuntimeReady(page);
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await dial.press("ArrowRight");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const audio =
          window.__MANDELHOWL_HEALTH__?.getSnapshot().audio;
        return [audio?.lifecycle, audio?.graphNodeCount];
      }),
    )
    .toEqual(["unavailable", 0]);
  await expect(
    page.getByText("MH-AUDIO-GRAPH-FAILED", { exact: true }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
