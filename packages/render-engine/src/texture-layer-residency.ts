export interface TextureLayerResidencySelection {
  /** GPU-resident layer for each selected modal slot, or -1. */
  readonly selectedResidentLayers: Float32Array;
  /** Resident slots whose texels must be replaced this update. */
  readonly changedResidentSlots: Int16Array;
  readonly changedCount: number;
  readonly residentModeIds: readonly (string | null)[];
}

type MutableTextureLayerResidencySelection = {
  selectedResidentLayers: Float32Array;
  changedResidentSlots: Int16Array;
  changedCount: number;
  residentModeIds: (string | null)[];
};

/**
 * Fixed-capacity, allocation-free top-K GPU residency planner.
 *
 * CPU KTX2 bytes remain the verified source of truth. Selected modes retain
 * their current GPU slots; newly selected modes deterministically evict the
 * lowest-numbered slot that is not part of the new top-K set.
 */
export class TopKTextureLayerResidency {
  private readonly output: MutableTextureLayerResidencySelection;

  constructor(
    readonly sourceModeIds: readonly string[],
    readonly capacity: number,
  ) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > sourceModeIds.length
    ) {
      throw new Error(
        "Texture residency capacity must fit the source layer count.",
      );
    }
    this.output = {
      selectedResidentLayers: new Float32Array(capacity).fill(-1),
      changedResidentSlots: new Int16Array(capacity).fill(-1),
      changedCount: 0,
      residentModeIds: Array.from({ length: capacity }, () => null),
    };
  }

  update(
    selectedModeIds: readonly (string | null)[],
  ): TextureLayerResidencySelection {
    const output = this.output;
    output.selectedResidentLayers.fill(-1);
    output.changedResidentSlots.fill(-1);
    output.changedCount = 0;

    const selectedCount = Math.min(this.capacity, selectedModeIds.length);
    for (let selected = 0; selected < selectedCount; selected += 1) {
      const modeId = selectedModeIds[selected] ?? null;
      if (!modeId || this.sourceModeIds.indexOf(modeId) < 0) continue;
      const residentSlot = output.residentModeIds.indexOf(modeId);
      if (residentSlot >= 0) {
        output.selectedResidentLayers[selected] = residentSlot;
      }
    }

    for (let selected = 0; selected < selectedCount; selected += 1) {
      if (output.selectedResidentLayers[selected] >= 0) continue;
      const modeId = selectedModeIds[selected] ?? null;
      if (!modeId || this.sourceModeIds.indexOf(modeId) < 0) continue;
      let replacementSlot = -1;
      for (let slot = 0; slot < this.capacity; slot += 1) {
        const residentModeId = output.residentModeIds[slot];
        if (
          residentModeId === null ||
          !this.isSelected(residentModeId, selectedModeIds, selectedCount)
        ) {
          replacementSlot = slot;
          break;
        }
      }
      if (replacementSlot < 0) continue;
      output.residentModeIds[replacementSlot] = modeId;
      output.selectedResidentLayers[selected] = replacementSlot;
      output.changedResidentSlots[output.changedCount] = replacementSlot;
      output.changedCount += 1;
    }
    return output;
  }

  private isSelected(
    modeId: string,
    selectedModeIds: readonly (string | null)[],
    selectedCount: number,
  ): boolean {
    for (let index = 0; index < selectedCount; index += 1) {
      if (selectedModeIds[index] === modeId) return true;
    }
    return false;
  }
}
