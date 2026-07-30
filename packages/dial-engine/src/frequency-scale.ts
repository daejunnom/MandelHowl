import {
  fromCentiHertz,
  quantizeFrequencyHz,
  toCentiHertz,
} from "../../contracts/src";
import type { DialConfig } from "./dial-state";
import { clamp, finiteOr } from "./math";

type FrequencyScaleConfig = Pick<
  DialConfig,
  "minAngleRadians" | "maxAngleRadians" | "minFrequencyHz" | "maxFrequencyHz"
>;

export function angleToFrequencyCentiHz(
  angleRadians: number,
  config: FrequencyScaleConfig,
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
  return toCentiHertz(
    Math.exp(logMinimum + normalized * logSpan),
    config.minFrequencyHz,
  );
}

export function angleToFrequency(
  angleRadians: number,
  config: FrequencyScaleConfig,
): number {
  return fromCentiHertz(
    angleToFrequencyCentiHz(angleRadians, config),
  );
}

export function frequencyCentiHzToAngle(
  frequencyCentiHz: number,
  config: FrequencyScaleConfig,
): number {
  const frequency = clamp(
    fromCentiHertz(
      frequencyCentiHz,
      toCentiHertz(config.minFrequencyHz),
    ),
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

export function frequencyToAngle(
  frequencyHz: number,
  config: FrequencyScaleConfig,
): number {
  return frequencyCentiHzToAngle(
    toCentiHertz(
      quantizeFrequencyHz(frequencyHz, config.minFrequencyHz),
      config.minFrequencyHz,
    ),
    config,
  );
}
