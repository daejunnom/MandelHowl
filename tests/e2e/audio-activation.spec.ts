import { expect, test } from "@playwright/test";

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
