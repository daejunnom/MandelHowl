import { afterEach, describe, expect, it, vi } from "vitest";
import challengeSamples from "../../specs/challenge/sample-targets.v1.json";
import {
  CHALLENGE_HOST_CONTRACT,
  CHALLENGE_TARGET_MESSAGE,
  createChallengeHostBridge,
  normalizeChallengeTarget,
  parseChallengeTargetMessage,
  validateChallengeResult,
} from "../../packages/browser-runtime/src";

describe("challenge host contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the canonical schema and normalizes every sample target", () => {
    expect(CHALLENGE_HOST_CONTRACT.$id).toBe(
      "https://mandelhowl.dev/contracts/challenge-host.v1.json",
    );
    expect(challengeSamples.schemaVersion).toBe(
      "mandelhowl.challenge-samples.v1",
    );
    expect(
      challengeSamples.targets.map(({ targetVolume }) =>
        normalizeChallengeTarget(targetVolume),
      ),
    ).toEqual([0, 25, 50, 75, 100]);
  });

  it("accepts only integer targets in the virtual output range", () => {
    expect(normalizeChallengeTarget(0)).toBe(0);
    expect(normalizeChallengeTarget("57")).toBe(57);
    expect(normalizeChallengeTarget(100)).toBe(100);
    expect(normalizeChallengeTarget(100.1)).toBeNull();
    expect(normalizeChallengeTarget(-1)).toBeNull();
    expect(normalizeChallengeTarget("volume 57")).toBeNull();
  });

  it("keeps target messages read-only and versioned", () => {
    const parsed = parseChallengeTargetMessage({
      type: CHALLENGE_TARGET_MESSAGE,
      targetVolume: 42,
    });
    expect(parsed).toEqual({
      type: CHALLENGE_TARGET_MESSAGE,
      targetVolume: 42,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
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

  it("reports only canonical settled integer results", () => {
    const valid = {
      targetVolume: 42,
      volume: 42,
      sequence: 7,
      datasetId: `sha256:${"a".repeat(64)}`,
      reached: true,
    };
    expect(validateChallengeResult(valid)).toBe(true);
    expect(
      validateChallengeResult({ ...valid, volume: 42.5 }),
    ).toBe(false);
    expect(
      validateChallengeResult({ ...valid, reached: false }),
    ).toBe(false);
    expect(
      validateChallengeResult({
        ...valid,
        datasetId: "unverified",
      }),
    ).toBe(false);
  });

  it("replies only to the exact allowlisted origin that proved host ownership", () => {
    const posted: Array<{ data: unknown; origin: string }> = [];
    const listeners: {
      message?: (event: MessageEvent<unknown>) => void;
    } = {};
    const hostWindow = {
      closed: false,
      postMessage(data: unknown, origin: string) {
        posted.push({ data, origin });
      },
    };
    Object.defineProperty(hostWindow, "location", {
      get() {
        throw new DOMException("Blocked cross-origin access", "SecurityError");
      },
    });
    const fakeWindow = {
      location: {
        origin: "https://instrument.test",
        search: "",
      },
      parent: hostWindow,
      opener: null,
      addEventListener(type: string, listener: EventListener) {
        if (type === "message") {
          listeners.message = listener as (
            event: MessageEvent<unknown>,
          ) => void;
        }
      },
      removeEventListener() {},
    };
    vi.stubGlobal("window", fakeWindow);

    const bridge = createChallengeHostBridge(
      () => {},
      ["https://host-a.test", "https://host-b.test"],
    );
    const result = {
      targetVolume: 42,
      volume: 42,
      sequence: 7,
      datasetId: `sha256:${"a".repeat(64)}`,
      reached: true,
    };

    bridge.reportSettledResult(result);
    expect(posted).toEqual([]);

    expect(listeners.message).toBeTypeOf("function");
    listeners.message?.({
      source: hostWindow,
      origin: "https://host-b.test",
      data: {
        type: CHALLENGE_TARGET_MESSAGE,
        targetVolume: 42,
      },
    } as unknown as MessageEvent<unknown>);
    bridge.reportSettledResult(result);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.origin).toBe("https://host-b.test");
    expect(posted[0]?.data).toMatchObject({
      type: "mandelhowl.challenge-result.v1",
      targetVolume: 42,
      volume: 42,
    });
  });
});
