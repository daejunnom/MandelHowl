import { GENERATED_DIAL_SPEC } from "./generated/runtime-specs.generated";

export const CENTIHERTZ_PER_HERTZ =
  GENERATED_DIAL_SPEC.fixedPoint.centihertzPerHertz;
export const FREQUENCY_DECIMAL_PLACES =
  GENERATED_DIAL_SPEC.fixedPoint.decimalPlaces;

function finiteSafeIntegerOr(value: number, fallback: number): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    return fallback;
  }
  return value;
}

function roundHalfAwayFromZero(value: number): number {
  const magnitude = Math.abs(value);
  const binaryTolerance =
    Number.EPSILON * Math.max(1, magnitude) * 4;
  const roundedMagnitude = Math.floor(
    magnitude + 0.5 + binaryTolerance,
  );
  return value < 0 ? -roundedMagnitude : roundedMagnitude;
}

/**
 * Converts a physics-boundary hertz value to the canonical integer storage
 * unit. Floating point is accepted only at this boundary and is immediately
 * collapsed onto the 0.01 Hz grid.
 */
export function toCentiHertz(
  frequencyHz: number,
  fallbackFrequencyHz = 0,
): number {
  const fallbackScaled = roundHalfAwayFromZero(
    fallbackFrequencyHz * CENTIHERTZ_PER_HERTZ,
  );
  const fallback = finiteSafeIntegerOr(fallbackScaled, 0);
  if (!Number.isFinite(frequencyHz)) return fallback;
  const scaled = frequencyHz * CENTIHERTZ_PER_HERTZ;
  if (!Number.isFinite(scaled)) return fallback;
  return finiteSafeIntegerOr(roundHalfAwayFromZero(scaled), fallback);
}

export function normalizeCentiHertz(
  frequencyCentiHz: number,
  fallbackCentiHz = 0,
): number {
  const fallback = finiteSafeIntegerOr(fallbackCentiHz, 0);
  // Preserve canonical integers before adding any binary rounding tolerance.
  // At the safe-integer limits, an EPS-scaled tolerance can otherwise push an
  // exact integer just outside the representable contract.
  if (Number.isSafeInteger(frequencyCentiHz)) {
    return frequencyCentiHz;
  }
  if (!Number.isFinite(frequencyCentiHz)) return fallback;
  return finiteSafeIntegerOr(
    roundHalfAwayFromZero(frequencyCentiHz),
    fallback,
  );
}

/**
 * Converts canonical integer storage to hertz only for numerical physics,
 * audio, and rendering boundaries.
 */
export function fromCentiHertz(
  frequencyCentiHz: number,
  fallbackCentiHz = 0,
): number {
  const fallback = finiteSafeIntegerOr(fallbackCentiHz, 0);
  const normalized = normalizeCentiHertz(
    frequencyCentiHz,
    fallback,
  );
  return normalized / CENTIHERTZ_PER_HERTZ;
}

export function quantizeFrequencyHz(
  frequencyHz: number,
  fallbackFrequencyHz = 0,
): number {
  return fromCentiHertz(
    toCentiHertz(frequencyHz, fallbackFrequencyHz),
  );
}

export function isCentiHertzInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

export function isFrequencyOnCentiHertzGrid(
  frequencyHz: number,
): boolean {
  if (!Number.isFinite(frequencyHz)) return false;
  return (
    quantizeFrequencyHz(frequencyHz, frequencyHz) === frequencyHz
  );
}

/**
 * Formats with integer division so no binary floating-point residue can leak
 * into the readout. Exactly two fractional digits are always emitted.
 */
export function formatCentiHertz(
  frequencyCentiHz: number,
): string {
  const normalized = normalizeCentiHertz(frequencyCentiHz);
  const sign = normalized < 0 ? "-" : "";
  const magnitude = Math.abs(normalized);
  const whole = Math.floor(magnitude / CENTIHERTZ_PER_HERTZ);
  const fraction = magnitude % CENTIHERTZ_PER_HERTZ;
  return `${sign}${whole}.${String(fraction).padStart(
    FREQUENCY_DECIMAL_PLACES,
    "0",
  )}`;
}

export function formatFrequencyHz(
  frequencyHz: number,
  fallbackFrequencyHz = 0,
): string {
  return `${formatCentiHertz(
    toCentiHertz(frequencyHz, fallbackFrequencyHz),
  )} Hz`;
}
