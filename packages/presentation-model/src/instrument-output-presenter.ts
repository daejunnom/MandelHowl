import { GENERATED_VOLUME_MAP_SPEC } from "../../contracts/src";

export type MeasurementStatus = "measuring" | "settled";

export interface RenderAttestationTarget {
  readonly dataset: DOMStringMap;
}

export interface RenderedVolumeSnapshot {
  readonly sequence: number;
  readonly volume: {
    readonly status: MeasurementStatus;
  };
}

/**
 * Presentation-owned evidence that a visible renderer returned successfully
 * for the exact snapshot that changed measurement state. Render and audio
 * engines remain ignorant of virtual-volume ownership.
 */
export class SettledRenderAttestationTracker {
  private readonly previousStatus = new WeakMap<
    RenderAttestationTarget,
    MeasurementStatus
  >();

  record(
    target: RenderAttestationTarget,
    snapshot: RenderedVolumeSnapshot,
  ): void {
    const status = snapshot.volume.status;
    if (status === this.previousStatus.get(target)) return;
    this.previousStatus.set(target, status);
    if (status === "settled") {
      target.dataset.settledSnapshotSequence = String(snapshot.sequence);
    } else {
      delete target.dataset.settledSnapshotSequence;
    }
  }

  clear(target: RenderAttestationTarget): void {
    this.previousStatus.delete(target);
    delete target.dataset.settledSnapshotSequence;
  }
}

export function formatVirtualVolume(value: number): string {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.min(100, Math.max(0, Math.round(finite)))
    .toString()
    .padStart(GENERATED_VOLUME_MAP_SPEC.display.widthDigits, "0");
}

export function measurementStatusLabel(
  status: MeasurementStatus,
): string {
  return status === "measuring"
    ? GENERATED_VOLUME_MAP_SPEC.display.measuringLabel
    : "SETTLED";
}
