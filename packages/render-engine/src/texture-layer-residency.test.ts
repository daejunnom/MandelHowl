import { describe, expect, it } from "vitest";
import { TopKTextureLayerResidency } from "./texture-layer-residency";

describe("top-K texture layer residency", () => {
  it("retains selected layers and deterministically evicts non-top-K slots", () => {
    const residency = new TopKTextureLayerResidency(
      ["a", "b", "c", "d", "e", "f"],
      4,
    );
    const first = residency.update(["a", "b", "c", "d"]);
    expect([...first.selectedResidentLayers]).toEqual([0, 1, 2, 3]);
    expect([...first.changedResidentSlots.slice(0, first.changedCount)]).toEqual(
      [0, 1, 2, 3],
    );

    const second = residency.update(["d", "b", "e", "f"]);
    expect(second).toBe(first);
    expect([...second.selectedResidentLayers]).toEqual([3, 1, 0, 2]);
    expect([...second.changedResidentSlots.slice(0, second.changedCount)]).toEqual(
      [0, 2],
    );
    expect(second.residentModeIds).toEqual(["e", "b", "f", "d"]);

    const stable = residency.update(["d", "b", "e", "f"]);
    expect(stable.changedCount).toBe(0);
    expect([...stable.selectedResidentLayers]).toEqual([3, 1, 0, 2]);
  });

  it("leaves unknown and empty selections unbound without inventing data", () => {
    const residency = new TopKTextureLayerResidency(["known"], 1);
    const selection = residency.update(["unknown"]);
    expect([...selection.selectedResidentLayers]).toEqual([-1]);
    expect(selection.changedCount).toBe(0);
    expect(selection.residentModeIds).toEqual([null]);
  });
});
