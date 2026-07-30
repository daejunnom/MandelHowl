import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeModesBinaryV1 } from "../../packages/asset-runtime/src";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_DIAL_SPEC,
} from "../../packages/contracts/src";
import {
  DEFAULT_DIAL_CONFIG,
  frequencyToAngle,
} from "../../packages/dial-engine/src";
import { waitForRuntimeReady } from "./runtime-ready";

const PINNED_MODES = decodeModesBinaryV1(
  readFileSync(
    resolve(
      process.cwd(),
      GENERATED_DATASET_RELEASE_SPEC.sourceDirectory,
      "modes.bin",
    ),
  ),
);

function separatedPinnedModes(): readonly [
  (typeof PINNED_MODES)[number],
  (typeof PINNED_MODES)[number],
] {
  if (PINNED_MODES.length < 4) {
    throw new Error("The pinned production dataset must contain at least four modes");
  }
  const oldMode =
    PINNED_MODES[Math.round((PINNED_MODES.length - 1) * 0.25)]!;
  const newMode =
    PINNED_MODES[Math.round((PINNED_MODES.length - 1) * 0.75)]!;
  return [oldMode, newMode];
}

const [TEMPORAL_OLD_MODE, TEMPORAL_NEW_MODE] = separatedPinnedModes();
const TEMPORAL_MODE_QUERY = new URLSearchParams({
  oldModeId: TEMPORAL_OLD_MODE.modeId,
  newModeId: TEMPORAL_NEW_MODE.modeId,
}).toString();

function temporalFixtureUrl(path: string): string {
  return `${path}?${TEMPORAL_MODE_QUERY}`;
}

interface TemporalObservation {
  readonly stage: string | null;
  readonly pixelSignature: string | null;
  readonly sandLikeSamples: number;
  readonly sandContrast: number;
  readonly snapshotSignature: string | null;
  readonly activeModeId: string | null;
  readonly oldModeId: string | null;
  readonly newModeId: string | null;
  readonly frequency: string | null;
}

async function waitForFixture(
  page: Page,
  renderer: "webgl2" | "canvas2d",
  stage: string,
): Promise<void> {
  const status = page.getByTestId("visual-renderer-status");
  await expect(status).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
  await expect(status).toHaveAttribute("data-renderer", renderer);
  await expect(status).toHaveAttribute("data-texture-ready", "true");
  await expect(status).toHaveAttribute("data-temporal-stage", stage);
  await expect(status).not.toHaveAttribute(
    "data-pixel-signature",
    /^(pending|empty|.+-unavailable)$/,
  );
}

async function observe(page: Page): Promise<TemporalObservation> {
  return page
    .getByTestId("visual-renderer-status")
    .evaluate((element) => ({
      stage: element.getAttribute("data-temporal-stage"),
      pixelSignature: element.getAttribute("data-pixel-signature"),
      sandLikeSamples: Number(
        element.getAttribute("data-sand-like-samples") ?? 0,
      ),
      sandContrast: Number(element.getAttribute("data-sand-contrast") ?? 0),
      snapshotSignature: element.getAttribute(
        "data-snapshot-signature",
      ),
      activeModeId: element.getAttribute("data-active-mode-id"),
      oldModeId: element.getAttribute("data-old-mode-id"),
      newModeId: element.getAttribute("data-new-mode-id"),
      frequency: element.getAttribute("data-frequency"),
    }));
}

async function advance(
  page: Page,
  control:
    | "temporal-step-one-frame"
    | "temporal-step-50ms"
    | "temporal-step-250ms",
  expectedStage: string,
): Promise<TemporalObservation> {
  await page.getByTestId(control).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(
    page.getByTestId("visual-renderer-status"),
  ).toHaveAttribute("data-temporal-stage", expectedStage);
  return observe(page);
}

for (const fixture of [
  {
    renderer: "webgl2",
    transitionPath: "/visual-fixture/temporal-transition",
    referencePath: "/visual-fixture/temporal-new-only",
  },
  {
    renderer: "canvas2d",
    transitionPath:
      "/visual-fixture/temporal-transition-canvas",
    referencePath: "/visual-fixture/temporal-new-only-canvas",
  },
] as const) {
  test(`${fixture.renderer} plate paints capture and residual at deterministic times`, async ({
    context,
    page,
  }) => {
    await page.goto(temporalFixtureUrl(fixture.transitionPath));
    await waitForFixture(page, fixture.renderer, "baseline");
    const baseline = await observe(page);

    expect(baseline.oldModeId).toBe(TEMPORAL_OLD_MODE.modeId);
    expect(baseline.newModeId).toBe(TEMPORAL_NEW_MODE.modeId);
    expect(baseline.activeModeId).toBe(TEMPORAL_OLD_MODE.modeId);
    expect(baseline.frequency).toBe(
      TEMPORAL_OLD_MODE.naturalFrequencyHz.toFixed(2),
    );
    expect(baseline.sandLikeSamples).toBeGreaterThan(100);
    expect(baseline.sandContrast).toBeGreaterThanOrEqual(22);

    const oneFrame = await advance(
      page,
      "temporal-step-one-frame",
      "one-frame",
    );
    expect(oneFrame.activeModeId).toBe(TEMPORAL_NEW_MODE.modeId);
    expect(oneFrame.frequency).toBe(
      TEMPORAL_NEW_MODE.naturalFrequencyHz.toFixed(2),
    );
    expect(oneFrame.pixelSignature).not.toBe(
      baseline.pixelSignature,
    );
    expect(oneFrame.sandLikeSamples).toBeGreaterThan(100);

    const referencePage = await context.newPage();
    try {
      await referencePage.goto(
        temporalFixtureUrl(fixture.referencePath),
      );
      await waitForFixture(
        referencePage,
        fixture.renderer,
        "new-only",
      );
      const newOnly = await observe(referencePage);

      // The current canonical snapshot is byte-for-byte equivalent. A
      // different framebuffer therefore comes only from the transition
      // renderer retaining the previous baked mode.
      expect(newOnly.snapshotSignature).toBe(
        oneFrame.snapshotSignature,
      );
      expect(newOnly.activeModeId).toBe(oneFrame.activeModeId);
      expect(newOnly.pixelSignature).not.toBe(
        oneFrame.pixelSignature,
      );
    } finally {
      await referencePage.close();
    }

    const after50ms = await advance(
      page,
      "temporal-step-50ms",
      "50ms",
    );
    expect(after50ms.activeModeId).toBe(after50ms.newModeId);
    expect(after50ms.pixelSignature).not.toBe(
      oneFrame.pixelSignature,
    );

    const after250ms = await advance(
      page,
      "temporal-step-250ms",
      "250ms",
    );
    expect(after250ms.activeModeId).toBe(after250ms.newModeId);
    expect(after250ms.pixelSignature).not.toBe(
      after50ms.pixelSignature,
    );
    expect(after250ms.pixelSignature).not.toBe(
      baseline.pixelSignature,
    );
  });
}

function dialAngleForFrequency(frequencyHz: number): number {
  if (
    DEFAULT_DIAL_CONFIG.minFrequencyHz !==
      GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz ||
    DEFAULT_DIAL_CONFIG.maxFrequencyHz !==
      GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz ||
    DEFAULT_DIAL_CONFIG.minAngleRadians !==
      GENERATED_DIAL_SPEC.mapping.minimumUnwrappedAngleRad ||
    DEFAULT_DIAL_CONFIG.maxAngleRadians !==
      GENERATED_DIAL_SPEC.mapping.maximumUnwrappedAngleRad
  ) {
    throw new Error("The dial engine is not using the generated dial mapping.");
  }
  return frequencyToAngle(frequencyHz, DEFAULT_DIAL_CONFIG);
}

async function rotateActualDial(
  page: Page,
  fromFrequencyHz: number,
  toFrequencyHz: number,
  settleFrames: number,
): Promise<void> {
  const dial = page.getByRole("slider", {
    name: "Drive frequency",
  });
  await dial.evaluate(
    async (
      element,
      {
        fromAngle,
        toAngle,
        settle,
      }: {
        fromAngle: number;
        toAngle: number;
        settle: number;
      },
    ) => {
      const bounds = element.getBoundingClientRect();
      const centreX = bounds.left + bounds.width / 2;
      const centreY = bounds.top + bounds.height / 2;
      const radius = Math.min(bounds.width, bounds.height) * 0.4;
      const pointerId = 73;
      const dispatch = (
        type: "pointerdown" | "pointermove" | "pointerup",
        angle: number,
        buttons: number,
      ) => {
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: "mouse",
            button: 0,
            buttons,
            clientX: centreX + Math.cos(angle) * radius,
            clientY: centreY + Math.sin(angle) * radius,
          }),
        );
      };
      const nextFrame = () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      dispatch("pointerdown", fromAngle, 1);
      const steps = Math.max(
        1,
        Math.ceil(Math.abs(toAngle - fromAngle) / 0.08),
      );
      for (let step = 1; step <= steps; step += 1) {
        await nextFrame();
        dispatch(
          "pointermove",
          fromAngle + ((toAngle - fromAngle) * step) / steps,
          1,
        );
      }
      for (let frame = 0; frame < settle; frame += 1) {
        await nextFrame();
        dispatch("pointermove", toAngle, 1);
      }
      dispatch("pointerup", toAngle, 0);
      // The app's rAF was registered before this helper. Two turns guarantee
      // one canonical simulation/presentation frame after pointerup.
      await nextFrame();
      await nextFrame();
    },
    {
      fromAngle: dialAngleForFrequency(fromFrequencyHz),
      toAngle: dialAngleForFrequency(toFrequencyHz),
      settle: settleFrames,
    },
  );
}

async function actualPlateSignature(page: Page): Promise<string> {
  // WebGL's default framebuffer is not preserved after compositing. Capture
  // the canvas as the user sees it instead of reading an undefined backbuffer
  // between animation frames.
  const pixels = await page
    .locator(".mh-plate-canvas")
    .screenshot({ animations: "allow" });
  let hash = 0x811c9dc5;
  const stride = Math.max(1, Math.floor(pixels.length / 65_536));
  for (let index = 0; index < pixels.length; index += stride) {
    hash ^= pixels[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

test("actual dial transition repaints the plate near-term, at 50 ms, and at 250 ms", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Select well-separated frequencies from the content-addressed production
  // modes instead of pinning a solver-specific ordinal or frequency.
  const oldFrequency = TEMPORAL_OLD_MODE.naturalFrequencyHz;
  const newFrequency = TEMPORAL_NEW_MODE.naturalFrequencyHz;
  await page.goto("/");
  await waitForRuntimeReady(page);
  const initialFrequency = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().runtime
        .driveFrequencyHz ??
      GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
  );
  // Hold the baseline long enough for the dial's velocity estimator to decay.
  // Otherwise pointer-up inertia can cross a nearby capture boundary.
  await rotateActualDial(page, initialFrequency, oldFrequency, 90);
  await expect
    .poll(() =>
      page.evaluate(
        () => {
          const activeModeId =
            window.__MANDELHOWL_HEALTH__?.getSnapshot().runtime
              .activeModeId;
          return activeModeId !== null;
        },
      ),
      { timeout: 15_000 },
    )
    .toBe(true);
  const baselineRuntime = await page.evaluate(
    () => window.__MANDELHOWL_HEALTH__?.getSnapshot().runtime,
  );
  expect(baselineRuntime?.activeModeId).not.toBeNull();
  const baseline = await actualPlateSignature(page);

  await rotateActualDial(
    page,
    baselineRuntime?.driveFrequencyHz ?? oldFrequency,
    newFrequency,
    0,
  );
  const nearTerm = await actualPlateSignature(page);
  const capturedNearTerm = await page.evaluate(
    () =>
      window.__MANDELHOWL_HEALTH__?.getSnapshot().runtime
        .activeModeId,
  );
  expect(capturedNearTerm).not.toBeNull();
  expect(capturedNearTerm).not.toBe(baselineRuntime?.activeModeId);
  expect(nearTerm).not.toBe(baseline);

  await page.waitForTimeout(50);
  const after50ms = await actualPlateSignature(page);
  expect(after50ms).not.toBe(nearTerm);
  await expect
    .poll(async () => {
      const activeModeId = await page.evaluate(
        () =>
          window.__MANDELHOWL_HEALTH__?.getSnapshot().runtime
            .activeModeId,
      );
      const ordinal = activeModeId?.match(/^mode-(\d+)$/)?.[1];
      const label = await page.locator(".mh-mode-readout strong").textContent();
      return ordinal
        ? label === `MODE ${Number.parseInt(ordinal, 10)}`
        : false;
    })
    .toBe(true);

  await page.waitForTimeout(200);
  const after250ms = await actualPlateSignature(page);
  expect(after250ms).not.toBe(after50ms);
  expect(after250ms).not.toBe(baseline);
});
