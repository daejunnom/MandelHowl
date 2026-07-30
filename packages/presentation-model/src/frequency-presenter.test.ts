import { describe, expect, it } from "vitest";
import {
  formatCompactFrequencyHz,
  formatDriveFrequencyCentiHz,
  formatDriveFrequencyHz,
  logarithmicFrequencyTickHz,
} from "./frequency-presenter";

describe("frequency presenter", () => {
  it("keeps exact centihertz visible across the whole dial range", () => {
    const cases = [
      [4_500, "45.00 Hz"],
      [68_319, "683.19 Hz"],
      [100_000, "1000.00 Hz"],
      [176_623, "1766.23 Hz"],
      [176_676, "1766.76 Hz"],
      [600_000, "6000.00 Hz"],
    ] as const;

    for (const [frequencyCentiHz, expected] of cases) {
      const formatted =
        formatDriveFrequencyCentiHz(frequencyCentiHz);
      expect(formatted).toBe(expected);
      expect(formatted).toMatch(/^\d+\.\d{2} Hz$/);
      expect(formatted).not.toContain("kHz");
    }
  });

  it("quantizes floating boundary values before presentation", () => {
    expect(formatDriveFrequencyHz(683.1919784165848)).toBe(
      "683.19 Hz",
    );
    expect(formatDriveFrequencyHz(999.999)).toBe("1000.00 Hz");
  });

  it("keeps compact labels separate from the exact readout", () => {
    expect(formatCompactFrequencyHz(1_170)).toBe("1.17k");
    expect(
      logarithmicFrequencyTickHz(45, 6_000, 0),
    ).toBe(45);
    expect(
      logarithmicFrequencyTickHz(45, 6_000, 1),
    ).toBe(6_000);
  });
});
