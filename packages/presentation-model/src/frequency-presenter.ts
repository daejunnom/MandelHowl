import {
  formatCentiHertz,
  formatFrequencyHz,
} from "../../contracts/src";

export function formatDriveFrequencyCentiHz(
  frequencyCentiHz: number,
): string {
  return `${formatCentiHertz(frequencyCentiHz)} Hz`;
}

export function formatDriveFrequencyHz(
  frequencyHz: number,
): string {
  return formatFrequencyHz(frequencyHz);
}

export function formatCompactFrequencyHz(
  frequencyHz: number,
): string {
  if (frequencyHz >= 1_000) {
    return `${Number((frequencyHz / 1_000).toPrecision(3))}k`;
  }
  return `${Math.round(frequencyHz)}`;
}

export function logarithmicFrequencyTickHz(
  minimumHz: number,
  maximumHz: number,
  normalized: number,
): number {
  return (
    minimumHz *
    Math.pow(maximumHz / minimumHz, normalized)
  );
}
