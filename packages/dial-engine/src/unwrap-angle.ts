import { finiteOr, TAU } from "./math";

/** Returns the shortest signed delta between two wrapped angles. */
export function unwrapAngleDelta(
  previousWrappedRadians: number,
  currentWrappedRadians: number,
  periodRadians = TAU,
): number {
  const previous = finiteOr(previousWrappedRadians, 0);
  const current = finiteOr(currentWrappedRadians, previous);
  const period = Math.max(Number.EPSILON, finiteOr(periodRadians, TAU));
  const halfPeriod = period / 2;
  let delta = (current - previous) % period;
  if (delta > halfPeriod) delta -= period;
  if (delta < -halfPeriod) delta += period;
  return Object.is(delta, -0) ? 0 : delta;
}

export function accumulateUnwrappedAngle(
  unwrappedRadians: number,
  previousWrappedRadians: number,
  currentWrappedRadians: number,
  periodRadians = TAU,
): number {
  return (
    finiteOr(unwrappedRadians, 0) +
    unwrapAngleDelta(
      previousWrappedRadians,
      currentWrappedRadians,
      periodRadians,
    )
  );
}
