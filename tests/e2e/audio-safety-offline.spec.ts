import { expect, test } from "@playwright/test";
import { GENERATED_AUDIO_SAFETY_SPEC } from "../../packages/contracts/src";
import type { OfflineAudioSafetySweep } from "../../packages/audio-engine/src";

test("renders the canonical audio chain below peak and RMS limits", async ({
  page,
}) => {
  await page.goto("/audio-safety-fixture");
  const output = page.getByTestId("audio-safety-sweep");
  await expect(output).toHaveAttribute("data-status", "ready", {
    timeout: 20_000,
  });
  const sweep = JSON.parse(
    (await output.textContent()) ?? "",
  ) as OfflineAudioSafetySweep;

  expect(sweep.schemaVersion).toBe(
    "mandelhowl.offline-audio-safety-sweep.v1",
  );
  expect(sweep.frequenciesHz).toEqual([
    55, 110, 220, 440, 1_000, 3_000, 6_000,
  ]);
  expect(sweep.maximumRmsDbfs).toBeLessThanOrEqual(
    GENERATED_AUDIO_SAFETY_SPEC.rmsLimiter.maximumRmsDbfs,
  );
  expect(sweep.maximumPeakDbfs).toBeLessThanOrEqual(
    GENERATED_AUDIO_SAFETY_SPEC.peakLimiter.ceilingDbfs,
  );
  expect(sweep.points).toHaveLength(sweep.frequenciesHz.length);
  expect(sweep.passed).toBe(true);
});
