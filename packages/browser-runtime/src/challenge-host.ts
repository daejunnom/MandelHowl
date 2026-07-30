import challengeHostContractSource from "../../../specs/challenge/host-contract.v1.json";

interface CanonicalChallengeHostContract {
  readonly $id: "https://mandelhowl.dev/contracts/challenge-host.v1.json";
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly ["type", "targetVolume"];
  readonly properties: {
    readonly type: {
      readonly const: "mandelhowl.challenge-target.v1";
    };
    readonly targetVolume: {
      readonly oneOf: readonly [
        {
          readonly type: "integer";
          readonly minimum: 0;
          readonly maximum: 100;
        },
        { readonly type: "null" },
      ];
    };
  };
  readonly transport: {
    readonly inboundMessageType: "mandelhowl.challenge-target.v1";
    readonly outboundMessageType: "mandelhowl.challenge-result.v1";
    readonly originPolicy: "same-origin-or-explicit-allowlist";
    readonly traceTransmission: "forbidden";
    readonly targetMutability: "host-read-only";
  };
}

function loadCanonicalChallengeHostContract(
  value: unknown,
): CanonicalChallengeHostContract {
  const contract = value as Partial<CanonicalChallengeHostContract>;
  const integerTarget = contract.properties?.targetVolume.oneOf[0];
  const nullTarget = contract.properties?.targetVolume.oneOf[1];
  if (
    contract.$id !==
      "https://mandelhowl.dev/contracts/challenge-host.v1.json" ||
    contract.type !== "object" ||
    contract.additionalProperties !== false ||
    contract.required?.length !== 2 ||
    contract.required[0] !== "type" ||
    contract.required[1] !== "targetVolume" ||
    contract.properties?.type.const !==
      "mandelhowl.challenge-target.v1" ||
    integerTarget?.type !== "integer" ||
    integerTarget.minimum !== 0 ||
    integerTarget.maximum !== 100 ||
    nullTarget?.type !== "null" ||
    contract.transport?.inboundMessageType !==
      contract.properties.type.const ||
    contract.transport.outboundMessageType !==
      "mandelhowl.challenge-result.v1" ||
    contract.transport.originPolicy !==
      "same-origin-or-explicit-allowlist" ||
    contract.transport.traceTransmission !== "forbidden" ||
    contract.transport.targetMutability !== "host-read-only"
  ) {
    throw new Error("Canonical challenge host contract is invalid");
  }
  return contract as CanonicalChallengeHostContract;
}

export const CHALLENGE_HOST_CONTRACT =
  loadCanonicalChallengeHostContract(challengeHostContractSource);
export const CHALLENGE_TARGET_MESSAGE =
  CHALLENGE_HOST_CONTRACT.transport.inboundMessageType;
export const CHALLENGE_RESULT_MESSAGE =
  CHALLENGE_HOST_CONTRACT.transport.outboundMessageType;
const CHALLENGE_TARGET_MINIMUM =
  CHALLENGE_HOST_CONTRACT.properties.targetVolume.oneOf[0].minimum;
const CHALLENGE_TARGET_MAXIMUM =
  CHALLENGE_HOST_CONTRACT.properties.targetVolume.oneOf[0].maximum;

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

const CONTENT_ADDRESSED_ID = /^sha256:[a-f0-9]{64}$/;

export function validateChallengeResult(
  result: Omit<ChallengeResultMessage, "type">,
): boolean {
  const target = result.targetVolume;
  const targetValid =
    target === null ||
    (Number.isInteger(target) &&
      target >= CHALLENGE_TARGET_MINIMUM &&
      target <= CHALLENGE_TARGET_MAXIMUM);
  const volumeValid =
    Number.isInteger(result.volume) &&
    result.volume >= CHALLENGE_TARGET_MINIMUM &&
    result.volume <= CHALLENGE_TARGET_MAXIMUM;
  const reached =
    target !== null && volumeValid && result.volume === target;
  return (
    targetValid &&
    volumeValid &&
    Number.isInteger(result.sequence) &&
    result.sequence >= 0 &&
    CONTENT_ADDRESSED_ID.test(result.datasetId) &&
    result.reached === reached
  );
}

export function normalizeChallengeTarget(value: unknown): number | null {
  const numberValue =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : value;
  return typeof numberValue === "number" &&
    Number.isInteger(numberValue) &&
    numberValue >= CHALLENGE_TARGET_MINIMUM &&
    numberValue <= CHALLENGE_TARGET_MAXIMUM
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
    return Object.freeze({
      type: CHALLENGE_TARGET_MESSAGE,
      targetVolume: null,
    });
  }
  return typeof candidate.targetVolume === "number" &&
    Number.isInteger(candidate.targetVolume) &&
    candidate.targetVolume >= CHALLENGE_TARGET_MINIMUM &&
    candidate.targetVolume <= CHALLENGE_TARGET_MAXIMUM
    ? Object.freeze({
        type: CHALLENGE_TARGET_MESSAGE,
        targetVolume: candidate.targetVolume,
      })
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
  let replyOrigin: string | null = null;
  if (hostWindow) {
    try {
      if (hostWindow.location.origin === window.location.origin) {
        replyOrigin = window.location.origin;
      }
    } catch {
      // A cross-origin host proves its exact allowlisted origin by sending a
      // valid target message. Never guess among multiple trusted origins.
    }
  }

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
    replyOrigin = event.origin;
    target = message.targetVolume;
    onTarget(target);
  };
  window.addEventListener("message", handleMessage);

  return {
    initialTarget: target,
    reportSettledResult(result) {
      if (
        !hostWindow ||
        replyOrigin === null ||
        !validateChallengeResult(result)
      ) {
        return;
      }
      hostWindow.postMessage(
        {
          type: CHALLENGE_RESULT_MESSAGE,
          ...result,
        } satisfies ChallengeResultMessage,
        replyOrigin,
      );
    },
    dispose() {
      window.removeEventListener("message", handleMessage);
    },
  };
}
