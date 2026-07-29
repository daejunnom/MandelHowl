import type { CanonicalOwnership } from "./contract-metadata";

export interface FeedbackSpec {
  readonly $schema?: string;
  readonly schemaVersion: "mandelhowl.feedback-spec.v1";
  readonly canonicalOwner: CanonicalOwnership;
  readonly units: {
    readonly time: "s";
    readonly frequency: "Hz";
    readonly phase: "rad";
    readonly amplitude: "normalized";
    readonly gain: "linear";
  };
  readonly simulation: {
    readonly stateRepresentation: "rotating-complex-envelope";
    readonly integrator: "exponential-euler";
    readonly fixedStepSeconds: number;
    readonly maximumCatchUpSeconds: number;
    readonly maximumStepsPerFrame: number;
    readonly pausedGapResetSeconds: number;
  };
  readonly drive: {
    readonly amplitudeNormalized: number;
    readonly phaseContinuity: "continuous-across-frequency-changes";
  };
  readonly modalSelection: {
    readonly maximumActiveModes: number;
    readonly activationBandwidthRatio: number;
    readonly residualEnergyThreshold: number;
  };
  readonly loop: {
    readonly delaySeconds: number;
    readonly gainLinear: number;
    readonly polarity: 1 | -1;
    readonly phaseOffsetRad: number;
    readonly filter: {
      readonly type: "band-pass-biquad-cascade";
      readonly highPassHz: number;
      readonly lowPassHz: number;
      readonly q: number;
    };
  };
  readonly noiseGate: {
    readonly openThresholdNormalized: number;
    readonly closeThresholdNormalized: number;
    readonly attackSeconds: number;
    readonly releaseSeconds: number;
    readonly closedAttenuationLinear: number;
  };
  readonly softClipper: {
    readonly function: "normalized-tanh";
    readonly drive: number;
  };
  readonly virtualSpeaker: {
    readonly maximumDisplacementNormalized: number;
  };
  readonly limiter: {
    readonly thresholdNormalized: number;
    readonly ceilingNormalized: number;
    readonly attackSeconds: number;
    readonly releaseSeconds: number;
    readonly holdSeconds: number;
  };
  readonly envelopeFollower: {
    readonly attackSeconds: number;
    readonly releaseSeconds: number;
  };
  readonly regimeThresholds: {
    readonly criticalLoopMarginHalfWidth: number;
    readonly decayingMaximumEnvelope: number;
    readonly growingMinimumSlopePerSecond: number;
    readonly saturatedMinimumEnvelope: number;
    /** Positive amount of gain reduction, in dB. */
    readonly saturatedMinimumGainReductionDb: number;
  };
  readonly determinism: {
    readonly randomSource: "forbidden";
    readonly clock: "injected-fixed-step";
    readonly delayedSamples: "preallocated-ring-buffer";
  };
}
