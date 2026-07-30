import { describe, expect, it } from "vitest";
import {
  CENTIHERTZ_PER_HERTZ,
  formatCentiHertz,
  formatFrequencyHz,
  fromCentiHertz,
  isFrequencyOnCentiHertzGrid,
  normalizeCentiHertz,
  quantizeFrequencyHz,
  toCentiHertz,
} from "./frequency-fixed-point";
import { GENERATED_DIAL_SPEC } from "./generated/runtime-specs.generated";

describe("frequency fixed-point contract", () => {
  it("uses the generated centihertz contract as its single scale", () => {
    expect(CENTIHERTZ_PER_HERTZ).toBe(100);
    expect(GENERATED_DIAL_SPEC.fixedPoint).toEqual({
      canonicalUnit: "centihertz",
      centihertzPerHertz: 100,
      decimalPlaces: 2,
      quantization: "nearest-centihertz",
      tieBreak: "half-away-from-zero",
      physicsBoundary: "hertz-from-centihertz",
    });
  });

  it("rounds the floating boundary once and stores a safe integer", () => {
    expect(toCentiHertz(683.1919784165848)).toBe(68_319);
    expect(toCentiHertz(1.005)).toBe(101);
    expect(toCentiHertz(-1.005)).toBe(-101);
    expect(toCentiHertz(Number.NaN, 220)).toBe(22_000);
    expect(toCentiHertz(Number.POSITIVE_INFINITY, 45)).toBe(4_500);
    expect(normalizeCentiHertz(68_319.5)).toBe(68_320);
    expect(normalizeCentiHertz(Number.NaN, 22_000)).toBe(22_000);
  });

  it("projects only centihertz values back into numerical physics", () => {
    expect(fromCentiHertz(68_319)).toBe(683.19);
    expect(quantizeFrequencyHz(683.196)).toBe(683.2);
    expect(isFrequencyOnCentiHertzGrid(683.19)).toBe(true);
    expect(isFrequencyOnCentiHertzGrid(683.191)).toBe(false);
  });

  it("formats exactly two decimal places without floating formatting", () => {
    expect(formatCentiHertz(22_000)).toBe("220.00");
    expect(formatCentiHertz(68_319)).toBe("683.19");
    expect(formatCentiHertz(600_000)).toBe("6000.00");
    expect(formatCentiHertz(-1)).toBe("-0.01");
    expect(formatFrequencyHz(1_170.005)).toBe("1170.01 Hz");
  });
});
