import { expect, test } from "@playwright/test";

async function waitForFixture(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("visual-renderer-status")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 20_000 },
  );
}

test("D0 WebGL draws the canonical speaker, plate, microphone, and cable scene", async ({
  page,
}) => {
  await page.goto("/visual-fixture/growing");
  await waitForFixture(page);

  const apparatus = page.locator(".mh-apparatus");
  const canvas = apparatus.locator(
    ":scope > canvas.mh-apparatus-canvas.mh-plate-canvas",
  );
  await expect(apparatus).toHaveAttribute("data-renderer-kind", "webgl2");
  await expect(canvas).toHaveAttribute(
    "data-webgl-apparatus-meshes",
    "speaker-cone,plate,microphone,feedback-cable",
  );
  await expect(canvas).toHaveAttribute(
    "data-webgl-apparatus-motion",
    "canonical-snapshot",
  );
  await expect(canvas).toHaveAttribute(
    "data-webgl-cable-direction",
    "microphone-to-feedback-to-speaker",
  );
  await expect(canvas).toHaveAttribute(
    "data-webgl-reduced-motion",
    "snapshot-signal-travel",
  );
  await expect(canvas).toHaveAttribute(
    "aria-label",
    /virtual speaker, Chladni plate and sand, virtual microphone, and feedback cable/u,
  );

  const bounds = await apparatus.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const surface = element
      .querySelector(".mh-apparatus-canvas")
      ?.getBoundingClientRect();
    return {
      frame: [frame.left, frame.top, frame.width, frame.height],
      surface: surface
        ? [surface.left, surface.top, surface.width, surface.height]
        : null,
    };
  });
  expect(bounds.surface).not.toBeNull();
  for (let index = 0; index < 4; index += 1) {
    expect(bounds.surface?.[index]).toBeCloseTo(bounds.frame[index] ?? 0);
  }

  // The semantic presenter remains in the DOM while its duplicated CSS
  // artwork yields to the actual WebGL meshes.
  await expect(apparatus.locator(".mh-speaker")).toHaveCount(1);
  await expect(apparatus.locator(".mh-microphone")).toHaveCount(1);
  await expect(apparatus.locator(".mh-feedback-cable")).toHaveCount(1);
  expect(
    await apparatus
      .locator(".mh-speaker-frame")
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("hidden");
});

test("reduced motion freezes cable travel but preserves apparatus signal levels", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/visual-fixture/reduced-motion");
  await waitForFixture(page);

  const canvas = page.locator(".mh-apparatus-canvas");
  await expect(canvas).toHaveAttribute(
    "data-webgl-reduced-motion",
    "level-preserved-travel-disabled",
  );
  await expect(page.locator(".mh-shell")).toHaveAttribute(
    "style",
    /--microphone-level:\s*0\.31/u,
  );
  await expect(page.locator(".mh-shell")).toHaveAttribute(
    "style",
    /--feedback-level:\s*0\.48/u,
  );
});

test("Canvas fail-operational mode keeps the same full apparatus presenter", async ({
  page,
}) => {
  await page.goto("/visual-fixture/canvas-fallback");
  await waitForFixture(page);

  const apparatus = page.locator(".mh-apparatus");
  const canvas = apparatus.locator(":scope > canvas.mh-apparatus-canvas");
  await expect(apparatus).toHaveAttribute("data-renderer-kind", "canvas2d");
  await expect(canvas).not.toHaveAttribute(
    "data-webgl-apparatus-meshes",
    /.+/u,
  );
  expect(
    await apparatus
      .locator(".mh-speaker-frame")
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("visible");
  expect(
    await apparatus
      .locator(".mh-feedback-cable")
      .evaluate((element) => getComputedStyle(element).visibility),
  ).toBe("visible");
});
