import type { DialConfig } from "./dial-state";
import { clamp, finiteOr } from "./math";

export interface InertiaState {
  readonly angleRadians: number;
  readonly angularVelocityRadiansPerSecond: number;
}

/** Integrates one small, deterministic inertial step including end-stop restoration. */
export function integrateDialInertia(
  inertia: InertiaState,
  deltaSeconds: number,
  config: DialConfig,
): InertiaState {
  const dt = Math.max(0, finiteOr(deltaSeconds, 0));
  if (dt === 0) return inertia;

  let angle = finiteOr(inertia.angleRadians, config.minAngleRadians);
  let velocity = clamp(
    finiteOr(inertia.angularVelocityRadiansPerSecond, 0),
    -config.maxPointerAngularVelocity,
    config.maxPointerAngularVelocity,
  );

  const below = Math.min(0, angle - config.minAngleRadians);
  const above = Math.max(0, angle - config.maxAngleRadians);
  const displacement = below + above;
  const springAcceleration =
    displacement === 0
      ? 0
      : -config.endStopStiffness * displacement - config.endStopDamping * velocity;

  velocity += springAcceleration * dt;
  velocity *= Math.exp(-config.inertiaFrictionPerSecond * dt);
  velocity = clamp(
    velocity,
    -config.maxPointerAngularVelocity,
    config.maxPointerAngularVelocity,
  );
  angle += velocity * dt;

  const overscroll = config.endStopOverscrollRadians;
  angle = clamp(
    angle,
    config.minAngleRadians - overscroll,
    config.maxAngleRadians + overscroll,
  );

  const insideRange =
    angle >= config.minAngleRadians && angle <= config.maxAngleRadians;
  if (insideRange && Math.abs(velocity) < config.inertiaStopVelocity) {
    velocity = 0;
  }

  const endStopSnapDistance =
    config.inertiaStopVelocity *
    Math.max(config.integrationStepSeconds, dt);
  if (
    angle < config.minAngleRadians &&
    Math.abs(angle - config.minAngleRadians) <= endStopSnapDistance &&
    Math.abs(velocity) < config.inertiaStopVelocity
  ) {
    angle = config.minAngleRadians;
    velocity = 0;
  } else if (
    angle > config.maxAngleRadians &&
    Math.abs(angle - config.maxAngleRadians) <= endStopSnapDistance &&
    Math.abs(velocity) < config.inertiaStopVelocity
  ) {
    angle = config.maxAngleRadians;
    velocity = 0;
  }

  return {
    angleRadians: angle,
    angularVelocityRadiansPerSecond: velocity,
  };
}
