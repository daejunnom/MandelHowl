import type { DialConfig } from "./dial-state";
import { clamp, finiteOr } from "./math";

export function angleToFrequency(
  angleRadians: number,
  config: Pick<
    DialConfig,
    "minAngleRadians" | "maxAngleRadians" | "minFrequencyHz" | "maxFrequencyHz"
  >,
): number {
  const angle = clamp(
    finiteOr(angleRadians, config.minAngleRadians),
    config.minAngleRadians,
    config.maxAngleRadians,
  );
  const normalized =
    (angle - config.minAngleRadians) /
    (config.maxAngleRadians - config.minAngleRadians);
  const logMinimum = Math.log(config.minFrequencyHz);
  const logSpan = Math.log(config.maxFrequencyHz) - logMinimum;
  return Math.exp(logMinimum + normalized * logSpan);
}

export function frequencyToAngle(
  frequencyHz: number,
  config: Pick<
    DialConfig,
    "minAngleRadians" | "maxAngleRadians" | "minFrequencyHz" | "maxFrequencyHz"
  >,
): number {
  const frequency = clamp(
    finiteOr(frequencyHz, config.minFrequencyHz),
    config.minFrequencyHz,
    config.maxFrequencyHz,
  );
  const normalized =
    (Math.log(frequency) - Math.log(config.minFrequencyHz)) /
    (Math.log(config.maxFrequencyHz) - Math.log(config.minFrequencyHz));
  return (
    config.minAngleRadians +
    normalized * (config.maxAngleRadians - config.minAngleRadians)
  );
}
