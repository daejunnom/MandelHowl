import { finiteOr, TAU } from "./math";

/** Returns the shortest signed delta between two wrapped angles. */
export function unwrapAngleDelta(
  previousWrappedRadians: number,
  currentWrappedRadians: number,
): number {
  const previous = finiteOr(previousWrappedRadians, 0);
  const current = finiteOr(currentWrappedRadians, previous);
  let delta = (current - previous) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return Object.is(delta, -0) ? 0 : delta;
}

export function accumulateUnwrappedAngle(
  unwrappedRadians: number,
  previousWrappedRadians: number,
  currentWrappedRadians: number,
): number {
  return (
    finiteOr(unwrappedRadians, 0) +
    unwrapAngleDelta(previousWrappedRadians, currentWrappedRadians)
  );
}
