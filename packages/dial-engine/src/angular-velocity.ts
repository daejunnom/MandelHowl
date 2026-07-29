import { clamp, finiteOr } from "./math";

export function estimateAngularVelocity(
  deltaAngleRadians: number,
  deltaSeconds: number,
  previousVelocity: number,
  smoothing: number,
  maximumMagnitude: number,
): number {
  const dt = finiteOr(deltaSeconds, 0);
  if (dt <= 0) return finiteOr(previousVelocity, 0);

  const maximum = Math.max(0, finiteOr(maximumMagnitude, 0));
  const instantaneous = clamp(
    finiteOr(deltaAngleRadians, 0) / dt,
    -maximum,
    maximum,
  );
  const blend = clamp(finiteOr(smoothing, 1), 0, 1);
  return (
    finiteOr(previousVelocity, 0) +
    (instantaneous - finiteOr(previousVelocity, 0)) * blend
  );
}
