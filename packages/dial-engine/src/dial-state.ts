import {
  GENERATED_DIAL_SPEC,
  GENERATED_FEEDBACK_SPEC,
} from "../../contracts/src";
import { clamp, finiteOr } from "./math";

export type RotationDirection = -1 | 0 | 1;

export interface DialConfig {
  readonly version: "mandelhowl.dial-config.v1";
  readonly minFrequencyHz: number;
  readonly maxFrequencyHz: number;
  readonly minAngleRadians: number;
  readonly maxAngleRadians: number;
  readonly unwrapPeriodRadians: number;
  readonly radialDeadZone: number;
  readonly maximumPointerSampleGapSeconds: number;
  readonly maximumPointerDeltaRadians: number;
  readonly maxPointerAngularVelocity: number;
  readonly velocityHistoryWindowSeconds: number;
  readonly stationaryVelocityThreshold: number;
  readonly approachDirectionThresholdHzPerSecond: number;
  readonly keyboardStepRadians: number;
  readonly keyboardPageStepRadians: number;
  readonly wheelRadiansPerUnit: number;
  readonly maxWheelStepRadians: number;
  readonly maximumInitialInertiaVelocity: number;
  readonly inertiaFrictionPerSecond: number;
  readonly inertiaStopVelocity: number;
  readonly inertiaMaximumDurationSeconds: number;
  readonly endStopOverscrollRadians: number;
  readonly endStopStiffness: number;
  readonly endStopDamping: number;
  readonly maxAdvanceSeconds: number;
  readonly integrationStepSeconds: number;
}

export interface DialState {
  readonly version: "mandelhowl.dial-state.v1";
  readonly config: DialConfig;
  /** Continuous, non-wrapped dial position. It may briefly include end-stop overscroll. */
  readonly unwrappedAngleRadians: number;
  /** Alias intended for presentation. This is also radians, never degrees. */
  readonly angleRadians: number;
  /** The angle used by the frequency scale after clamping to the physical range. */
  readonly effectiveAngleRadians: number;
  readonly angularVelocityRadiansPerSecond: number;
  readonly frequencyHz: number;
  readonly previousFrequencyHz: number;
  readonly frequencySweepHzPerSecond: number;
  readonly direction: RotationDirection;
  readonly stoppedSeconds: number;
  readonly dragging: boolean;
  readonly lastPointerAngleRadians: number | null;
  readonly lastPointerTimestampMs: number | null;
  readonly lastUpdateTimestampMs: number | null;
  readonly inertiaElapsedSeconds: number;
}

export const DEFAULT_DIAL_CONFIG: DialConfig = Object.freeze({
  version: "mandelhowl.dial-config.v1",
  minFrequencyHz: GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
  maxFrequencyHz: GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz,
  minAngleRadians: GENERATED_DIAL_SPEC.mapping.minimumUnwrappedAngleRad,
  maxAngleRadians: GENERATED_DIAL_SPEC.mapping.maximumUnwrappedAngleRad,
  unwrapPeriodRadians: GENERATED_DIAL_SPEC.pointerSampling.unwrapPeriodRad,
  radialDeadZone: GENERATED_DIAL_SPEC.pointerSampling.minimumRadiusRatio,
  maximumPointerSampleGapSeconds:
    GENERATED_DIAL_SPEC.pointerSampling.maximumSampleGapSeconds,
  maximumPointerDeltaRadians:
    GENERATED_DIAL_SPEC.pointerSampling.maximumAngularDeltaPerSampleRad,
  maxPointerAngularVelocity:
    GENERATED_DIAL_SPEC.velocityEstimator.maximumAbsoluteRadPerSecond,
  velocityHistoryWindowSeconds:
    GENERATED_DIAL_SPEC.velocityEstimator.historyWindowSeconds,
  stationaryVelocityThreshold:
    GENERATED_DIAL_SPEC.velocityEstimator.stationaryThresholdRadPerSecond,
  approachDirectionThresholdHzPerSecond:
    GENERATED_DIAL_SPEC.velocityEstimator
      .approachDirectionThresholdHzPerSecond,
  keyboardStepRadians: GENERATED_DIAL_SPEC.keyboard.arrowStepRad,
  keyboardPageStepRadians: GENERATED_DIAL_SPEC.keyboard.pageStepRad,
  wheelRadiansPerUnit: GENERATED_DIAL_SPEC.wheel.radiansPerDeltaPixel,
  maxWheelStepRadians: GENERATED_DIAL_SPEC.wheel.maximumDeltaRadPerEvent,
  maximumInitialInertiaVelocity:
    GENERATED_DIAL_SPEC.inertia.maximumInitialRadPerSecond,
  inertiaFrictionPerSecond:
    GENERATED_DIAL_SPEC.inertia.frictionRadPerSecondSquared,
  inertiaStopVelocity: GENERATED_DIAL_SPEC.inertia.stopThresholdRadPerSecond,
  inertiaMaximumDurationSeconds:
    GENERATED_DIAL_SPEC.inertia.maximumDurationSeconds,
  endStopOverscrollRadians:
    GENERATED_DIAL_SPEC.endStops.maximumOverscrollRad,
  endStopStiffness:
    GENERATED_DIAL_SPEC.endStops.springStiffnessPerSecondSquared,
  endStopDamping: GENERATED_DIAL_SPEC.endStops.dampingPerSecond,
  maxAdvanceSeconds:
    GENERATED_FEEDBACK_SPEC.simulation.maximumCatchUpSeconds,
  integrationStepSeconds:
    GENERATED_FEEDBACK_SPEC.simulation.fixedStepSeconds,
});

export function createDialConfig(
  overrides: Partial<Omit<DialConfig, "version">> = {},
): DialConfig {
  const minFrequencyHz = Math.max(
    Number.MIN_VALUE,
    finiteOr(
      overrides.minFrequencyHz ?? DEFAULT_DIAL_CONFIG.minFrequencyHz,
      DEFAULT_DIAL_CONFIG.minFrequencyHz,
    ),
  );
  const maxFrequencyHz = Math.max(
    minFrequencyHz + Number.EPSILON,
    finiteOr(
      overrides.maxFrequencyHz ?? DEFAULT_DIAL_CONFIG.maxFrequencyHz,
      DEFAULT_DIAL_CONFIG.maxFrequencyHz,
    ),
  );
  const minAngleRadians = finiteOr(
    overrides.minAngleRadians ?? DEFAULT_DIAL_CONFIG.minAngleRadians,
    DEFAULT_DIAL_CONFIG.minAngleRadians,
  );
  const maxAngleRadians = Math.max(
    minAngleRadians + Number.EPSILON,
    finiteOr(
      overrides.maxAngleRadians ?? DEFAULT_DIAL_CONFIG.maxAngleRadians,
      DEFAULT_DIAL_CONFIG.maxAngleRadians,
    ),
  );

  return Object.freeze({
    version: "mandelhowl.dial-config.v1",
    minFrequencyHz,
    maxFrequencyHz,
    minAngleRadians,
    maxAngleRadians,
    unwrapPeriodRadians: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.unwrapPeriodRadians ??
          DEFAULT_DIAL_CONFIG.unwrapPeriodRadians,
        DEFAULT_DIAL_CONFIG.unwrapPeriodRadians,
      ),
    ),
    radialDeadZone: Math.max(
      0,
      finiteOr(
        overrides.radialDeadZone ?? DEFAULT_DIAL_CONFIG.radialDeadZone,
        DEFAULT_DIAL_CONFIG.radialDeadZone,
      ),
    ),
    maximumPointerSampleGapSeconds: Math.max(
      0,
      finiteOr(
        overrides.maximumPointerSampleGapSeconds ??
          DEFAULT_DIAL_CONFIG.maximumPointerSampleGapSeconds,
        DEFAULT_DIAL_CONFIG.maximumPointerSampleGapSeconds,
      ),
    ),
    maximumPointerDeltaRadians: Math.max(
      0,
      finiteOr(
        overrides.maximumPointerDeltaRadians ??
          DEFAULT_DIAL_CONFIG.maximumPointerDeltaRadians,
        DEFAULT_DIAL_CONFIG.maximumPointerDeltaRadians,
      ),
    ),
    maxPointerAngularVelocity: Math.max(
      0.01,
      finiteOr(
        overrides.maxPointerAngularVelocity ??
          DEFAULT_DIAL_CONFIG.maxPointerAngularVelocity,
        DEFAULT_DIAL_CONFIG.maxPointerAngularVelocity,
      ),
    ),
    velocityHistoryWindowSeconds: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.velocityHistoryWindowSeconds ??
          DEFAULT_DIAL_CONFIG.velocityHistoryWindowSeconds,
        DEFAULT_DIAL_CONFIG.velocityHistoryWindowSeconds,
      ),
    ),
    stationaryVelocityThreshold: Math.max(
      0,
      finiteOr(
        overrides.stationaryVelocityThreshold ??
          DEFAULT_DIAL_CONFIG.stationaryVelocityThreshold,
        DEFAULT_DIAL_CONFIG.stationaryVelocityThreshold,
      ),
    ),
    approachDirectionThresholdHzPerSecond: Math.max(
      0,
      finiteOr(
        overrides.approachDirectionThresholdHzPerSecond ??
          DEFAULT_DIAL_CONFIG.approachDirectionThresholdHzPerSecond,
        DEFAULT_DIAL_CONFIG.approachDirectionThresholdHzPerSecond,
      ),
    ),
    keyboardStepRadians: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.keyboardStepRadians ?? DEFAULT_DIAL_CONFIG.keyboardStepRadians,
        DEFAULT_DIAL_CONFIG.keyboardStepRadians,
      ),
    ),
    keyboardPageStepRadians: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.keyboardPageStepRadians ??
          DEFAULT_DIAL_CONFIG.keyboardPageStepRadians,
        DEFAULT_DIAL_CONFIG.keyboardPageStepRadians,
      ),
    ),
    wheelRadiansPerUnit: Math.max(
      0,
      finiteOr(
        overrides.wheelRadiansPerUnit ?? DEFAULT_DIAL_CONFIG.wheelRadiansPerUnit,
        DEFAULT_DIAL_CONFIG.wheelRadiansPerUnit,
      ),
    ),
    maxWheelStepRadians: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.maxWheelStepRadians ?? DEFAULT_DIAL_CONFIG.maxWheelStepRadians,
        DEFAULT_DIAL_CONFIG.maxWheelStepRadians,
      ),
    ),
    maximumInitialInertiaVelocity: Math.max(
      0,
      finiteOr(
        overrides.maximumInitialInertiaVelocity ??
          DEFAULT_DIAL_CONFIG.maximumInitialInertiaVelocity,
        DEFAULT_DIAL_CONFIG.maximumInitialInertiaVelocity,
      ),
    ),
    inertiaFrictionPerSecond: Math.max(
      0,
      finiteOr(
        overrides.inertiaFrictionPerSecond ??
          DEFAULT_DIAL_CONFIG.inertiaFrictionPerSecond,
        DEFAULT_DIAL_CONFIG.inertiaFrictionPerSecond,
      ),
    ),
    inertiaStopVelocity: Math.max(
      0,
      finiteOr(
        overrides.inertiaStopVelocity ?? DEFAULT_DIAL_CONFIG.inertiaStopVelocity,
        DEFAULT_DIAL_CONFIG.inertiaStopVelocity,
      ),
    ),
    inertiaMaximumDurationSeconds: Math.max(
      0,
      finiteOr(
        overrides.inertiaMaximumDurationSeconds ??
          DEFAULT_DIAL_CONFIG.inertiaMaximumDurationSeconds,
        DEFAULT_DIAL_CONFIG.inertiaMaximumDurationSeconds,
      ),
    ),
    endStopOverscrollRadians: Math.max(
      0,
      finiteOr(
        overrides.endStopOverscrollRadians ??
          DEFAULT_DIAL_CONFIG.endStopOverscrollRadians,
        DEFAULT_DIAL_CONFIG.endStopOverscrollRadians,
      ),
    ),
    endStopStiffness: Math.max(
      0,
      finiteOr(
        overrides.endStopStiffness ?? DEFAULT_DIAL_CONFIG.endStopStiffness,
        DEFAULT_DIAL_CONFIG.endStopStiffness,
      ),
    ),
    endStopDamping: Math.max(
      0,
      finiteOr(
        overrides.endStopDamping ?? DEFAULT_DIAL_CONFIG.endStopDamping,
        DEFAULT_DIAL_CONFIG.endStopDamping,
      ),
    ),
    maxAdvanceSeconds: Math.max(
      0,
      finiteOr(
        overrides.maxAdvanceSeconds ?? DEFAULT_DIAL_CONFIG.maxAdvanceSeconds,
        DEFAULT_DIAL_CONFIG.maxAdvanceSeconds,
      ),
    ),
    integrationStepSeconds: clamp(
      finiteOr(
        overrides.integrationStepSeconds ??
          DEFAULT_DIAL_CONFIG.integrationStepSeconds,
        DEFAULT_DIAL_CONFIG.integrationStepSeconds,
      ),
      1 / 1000,
      1 / 30,
    ),
  });
}
