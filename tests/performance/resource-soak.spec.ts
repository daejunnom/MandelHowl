import { expect, test, type Page } from "@playwright/test";
import { GENERATED_AUDIO_SAFETY_SPEC } from "../../packages/contracts/src";
import { waitForRuntimeReady } from "../e2e/runtime-ready";

interface BrowserMemory {
  readonly usedJSHeapSize: number;
}

async function usedHeapBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (
      performance as Performance & {
        readonly memory?: BrowserMemory;
      }
    ).memory;
    return memory?.usedJSHeapSize ?? null;
  });
}

async function exerciseDial(page: Page, count: number): Promise<void> {
  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await page.evaluate(async (eventCount) => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement)) {
      throw new Error("The frequency dial is not focused.");
    }
    for (let index = 0; index < eventCount; index += 1) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: index % 2 === 0 ? "ArrowRight" : "ArrowLeft",
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 4));
    }
  }, count);
}

test.setTimeout(60_000);

test("keeps runtime consumers, audio nodes and buffers bounded during a soak", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  await exerciseDial(page, 4);

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__MANDELHOWL_HEALTH__?.getSnapshot().audio.lifecycle,
        ),
      { timeout: 10_000 },
    )
    .toMatch(/^(running|unavailable)$/);

  const baseline = await page.evaluate(() =>
    window.__MANDELHOWL_HEALTH__?.getSnapshot(),
  );
  expect(baseline).toBeDefined();
  if (!baseline) return;
  const baselineHeap = await usedHeapBytes(page);

  await exerciseDial(page, 160);
  await page.waitForTimeout(2_500);
  const middle = await page.evaluate(() =>
    window.__MANDELHOWL_HEALTH__?.getSnapshot(),
  );
  expect(middle).toBeDefined();
  if (!middle) return;

  await exerciseDial(page, 160);
  await page.waitForTimeout(2_500);
  const final = await page.evaluate(() =>
    window.__MANDELHOWL_HEALTH__?.getSnapshot(),
  );
  expect(final).toBeDefined();
  if (!final) return;
  const finalHeap = await usedHeapBytes(page);

  expect(middle.presentationFanout.consumerCount).toBe(
    baseline.presentationFanout.consumerCount,
  );
  expect(final.presentationFanout.consumerCount).toBe(
    baseline.presentationFanout.consumerCount,
  );
  expect(final.presentationFanout.consumerCount).toBe(3);
  expect(final.presentationFanout.rejectedFrames).toBe(0);
  expect(final.presentationFanout.publishedFrames).toBeGreaterThan(
    middle.presentationFanout.publishedFrames,
  );
  expect(middle.hotPathFanout.consumerCount).toBe(
    baseline.hotPathFanout.consumerCount,
  );
  expect(final.hotPathFanout.consumerCount).toBe(
    baseline.hotPathFanout.consumerCount,
  );
  expect(final.hotPathFanout.consumerCount).toBe(2);
  expect(final.hotPathFanout.rejectedFrames).toBe(0);
  expect(final.hotPathFanout.publishedFrames).toBeGreaterThan(
    middle.hotPathFanout.publishedFrames,
  );
  expect(final.animationFrames).toBeGreaterThan(middle.animationFrames);
  expect(final.renderer?.framesRendered ?? 0).toBeGreaterThan(
    middle.renderer?.framesRendered ?? 0,
  );
  const observedFrames =
    final.animationFrames - baseline.animationFrames;
  const observedSeconds =
    (final.capturedAtMs - baseline.capturedAtMs) / 1_000;
  const observedPresentationFrames =
    final.presentationFanout.publishedFrames -
    baseline.presentationFanout.publishedFrames;
  const observedFramesPerSecond = observedFrames / observedSeconds;
  // One exceptional dataset-transition publication may occur after the
  // baseline; normal presentation snapshots remain bounded to 24 Hz.
  expect(observedPresentationFrames).toBeLessThanOrEqual(
    Math.ceil(observedSeconds * 24) + 1,
  );
  await testInfo.attach("performance-metrics.json", {
    body: JSON.stringify(
      {
        observedFramesPerSecond,
        observedPresentationFrames,
        frameWorkP95Ms: final.frameWorkP95Ms,
        longestFrameWorkMs: final.longestFrameWorkMs,
        observedSeconds,
        observedFrames,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  // Shared/headless hosts can deschedule the browser. Product work must fit
  // the canonical tier budget when it is actually scheduled; scheduler FPS
  // remains a liveness check because host descheduling is outside page work.
  expect(observedFramesPerSecond).toBeGreaterThanOrEqual(10);
  const desktopTier =
    final.renderer?.quality === "high" ||
    final.renderer?.quality === "balanced";
  expect(final.frameWorkP95Ms).toBeLessThanOrEqual(
    desktopTier ? 1_000 / 60 : 1_000 / 30,
  );
  expect(final.longestFrameWorkMs).toBeLessThan(50);
  expect(final.audio.graphNodeCount).toBe(baseline.audio.graphNodeCount);
  expect(final.audio.framesApplied).toBeGreaterThanOrEqual(
    middle.audio.framesApplied,
  );
  expect(final.audio.appliedGain).toBeLessThanOrEqual(
    GENERATED_AUDIO_SAFETY_SPEC.sourceMapping.maximumOutputGainLinear,
  );
  expect(final.audio.rmsDbfs).toBeLessThanOrEqual(
    GENERATED_AUDIO_SAFETY_SPEC.rmsLimiter.maximumRmsDbfs,
  );
  expect(final.audio.peakDbfs).toBeLessThanOrEqual(
    GENERATED_AUDIO_SAFETY_SPEC.peakLimiter.ceilingDbfs,
  );
  expect(Number.isFinite(final.longestFrameDeltaMs)).toBe(true);
  expect(final.longestFrameDeltaMs).toBeLessThan(5_000);

  if (baselineHeap !== null && finalHeap !== null) {
    expect(finalHeap - baselineHeap).toBeLessThan(32 * 1024 * 1024);
  }
});
