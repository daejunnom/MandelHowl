import { describe, expect, it } from "vitest";
import {
  CHALLENGE_TARGET_MESSAGE,
  normalizeChallengeTarget,
  parseChallengeTargetMessage,
} from "../../packages/browser-runtime/src";

describe("challenge host contract", () => {
  it("accepts only integer targets in the virtual output range", () => {
    expect(normalizeChallengeTarget(0)).toBe(0);
    expect(normalizeChallengeTarget("57")).toBe(57);
    expect(normalizeChallengeTarget(100)).toBe(100);
    expect(normalizeChallengeTarget(100.1)).toBeNull();
    expect(normalizeChallengeTarget(-1)).toBeNull();
    expect(normalizeChallengeTarget("volume 57")).toBeNull();
  });

  it("keeps target messages read-only and versioned", () => {
    expect(
      parseChallengeTargetMessage({
        type: CHALLENGE_TARGET_MESSAGE,
        targetVolume: 42,
      }),
    ).toEqual({
      type: CHALLENGE_TARGET_MESSAGE,
      targetVolume: 42,
    });
    expect(
      parseChallengeTargetMessage({
        type: "mandelhowl.challenge-target.v0",
        targetVolume: 42,
      }),
    ).toBeNull();
    expect(
      parseChallengeTargetMessage({
        type: CHALLENGE_TARGET_MESSAGE,
        targetVolume: "42",
      }),
    ).toBeNull();
    expect(
      parseChallengeTargetMessage({
        type: CHALLENGE_TARGET_MESSAGE,
        targetVolume: 42,
        extra: true,
      }),
    ).toBeNull();
  });
});
