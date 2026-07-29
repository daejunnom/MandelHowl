export {
  estimateAngularVelocity,
} from "./angular-velocity";
export type { DialCommand, DialKeyboardKey } from "./dial-command";
export {
  createDialState,
  reduceDialState,
  stepDialState,
} from "./dial-engine";
export {
  createDialConfig,
  DEFAULT_DIAL_CONFIG,
} from "./dial-state";
export type {
  DialConfig,
  DialState,
  RotationDirection,
} from "./dial-state";
export {
  applyEndStopResistance,
  clampToDialRange,
} from "./end-stop";
export {
  angleToFrequency,
  frequencyToAngle,
} from "./frequency-scale";
export {
  integrateDialInertia,
} from "./inertia";
export type { InertiaState } from "./inertia";
export {
  isOutsideRadialDeadZone,
  pointerAngleRadians,
  radialDistance,
} from "./radial-dead-zone";
export type { DialPoint } from "./radial-dead-zone";
export {
  accumulateUnwrappedAngle,
  unwrapAngleDelta,
} from "./unwrap-angle";
export {
  createDialGestureTrace,
  recordDialTraceCommand,
  replayDialGestureTrace,
  validateDialGestureTrace,
} from "./gesture-trace";
export type {
  CreateDialGestureTraceOptions,
  DialTraceReplayResult,
} from "./gesture-trace";
