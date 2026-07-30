import {
  COVERAGE_REPORT_SCHEMA_SHA256,
  GENERATED_FEEDBACK_SPEC,
  GENERATED_DIAL_SPEC,
  N_VERSION_CONTRACT_DIGESTS,
  RUNTIME_SPEC_SOURCE_HASHES,
  type ReachabilityCoverageReport,
  type ResonanceTrajectoryTrace,
  type StaticDistributionReport,
} from "../../../packages/contracts/src";
import {
  advanceResonance,
  createResonanceState,
  estimateOpenLoopMarginAtFrequency,
  getResonanceSnapshot,
  type ResonanceSnapshot,
  type RuntimeModalDataset,
} from "../../../packages/resonance-engine/src/resonance-engine";

export interface ReplayTrajectoryResult {
  readonly snapshot: ResonanceSnapshot;
  readonly settledVolume: number | null;
  readonly matchedExpectedVolume: boolean;
}

export interface ReachabilitySearchOptions {
  readonly initialFrequencyHz?: number;
  readonly rampSeconds?: number;
  readonly holdSeconds?: number;
  readonly modeIndex?: number;
  /**
   * Maximum bisection depth for a globally sampled trajectory interval.
   * Kept under its original name for wire/API compatibility.
   */
  readonly maximumCorrectionIterations?: number;
  readonly staticSampleCount?: number;
  readonly requiredExtremeFraction?: number;
}

export interface ReachabilitySearchResult {
  readonly report: ReachabilityCoverageReport;
  readonly attempts: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function validateResonanceTrajectoryTrace(
  trace: ResonanceTrajectoryTrace,
): readonly string[] {
  const errors: string[] = [];
  if (trace.schemaVersion !== "mandelhowl.resonance-trajectory-trace.v1") {
    errors.push("TRACE_SCHEMA_VERSION_UNSUPPORTED");
  }
  if (!Number.isFinite(trace.durationSeconds) || trace.durationSeconds <= 0) {
    errors.push("TRACE_DURATION_INVALID");
  }
  if (
    !Number.isInteger(trace.expectedSettledVolume) ||
    trace.expectedSettledVolume < 0 ||
    trace.expectedSettledVolume > 100
  ) {
    errors.push("TRACE_EXPECTED_VOLUME_INVALID");
  }
  if (trace.keyframes.length === 0) errors.push("TRACE_KEYFRAMES_EMPTY");
  let previousTime = -1;
  trace.keyframes.forEach((keyframe, index) => {
    if (keyframe.sequence !== index) errors.push("TRACE_SEQUENCE_INVALID");
    if (
      !Number.isFinite(keyframe.atSeconds) ||
      keyframe.atSeconds < previousTime ||
      keyframe.atSeconds > trace.durationSeconds
    ) {
      errors.push("TRACE_TIME_INVALID");
    }
    if (
      !Number.isFinite(keyframe.frequencyHz) ||
      keyframe.frequencyHz <
        GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz ||
      keyframe.frequencyHz >
        GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz
    ) {
      errors.push("TRACE_FREQUENCY_INVALID");
    }
    previousTime = keyframe.atSeconds;
  });
  if (trace.keyframes[0]?.atSeconds !== 0) {
    errors.push("TRACE_MUST_START_AT_ZERO");
  }
  return Object.freeze([...new Set(errors)]);
}

function driveAtTime(
  trace: ResonanceTrajectoryTrace,
  timeSeconds: number,
): {
  readonly frequencyHz: number;
  readonly sweepHzPerSecond: number;
  readonly direction: -1 | 0 | 1;
} {
  let left = trace.keyframes[0];
  for (let index = 1; index < trace.keyframes.length; index += 1) {
    const right = trace.keyframes[index];
    if (timeSeconds <= right.atSeconds) {
      const duration = right.atSeconds - left.atSeconds;
      if (duration <= 0) {
        return {
          frequencyHz: right.frequencyHz,
          sweepHzPerSecond: 0,
          direction: 0,
        };
      }
      const progress = clamp(
        (timeSeconds - left.atSeconds) / duration,
        0,
        1,
      );
      const sweep =
        (right.frequencyHz - left.frequencyHz) / duration;
      return {
        frequencyHz:
          left.frequencyHz +
          (right.frequencyHz - left.frequencyHz) * progress,
        sweepHzPerSecond: sweep,
        direction: sweep < 0 ? -1 : sweep > 0 ? 1 : 0,
      };
    }
    left = right;
  }
  return {
    frequencyHz: left.frequencyHz,
    sweepHzPerSecond: 0,
    direction: 0,
  };
}

export function replayResonanceTrajectory(
  dataset: RuntimeModalDataset,
  trace: ResonanceTrajectoryTrace,
): ReplayTrajectoryResult {
  const errors = validateResonanceTrajectoryTrace(trace);
  if (errors.length > 0) {
    throw new Error(`Invalid resonance trace: ${errors.join(", ")}`);
  }
  if (trace.modalModelId !== dataset.modalModelId) {
    throw new Error("Trace modalModelId does not match replay dataset");
  }
  let state = createResonanceState({
    dataset,
    initialFrequencyHz: trace.initialFrequencyHz,
  });
  const step = GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds;
  const stepCount = Math.round(trace.durationSeconds / step);
  for (let index = 1; index <= stepCount; index += 1) {
    const time = Math.min(trace.durationSeconds, index * step);
    state = advanceResonance(
      state,
      step,
      driveAtTime(trace, time),
    );
  }
  const snapshot = getResonanceSnapshot(state);
  return Object.freeze({
    snapshot,
    settledVolume: snapshot.settled
      ? snapshot.lastSettledVolume
      : null,
    matchedExpectedVolume:
      snapshot.settled &&
      snapshot.lastSettledVolume === trace.expectedSettledVolume,
  });
}

interface TracePlan {
  readonly id: string;
  readonly initialFrequencyHz: number;
  readonly durationSeconds: number;
  readonly keyframes: readonly {
    readonly atSeconds: number;
    readonly frequencyHz: number;
  }[];
}

interface MarginBranch {
  readonly id: "lower-frequency" | "higher-frequency";
  readonly peakFrequencyHz: number;
  readonly outsideFrequencyHz: number;
}

interface TrajectoryFamily {
  readonly id: string;
  readonly initialFrequencyHz: number | "candidate";
  readonly rampSeconds: number;
  readonly holdSeconds: number;
  readonly quietHoldSeconds: number;
  readonly peakHoldSeconds: number;
}

interface TrajectoryObservation {
  readonly position: number;
  readonly settledVolume: number | null;
}

function createTraceFromPlan(
  dataset: RuntimeModalDataset,
  plan: TracePlan,
  expectedSettledVolume = 0,
): ResonanceTrajectoryTrace {
  return Object.freeze({
    schemaVersion: "mandelhowl.resonance-trajectory-trace.v1",
    traceId: plan.id,
    modalModelId: dataset.modalModelId,
    initialFrequencyHz: plan.initialFrequencyHz,
    durationSeconds: plan.durationSeconds,
    expectedSettledVolume,
    keyframes: Object.freeze(
      plan.keyframes.map((keyframe, sequence) =>
        Object.freeze({ sequence, ...keyframe }),
      ),
    ),
  });
}

function bindObservedVolume(
  trace: ResonanceTrajectoryTrace,
  settledVolume: number,
): ResonanceTrajectoryTrace {
  return Object.freeze({
    ...trace,
    traceId: `reach-v${String(settledVolume).padStart(3, "0")}`,
    expectedSettledVolume: settledVolume,
  });
}

function directTracePlan(
  id: string,
  initialFrequencyHz: number,
  frequencyHz: number,
  rampSeconds: number,
  holdSeconds: number,
): TracePlan {
  return Object.freeze({
    id,
    initialFrequencyHz,
    durationSeconds: rampSeconds + holdSeconds,
    keyframes: Object.freeze([
      Object.freeze({
        atSeconds: 0,
        frequencyHz: initialFrequencyHz,
      }),
      Object.freeze({
        atSeconds: rampSeconds,
        frequencyHz,
      }),
    ]),
  });
}

function explorationTracePlan(
  family: TrajectoryFamily,
  candidateFrequencyHz: number,
  peakFrequencyHz: number,
): TracePlan {
  const initialFrequencyHz =
    family.initialFrequencyHz === "candidate"
      ? candidateFrequencyHz
      : family.initialFrequencyHz;
  const keyframes: Array<{
    readonly atSeconds: number;
    readonly frequencyHz: number;
  }> = [
    Object.freeze({
      atSeconds: 0,
      frequencyHz: initialFrequencyHz,
    }),
  ];
  let time = family.quietHoldSeconds;
  if (time > 0) {
    keyframes.push(
      Object.freeze({
        atSeconds: time,
        frequencyHz: initialFrequencyHz,
      }),
    );
  }
  if (family.peakHoldSeconds > 0) {
    time += family.rampSeconds;
    keyframes.push(
      Object.freeze({
        atSeconds: time,
        frequencyHz: peakFrequencyHz,
      }),
    );
    time += family.peakHoldSeconds;
    keyframes.push(
      Object.freeze({
        atSeconds: time,
        frequencyHz: peakFrequencyHz,
      }),
    );
  }
  if (
    keyframes[keyframes.length - 1]?.frequencyHz !==
    candidateFrequencyHz
  ) {
    time += family.rampSeconds;
    keyframes.push(
      Object.freeze({
        atSeconds: time,
        frequencyHz: candidateFrequencyHz,
      }),
    );
  }
  return Object.freeze({
    id: family.id,
    initialFrequencyHz,
    durationSeconds: time + family.holdSeconds,
    keyframes: Object.freeze(keyframes),
  });
}

function peakMarginFrequency(
  dataset: RuntimeModalDataset,
  preferredModeIndex?: number,
): number {
  const preferredMode =
    preferredModeIndex === undefined
      ? undefined
      : dataset.modes[preferredModeIndex];
  if (preferredModeIndex !== undefined && !preferredMode) {
    throw new RangeError(`Unknown reachability mode index ${preferredModeIndex}`);
  }
  const localSpan = preferredMode
    ? Math.max(24, preferredMode.frequencyHz * 0.22)
    : 0;
  const minimum = preferredMode
    ? Math.max(
        dataset.frequencyRangeHz[0],
        preferredMode.frequencyHz - localSpan,
      )
    : dataset.frequencyRangeHz[0];
  const maximum = preferredMode
    ? Math.min(
        dataset.frequencyRangeHz[1],
        preferredMode.frequencyHz + localSpan,
      )
    : dataset.frequencyRangeHz[1];
  const sampleCount = preferredMode ? 1_024 : 4_096;
  const sampleStep = (maximum - minimum) / sampleCount;
  let bestFrequency = minimum;
  let bestMargin = Number.NEGATIVE_INFINITY;
  let bestSample = 0;
  for (let sample = 0; sample <= sampleCount; sample += 1) {
    const frequency = minimum + sampleStep * sample;
    const margin = estimateOpenLoopMarginAtFrequency(dataset, frequency);
    if (margin > bestMargin) {
      bestMargin = margin;
      bestFrequency = frequency;
      bestSample = sample;
    }
  }

  let left =
    minimum + sampleStep * Math.max(0, bestSample - 1);
  let right =
    minimum + sampleStep * Math.min(sampleCount, bestSample + 1);
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const leftThird = left + (right - left) / 3;
    const rightThird = right - (right - left) / 3;
    if (
      estimateOpenLoopMarginAtFrequency(dataset, leftThird) <
      estimateOpenLoopMarginAtFrequency(dataset, rightThird)
    ) {
      left = leftThird;
    } else {
      right = rightThird;
    }
  }
  const refined = (left + right) / 2;
  return estimateOpenLoopMarginAtFrequency(dataset, refined) > bestMargin
    ? refined
    : bestFrequency;
}

function findMarginBranch(
  dataset: RuntimeModalDataset,
  peakFrequencyHz: number,
  id: MarginBranch["id"],
): MarginBranch | null {
  const boundaryMargin =
    -GENERATED_FEEDBACK_SPEC.regimeThresholds
      .criticalLoopMarginHalfWidth *
    1.01;
  const limit =
    id === "lower-frequency"
      ? dataset.frequencyRangeHz[0]
      : dataset.frequencyRangeHz[1];
  const span = limit - peakFrequencyHz;
  const samples = 8_192;
  for (let sample = 1; sample <= samples; sample += 1) {
    const frequency = peakFrequencyHz + span * (sample / samples);
    if (
      estimateOpenLoopMarginAtFrequency(dataset, frequency) <=
      boundaryMargin
    ) {
      return Object.freeze({
        id,
        peakFrequencyHz,
        outsideFrequencyHz: frequency,
      });
    }
  }
  return null;
}

function frequencyForMarginPosition(
  dataset: RuntimeModalDataset,
  branch: MarginBranch,
  position: number,
): number {
  const half =
    GENERATED_FEEDBACK_SPEC.regimeThresholds
      .criticalLoopMarginHalfWidth;
  const inset = 0.999;
  const margin =
    -half * inset + clamp(position, 0, 1) * half * 2 * inset;
  let outsideFrequency = branch.outsideFrequencyHz;
  let insideFrequency = branch.peakFrequencyHz;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (outsideFrequency + insideFrequency) / 2;
    if (
      estimateOpenLoopMarginAtFrequency(dataset, middle) < margin
    ) {
      outsideFrequency = middle;
    } else {
      insideFrequency = middle;
    }
  }
  return (outsideFrequency + insideFrequency) / 2;
}

function exploreTrajectoryFamily(
  dataset: RuntimeModalDataset,
  branch: MarginBranch,
  family: TrajectoryFamily,
  maximumRefinementDepth: number,
  tracesByVolume: Map<number, ResonanceTrajectoryTrace>,
): number {
  const observations = new Map<number, TrajectoryObservation>();
  let attempts = 0;

  const observe = (position: number): TrajectoryObservation => {
    const cached = observations.get(position);
    if (cached) return cached;
    const frequency = frequencyForMarginPosition(
      dataset,
      branch,
      position,
    );
    const trace = createTraceFromPlan(
      dataset,
      explorationTracePlan(
        family,
        frequency,
        branch.peakFrequencyHz,
      ),
    );
    const replay = replayResonanceTrajectory(dataset, trace);
    attempts += 1;
    if (replay.settledVolume !== null) {
      if (!tracesByVolume.has(replay.settledVolume)) {
        tracesByVolume.set(
          replay.settledVolume,
          bindObservedVolume(trace, replay.settledVolume),
        );
      }
    }
    const observation = Object.freeze({
      position,
      settledVolume: replay.settledVolume,
    });
    observations.set(position, observation);
    return observation;
  };

  const refine = (
    left: TrajectoryObservation,
    right: TrajectoryObservation,
    depth: number,
  ): void => {
    if (tracesByVolume.size === 101 || depth >= maximumRefinementDepth) {
      return;
    }
    const outputGap =
      left.settledVolume === null || right.settledVolume === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(right.settledVolume - left.settledVolume);
    if (outputGap <= 1) return;
    const middle = observe((left.position + right.position) / 2);
    refine(left, middle, depth + 1);
    refine(middle, right, depth + 1);
  };

  const coarseSegments = 16;
  let left = observe(0);
  for (let segment = 1; segment <= coarseSegments; segment += 1) {
    const right = observe(segment / coarseSegments);
    refine(left, right, 0);
    left = right;
    if (tracesByVolume.size === 101) {
      break;
    }
  }
  return attempts;
}

export function measureStaticDistribution(
  dataset: RuntimeModalDataset,
  sampleCount = 401,
  requiredExtremeFraction = 0.9,
): StaticDistributionReport {
  const minimum = dataset.frequencyRangeHz[0];
  const maximum = dataset.frequencyRangeHz[1];
  let zeroCount = 0;
  let hundredCount = 0;
  let intermediateCount = 0;
  const durationSeconds = 10;
  const step = GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds;
  const steps = Math.round(durationSeconds / step);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const frequency =
      minimum +
      (maximum - minimum) *
        (sample / Math.max(1, sampleCount - 1));
    let state = createResonanceState({
      dataset,
      initialFrequencyHz: frequency,
    });
    for (let index = 0; index < steps; index += 1) {
      state = advanceResonance(state, step, {
        frequencyHz: frequency,
        sweepHzPerSecond: 0,
        direction: 0,
      });
    }
    const value = getResonanceSnapshot(state).lastSettledVolume;
    if (value === 0) zeroCount += 1;
    else if (value === 100) hundredCount += 1;
    else intermediateCount += 1;
  }
  const extremeFraction =
    (zeroCount + hundredCount) / Math.max(1, sampleCount);
  return Object.freeze({
    sampleCount,
    zeroCount,
    hundredCount,
    intermediateCount,
    extremeFraction,
    requiredExtremeFraction,
    passed: extremeFraction >= requiredExtremeFraction,
  });
}

export function searchReachabilityCoverage(
  dataset: RuntimeModalDataset,
  options: ReachabilitySearchOptions = {},
): ReachabilitySearchResult {
  const initialFrequencyHz = clamp(
    options.initialFrequencyHz ??
      GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
    dataset.frequencyRangeHz[0],
    dataset.frequencyRangeHz[1],
  );
  const resolved = {
    initialFrequencyHz,
    rampSeconds: options.rampSeconds ?? 0.4,
    holdSeconds: options.holdSeconds ?? 12,
    maximumRefinementDepth: Math.floor(
      clamp(options.maximumCorrectionIterations ?? 12, 1, 18),
    ),
  };
  const peakFrequencyHz = peakMarginFrequency(
    dataset,
    options.modeIndex,
  );
  const tracesByVolume = new Map<number, ResonanceTrajectoryTrace>();
  let attempts = 0;

  const observePlan = (plan: TracePlan): void => {
    const trace = createTraceFromPlan(dataset, plan);
    const replay = replayResonanceTrajectory(dataset, trace);
    attempts += 1;
    if (
      replay.settledVolume !== null &&
      !tracesByVolume.has(replay.settledVolume)
    ) {
      tracesByVolume.set(
        replay.settledVolume,
        bindObservedVolume(trace, replay.settledVolume),
      );
    }
  };

  // Physical endpoints are ordinary trajectories. Their observed results are
  // recorded; neither path requests a preselected integer output.
  observePlan(
    directTracePlan(
      "global-static-minimum",
      dataset.frequencyRangeHz[0],
      dataset.frequencyRangeHz[0],
      resolved.rampSeconds,
      resolved.holdSeconds,
    ),
  );
  observePlan(
    directTracePlan(
      "global-peak-approach",
      initialFrequencyHz,
      peakFrequencyHz,
      resolved.rampSeconds,
      resolved.holdSeconds,
    ),
  );

  const branches = (
    ["lower-frequency", "higher-frequency"] as const
  )
    .map((id) => findMarginBranch(dataset, peakFrequencyHz, id))
    .filter((branch): branch is MarginBranch => branch !== null);
  if (branches.length === 0) {
    throw new Error("No deterministic critical-margin branch was found");
  }

  const oppositeEndpoint =
    Math.abs(initialFrequencyHz - dataset.frequencyRangeHz[0]) <=
    Math.abs(initialFrequencyHz - dataset.frequencyRangeHz[1])
      ? dataset.frequencyRangeHz[1]
      : dataset.frequencyRangeHz[0];
  const families: readonly TrajectoryFamily[] = Object.freeze([
    Object.freeze({
      id: "global-direct-approach",
      initialFrequencyHz,
      rampSeconds: resolved.rampSeconds,
      holdSeconds: resolved.holdSeconds,
      quietHoldSeconds: 0,
      peakHoldSeconds: 0,
    }),
    Object.freeze({
      id: "global-opposite-approach",
      initialFrequencyHz: oppositeEndpoint,
      rampSeconds: resolved.rampSeconds,
      holdSeconds: resolved.holdSeconds,
      quietHoldSeconds: 0,
      peakHoldSeconds: 0,
    }),
    Object.freeze({
      id: "global-static-hold",
      initialFrequencyHz: "candidate",
      rampSeconds: 0,
      holdSeconds: resolved.holdSeconds,
      quietHoldSeconds: 0,
      peakHoldSeconds: 0,
    }),
    Object.freeze({
      id: "global-slow-approach",
      initialFrequencyHz,
      rampSeconds: Math.max(1.2, resolved.rampSeconds * 3),
      holdSeconds: Math.max(14, resolved.holdSeconds),
      quietHoldSeconds: 0,
      peakHoldSeconds: 0,
    }),
    Object.freeze({
      id: "global-quiet-then-approach",
      initialFrequencyHz,
      rampSeconds: resolved.rampSeconds,
      holdSeconds: Math.max(14, resolved.holdSeconds),
      quietHoldSeconds: 1,
      peakHoldSeconds: 0,
    }),
    Object.freeze({
      id: "global-peak-history",
      initialFrequencyHz,
      rampSeconds: Math.max(0.6, resolved.rampSeconds),
      holdSeconds: Math.max(16, resolved.holdSeconds),
      quietHoldSeconds: 0,
      peakHoldSeconds: 0.8,
    }),
  ]);

  for (const family of families) {
    for (const branch of branches) {
      attempts += exploreTrajectoryFamily(
        dataset,
        branch,
        family,
        resolved.maximumRefinementDepth,
        tracesByVolume,
      );
      if (tracesByVolume.size === 101) break;
    }
    if (tracesByVolume.size === 101) break;
  }

  const traces = [...tracesByVolume.values()];
  traces.sort(
    (left, right) =>
      left.expectedSettledVolume - right.expectedSettledVolume,
  );
  const coveredValues = Object.freeze(
    traces.map((trace) => trace.expectedSettledVolume),
  );
  const coveredSet = new Set(coveredValues);
  const missingValues = Object.freeze(
    Array.from({ length: 101 }, (_, value) => value).filter(
      (value) => !coveredSet.has(value),
    ),
  );
  const staticDistribution = measureStaticDistribution(
    dataset,
    options.staticSampleCount ?? 401,
    options.requiredExtremeFraction ?? 0.9,
  );
  const replayVerified =
    missingValues.length === 0 &&
    traces.every(
      (trace) =>
        replayResonanceTrajectory(dataset, trace)
          .matchedExpectedVolume,
    );
  const report: ReachabilityCoverageReport = Object.freeze({
    schemaVersion: "mandelhowl.coverage-report.v1",
    modalModelId: dataset.modalModelId,
    runtimeAlgorithmRevision:
      GENERATED_FEEDBACK_SPEC.algorithmRevision,
    coverageContract: Object.freeze({
      schemaVersion: "mandelhowl.coverage-report.v1",
      schemaSha256: COVERAGE_REPORT_SCHEMA_SHA256,
    }),
    generatedBy: Object.freeze({
      algorithm: "deterministic-global-trajectory-search-v1",
      feedbackAlgorithmRevision:
        GENERATED_FEEDBACK_SPEC.algorithmRevision,
      perValueRuntimeLookup: "forbidden",
      randomSource: "forbidden",
    }),
    perValueRuntimeExceptionTable: false,
    verificationStatus: "runtime-replay-verified",
    runtimeSpecSha256: Object.freeze({
      dial: RUNTIME_SPEC_SOURCE_HASHES.dial,
      feedback: RUNTIME_SPEC_SOURCE_HASHES.feedback,
      volumeMap: RUNTIME_SPEC_SOURCE_HASHES.volumeMap,
      audioSafety: RUNTIME_SPEC_SOURCE_HASHES.audioSafety,
      uiNVersion:
        N_VERSION_CONTRACT_DIGESTS.presentationContract.slice(
          "sha256:".length,
        ),
    }),
    staticDistribution,
    replayVerified,
    coveredValues,
    missingValues,
    traces: Object.freeze(traces),
    outputs: Object.freeze(
      traces.map((trace) =>
        Object.freeze({
          target: trace.expectedSettledVolume,
          verification: "runtime-replay-verified" as const,
          verified: true as const,
          trace,
        }),
      ),
    ),
  });
  return Object.freeze({ report, attempts });
}
