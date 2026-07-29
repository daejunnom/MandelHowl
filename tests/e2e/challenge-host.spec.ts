import { expect, test } from "@playwright/test";

test("accepts a same-origin read-only target and reports settled results", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const state = window as unknown as {
      __mhChallengeResults: unknown[];
    };
    state.__mhChallengeResults = [];
    window.addEventListener("message", (event) => {
      if (
        event.origin === window.location.origin &&
        typeof event.data === "object" &&
        event.data !== null &&
        (event.data as { type?: unknown }).type ===
          "mandelhowl.challenge-result.v1"
      ) {
        state.__mhChallengeResults.push(event.data);
      }
    });
    const frame = document.createElement("iframe");
    frame.id = "challenge-frame";
    frame.title = "MandelHowl challenge";
    frame.src = "/?target=7";
    frame.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9999";
    document.body.append(frame);
  });

  const challenge = page.frameLocator("#challenge-frame");
  await expect(challenge.getByText("READ-ONLY TARGET 007")).toBeVisible();
  await expect(
    challenge.getByRole("slider", { name: "Drive frequency" }),
  ).toHaveCount(1);

  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      "#challenge-frame",
    );
    frame?.contentWindow?.postMessage(
      {
        type: "mandelhowl.challenge-target.v1",
        targetVolume: 64,
      },
      window.location.origin,
    );
  });
  await expect(challenge.getByText("READ-ONLY TARGET 064")).toBeVisible();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window as unknown as {
            __mhChallengeResults: Array<{
              type?: string;
              targetVolume?: number;
              volume?: number;
              datasetId?: string;
            }>;
          };
          return state.__mhChallengeResults.find(
            (result) => result.targetVolume === 64,
          );
        }),
      { timeout: 15_000 },
    )
    .toMatchObject({
      type: "mandelhowl.challenge-result.v1",
      targetVolume: 64,
      volume: expect.any(Number),
      datasetId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
});
