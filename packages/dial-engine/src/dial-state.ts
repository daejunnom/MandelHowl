import { clamp, finiteOr, TAU } from "./math";

export type RotationDirection = -1 | 0 | 1;

export interface DialConfig {
  readonly version: "mandelhowl.dial-config.v1";
  readonly minFrequencyHz: number;
  readonly maxFrequencyHz: number;
  readonly minAngleRadians: number;
  readonly maxAngleRadians: number;
  readonly radialDeadZone: number;
  readonly maxPointerAngularVelocity: number;
  readonly velocitySmoothing: number;
  readonly keyboardStepRadians: number;
  readonly keyboardPageStepRadians: number;
  readonly wheelRadiansPerUnit: number;
  readonly maxWheelStepRadians: number;
  readonly inertiaFrictionPerSecond: number;
  readonly inertiaStopVelocity: number;
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
}

export const DEFAULT_DIAL_CONFIG: DialConfig = Object.freeze({
  version: "mandelhowl.dial-config.v1",
  minFrequencyHz: 52,
  maxFrequencyHz: 1250,
  minAngleRadians: 0,
  maxAngleRadians: TAU * 3,
  radialDeadZone: 18,
  maxPointerAngularVelocity: TAU * 4,
  velocitySmoothing: 0.32,
  keyboardStepRadians: Math.PI / 90,
  keyboardPageStepRadians: Math.PI / 12,
  wheelRadiansPerUnit: 0.0025,
  maxWheelStepRadians: Math.PI / 10,
  inertiaFrictionPerSecond: 7.5,
  inertiaStopVelocity: 0.012,
  endStopOverscrollRadians: Math.PI / 12,
  endStopStiffness: 92,
  endStopDamping: 15,
  maxAdvanceSeconds: 0.25,
  integrationStepSeconds: 1 / 120,
});

export function createDialConfig(
  overrides: Partial<Omit<DialConfig, "version">> = {},
): DialConfig {
  const minFrequencyHz = Math.max(
    Number.MIN_VALUE,
    finiteOr(overrides.minFrequencyHz ?? DEFAULT_DIAL_CONFIG.minFrequencyHz, 52),
  );
  const maxFrequencyHz = Math.max(
    minFrequencyHz + Number.EPSILON,
    finiteOr(overrides.maxFrequencyHz ?? DEFAULT_DIAL_CONFIG.maxFrequencyHz, 1250),
  );
  const minAngleRadians = finiteOr(
    overrides.minAngleRadians ?? DEFAULT_DIAL_CONFIG.minAngleRadians,
    0,
  );
  const maxAngleRadians = Math.max(
    minAngleRadians + Number.EPSILON,
    finiteOr(
      overrides.maxAngleRadians ?? DEFAULT_DIAL_CONFIG.maxAngleRadians,
      TAU * 3,
    ),
  );

  return Object.freeze({
    version: "mandelhowl.dial-config.v1",
    minFrequencyHz,
    maxFrequencyHz,
    minAngleRadians,
    maxAngleRadians,
    radialDeadZone: Math.max(
      0,
      finiteOr(overrides.radialDeadZone ?? DEFAULT_DIAL_CONFIG.radialDeadZone, 18),
    ),
    maxPointerAngularVelocity: Math.max(
      0.01,
      finiteOr(
        overrides.maxPointerAngularVelocity ??
          DEFAULT_DIAL_CONFIG.maxPointerAngularVelocity,
        TAU * 4,
      ),
    ),
    velocitySmoothing: clamp(
      finiteOr(
        overrides.velocitySmoothing ?? DEFAULT_DIAL_CONFIG.velocitySmoothing,
        0.32,
      ),
      0,
      1,
    ),
    keyboardStepRadians: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.keyboardStepRadians ?? DEFAULT_DIAL_CONFIG.keyboardStepRadians,
        Math.PI / 90,
      ),
    ),
    keyboardPageStepRadians: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.keyboardPageStepRadians ??
          DEFAULT_DIAL_CONFIG.keyboardPageStepRadians,
        Math.PI / 12,
      ),
    ),
    wheelRadiansPerUnit: Math.max(
      0,
      finiteOr(
        overrides.wheelRadiansPerUnit ?? DEFAULT_DIAL_CONFIG.wheelRadiansPerUnit,
        0.0025,
      ),
    ),
    maxWheelStepRadians: Math.max(
      Number.EPSILON,
      finiteOr(
        overrides.maxWheelStepRadians ?? DEFAULT_DIAL_CONFIG.maxWheelStepRadians,
        Math.PI / 10,
      ),
    ),
    inertiaFrictionPerSecond: Math.max(
      0,
      finiteOr(
        overrides.inertiaFrictionPerSecond ??
          DEFAULT_DIAL_CONFIG.inertiaFrictionPerSecond,
        7.5,
      ),
    ),
    inertiaStopVelocity: Math.max(
      0,
      finiteOr(
        overrides.inertiaStopVelocity ?? DEFAULT_DIAL_CONFIG.inertiaStopVelocity,
        0.012,
      ),
    ),
    endStopOverscrollRadians: Math.max(
      0,
      finiteOr(
        overrides.endStopOverscrollRadians ??
          DEFAULT_DIAL_CONFIG.endStopOverscrollRadians,
        Math.PI / 12,
      ),
    ),
    endStopStiffness: Math.max(
      0,
      finiteOr(
        overrides.endStopStiffness ?? DEFAULT_DIAL_CONFIG.endStopStiffness,
        92,
      ),
    ),
    endStopDamping: Math.max(
      0,
      finiteOr(
        overrides.endStopDamping ?? DEFAULT_DIAL_CONFIG.endStopDamping,
        15,
      ),
    ),
    maxAdvanceSeconds: Math.max(
      0,
      finiteOr(
        overrides.maxAdvanceSeconds ?? DEFAULT_DIAL_CONFIG.maxAdvanceSeconds,
        0.25,
      ),
    ),
    integrationStepSeconds: clamp(
      finiteOr(
        overrides.integrationStepSeconds ??
          DEFAULT_DIAL_CONFIG.integrationStepSeconds,
        1 / 120,
      ),
      1 / 1000,
      1 / 30,
    ),
  });
}
