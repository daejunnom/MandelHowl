export const CHALLENGE_TARGET_MESSAGE =
  "mandelhowl.challenge-target.v1" as const;
export const CHALLENGE_RESULT_MESSAGE =
  "mandelhowl.challenge-result.v1" as const;

export interface ChallengeTargetMessage {
  readonly type: typeof CHALLENGE_TARGET_MESSAGE;
  readonly targetVolume: number | null;
}

export interface ChallengeResultMessage {
  readonly type: typeof CHALLENGE_RESULT_MESSAGE;
  readonly targetVolume: number | null;
  readonly volume: number;
  readonly sequence: number;
  readonly datasetId: string;
  readonly reached: boolean;
}

export interface ChallengeHostBridge {
  readonly initialTarget: number | null;
  reportSettledResult(result: Omit<ChallengeResultMessage, "type">): void;
  dispose(): void;
}

export function normalizeChallengeTarget(value: unknown): number | null {
  const numberValue =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : value;
  return typeof numberValue === "number" &&
    Number.isInteger(numberValue) &&
    numberValue >= 0 &&
    numberValue <= 100
    ? numberValue
    : null;
}

export function parseChallengeTargetMessage(
  value: unknown,
): ChallengeTargetMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("type") ||
    !keys.includes("targetVolume")
  ) {
    return null;
  }
  const candidate = value as Partial<ChallengeTargetMessage>;
  if (candidate.type !== CHALLENGE_TARGET_MESSAGE) return null;
  if (candidate.targetVolume === null) {
    return { type: CHALLENGE_TARGET_MESSAGE, targetVolume: null };
  }
  return typeof candidate.targetVolume === "number" &&
    Number.isInteger(candidate.targetVolume) &&
    candidate.targetVolume >= 0 &&
    candidate.targetVolume <= 100
    ? {
        type: CHALLENGE_TARGET_MESSAGE,
        targetVolume: candidate.targetVolume,
      }
    : null;
}

function initialTargetFromLocation(): number | null {
  if (typeof window === "undefined") return null;
  const parameters = new URLSearchParams(window.location.search);
  return normalizeChallengeTarget(
    parameters.get("targetVolume") ?? parameters.get("target"),
  );
}

function allowedHostOrigins(
  explicitOrigins: readonly string[],
): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  const origins = new Set<string>([window.location.origin]);
  for (const value of explicitOrigins) {
    try {
      const origin = new URL(value).origin;
      if (origin !== "null") origins.add(origin);
    } catch {
      // A malformed allowlist entry never broadens the trust boundary.
    }
  }
  return origins;
}

/**
 * Read-only host bridge. Targets can be supplied by URL or a trusted parent
 * frame, but they never enter the dial or resonance calculation.
 */
export function createChallengeHostBridge(
  onTarget: (target: number | null) => void,
  explicitAllowedOrigins: readonly string[] = [],
): ChallengeHostBridge {
  if (typeof window === "undefined") {
    return {
      initialTarget: null,
      reportSettledResult() {},
      dispose() {},
    };
  }

  const origins = allowedHostOrigins(explicitAllowedOrigins);
  const hostWindow =
    window.parent !== window
      ? window.parent
      : window.opener && !window.opener.closed
        ? window.opener
        : null;
  let target = initialTargetFromLocation();

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (
      !hostWindow ||
      event.source !== hostWindow ||
      !origins.has(event.origin)
    ) {
      return;
    }
    const message = parseChallengeTargetMessage(event.data);
    if (!message) return;
    target = message.targetVolume;
    onTarget(target);
  };
  window.addEventListener("message", handleMessage);

  return {
    initialTarget: target,
    reportSettledResult(result) {
      if (!hostWindow) return;
      const destination =
        [...origins].find((origin) => origin !== window.location.origin) ??
        window.location.origin;
      hostWindow.postMessage(
        {
          type: CHALLENGE_RESULT_MESSAGE,
          ...result,
        } satisfies ChallengeResultMessage,
        destination,
      );
    },
    dispose() {
      window.removeEventListener("message", handleMessage);
    },
  };
}
