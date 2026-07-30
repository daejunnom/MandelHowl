import { expect, test } from "@playwright/test";
import { waitForRuntimeReady } from "./runtime-ready";

test("apparatus motion is driven by canonical frequency, microphone, and feedback values", async ({
  page,
}) => {
  await page.goto("/visual-fixture/decayed");
  const status = page.getByTestId("visual-renderer-status");
  await expect(status).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
  const silent = await page.locator(".mh-shell").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      driveCycle: style.getPropertyValue("--drive-cycle").trim(),
      microphoneLevel: style
        .getPropertyValue("--microphone-level")
        .trim(),
      feedbackLevel: style.getPropertyValue("--feedback-level").trim(),
    };
  });
  expect(silent).toEqual({
    driveCycle: "0.92s",
    microphoneLevel: "0",
    feedbackLevel: "0",
  });

  await page.goto("/visual-fixture/saturated");
  await expect(status).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
  const captured = await page.locator(".mh-shell").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      driveCycleSeconds: Number.parseFloat(
        style.getPropertyValue("--drive-cycle"),
      ),
      microphoneLevel: Number.parseFloat(
        style.getPropertyValue("--microphone-level"),
      ),
      feedbackLevel: Number.parseFloat(
        style.getPropertyValue("--feedback-level"),
      ),
      feedbackCycleSeconds: Number.parseFloat(
        style.getPropertyValue("--feedback-cycle"),
      ),
    };
  });
  expect(captured.driveCycleSeconds).toBeLessThan(0.92);
  expect(captured.microphoneLevel).toBeCloseTo(0.62);
  expect(captured.feedbackLevel).toBe(1);
  expect(captured.feedbackCycleSeconds).toBeCloseTo(0.85);
});

test("shows one oscilloscope signal and never lets the dial hand cover Hz", async ({
  page,
}) => {
  await page.goto("/visual-fixture/critical");
  await expect(page.getByTestId("visual-renderer-status")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 20_000 },
  );

  const instruments = page.locator(".mh-instrumentation");
  await expect(instruments.locator('[role="img"]')).toHaveCount(1);
  await expect(instruments.locator(".mh-oscilloscope")).toHaveCount(1);
  await expect(instruments.locator(".mh-phase-meter")).toHaveCount(0);
  await expect(instruments.locator(".mh-scope-phase-emphasis")).toContainText(
    "PHASE",
  );

  const stacking = await page.locator(".mh-dial").evaluate((dial) => ({
    face: Number.parseInt(
      getComputedStyle(dial.querySelector(".mh-dial-face")!).zIndex,
      10,
    ),
    pointer: Number.parseInt(
      getComputedStyle(dial.querySelector(".mh-dial-pointer")!).zIndex,
      10,
    ),
  }));
  expect(stacking.face).toBeGreaterThan(stacking.pointer);
});

test("publishes a settled number on the exact renderer snapshot sequence", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  await page.evaluate(() => {
    const host = window as typeof window & {
      __MANDELHOWL_SETTLEMENT_ATTESTATION__?: {
        dom: number;
        renderer: number | null;
        liveRenderer: number | null;
      };
    };
    let sawMeasuring = false;
    const observer = new MutationObserver(() => {
      const state = document.querySelector(".mh-output-state")?.textContent;
      if (state === "MEASURING") {
        sawMeasuring = true;
        return;
      }
      if (!sawMeasuring || state !== "SETTLED") return;
      host.__MANDELHOWL_SETTLEMENT_ATTESTATION__ = {
        dom: Number(
          document
            .querySelector(".mh-shell")
            ?.getAttribute("data-snapshot-sequence") ?? -1,
        ),
        renderer: Number(
          document
            .querySelector(
              ".mh-plate-canvas:not(.mh-plate-canvas-suspended)",
            )
            ?.getAttribute("data-settled-snapshot-sequence") ?? -1,
        ),
        liveRenderer:
          window.__MANDELHOWL_HEALTH__?.getSnapshot().renderer
            ?.lastSnapshotSequence ?? null,
      };
      observer.disconnect();
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  const dial = page.getByRole("slider", { name: "Drive frequency" });
  await dial.focus();
  await dial.press("Home");
  await expect(page.locator(".mh-output-state")).toHaveText("MEASURING");
  await expect(page.locator(".mh-output-state")).toHaveText("SETTLED", {
    timeout: 15_000,
  });
  const attestation = await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __MANDELHOWL_SETTLEMENT_ATTESTATION__?: {
                dom: number;
                renderer: number | null;
                liveRenderer: number | null;
              };
            }
          ).__MANDELHOWL_SETTLEMENT_ATTESTATION__ ?? null,
      ),
    )
    .not.toBeNull();
  void attestation;
  const sequences = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __MANDELHOWL_SETTLEMENT_ATTESTATION__?: {
            dom: number;
            renderer: number | null;
            liveRenderer: number | null;
          };
        }
      ).__MANDELHOWL_SETTLEMENT_ATTESTATION__,
  );
  expect(sequences?.renderer).toBe(sequences?.dom);
  expect(sequences?.liveRenderer ?? -1).toBeGreaterThanOrEqual(
    sequences?.dom ?? 0,
  );
});
