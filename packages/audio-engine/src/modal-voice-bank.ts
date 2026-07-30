import type { ModalSnapshot } from "../../contracts/src";

export interface AudibleModalVoiceBuffer {
  readonly modeIndices: Int32Array;
  readonly frequenciesHz: Float64Array;
  readonly weights: Float64Array;
  count: number;
}

export function createAudibleModalVoiceBuffer(
  capacity: number,
): AudibleModalVoiceBuffer {
  const safeCapacity = Math.max(0, Math.floor(capacity));
  return {
    modeIndices: new Int32Array(safeCapacity),
    frequenciesHz: new Float64Array(safeCapacity),
    weights: new Float64Array(safeCapacity),
    count: 0,
  };
}

function resetVoiceBuffer(target: AudibleModalVoiceBuffer): void {
  target.modeIndices.fill(-1);
  target.frequenciesHz.fill(0);
  target.weights.fill(0);
  target.count = 0;
}

function isValidMode(mode: ModalSnapshot): boolean {
  return (
    mode.modeId.length > 0 &&
    Number.isFinite(mode.naturalFrequencyHz) &&
    mode.naturalFrequencyHz > 0 &&
    Number.isFinite(mode.amplitudeNormalized) &&
    mode.amplitudeNormalized >= 0 &&
    mode.amplitudeNormalized <= 1 &&
    Number.isFinite(mode.energyNormalized) &&
    mode.energyNormalized >= 0 &&
    mode.energyNormalized <= 1 &&
    Number.isFinite(mode.audibleWeightNormalized) &&
    mode.audibleWeightNormalized >= -1 &&
    mode.audibleWeightNormalized <= 1 &&
    Number.isFinite(mode.phaseRad) &&
    Math.abs(
      mode.amplitudeNormalized * mode.amplitudeNormalized -
        mode.energyNormalized,
    ) <= 1e-6
  );
}

function insertVoice(
  target: AudibleModalVoiceBuffer,
  modeIndex: number,
  frequencyHz: number,
  weight: number,
): void {
  const capacity = target.weights.length;
  if (capacity === 0) return;
  let insertion = target.count;
  const magnitude = Math.abs(weight);
  for (let index = 0; index < target.count; index += 1) {
    const existingWeight = target.weights[index] ?? 0;
    const existingModeIndex = target.modeIndices[index] ?? -1;
    if (
      magnitude > Math.abs(existingWeight) ||
      (magnitude === Math.abs(existingWeight) &&
        modeIndex < existingModeIndex)
    ) {
      insertion = index;
      break;
    }
  }
  if (insertion >= capacity) return;
  const nextCount = Math.min(capacity, target.count + 1);
  for (let index = nextCount - 1; index > insertion; index -= 1) {
    target.modeIndices[index] = target.modeIndices[index - 1] ?? -1;
    target.frequenciesHz[index] =
      target.frequenciesHz[index - 1] ?? 0;
    target.weights[index] = target.weights[index - 1] ?? 0;
  }
  target.modeIndices[insertion] = modeIndex;
  target.frequenciesHz[insertion] = frequencyHz;
  target.weights[insertion] = weight;
  target.count = nextCount;
}

/**
 * Projects the strongest canonical modal states into fixed backing arrays.
 * Returns false, and clears the bank, if any scientific mode value is invalid;
 * a partially trusted bank must never reach AudioParams.
 */
export function writeAudibleModalVoices(
  modes: readonly ModalSnapshot[],
  minimumEnergyNormalized: number,
  target: AudibleModalVoiceBuffer,
): boolean {
  resetVoiceBuffer(target);
  const minimumEnergy = Math.max(
    0,
    Number.isFinite(minimumEnergyNormalized)
      ? minimumEnergyNormalized
      : 0,
  );
  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    if (!mode || !isValidMode(mode)) {
      resetVoiceBuffer(target);
      return false;
    }
    if (mode.energyNormalized < minimumEnergy) continue;
    const weight =
      mode.amplitudeNormalized *
      mode.audibleWeightNormalized *
      Math.cos(mode.phaseRad);
    if (weight === 0) continue;
    insertVoice(
      target,
      index,
      mode.naturalFrequencyHz,
      weight,
    );
  }

  let weightSum = 0;
  for (let index = 0; index < target.count; index += 1) {
    weightSum += Math.abs(target.weights[index] ?? 0);
  }
  if (weightSum > 0) {
    for (let index = 0; index < target.count; index += 1) {
      target.weights[index] =
        (target.weights[index] ?? 0) / weightSum;
    }
  }
  return true;
}
