import type { DialConfig } from "./dial-state";
import { clamp, finiteOr } from "./math";

/**
 * Compresses arbitrary pointer travel into a finite, asymptotic overscroll region.
 * Values within the valid dial range pass through unchanged.
 */
export function applyEndStopResistance(
  angleRadians: number,
  config: Pick<
    DialConfig,
    "minAngleRadians" | "maxAngleRadians" | "endStopOverscrollRadians"
  >,
): number {
  const angle = finiteOr(angleRadians, config.minAngleRadians);
  const overscroll = Math.max(0, config.endStopOverscrollRadians);
  if (angle < config.minAngleRadians) {
    if (overscroll === 0) return config.minAngleRadians;
    const travel = config.minAngleRadians - angle;
    return config.minAngleRadians - overscroll * (1 - Math.exp(-travel / overscroll));
  }
  if (angle > config.maxAngleRadians) {
    if (overscroll === 0) return config.maxAngleRadians;
    const travel = angle - config.maxAngleRadians;
    return config.maxAngleRadians + overscroll * (1 - Math.exp(-travel / overscroll));
  }
  return angle;
}

export function clampToDialRange(
  angleRadians: number,
  config: Pick<DialConfig, "minAngleRadians" | "maxAngleRadians">,
): number {
  return clamp(
    finiteOr(angleRadians, config.minAngleRadians),
    config.minAngleRadians,
    config.maxAngleRadians,
  );
}
