import { describe, expect, it } from "vitest";
import { GENERATED_VOLUME_MAP_SPEC } from "../../contracts/src";
import {
  formatVirtualVolume,
  measurementStatusLabel,
  SettledRenderAttestationTracker,
} from "./instrument-output-presenter";

describe("canonical instrument output presentation", () => {
  it("uses the generated volume display width and measuring label", () => {
    expect(formatVirtualVolume(7)).toBe(
      "7".padStart(
        GENERATED_VOLUME_MAP_SPEC.display.widthDigits,
        "0",
      ),
    );
    expect(measurementStatusLabel("measuring")).toBe(
      GENERATED_VOLUME_MAP_SPEC.display.measuringLabel,
    );
    expect(measurementStatusLabel("settled")).toBe("SETTLED");
  });

  it("clamps malformed display-only values to the integer result domain", () => {
    expect(formatVirtualVolume(Number.NaN)).toBe("000");
    expect(formatVirtualVolume(-3)).toBe("000");
    expect(formatVirtualVolume(140)).toBe("100");
  });

  it("attests only a successful measuring-to-settled presentation transition", () => {
    const tracker = new SettledRenderAttestationTracker();
    const target = { dataset: {} as DOMStringMap };
    const measuring = {
      sequence: 8,
      volume: { status: "measuring" as const },
    };
    const settled = {
      sequence: 9,
      volume: { status: "settled" as const },
    };

    tracker.record(target, measuring);
    expect(target.dataset.settledSnapshotSequence).toBeUndefined();
    tracker.record(target, settled);
    expect(target.dataset.settledSnapshotSequence).toBe("9");
    tracker.record(target, { ...settled, sequence: 10 });
    expect(target.dataset.settledSnapshotSequence).toBe("9");
    tracker.record(target, { ...measuring, sequence: 11 });
    expect(target.dataset.settledSnapshotSequence).toBeUndefined();
    tracker.clear(target);
    expect(target.dataset.settledSnapshotSequence).toBeUndefined();
  });
});
