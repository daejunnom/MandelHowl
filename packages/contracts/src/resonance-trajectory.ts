export interface ResonanceTrajectoryKeyframe {
  readonly sequence: number;
  readonly atSeconds: number;
  readonly frequencyHz: number;
}

/**
 * Piecewise-linear frequency history replayed against the injected fixed-step
 * clock. It is validation evidence, never a runtime volume lookup table.
 */
export interface ResonanceTrajectoryTrace {
  readonly schemaVersion: "mandelhowl.resonance-trajectory-trace.v1";
  readonly traceId: string;
  /** Stable modes.bin identity; unlike the package id, this is non-circular. */
  readonly modalModelId: `sha256:${string}`;
  readonly initialFrequencyHz: number;
  readonly durationSeconds: number;
  readonly expectedSettledVolume: number;
  readonly keyframes: readonly ResonanceTrajectoryKeyframe[];
}

export interface StaticDistributionReport {
  readonly sampleCount: number;
  readonly zeroCount: number;
  readonly hundredCount: number;
  readonly intermediateCount: number;
  readonly extremeFraction: number;
  readonly requiredExtremeFraction: number;
  readonly passed: boolean;
}

export interface ReachabilityCoverageReport {
  readonly schemaVersion: "mandelhowl.coverage-report.v1";
  readonly modalModelId: `sha256:${string}`;
  readonly generatedBy: {
    readonly algorithm: "deterministic-global-trajectory-search-v1";
    readonly perValueRuntimeLookup: "forbidden";
    readonly randomSource: "forbidden";
  };
  readonly perValueRuntimeExceptionTable: false;
  readonly verificationStatus: "runtime-replay-verified";
  readonly runtimeSpecSha256: {
    readonly dial: string;
    readonly feedback: string;
    readonly volumeMap: string;
  };
  readonly staticDistribution: StaticDistributionReport;
  readonly replayVerified: boolean;
  readonly coveredValues: readonly number[];
  readonly missingValues: readonly number[];
  readonly traces: readonly ResonanceTrajectoryTrace[];
  readonly outputs: readonly {
    readonly target: number;
    readonly verification: "runtime-replay-verified";
    readonly verified: true;
    readonly trace: ResonanceTrajectoryTrace;
  }[];
}
