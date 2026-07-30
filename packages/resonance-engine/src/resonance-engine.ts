import {
  GENERATED_DIAL_SPEC,
  GENERATED_FEEDBACK_SPEC,
  GENERATED_VOLUME_MAP_SPEC,
  fromCentiHertz,
  toCentiHertz,
  type ContentAddressedId,
  type DiagnosticRecord,
  type FrequencyResponseTable,
  type ResonanceDataset,
} from "../../contracts/src";
import {
  PROTOTYPE_MODAL_DATASET,
  type PrototypeModalDataset,
  type PrototypeModeRecord,
} from "./prototype-dataset";

const TAU = Math.PI * 2;
export const RUNTIME_FEEDBACK_ALGORITHM_REVISION =
  "fixed-step-modal-feedback-v4" as const;

function assertSupportedFeedbackAlgorithmRevision(
  revision: string,
): asserts revision is typeof RUNTIME_FEEDBACK_ALGORITHM_REVISION {
  if (revision !== RUNTIME_FEEDBACK_ALGORITHM_REVISION) {
    throw new Error(
      `Unsupported feedback algorithm revision: ${revision}`,
    );
  }
}

assertSupportedFeedbackAlgorithmRevision(
  GENERATED_FEEDBACK_SPEC.algorithmRevision,
);

const FIXED_STEP_SECONDS =
  GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds;
const MAX_ADVANCE_SECONDS =
  GENERATED_FEEDBACK_SPEC.simulation.maximumCatchUpSeconds;
const MAXIMUM_STEPS_PER_FRAME =
  GENERATED_FEEDBACK_SPEC.simulation.maximumStepsPerFrame;
const PAUSED_GAP_RESET_SECONDS =
  GENERATED_FEEDBACK_SPEC.simulation.pausedGapResetSeconds;
const CRITICAL_LOOP_MARGIN_HALF_WIDTH =
  GENERATED_FEEDBACK_SPEC.regimeThresholds.criticalLoopMarginHalfWidth;
const MAXIMUM_ACTIVE_MODES = Math.max(
  1,
  Math.floor(
    GENERATED_FEEDBACK_SPEC.modalSelection.maximumActiveModes,
  ),
);
const ACTIVATION_BANDWIDTH_RATIO =
  GENERATED_FEEDBACK_SPEC.modalSelection.activationBandwidthRatio;
const RESIDUAL_ENERGY_THRESHOLD =
  GENERATED_FEEDBACK_SPEC.modalSelection.residualEnergyThreshold;
const CALIBRATION = GENERATED_FEEDBACK_SPEC.calibration;
const MEASUREMENT_TOTAL_SECONDS =
  GENERATED_VOLUME_MAP_SPEC.measurement.minimumObservationSeconds +
  GENERATED_VOLUME_MAP_SPEC.measurement.stabilityWindowSeconds +
  GENERATED_VOLUME_MAP_SPEC.measurement.confirmationHoldSeconds;
const RECENT_SAMPLE_COUNT = 128;

export type ResonanceRegime =
  | "decaying"
  | "critical"
  | "growing"
  | "saturated";

export interface RuntimeModalMode {
  readonly id: string;
  readonly frequencyHz: number;
  readonly dampingRatio: number;
  readonly driveCoupling: number;
  readonly microphoneCoupling: number;
  readonly phaseOffsetRadians: number;
  readonly radiationEfficiency: number;
  readonly textureLayer: number;
  readonly radialOrder?: number;
  readonly angularOrder?: number;
}

export interface RuntimeModalDataset {
  readonly datasetId: ContentAddressedId;
  readonly modalModelId: ContentAddressedId;
  readonly frequencyRangeHz: readonly [number, number];
  /** Dataset-global transfer normalization; never frequency/value specific. */
  readonly maximumModalCoupling: number;
  readonly modes: readonly RuntimeModalMode[];
  /**
   * Optional baked aggregate plate-to-microphone transfer response.
   *
   * `mandelhowl-response-v1` contains the complex sum across every mode. It is
   * retained for response-curve consumers and deterministic interpolation, but
   * it cannot replace the per-mode weights used by the modal state integrator.
   */
  readonly response?: FrequencyResponseTable;
}

export interface InterpolatedFrequencyResponse {
  readonly frequencyHz: number;
  readonly real: number;
  readonly imaginary: number;
  readonly magnitude: number;
  readonly phaseRadians: number;
  readonly lowerSampleIndex: number;
  readonly upperSampleIndex: number;
}

export interface ResonanceDrive {
  readonly frequencyHz: number;
  readonly sweepHzPerSecond?: number;
  readonly direction?: -1 | 0 | 1;
}

/**
 * Internal fixed-step state. Ring buffers are allocated once and reused; the
 * exported snapshots are immutable copies and consumers never receive these
 * writable arrays.
 */
export interface ResonanceState {
  schemaVersion: "mandelhowl.resonance-state.v1";
  dataset: RuntimeModalDataset;
  simulationTimeSeconds: number;
  simulationStep: number;
  sequence: number;
  accumulatorSeconds: number;
  pausedGapCount: number;
  /** Canonical drive frequency stored as an integer centihertz. */
  driveFrequencyCentiHz: number;
  previousDriveFrequencyCentiHz: number;
  sweepHzPerSecond: number;
  approachDirection: -1 | 0 | 1;
  drivePhaseRadians: number;
  modeEnergy: Float64Array;
  modePhaseRadians: Float64Array;
  /** Preallocated modal-selection scratch; never exposed to consumers. */
  modeResponseScratch: Float64Array;
  modeDriveScoreScratch: Float64Array;
  modeLoopScoreScratch: Float64Array;
  /** Stable frequency ordering and hot-path active/residual update buffers. */
  frequencySortedModeIndices: Int32Array;
  modeUpdateIndices: Int32Array;
  modeUpdateMarks: Uint32Array;
  modeUpdateMarkGeneration: number;
  modeUpdateCount: number;
  nonzeroModeIndices: Int32Array;
  nextNonzeroModeIndices: Int32Array;
  nonzeroModeCount: number;
  activeModeIndices: Int32Array;
  activeModePriorityScratch: Float64Array;
  activeModeCount: number;
  loopEnergyEnvelope: number;
  feedbackEnvelope: number;
  feedbackLoopSignal: number;
  gateGain: number;
  gateOpen: boolean;
  limiterGain: number;
  limiterHoldSeconds: number;
  limiterGainReductionDb: number;
  limiterActive: boolean;
  delayBuffer: Float64Array;
  delayWriteIndex: number;
  microphoneRms: number;
  microphonePeak: number;
  recentMicrophoneSamples: Float64Array;
  recentSampleWriteIndex: number;
  recentSampleCount: number;
  rmsWindow: Float64Array;
  rmsWindowWriteIndex: number;
  rmsWindowCount: number;
  rmsWindowSumSquares: number;
  previousMeasuredRms: number;
  regime: ResonanceRegime;
  activeModeIndex: number | null;
  instantaneousVolume: number;
  settledVolume: number;
  lastSettledVolume: number | null;
  measurementElapsedSeconds: number;
  measurementObservationSeconds: number;
  measurementStabilitySeconds: number;
  measurementConfirmationSeconds: number;
  diagnostics: readonly DiagnosticRecord[];
}

export interface ResonanceSnapshot {
  readonly schemaVersion: "mandelhowl.runtime-resonance-snapshot.v1";
  readonly datasetId: ContentAddressedId;
  readonly simulationTimeSeconds: number;
  readonly simulationStep: number;
  readonly frequencyCentiHz: number;
  readonly frequencyHz: number;
  readonly sweepHzPerSecond: number;
  readonly modeEnergy: readonly number[];
  readonly modePhaseRadians: readonly number[];
  readonly feedbackEnvelope: number;
  readonly feedbackLoopSignal: number;
  readonly limiterGainReductionDb: number;
  readonly limiterActive: boolean;
  readonly microphoneRms: number;
  readonly microphonePeak: number;
  readonly recentMicrophoneSamples: readonly number[];
  readonly regime: ResonanceRegime;
  readonly activeModeIndex: number | null;
  /** Last confirmed value while measuring; never a transient placeholder. */
  readonly volume: number;
  readonly lastSettledVolume: number | null;
  readonly measurementProgress: number;
  readonly settled: boolean;
  readonly diagnostics: readonly DiagnosticRecord[];
}

export interface CreateResonanceOptions {
  readonly dataset?:
    | RuntimeModalDataset
    | PrototypeModalDataset
    | ResonanceDataset;
  readonly initialFrequencyHz?: number;
  readonly diagnostics?: readonly DiagnosticRecord[];
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finiteOr(value, minimum)));
}

function sign(value: number, deadBand = 1e-6): -1 | 0 | 1 {
  if (value > deadBand) return 1;
  if (value < -deadBand) return -1;
  return 0;
}

function wrapPhase(value: number): number {
  const wrapped = value % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function exponentialFollow(
  current: number,
  target: number,
  timeSeconds: number,
  deltaSeconds: number,
): number {
  if (timeSeconds <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-deltaSeconds / timeSeconds));
}

function normalizedTanh(value: number, drive: number): number {
  const safeDrive = Math.max(Number.EPSILON, drive);
  return Math.tanh(value * safeDrive) / Math.tanh(safeDrive);
}

function isDecodedDataset(
  dataset: RuntimeModalDataset | PrototypeModalDataset | ResonanceDataset,
): dataset is ResonanceDataset {
  return "manifest" in dataset && "response" in dataset;
}

function normalizeResponseTable(
  response: FrequencyResponseTable,
  frequencyRangeHz: readonly [number, number],
): FrequencyResponseTable {
  const { sampleCount } = response;
  if (
    !Number.isInteger(sampleCount) ||
    sampleCount < 2 ||
    response.frequenciesHz.length !== sampleCount ||
    response.real.length !== sampleCount ||
    response.imaginary.length !== sampleCount
  ) {
    throw new TypeError("Runtime response table dimensions are invalid");
  }
  const frequenciesHz: number[] = [];
  const real: number[] = [];
  const imaginary: number[] = [];
  let previousFrequency = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const frequency = response.frequenciesHz[index];
    const realValue = response.real[index];
    const imaginaryValue = response.imaginary[index];
    if (
      !Number.isFinite(frequency) ||
      !Number.isFinite(realValue) ||
      !Number.isFinite(imaginaryValue) ||
      frequency <= 0 ||
      frequency <= previousFrequency
    ) {
      throw new TypeError(
        `Runtime response sample ${index} violates ordering or bounds`,
      );
    }
    previousFrequency = frequency;
    frequenciesHz.push(frequency);
    real.push(realValue);
    imaginary.push(imaginaryValue);
  }
  if (
    frequenciesHz[0] > frequencyRangeHz[0] ||
    frequenciesHz[sampleCount - 1] < frequencyRangeHz[1]
  ) {
    throw new RangeError(
      "Runtime response table does not cover the dataset frequency range",
    );
  }
  return Object.freeze({
    sampleCount,
    frequenciesHz: Object.freeze(frequenciesHz),
    real: Object.freeze(real),
    imaginary: Object.freeze(imaginary),
  });
}

/**
 * Samples the baked aggregate complex transfer curve in logarithmic-frequency
 * space. Out-of-range finite inputs clamp to the verified response endpoints.
 *
 * This is intentionally not used as a per-mode excitation score:
 * response-v1 stores only the sum across modes, so that substitution would
 * discard mode identity and invalidate the calibrated modal trajectories.
 */
export function interpolateBakedFrequencyResponse(
  dataset: Pick<RuntimeModalDataset, "response">,
  frequencyHz: number,
): InterpolatedFrequencyResponse | null {
  const response = dataset.response;
  if (!response) return null;
  if (!Number.isFinite(frequencyHz)) {
    throw new TypeError("Response sample frequency must be finite");
  }
  const lastIndex = response.sampleCount - 1;
  const minimumFrequency = response.frequenciesHz[0];
  const maximumFrequency = response.frequenciesHz[lastIndex];
  const frequency = Math.min(
    maximumFrequency,
    Math.max(minimumFrequency, frequencyHz),
  );

  let lowerIndex = 0;
  let upperIndex = lastIndex;
  if (frequency <= minimumFrequency) {
    upperIndex = 0;
  } else if (frequency >= maximumFrequency) {
    lowerIndex = lastIndex;
  } else {
    while (upperIndex - lowerIndex > 1) {
      const middleIndex = (lowerIndex + upperIndex) >>> 1;
      if (response.frequenciesHz[middleIndex] <= frequency) {
        lowerIndex = middleIndex;
      } else {
        upperIndex = middleIndex;
      }
    }
    if (response.frequenciesHz[lowerIndex] === frequency) {
      upperIndex = lowerIndex;
    } else if (response.frequenciesHz[upperIndex] === frequency) {
      lowerIndex = upperIndex;
    }
  }

  const lowerFrequency = response.frequenciesHz[lowerIndex];
  const upperFrequency = response.frequenciesHz[upperIndex];
  const progress =
    lowerIndex === upperIndex
      ? 0
      : (Math.log(frequency) - Math.log(lowerFrequency)) /
        (Math.log(upperFrequency) - Math.log(lowerFrequency));
  const real =
    response.real[lowerIndex] +
    (response.real[upperIndex] - response.real[lowerIndex]) * progress;
  const imaginary =
    response.imaginary[lowerIndex] +
    (response.imaginary[upperIndex] -
      response.imaginary[lowerIndex]) *
      progress;
  return Object.freeze({
    frequencyHz: frequency,
    real,
    imaginary,
    magnitude: Math.hypot(real, imaginary),
    phaseRadians: Math.atan2(imaginary, real),
    lowerSampleIndex: lowerIndex,
    upperSampleIndex: upperIndex,
  });
}

export function runtimeModalDatasetFromResonanceDataset(
  dataset: ResonanceDataset,
): RuntimeModalDataset {
  const maximumModalCoupling = Math.max(
    Number.EPSILON,
    ...dataset.modes.map((mode) =>
      Math.abs(mode.actuatorCoupling * mode.microphoneCoupling),
    ),
  );
  return Object.freeze({
    datasetId: dataset.manifest.datasetId,
    modalModelId: `sha256:${dataset.manifest.files.modes.sha256}`,
    frequencyRangeHz: Object.freeze([
      dataset.manifest.frequencyRange.minimumHz,
      dataset.manifest.frequencyRange.maximumHz,
    ] as const),
    maximumModalCoupling,
    response: normalizeResponseTable(dataset.response, [
      dataset.manifest.frequencyRange.minimumHz,
      dataset.manifest.frequencyRange.maximumHz,
    ]),
    modes: Object.freeze(
      dataset.modes.map((mode) =>
        Object.freeze({
          id: mode.modeId,
          frequencyHz: mode.naturalFrequencyHz,
          dampingRatio: mode.dampingRatio,
          driveCoupling: Math.abs(mode.actuatorCoupling),
          microphoneCoupling: Math.abs(mode.microphoneCoupling),
          phaseOffsetRadians: wrapPhase(
            mode.phaseReferenceRad +
              (mode.actuatorCoupling * mode.microphoneCoupling < 0
                ? Math.PI
                : 0),
          ),
          radiationEfficiency: mode.radiationEfficiency,
          textureLayer: mode.textureLayer,
        }),
      ),
    ),
  });
}

function normalizeDataset(
  dataset:
    | RuntimeModalDataset
    | PrototypeModalDataset
    | ResonanceDataset,
): RuntimeModalDataset {
  if (isDecodedDataset(dataset)) {
    return runtimeModalDatasetFromResonanceDataset(dataset);
  }
  const maximumModalCoupling = Math.max(
    Number.EPSILON,
    ...dataset.modes.map((mode) =>
      Math.abs(mode.driveCoupling * mode.microphoneCoupling),
    ),
  );
  const frequencyRangeHz = Object.freeze([
    ...dataset.frequencyRangeHz,
  ] as [number, number]);
  return Object.freeze({
    datasetId: dataset.datasetId,
    modalModelId:
      "modalModelId" in dataset
        ? dataset.modalModelId
        : dataset.datasetId,
    frequencyRangeHz,
    maximumModalCoupling:
      "maximumModalCoupling" in dataset
        ? dataset.maximumModalCoupling
        : maximumModalCoupling,
    ...("response" in dataset && dataset.response
      ? {
          response: normalizeResponseTable(
            dataset.response,
            frequencyRangeHz,
          ),
        }
      : {}),
    modes: Object.freeze(
      dataset.modes.map((mode: RuntimeModalMode | PrototypeModeRecord, index) =>
        Object.freeze({
          id: mode.id,
          frequencyHz: mode.frequencyHz,
          dampingRatio: mode.dampingRatio,
          driveCoupling: mode.driveCoupling,
          microphoneCoupling: mode.microphoneCoupling,
          phaseOffsetRadians: mode.phaseOffsetRadians,
          radiationEfficiency:
            "radiationEfficiency" in mode ? mode.radiationEfficiency : 1,
          textureLayer: "textureLayer" in mode ? mode.textureLayer : index,
          ...("radialOrder" in mode ? { radialOrder: mode.radialOrder } : {}),
          ...("angularOrder" in mode
            ? { angularOrder: mode.angularOrder }
            : {}),
        }),
      ),
    ),
  });
}

function responseAtFrequency(
  frequencyHz: number,
  modeFrequencyHz: number,
  dampingRatio: number,
): number {
  const bandwidthHz = Math.max(
    CALIBRATION.modalResponse.minimumBandwidthHz,
    modeFrequencyHz *
      (dampingRatio *
        CALIBRATION.modalResponse.dampingBandwidthMultiplier +
        CALIBRATION.modalResponse.relativeBandwidthFloor),
  );
  const normalizedDetuning = (frequencyHz - modeFrequencyHz) / bandwidthHz;
  return 1 / (1 + normalizedDetuning * normalizedDetuning);
}

function modeIsInsideActivationBandwidth(
  frequencyHz: number,
  modeFrequencyHz: number,
): boolean {
  return (
    Math.abs(frequencyHz - modeFrequencyHz) /
      Math.max(Number.EPSILON, modeFrequencyHz) <=
    ACTIVATION_BANDWIDTH_RATIO
  );
}

function feedbackPhaseAlignment(
  frequencyHz: number,
  modePhaseOffsetRadians: number,
): number {
  const loopPhase =
    -TAU * frequencyHz * GENERATED_FEEDBACK_SPEC.loop.delaySeconds +
    GENERATED_FEEDBACK_SPEC.loop.phaseOffsetRad +
    modePhaseOffsetRadians;
  // The actuator basis is sign-normalized before packaging, so the encoded
  // actuator × microphone sign is the physical return polarity rather than
  // an arbitrary eigenvector sign. Only a positive real loop component can
  // contribute to self-excited growth; anti-aligned return remains damping.
  return Math.max(
    0,
    Math.cos(loopPhase) * GENERATED_FEEDBACK_SPEC.loop.polarity,
  );
}

export function estimateOpenLoopMarginAtFrequency(
  dataset: RuntimeModalDataset,
  frequencyHz: number,
  direction: -1 | 0 | 1 = 0,
  residualEnvelope = 0,
): number {
  const frequency = clamp(
    frequencyHz,
    dataset.frequencyRangeHz[0],
    dataset.frequencyRangeHz[1],
  );
  const filterMagnitude = bandPassMagnitude(frequency);
  let previousScore = Number.POSITIVE_INFINITY;
  let previousIndex = -1;
  let strongestScore = 0;
  let responseSum = 0;
  const maximumSelected = Math.min(
    MAXIMUM_ACTIVE_MODES,
    dataset.modes.length,
  );
  for (let rank = 0; rank < maximumSelected; rank += 1) {
    let selectedIndex = -1;
    let selectedScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < dataset.modes.length; index += 1) {
      const mode = dataset.modes[index];
      if (
        !modeIsInsideActivationBandwidth(
          frequency,
          mode.frequencyHz,
        )
      ) {
        continue;
      }
      const response = responseAtFrequency(
        frequency,
        mode.frequencyHz,
        mode.dampingRatio,
      );
      const directionalPhase =
        direction === 0
          ? 1
          : 1 +
            direction *
              Math.sin(mode.phaseOffsetRadians) *
              CALIBRATION.modalResponse.directionalPhaseScale;
      const driveScore =
        response *
        Math.abs(mode.driveCoupling * mode.microphoneCoupling) /
        dataset.maximumModalCoupling *
        directionalPhase;
      const score =
        driveScore *
        filterMagnitude *
        feedbackPhaseAlignment(
          frequency,
          mode.phaseOffsetRadians,
        );
      const followsPrevious =
        score < previousScore ||
        (score === previousScore && index > previousIndex);
      if (
        followsPrevious &&
        (score > selectedScore ||
          (score === selectedScore && index < selectedIndex))
      ) {
        selectedIndex = index;
        selectedScore = score;
      }
    }
    if (selectedIndex < 0 || selectedScore <= 0) break;
    if (rank === 0) strongestScore = selectedScore;
    responseSum += selectedScore;
    previousScore = selectedScore;
    previousIndex = selectedIndex;
  }
  const adjacentResponse = clamp(responseSum - strongestScore, 0, 1);
  const historyBoost =
    CALIBRATION.loopMargin.residualHistoryGainMaximum *
    clamp(
      (residualEnvelope -
        CALIBRATION.loopMargin.residualHistoryStartEnvelope) /
        CALIBRATION.loopMargin.residualHistorySpanEnvelope,
      0,
      1,
    );
  return (
    strongestScore * GENERATED_FEEDBACK_SPEC.loop.gainLinear +
    adjacentResponse * CALIBRATION.loopMargin.adjacentModeGainLinear +
    historyBoost -
    1
  );
}

function bandPassMagnitude(frequencyHz: number): number {
  const filter = GENERATED_FEEDBACK_SPEC.loop.filter;
  const frequency = Math.max(Number.EPSILON, finiteOr(frequencyHz, 0));
  const q = Math.max(Number.EPSILON, filter.q);
  const highRatio = frequency / filter.highPassHz;
  const highPass =
    (highRatio * highRatio) /
    Math.sqrt(
      Math.pow(1 - highRatio * highRatio, 2) +
        Math.pow(highRatio / q, 2),
    );
  const lowRatio = frequency / filter.lowPassHz;
  const lowPass =
    1 /
    Math.sqrt(
      Math.pow(1 - lowRatio * lowRatio, 2) +
        Math.pow(lowRatio / q, 2),
    );
  return clamp(highPass * lowPass, 0, 1);
}

export function volumeFromVirtualRms(rms: number): number {
  const mapping = GENERATED_VOLUME_MAP_SPEC.mapping;
  const safeRms = Math.max(0, finiteOr(rms, 0));
  if (safeRms <= mapping.noiseFloorRms) return mapping.belowNoiseFloor;
  if (safeRms >= mapping.saturationRms) return mapping.atOrAboveSaturation;
  const numerator = 20 * Math.log10(safeRms / mapping.noiseFloorRms);
  const denominator =
    20 *
    Math.log10(mapping.saturationRms / mapping.noiseFloorRms);
  return Math.round(1 + 98 * clamp(numerator / denominator, 0, 1));
}

export function classifyResonanceRegime(
  loopMargin: number,
  envelope: number,
  limiterGainReductionDb = 0,
  envelopeSlopePerSecond = 0,
): ResonanceRegime {
  const thresholds = GENERATED_FEEDBACK_SPEC.regimeThresholds;
  if (
    envelope >= thresholds.saturatedMinimumEnvelope &&
    (limiterGainReductionDb >= thresholds.saturatedMinimumGainReductionDb ||
      envelope >= thresholds.saturatedUnconditionalEnvelope)
  ) {
    return "saturated";
  }
  if (loopMargin > thresholds.criticalLoopMarginHalfWidth) {
    return envelopeSlopePerSecond >=
      thresholds.growingMinimumSlopePerSecond ||
      envelope > thresholds.decayingMaximumEnvelope
      ? "growing"
      : "decaying";
  }
  if (loopMargin >= -thresholds.criticalLoopMarginHalfWidth) {
    return "critical";
  }
  return "decaying";
}

export function createResonanceState(
  options: CreateResonanceOptions = {},
): ResonanceState {
  const dataset = normalizeDataset(
    options.dataset ?? PROTOTYPE_MODAL_DATASET,
  );
  const [minimumFrequency, maximumFrequency] = dataset.frequencyRangeHz;
  const frequencyCentiHz = toCentiHertz(clamp(
    finiteOr(options.initialFrequencyHz, 220),
    minimumFrequency,
    maximumFrequency,
  ));
  const delaySamples = Math.max(
    1,
    Math.round(
      GENERATED_FEEDBACK_SPEC.loop.delaySeconds / FIXED_STEP_SECONDS,
    ),
  );
  const rmsSamples = Math.max(
    1,
    Math.round(
      GENERATED_VOLUME_MAP_SPEC.measurement.rmsWindowSeconds /
      FIXED_STEP_SECONDS,
    ),
  );
  const frequencySortedModeIndices = Int32Array.from(
    Array.from(
      { length: dataset.modes.length },
      (_, modeIndex) => modeIndex,
    ).sort((leftIndex, rightIndex) => {
      const frequencyDifference =
        dataset.modes[leftIndex].frequencyHz -
        dataset.modes[rightIndex].frequencyHz;
      return frequencyDifference === 0
        ? leftIndex - rightIndex
        : frequencyDifference;
    }),
  );

  return {
    schemaVersion: "mandelhowl.resonance-state.v1",
    dataset,
    simulationTimeSeconds: 0,
    simulationStep: 0,
    sequence: 0,
    accumulatorSeconds: 0,
    pausedGapCount: 0,
    driveFrequencyCentiHz: frequencyCentiHz,
    previousDriveFrequencyCentiHz: frequencyCentiHz,
    sweepHzPerSecond: 0,
    approachDirection: 0,
    drivePhaseRadians: 0,
    modeEnergy: new Float64Array(dataset.modes.length),
    modePhaseRadians: Float64Array.from(
      dataset.modes,
      (mode) => mode.phaseOffsetRadians,
    ),
    modeResponseScratch: new Float64Array(dataset.modes.length),
    modeDriveScoreScratch: new Float64Array(dataset.modes.length),
    modeLoopScoreScratch: new Float64Array(dataset.modes.length),
    frequencySortedModeIndices,
    modeUpdateIndices: new Int32Array(dataset.modes.length),
    modeUpdateMarks: new Uint32Array(dataset.modes.length),
    modeUpdateMarkGeneration: 0,
    modeUpdateCount: 0,
    nonzeroModeIndices: new Int32Array(dataset.modes.length),
    nextNonzeroModeIndices: new Int32Array(dataset.modes.length),
    nonzeroModeCount: 0,
    activeModeIndices: new Int32Array(
      Math.min(MAXIMUM_ACTIVE_MODES, dataset.modes.length),
    ),
    activeModePriorityScratch: new Float64Array(
      Math.min(MAXIMUM_ACTIVE_MODES, dataset.modes.length),
    ),
    activeModeCount: 0,
    loopEnergyEnvelope: 0,
    feedbackEnvelope: 0,
    feedbackLoopSignal: 0,
    gateGain: 0,
    gateOpen: false,
    limiterGain: 1,
    limiterHoldSeconds: 0,
    limiterGainReductionDb: 0,
    limiterActive: false,
    delayBuffer: new Float64Array(delaySamples),
    delayWriteIndex: 0,
    microphoneRms: 0,
    microphonePeak: 0,
    recentMicrophoneSamples: new Float64Array(RECENT_SAMPLE_COUNT),
    recentSampleWriteIndex: 0,
    recentSampleCount: 0,
    rmsWindow: new Float64Array(rmsSamples),
    rmsWindowWriteIndex: 0,
    rmsWindowCount: 0,
    rmsWindowSumSquares: 0,
    previousMeasuredRms: 0,
    regime: "decaying",
    activeModeIndex: null,
    instantaneousVolume: 0,
    settledVolume: 0,
    lastSettledVolume: null,
    measurementElapsedSeconds: 0,
    measurementObservationSeconds: 0,
    measurementStabilitySeconds: 0,
    measurementConfirmationSeconds: 0,
    diagnostics: Object.freeze([...(options.diagnostics ?? [])]),
  };
}

function resetMeasurement(state: ResonanceState): void {
  state.measurementElapsedSeconds = 0;
  state.measurementObservationSeconds = 0;
  state.measurementStabilitySeconds = 0;
  state.measurementConfirmationSeconds = 0;
}

function pushMeasurementSample(
  state: ResonanceState,
  rmsLevel: number,
  waveformSample: number,
): number {
  const previous = state.rmsWindow[state.rmsWindowWriteIndex] ?? 0;
  state.rmsWindowSumSquares = Math.max(
    0,
    state.rmsWindowSumSquares - previous * previous + rmsLevel * rmsLevel,
  );
  state.rmsWindow[state.rmsWindowWriteIndex] = rmsLevel;
  state.rmsWindowWriteIndex =
    (state.rmsWindowWriteIndex + 1) % state.rmsWindow.length;
  state.rmsWindowCount = Math.min(
    state.rmsWindow.length,
    state.rmsWindowCount + 1,
  );

  state.recentMicrophoneSamples[state.recentSampleWriteIndex] = waveformSample;
  state.recentSampleWriteIndex =
    (state.recentSampleWriteIndex + 1) %
    state.recentMicrophoneSamples.length;
  state.recentSampleCount = Math.min(
    state.recentMicrophoneSamples.length,
    state.recentSampleCount + 1,
  );
  return Math.sqrt(
    state.rmsWindowSumSquares / Math.max(1, state.rmsWindowCount),
  );
}

function lowerBoundModeFrequency(
  state: ResonanceState,
  frequencyHz: number,
): number {
  let lower = 0;
  let upper = state.frequencySortedModeIndices.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const modeIndex =
      state.frequencySortedModeIndices[middle] ?? -1;
    const modeFrequency =
      state.dataset.modes[modeIndex]?.frequencyHz ??
      Number.POSITIVE_INFINITY;
    if (modeFrequency < frequencyHz) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

function upperBoundModeFrequency(
  state: ResonanceState,
  frequencyHz: number,
): number {
  let lower = 0;
  let upper = state.frequencySortedModeIndices.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const modeIndex =
      state.frequencySortedModeIndices[middle] ?? -1;
    const modeFrequency =
      state.dataset.modes[modeIndex]?.frequencyHz ??
      Number.POSITIVE_INFINITY;
    if (modeFrequency <= frequencyHz) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

function addModeUpdateIndex(
  state: ResonanceState,
  modeIndex: number,
): void {
  if (
    modeIndex < 0 ||
    modeIndex >= state.dataset.modes.length ||
    state.modeUpdateMarks[modeIndex] ===
      state.modeUpdateMarkGeneration
  ) {
    return;
  }
  state.modeUpdateMarks[modeIndex] =
    state.modeUpdateMarkGeneration;
  state.modeUpdateIndices[state.modeUpdateCount] = modeIndex;
  state.modeUpdateCount += 1;
}

function collectModeUpdateIndices(
  state: ResonanceState,
  frequencyHz: number,
): void {
  state.modeUpdateMarkGeneration =
    (state.modeUpdateMarkGeneration + 1) >>> 0;
  if (state.modeUpdateMarkGeneration === 0) {
    state.modeUpdateMarks.fill(0);
    state.modeUpdateMarkGeneration = 1;
  }
  state.modeUpdateCount = 0;

  const ratio = ACTIVATION_BANDWIDTH_RATIO;
  if (ratio >= 1) {
    for (
      let sortedPosition = 0;
      sortedPosition < state.frequencySortedModeIndices.length;
      sortedPosition += 1
    ) {
      addModeUpdateIndex(
        state,
        state.frequencySortedModeIndices[sortedPosition] ?? -1,
      );
    }
  } else {
    const boundaryEpsilon = Math.max(
      1e-9,
      Math.abs(frequencyHz) * 1e-12,
    );
    const minimumModeFrequency =
      frequencyHz / (1 + ratio) - boundaryEpsilon;
    const maximumModeFrequency =
      frequencyHz / Math.max(Number.EPSILON, 1 - ratio) +
      boundaryEpsilon;
    const first = lowerBoundModeFrequency(
      state,
      minimumModeFrequency,
    );
    const afterLast = upperBoundModeFrequency(
      state,
      maximumModeFrequency,
    );
    for (
      let sortedPosition = first;
      sortedPosition < afterLast;
      sortedPosition += 1
    ) {
      const modeIndex =
        state.frequencySortedModeIndices[sortedPosition] ?? -1;
      const mode = state.dataset.modes[modeIndex];
      if (
        mode &&
        modeIsInsideActivationBandwidth(
          frequencyHz,
          mode.frequencyHz,
        )
      ) {
        addModeUpdateIndex(state, modeIndex);
      }
    }
  }

  for (
    let residualPosition = 0;
    residualPosition < state.nonzeroModeCount;
    residualPosition += 1
  ) {
    addModeUpdateIndex(
      state,
      state.nonzeroModeIndices[residualPosition] ?? -1,
    );
  }

  // Preserve the original mode-index accumulation and tie order exactly.
  for (
    let updatePosition = 1;
    updatePosition < state.modeUpdateCount;
    updatePosition += 1
  ) {
    const modeIndex =
      state.modeUpdateIndices[updatePosition] ?? -1;
    let insertionPosition = updatePosition;
    while (
      insertionPosition > 0 &&
      (state.modeUpdateIndices[insertionPosition - 1] ?? -1) >
        modeIndex
    ) {
      state.modeUpdateIndices[insertionPosition] =
        state.modeUpdateIndices[insertionPosition - 1] ?? -1;
      insertionPosition -= 1;
    }
    state.modeUpdateIndices[insertionPosition] = modeIndex;
  }
}

function commitNonzeroModeIndices(
  state: ResonanceState,
  nextCount: number,
): void {
  for (let position = 0; position < nextCount; position += 1) {
    state.nonzeroModeIndices[position] =
      state.nextNonzeroModeIndices[position] ?? -1;
  }
  state.nonzeroModeCount = nextCount;
}

function beginActiveModeSelection(state: ResonanceState): void {
  state.activeModeIndices.fill(-1);
  state.activeModePriorityScratch.fill(-1);
  state.activeModeCount = 0;
}

function insertActiveModeCandidate(
  state: ResonanceState,
  modeIndex: number,
  priority: number,
): void {
  const capacity = state.activeModeIndices.length;
  if (capacity === 0 || !Number.isFinite(priority)) return;
  let insertion = state.activeModeCount;
  for (let index = 0; index < state.activeModeCount; index += 1) {
    const existingPriority =
      state.activeModePriorityScratch[index] ?? -1;
    const existingMode = state.activeModeIndices[index] ?? -1;
    if (
      priority > existingPriority ||
      (priority === existingPriority && modeIndex < existingMode)
    ) {
      insertion = index;
      break;
    }
  }
  if (insertion >= capacity) return;
  const nextCount = Math.min(capacity, state.activeModeCount + 1);
  for (let index = nextCount - 1; index > insertion; index -= 1) {
    state.activeModeIndices[index] =
      state.activeModeIndices[index - 1] ?? -1;
    state.activeModePriorityScratch[index] =
      state.activeModePriorityScratch[index - 1] ?? -1;
  }
  state.activeModeIndices[insertion] = modeIndex;
  state.activeModePriorityScratch[insertion] = priority;
  state.activeModeCount = nextCount;
}

function isSelectedActiveMode(
  state: ResonanceState,
  modeIndex: number,
): boolean {
  for (let index = 0; index < state.activeModeCount; index += 1) {
    if (state.activeModeIndices[index] === modeIndex) return true;
  }
  return false;
}

/**
 * Residual energy is intentionally allowed to survive a frequency change, but
 * it must never occupy every bounded update slot and starve the mode currently
 * being driven. Reserve one slot for the strongest in-band capture while
 * retaining the remaining residual candidates in their deterministic order.
 */
function reserveCaptureModeCandidate(
  state: ResonanceState,
  modeIndex: number,
  priority: number,
): void {
  if (
    modeIndex < 0 ||
    priority <= 0 ||
    isSelectedActiveMode(state, modeIndex)
  ) {
    return;
  }
  const capacity = state.activeModeIndices.length;
  if (state.activeModeCount < capacity) {
    insertActiveModeCandidate(state, modeIndex, priority);
    return;
  }
  if (capacity === 0) return;

  let insertion = capacity - 1;
  state.activeModeIndices[insertion] = modeIndex;
  state.activeModePriorityScratch[insertion] = priority;
  while (insertion > 0) {
    const previousPriority =
      state.activeModePriorityScratch[insertion - 1] ?? -1;
    const previousMode =
      state.activeModeIndices[insertion - 1] ?? -1;
    if (
      previousPriority > priority ||
      (previousPriority === priority && previousMode < modeIndex)
    ) {
      break;
    }
    state.activeModeIndices[insertion] = previousMode;
    state.activeModePriorityScratch[insertion] = previousPriority;
    insertion -= 1;
    state.activeModeIndices[insertion] = modeIndex;
    state.activeModePriorityScratch[insertion] = priority;
  }
}

function integrateFixedStep(
  state: ResonanceState,
  driveFrequencyHz: number,
  driveSweepHzPerSecond?: number,
  driveDirection?: -1 | 0 | 1,
): void {
  const [minimumFrequency, maximumFrequency] =
    state.dataset.frequencyRangeHz;
  const previousFrequencyHz = fromCentiHertz(
    state.driveFrequencyCentiHz,
  );
  const frequencyCentiHz = toCentiHertz(clamp(
    finiteOr(driveFrequencyHz, previousFrequencyHz),
    minimumFrequency,
    maximumFrequency,
  ));
  const frequencyHz = fromCentiHertz(frequencyCentiHz);
  const inferredSweep =
    (frequencyCentiHz - state.driveFrequencyCentiHz) /
    (GENERATED_DIAL_SPEC.fixedPoint.centihertzPerHertz *
      FIXED_STEP_SECONDS);
  const sweepHzPerSecond = clamp(
    finiteOr(driveSweepHzPerSecond, inferredSweep),
    -50_000,
    50_000,
  );
  const approachDirection =
    driveDirection === -1 ||
    driveDirection === 0 ||
    driveDirection === 1
      ? driveDirection
      : sign(sweepHzPerSecond, 0.1);
  const speedCapture = Math.exp(
    -Math.abs(sweepHzPerSecond) /
      CALIBRATION.modalResponse.captureSpeedHzPerSecond,
  );

  const filterMagnitude = bandPassMagnitude(frequencyHz);
  collectModeUpdateIndices(state, frequencyHz);
  beginActiveModeSelection(state);
  let strongestCaptureModeIndex = -1;
  let strongestCaptureDriveScore = 0;
  for (
    let updatePosition = 0;
    updatePosition < state.modeUpdateCount;
    updatePosition += 1
  ) {
    const index = state.modeUpdateIndices[updatePosition] ?? -1;
    const mode = state.dataset.modes[index];
    if (!mode) continue;
    const response = responseAtFrequency(
      frequencyHz,
      mode.frequencyHz,
      mode.dampingRatio,
    );
    const coupling =
      response *
      Math.abs(mode.driveCoupling * mode.microphoneCoupling) /
      state.dataset.maximumModalCoupling;
    const directionalPhase =
      approachDirection === 0
        ? 1
        : 1 +
          approachDirection *
            Math.sin(mode.phaseOffsetRadians) *
            CALIBRATION.modalResponse.directionalPhaseScale;
    const driveScore = Math.max(0, coupling * directionalPhase);
    const loopScore =
      driveScore *
      filterMagnitude *
      feedbackPhaseAlignment(
        frequencyHz,
        mode.phaseOffsetRadians,
      );
    state.modeResponseScratch[index] = response;
    state.modeDriveScoreScratch[index] = driveScore;
    state.modeLoopScoreScratch[index] = loopScore;

    const insideActivationBandwidth = modeIsInsideActivationBandwidth(
      frequencyHz,
      mode.frequencyHz,
    );
    if (
      insideActivationBandwidth &&
      (driveScore > strongestCaptureDriveScore ||
        (driveScore === strongestCaptureDriveScore &&
          (strongestCaptureModeIndex < 0 ||
            index < strongestCaptureModeIndex)))
    ) {
      strongestCaptureModeIndex = index;
      strongestCaptureDriveScore = driveScore;
    }
    const residualEnergy = clamp(
      state.modeEnergy[index] ?? 0,
      0,
      1,
    );
    if (
      insideActivationBandwidth ||
      residualEnergy >= RESIDUAL_ENERGY_THRESHOLD
    ) {
      insertActiveModeCandidate(
        state,
        index,
        Math.max(driveScore, residualEnergy),
      );
    }
  }
  reserveCaptureModeCandidate(
    state,
    strongestCaptureModeIndex,
    strongestCaptureDriveScore,
  );

  let strongestModeIndex = -1;
  let strongestDriveScore = 0;
  let strongestLoopScore = 0;
  let loopResponseSum = 0;
  let microphoneWeight = 0;
  let radiationWeight = 0;
  const retainedDrive =
    CALIBRATION.modalEnergy.retainedDriveBase +
    speedCapture *
      (1 - CALIBRATION.modalEnergy.retainedDriveBase);
  const feedbackDrive =
    CALIBRATION.modalEnergy.feedbackDriveBase +
    state.feedbackEnvelope *
      CALIBRATION.modalEnergy.feedbackEnvelopeMultiplier +
    Math.abs(state.feedbackLoopSignal) *
      CALIBRATION.modalEnergy.feedbackSignalMultiplier;

  let nextNonzeroModeCount = 0;
  for (
    let updatePosition = 0;
    updatePosition < state.modeUpdateCount;
    updatePosition += 1
  ) {
    const index = state.modeUpdateIndices[updatePosition] ?? -1;
    const mode = state.dataset.modes[index];
    if (!mode) continue;
    const oldEnergy = clamp(state.modeEnergy[index] ?? 0, 0, 1);
    if (!isSelectedActiveMode(state, index)) {
      if (oldEnergy > 0) {
        const releaseRate =
          CALIBRATION.modalEnergy.releaseBasePerSecond +
          mode.dampingRatio *
            CALIBRATION.modalEnergy
              .releaseDampingMultiplierPerSecond;
        const decayedEnergy =
          oldEnergy * Math.exp(-releaseRate * FIXED_STEP_SECONDS);
        state.modeEnergy[index] =
          decayedEnergy >= RESIDUAL_ENERGY_THRESHOLD
            ? decayedEnergy
            : 0;
        if (state.modeEnergy[index] > 0) {
          state.modePhaseRadians[index] = wrapPhase(
            (state.modePhaseRadians[index] ??
              mode.phaseOffsetRadians) +
              TAU *
                (mode.frequencyHz - frequencyHz) *
                FIXED_STEP_SECONDS *
                CALIBRATION.modalEnergy.phaseDriftScale,
          );
          state.nextNonzeroModeIndices[nextNonzeroModeCount] =
            index;
          nextNonzeroModeCount += 1;
        }
      }
      continue;
    }

    const response = state.modeResponseScratch[index] ?? 0;
    const score = state.modeDriveScoreScratch[index] ?? 0;
    const loopScore = state.modeLoopScoreScratch[index] ?? 0;
    loopResponseSum += loopScore;
    if (loopScore > strongestLoopScore) {
      strongestLoopScore = loopScore;
    }
    if (score > strongestDriveScore) {
      strongestDriveScore = score;
      strongestModeIndex = index;
    }
    const targetEnergy = clamp(
      score * retainedDrive * feedbackDrive,
      0,
      1,
    );
    const followsAttack = targetEnergy > oldEnergy;
    const followRate = followsAttack
      ? CALIBRATION.modalEnergy.attackBasePerSecond +
        response *
          CALIBRATION.modalEnergy
            .attackResponseMultiplierPerSecond
      : CALIBRATION.modalEnergy.releaseBasePerSecond +
        mode.dampingRatio *
          CALIBRATION.modalEnergy
            .releaseDampingMultiplierPerSecond;
    state.modeEnergy[index] = clamp(
      oldEnergy +
        (targetEnergy - oldEnergy) *
          (1 - Math.exp(-followRate * FIXED_STEP_SECONDS)),
      0,
      1,
    );

    state.modePhaseRadians[index] = wrapPhase(
      (state.modePhaseRadians[index] ?? mode.phaseOffsetRadians) +
        TAU *
          (mode.frequencyHz - frequencyHz) *
          FIXED_STEP_SECONDS *
          CALIBRATION.modalEnergy.phaseDriftScale,
    );
    const amplitude = Math.sqrt(state.modeEnergy[index]);
    microphoneWeight +=
      amplitude *
      mode.microphoneCoupling *
      (CALIBRATION.microphone.modeBaseWeight +
        Math.sin(state.modePhaseRadians[index]) *
          CALIBRATION.microphone.modePhaseWeight);
    radiationWeight += amplitude * mode.radiationEfficiency;
    if (state.modeEnergy[index] > 0) {
      state.nextNonzeroModeIndices[nextNonzeroModeCount] = index;
      nextNonzeroModeCount += 1;
    }
  }
  commitNonzeroModeIndices(state, nextNonzeroModeCount);

  const adjacentResponse = clamp(
    loopResponseSum - strongestLoopScore,
    0,
    1,
  );
  const phaseA =
    strongestModeIndex >= 0
      ? state.modePhaseRadians[strongestModeIndex]
      : 0;
  const secondaryModeIndex =
    state.activeModeCount > 1
      ? (state.activeModeIndices[1] ?? -1)
      : -1;
  const phaseB =
    secondaryModeIndex >= 0
      ? state.modePhaseRadians[secondaryModeIndex]
      : phaseA;
  const beat = 0.5 + 0.5 * Math.sin(phaseA - phaseB);
  const historyBoost =
    CALIBRATION.loopMargin.residualHistoryGainMaximum *
    clamp(
      (state.loopEnergyEnvelope -
        CALIBRATION.loopMargin.residualHistoryStartEnvelope) /
        CALIBRATION.loopMargin.residualHistorySpanEnvelope,
      0,
      1,
    );
  const loopGain =
    strongestLoopScore * GENERATED_FEEDBACK_SPEC.loop.gainLinear +
    adjacentResponse * CALIBRATION.loopMargin.adjacentModeGainLinear +
    historyBoost;
  const loopMargin = loopGain - 1;

  const normalizedMicrophone = clamp(
    microphoneWeight /
      Math.max(
        1,
        state.dataset.modes.length *
          CALIBRATION.microphone.normalizationPerMode,
      ),
    0,
    1,
  );
  const radiationScale = clamp(
    radiationWeight /
      Math.max(
        1,
        state.dataset.modes.length *
          CALIBRATION.microphone.radiationNormalizationPerMode,
      ),
    0,
    1,
  );
  state.drivePhaseRadians = wrapPhase(
    state.drivePhaseRadians + TAU * frequencyHz * FIXED_STEP_SECONDS,
  );
  const waveformSample =
    normalizedMicrophone *
    (CALIBRATION.microphone.waveformDryWeight +
      state.feedbackEnvelope *
        CALIBRATION.microphone.waveformFeedbackWeight) *
    Math.sin(
      state.drivePhaseRadians +
        phaseA * CALIBRATION.microphone.waveformModePhaseWeight,
    );

  const delayed = state.delayBuffer[state.delayWriteIndex] ?? 0;
  state.delayBuffer[state.delayWriteIndex] = waveformSample;
  state.delayWriteIndex =
    (state.delayWriteIndex + 1) % state.delayBuffer.length;
  const loopPhase =
    -TAU * frequencyHz * GENERATED_FEEDBACK_SPEC.loop.delaySeconds +
    GENERATED_FEEDBACK_SPEC.loop.phaseOffsetRad;
  const filtered =
    delayed *
    bandPassMagnitude(frequencyHz) *
    Math.cos(loopPhase) *
    GENERATED_FEEDBACK_SPEC.loop.polarity;

  const gateSpec = GENERATED_FEEDBACK_SPEC.noiseGate;
  const gateDetector =
    Math.abs(filtered) +
    strongestDriveScore *
      GENERATED_FEEDBACK_SPEC.drive.amplitudeNormalized;
  if (!state.gateOpen && gateDetector >= gateSpec.openThresholdNormalized) {
    state.gateOpen = true;
  } else if (
    state.gateOpen &&
    gateDetector <= gateSpec.closeThresholdNormalized
  ) {
    state.gateOpen = false;
  }
  const gateTarget = state.gateOpen ? 1 : gateSpec.closedAttenuationLinear;
  state.gateGain = exponentialFollow(
    state.gateGain,
    gateTarget,
    state.gateOpen ? gateSpec.attackSeconds : gateSpec.releaseSeconds,
    FIXED_STEP_SECONDS,
  );

  const coherentModalReturn =
    state.loopEnergyEnvelope *
    strongestLoopScore *
    Math.sin(state.drivePhaseRadians + phaseA);
  const preClip =
    (filtered + coherentModalReturn) *
    GENERATED_FEEDBACK_SPEC.loop.gainLinear *
    state.gateGain;
  const clipped = normalizedTanh(
    preClip,
    GENERATED_FEEDBACK_SPEC.softClipper.drive,
  );
  const limiterSpec = GENERATED_FEEDBACK_SPEC.limiter;
  const absoluteClipped = Math.abs(clipped);
  let limiterTarget = 1;
  if (absoluteClipped > limiterSpec.thresholdNormalized) {
    limiterTarget = limiterSpec.thresholdNormalized / absoluteClipped;
    state.limiterHoldSeconds = limiterSpec.holdSeconds;
  } else {
    state.limiterHoldSeconds = Math.max(
      0,
      state.limiterHoldSeconds - FIXED_STEP_SECONDS,
    );
    if (state.limiterHoldSeconds > 0) limiterTarget = state.limiterGain;
  }
  state.limiterGain = clamp(
    exponentialFollow(
      state.limiterGain,
      limiterTarget,
      limiterTarget < state.limiterGain
        ? limiterSpec.attackSeconds
        : limiterSpec.releaseSeconds,
      FIXED_STEP_SECONDS,
    ),
    0,
    1,
  );
  state.feedbackLoopSignal = clamp(
    clipped *
      state.limiterGain *
      GENERATED_FEEDBACK_SPEC.virtualSpeaker
        .maximumDisplacementNormalized,
    -limiterSpec.ceilingNormalized,
    limiterSpec.ceilingNormalized,
  );
  state.limiterGainReductionDb =
    state.limiterGain >= 1
      ? 0
      : Math.max(0, -20 * Math.log10(Math.max(1e-9, state.limiterGain)));
  state.limiterActive = state.limiterGainReductionDb > 0.01;

  let loopEnergy = state.loopEnergyEnvelope;
  if (loopMargin > CRITICAL_LOOP_MARGIN_HALF_WIDTH) {
    const growthRate =
      CALIBRATION.energyDynamics.growthBasePerSecond +
      loopMargin *
        CALIBRATION.energyDynamics.growthMarginMultiplierPerSecond;
    loopEnergy +=
      (1 - loopEnergy) *
      (1 - Math.exp(-growthRate * FIXED_STEP_SECONDS));
  } else if (loopMargin < -CRITICAL_LOOP_MARGIN_HALF_WIDTH) {
    // This is the intentionally retained reverberation law.
    const decayRate =
      CALIBRATION.energyDynamics.decayBasePerSecond +
      Math.abs(loopMargin) *
        CALIBRATION.energyDynamics.decayMarginMultiplierPerSecond;
    loopEnergy *= Math.exp(-decayRate * FIXED_STEP_SECONDS);
  } else {
    const position = clamp(
      (loopMargin + CRITICAL_LOOP_MARGIN_HALF_WIDTH) /
        (2 * CRITICAL_LOOP_MARGIN_HALF_WIDTH),
      0,
      1,
    );
    const mapping = GENERATED_VOLUME_MAP_SPEC.mapping;
    const lowerCriticalRms =
      mapping.noiseFloorRms *
      CALIBRATION.energyDynamics.criticalLowerRmsMultiplier;
    const mappedPosition = clamp(
      position /
        CALIBRATION.energyDynamics.criticalSaturationPosition,
      0,
      1,
    );
    const targetRms =
      lowerCriticalRms *
      Math.pow(
        mapping.saturationRms / lowerCriticalRms,
        mappedPosition,
      );
    const microphoneScale =
      CALIBRATION.microphone.levelBase +
      normalizedMicrophone *
        CALIBRATION.microphone.modalResponseWeight +
      radiationScale * CALIBRATION.microphone.radiationWeight;
    const criticalTarget = clamp(
      targetRms /
        Math.max(
          CALIBRATION.microphone.minimumCriticalScale,
          microphoneScale,
        ),
      mapping.noiseFloorRms * 0.8,
      0.86,
    );
    loopEnergy = exponentialFollow(
      loopEnergy,
      criticalTarget,
      1 / CALIBRATION.energyDynamics.criticalFollowRatePerSecond,
      FIXED_STEP_SECONDS,
    );
  }
  state.loopEnergyEnvelope = clamp(loopEnergy, 0, 1);
  const follower = GENERATED_FEEDBACK_SPEC.envelopeFollower;
  const previousFeedbackEnvelope = state.feedbackEnvelope;
  state.feedbackEnvelope = clamp(
    exponentialFollow(
      state.feedbackEnvelope,
      state.loopEnergyEnvelope,
      state.loopEnergyEnvelope > state.feedbackEnvelope
        ? follower.attackSeconds
        : follower.releaseSeconds,
      FIXED_STEP_SECONDS,
    ),
    0,
    1,
  );

  const beatModulation =
    CALIBRATION.microphone.beatBase +
    beat * CALIBRATION.microphone.beatWeight;
  const microphoneLevel = clamp(
    state.feedbackEnvelope *
      beatModulation *
      (CALIBRATION.microphone.levelBase +
        normalizedMicrophone *
          CALIBRATION.microphone.modalResponseWeight +
        radiationScale * CALIBRATION.microphone.radiationWeight),
    0,
    1,
  );
  const measuredRms = pushMeasurementSample(
    state,
    microphoneLevel,
    clamp(waveformSample, -1, 1),
  );
  state.microphoneRms = measuredRms;
  state.microphonePeak = clamp(
    microphoneLevel *
      (CALIBRATION.microphone.peakBase +
        adjacentResponse *
          CALIBRATION.microphone.peakAdjacentResponseWeight),
    0,
    1,
  );
  state.instantaneousVolume = volumeFromVirtualRms(measuredRms);
  state.regime = classifyResonanceRegime(
    loopMargin,
    state.feedbackEnvelope,
    absoluteClipped > limiterSpec.thresholdNormalized
      ? state.limiterGainReductionDb
      : 0,
    (state.feedbackEnvelope - previousFeedbackEnvelope) /
      FIXED_STEP_SECONDS,
  );
  state.activeModeIndex =
    strongestDriveScore >=
        CALIBRATION.modalEnergy.activeModeScoreMinimum &&
      strongestModeIndex >= 0
      ? strongestModeIndex
      : null;

  const frequencyMotion = Math.abs(sweepHzPerSecond);
  const changedFrequency =
    frequencyCentiHz !== state.driveFrequencyCentiHz;
  const stableDrive =
    frequencyMotion <
      GENERATED_DIAL_SPEC.velocityEstimator
        .approachDirectionThresholdHzPerSecond &&
    !changedFrequency;
  const measurementWasSettled =
    state.measurementElapsedSeconds >= MEASUREMENT_TOTAL_SECONDS;
  let measurementTrendRms = state.previousMeasuredRms;
  if (!stableDrive) {
    resetMeasurement(state);
  } else {
    state.measurementObservationSeconds = Math.min(
      GENERATED_VOLUME_MAP_SPEC.measurement.minimumObservationSeconds,
      state.measurementObservationSeconds + FIXED_STEP_SECONDS,
    );
    const trendRms = exponentialFollow(
      state.previousMeasuredRms,
      state.loopEnergyEnvelope,
      GENERATED_VOLUME_MAP_SPEC.measurement.stabilityWindowSeconds,
      FIXED_STEP_SECONDS,
    );
    measurementTrendRms = trendRms;
    const relativeSlope =
      Math.abs(trendRms - state.previousMeasuredRms) /
      Math.max(
        GENERATED_VOLUME_MAP_SPEC.mapping.noiseFloorRms,
        state.previousMeasuredRms,
      ) /
      FIXED_STEP_SECONDS;
    const stableExtreme =
      (state.regime === "saturated" && state.feedbackEnvelope >= 0.95) ||
      (state.regime === "decaying" &&
        measuredRms <= GENERATED_VOLUME_MAP_SPEC.mapping.noiseFloorRms);
    if (
      state.measurementObservationSeconds >=
        GENERATED_VOLUME_MAP_SPEC.measurement.minimumObservationSeconds &&
      (stableExtreme ||
        relativeSlope <=
        GENERATED_VOLUME_MAP_SPEC.measurement
          .maximumRelativeRmsSlopePerSecond)
    ) {
      state.measurementStabilitySeconds = Math.min(
        GENERATED_VOLUME_MAP_SPEC.measurement.stabilityWindowSeconds,
        state.measurementStabilitySeconds + FIXED_STEP_SECONDS,
      );
    } else if (
      state.measurementObservationSeconds >=
      GENERATED_VOLUME_MAP_SPEC.measurement.minimumObservationSeconds
    ) {
      state.measurementStabilitySeconds = 0;
      state.measurementConfirmationSeconds = 0;
    }
    if (
      state.measurementStabilitySeconds >=
      GENERATED_VOLUME_MAP_SPEC.measurement.stabilityWindowSeconds
    ) {
      state.measurementConfirmationSeconds = Math.min(
        GENERATED_VOLUME_MAP_SPEC.measurement.confirmationHoldSeconds,
        state.measurementConfirmationSeconds + FIXED_STEP_SECONDS,
      );
    }
  }
  state.measurementElapsedSeconds =
    state.measurementObservationSeconds +
    state.measurementStabilitySeconds +
    state.measurementConfirmationSeconds;
  if (
    state.measurementConfirmationSeconds >=
      GENERATED_VOLUME_MAP_SPEC.measurement.confirmationHoldSeconds &&
    !measurementWasSettled
  ) {
    state.settledVolume = state.instantaneousVolume;
    state.lastSettledVolume = state.instantaneousVolume;
  }
  state.previousMeasuredRms = measurementTrendRms;
  state.previousDriveFrequencyCentiHz =
    state.driveFrequencyCentiHz;
  state.driveFrequencyCentiHz = frequencyCentiHz;
  state.sweepHzPerSecond = sweepHzPerSecond;
  state.approachDirection = approachDirection;
  state.simulationTimeSeconds += FIXED_STEP_SECONDS;
  state.simulationStep += 1;
}

function resetAfterPausedGap(state: ResonanceState): void {
  state.accumulatorSeconds = 0;
  state.delayBuffer.fill(0);
  state.delayWriteIndex = 0;
  state.feedbackLoopSignal = 0;
  state.gateGain = 0;
  state.gateOpen = false;
  state.limiterGain = 1;
  state.limiterHoldSeconds = 0;
  state.limiterGainReductionDb = 0;
  state.limiterActive = false;
  state.sweepHzPerSecond = 0;
  resetMeasurement(state);
  state.pausedGapCount += 1;
}

export function resetResonanceAfterPausedGap(
  state: ResonanceState,
): ResonanceState {
  resetAfterPausedGap(state);
  state.sequence += 1;
  return state;
}

export function advanceResonance(
  state: ResonanceState,
  deltaSeconds: number,
  drive: ResonanceDrive = {
    frequencyHz: fromCentiHertz(state.driveFrequencyCentiHz),
  },
): ResonanceState {
  return advanceResonanceScalars(
    state,
    deltaSeconds,
    drive.frequencyHz,
    drive.sweepHzPerSecond,
    drive.direction,
  );
}

export function advanceResonanceScalars(
  state: ResonanceState,
  deltaSeconds: number,
  frequencyHz: number,
  sweepHzPerSecond?: number,
  direction?: -1 | 0 | 1,
): ResonanceState {
  const rawDelta = finiteOr(deltaSeconds, 0);
  if (rawDelta > PAUSED_GAP_RESET_SECONDS) {
    return resetResonanceAfterPausedGap(state);
  }
  const requestedDelta = clamp(rawDelta, 0, MAX_ADVANCE_SECONDS);
  state.accumulatorSeconds += requestedDelta;
  let steps = 0;
  while (
    state.accumulatorSeconds + 1e-12 >= FIXED_STEP_SECONDS &&
    steps < MAXIMUM_STEPS_PER_FRAME
  ) {
    integrateFixedStep(
      state,
      frequencyHz,
      sweepHzPerSecond,
      direction,
    );
    state.accumulatorSeconds -= FIXED_STEP_SECONDS;
    steps += 1;
  }
  state.accumulatorSeconds = Math.max(0, state.accumulatorSeconds);
  state.sequence += 1;
  return state;
}

function recentSamples(state: ResonanceState): readonly number[] {
  const samples: number[] = [];
  const count = state.recentSampleCount;
  const start =
    (state.recentSampleWriteIndex - count + state.recentMicrophoneSamples.length) %
    state.recentMicrophoneSamples.length;
  for (let index = 0; index < count; index += 1) {
    samples.push(
      state.recentMicrophoneSamples[
        (start + index) % state.recentMicrophoneSamples.length
      ],
    );
  }
  return Object.freeze(samples);
}

export function getResonanceSnapshot(
  state: ResonanceState,
): ResonanceSnapshot {
  const measurementProgress = clamp(
    state.measurementElapsedSeconds / MEASUREMENT_TOTAL_SECONDS,
    0,
    1,
  );
  const settled = measurementProgress >= 1;
  return Object.freeze({
    schemaVersion: "mandelhowl.runtime-resonance-snapshot.v1",
    datasetId: state.dataset.datasetId,
    simulationTimeSeconds: state.simulationTimeSeconds,
    simulationStep: state.simulationStep,
    frequencyCentiHz: state.driveFrequencyCentiHz,
    frequencyHz: fromCentiHertz(state.driveFrequencyCentiHz),
    sweepHzPerSecond: state.sweepHzPerSecond,
    modeEnergy: Object.freeze(Array.from(state.modeEnergy)),
    modePhaseRadians: Object.freeze(Array.from(state.modePhaseRadians)),
    feedbackEnvelope: state.feedbackEnvelope,
    feedbackLoopSignal: state.feedbackLoopSignal,
    limiterGainReductionDb: state.limiterGainReductionDb,
    limiterActive: state.limiterActive,
    microphoneRms: state.microphoneRms,
    microphonePeak: state.microphonePeak,
    recentMicrophoneSamples: recentSamples(state),
    regime: state.regime,
    activeModeIndex: state.activeModeIndex,
    volume: state.lastSettledVolume ?? 0,
    lastSettledVolume: state.lastSettledVolume,
    measurementProgress,
    settled,
    diagnostics: state.diagnostics,
  });
}

export function replaceResonanceDataset(
  state: ResonanceState,
  dataset: RuntimeModalDataset | ResonanceDataset,
  diagnostics: readonly DiagnosticRecord[] = state.diagnostics,
): ResonanceState {
  return createResonanceState({
    dataset,
    initialFrequencyHz: fromCentiHertz(
      state.driveFrequencyCentiHz,
    ),
    diagnostics,
  });
}

export const initResonance = createResonanceState;
export const stepResonance = advanceResonance;
