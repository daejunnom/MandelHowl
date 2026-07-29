import {
  GENERATED_FEEDBACK_SPEC,
  GENERATED_DIAL_SPEC,
  RUNTIME_SPEC_SOURCE_HASHES,
  type ReachabilityCoverageReport,
  type ResonanceTrajectoryTrace,
  type StaticDistributionReport,
} from "../../contracts/src";
import {
  advanceResonance,
  createResonanceState,
  estimateOpenLoopMarginAtFrequency,
  getResonanceSnapshot,
  type ResonanceSnapshot,
  type RuntimeModalDataset,
} from "./resonance-engine";

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

function createTrace(
  dataset: RuntimeModalDataset,
  targetVolume: number,
  frequencyHz: number,
  options: Required<
    Pick<
      ReachabilitySearchOptions,
      "initialFrequencyHz" | "rampSeconds" | "holdSeconds"
    >
  >,
): ResonanceTrajectoryTrace {
  return Object.freeze({
    schemaVersion: "mandelhowl.resonance-trajectory-trace.v1",
    traceId: `reach-v${String(targetVolume).padStart(3, "0")}`,
    modalModelId: dataset.modalModelId,
    initialFrequencyHz: options.initialFrequencyHz,
    durationSeconds: options.rampSeconds + options.holdSeconds,
    expectedSettledVolume: targetVolume,
    keyframes: Object.freeze([
      Object.freeze({
        sequence: 0,
        atSeconds: 0,
        frequencyHz: options.initialFrequencyHz,
      }),
      Object.freeze({
        sequence: 1,
        atSeconds: options.rampSeconds,
        frequencyHz,
      }),
    ]),
  });
}

function strongestModeIndex(dataset: RuntimeModalDataset): number {
  let strongestIndex = 0;
  let strongestCoupling = Number.NEGATIVE_INFINITY;
  dataset.modes.forEach((mode, index) => {
    const coupling = mode.driveCoupling * mode.microphoneCoupling;
    if (coupling > strongestCoupling) {
      strongestCoupling = coupling;
      strongestIndex = index;
    }
  });
  return strongestIndex;
}

function frequencyForMargin(
  dataset: RuntimeModalDataset,
  modeIndex: number,
  margin: number,
): number {
  const mode = dataset.modes[modeIndex];
  const searchLimit = Math.max(
    dataset.frequencyRangeHz[0],
    mode.frequencyHz - Math.max(24, mode.frequencyHz * 0.22),
  );
  let high = mode.frequencyHz;
  let low = high;
  const searchSteps = 256;
  for (let step = 1; step <= searchSteps; step += 1) {
    const candidate =
      mode.frequencyHz -
      (mode.frequencyHz - searchLimit) * (step / searchSteps);
    if (
      estimateOpenLoopMarginAtFrequency(dataset, candidate) <
      margin
    ) {
      low = candidate;
      break;
    }
  }
  if (
    low === high ||
    estimateOpenLoopMarginAtFrequency(dataset, high) <= margin
  ) {
    throw new Error(`Mode ${mode.id} does not bracket loop margin ${margin}`);
  }
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (low + high) / 2;
    if (
      estimateOpenLoopMarginAtFrequency(dataset, middle) < margin
    ) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

function desiredMarginForVolume(volume: number): number {
  const half =
    GENERATED_FEEDBACK_SPEC.regimeThresholds
      .criticalLoopMarginHalfWidth;
  const normalized = clamp((volume - 1) / 98, 0, 1);
  const lowerEndpointWeight = clamp(1 - normalized * 98, 0, 1);
  const upperEndpointWeight = clamp(
    1 - (1 - normalized) * 98,
    0,
    1,
  );
  const endpointInsetNormalized =
    normalized +
    lowerEndpointWeight * 0.0025 -
    upperEndpointWeight * 0.0025;
  return clamp(
    -half + endpointInsetNormalized * half * 2,
    -half * 0.998,
    half * 0.998,
  );
}

function findTraceForVolume(
  dataset: RuntimeModalDataset,
  targetVolume: number,
  modeIndex: number,
  options: Required<
    Pick<
      ReachabilitySearchOptions,
      | "initialFrequencyHz"
      | "rampSeconds"
      | "holdSeconds"
      | "maximumCorrectionIterations"
    >
  >,
): { readonly trace: ResonanceTrajectoryTrace | null; readonly attempts: number } {
  const half =
    GENERATED_FEEDBACK_SPEC.regimeThresholds
      .criticalLoopMarginHalfWidth;
  let margin = desiredMarginForVolume(targetVolume);
  let attempts = 0;
  let best:
    | {
        readonly difference: number;
        readonly trace: ResonanceTrajectoryTrace;
        readonly actual: number;
      }
    | undefined;

  for (
    let iteration = 0;
    iteration < options.maximumCorrectionIterations;
    iteration += 1
  ) {
    const frequency = frequencyForMargin(
      dataset,
      modeIndex,
      margin,
    );
    const trace = createTrace(dataset, targetVolume, frequency, options);
    const replay = replayResonanceTrajectory(dataset, trace);
    attempts += 1;
    if (replay.settledVolume === targetVolume) return { trace, attempts };
    if (replay.settledVolume !== null) {
      const difference = Math.abs(replay.settledVolume - targetVolume);
      if (!best || difference < best.difference) {
        best = { difference, trace, actual: replay.settledVolume };
      }
      margin = clamp(
        margin +
          ((targetVolume - replay.settledVolume) / 98) *
            half *
            2 *
            0.9,
        -half * 0.998,
        half * 0.998,
      );
    }
  }

  let lowMargin = -half * 0.999;
  let highMargin = half * 0.999;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const marginCandidate = (lowMargin + highMargin) / 2;
    const frequency = frequencyForMargin(
      dataset,
      modeIndex,
      marginCandidate,
    );
    const trace = createTrace(dataset, targetVolume, frequency, options);
    const replay = replayResonanceTrajectory(dataset, trace);
    attempts += 1;
    if (replay.settledVolume === targetVolume) return { trace, attempts };
    if (replay.settledVolume === null) continue;
    const difference = Math.abs(replay.settledVolume - targetVolume);
    if (!best || difference < best.difference) {
      best = { difference, trace, actual: replay.settledVolume };
    }
    if (replay.settledVolume < targetVolume) {
      lowMargin = marginCandidate;
    } else {
      highMargin = marginCandidate;
    }
  }
  return { trace: null, attempts };
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
  const resolved = {
    initialFrequencyHz:
      options.initialFrequencyHz ??
      GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
    rampSeconds: options.rampSeconds ?? 0.4,
    holdSeconds: options.holdSeconds ?? 12,
    maximumCorrectionIterations:
      options.maximumCorrectionIterations ?? 8,
  };
  const modeIndex =
    options.modeIndex ?? strongestModeIndex(dataset);
  const traces: ResonanceTrajectoryTrace[] = [];
  let attempts = 0;

  const zeroTrace = createTrace(
    dataset,
    0,
    dataset.frequencyRangeHz[0],
    resolved,
  );
  const hundredTrace = createTrace(
    dataset,
    100,
    dataset.modes[modeIndex].frequencyHz,
    resolved,
  );
  for (const trace of [zeroTrace, hundredTrace]) {
    attempts += 1;
    if (replayResonanceTrajectory(dataset, trace).matchedExpectedVolume) {
      traces.push(trace);
    }
  }
  for (let target = 1; target <= 99; target += 1) {
    const found = findTraceForVolume(
      dataset,
      target,
      modeIndex,
      resolved,
    );
    attempts += found.attempts;
    if (found.trace) traces.push(found.trace);
  }
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
    generatedBy: Object.freeze({
      algorithm: "deterministic-global-trajectory-search-v1",
      perValueRuntimeLookup: "forbidden",
      randomSource: "forbidden",
    }),
    perValueRuntimeExceptionTable: false,
    verificationStatus: "runtime-replay-verified",
    runtimeSpecSha256: Object.freeze({
      dial: RUNTIME_SPEC_SOURCE_HASHES.dial,
      feedback: RUNTIME_SPEC_SOURCE_HASHES.feedback,
      volumeMap: RUNTIME_SPEC_SOURCE_HASHES.volumeMap,
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
