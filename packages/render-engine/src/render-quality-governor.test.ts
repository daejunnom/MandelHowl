import { describe, expect, it } from "vitest";
import {
  GENERATED_PERFORMANCE_BUDGET_SPEC,
  GENERATED_RENDER_QUALITY_TIERS_SPEC,
} from "../../contracts/src";
import {
  RENDER_DEGRADATION_LABELS,
  RenderQualityGovernor,
} from "./render-quality-governor";

describe("runtime render quality governor", () => {
  it("follows the handoff degradation order under sustained pressure", () => {
    const governor = new RenderQualityGovernor({
      sampleWindow: 4,
      frameBudgetMs: 20,
      requiredOverBudgetWindows: 1,
    });

    const handoffOrder = [
      "reduce-sand-residual",
      "reduce-normal-resolution",
      "disable-post-processing",
      "reduce-oscilloscope-samples",
      "reduce-internal-resolution",
      "switch-to-canvas-data",
    ];
    expect(
      GENERATED_RENDER_QUALITY_TIERS_SPEC.degradationOrder,
    ).toEqual(handoffOrder);
    expect(RENDER_DEGRADATION_LABELS).toEqual([
      "full",
      ...handoffOrder,
    ]);
    for (let stage = 1; stage <= 6; stage += 1) {
      for (let frame = 0; frame < 4; frame += 1) {
        governor.record(28);
      }
      expect(governor.stage).toBe(stage);
    }
  });

  it("ignores isolated long frames and never oscillates quality", () => {
    const governor = new RenderQualityGovernor({
      sampleWindow: 4,
      frameBudgetMs: 20,
      requiredOverBudgetWindows: 2,
    });

    for (const duration of [4, 5, 72, 4]) governor.record(duration);
    for (const duration of [4, 4, 4, 4]) governor.record(duration);
    expect(governor.stage).toBe(0);

    for (let frame = 0; frame < 8; frame += 1) governor.record(30);
    expect(governor.stage).toBe(1);
    for (let frame = 0; frame < 40; frame += 1) governor.record(3);
    expect(governor.stage).toBe(1);
  });

  it("rejects invalid telemetry without degrading", () => {
    const governor = new RenderQualityGovernor({
      sampleWindow: 4,
      requiredOverBudgetWindows: 1,
    });
    governor.record(Number.NaN);
    governor.record(Number.POSITIVE_INFINITY);
    governor.record(-1);
    expect(governor.stage).toBe(0);
  });

  it("uses the canonical 60 FPS performance budget by default", () => {
    const governor = new RenderQualityGovernor({
      sampleWindow: 4,
      requiredOverBudgetWindows: 1,
    });
    for (let frame = 0; frame < 4; frame += 1) {
      governor.record(16.8);
    }
    expect(governor.stage).toBe(1);
  });

  it("derives its default window policy from the canonical visual budget", () => {
    const governor = new RenderQualityGovernor();
    const { sampleWindowFrames, requiredOverBudgetWindows } =
      GENERATED_PERFORMANCE_BUDGET_SPEC.runtimeDegradation;
    for (
      let frame = 0;
      frame < sampleWindowFrames * requiredOverBudgetWindows - 1;
      frame += 1
    ) {
      governor.record(40);
    }
    expect(governor.stage).toBe(0);
    governor.record(40);
    expect(governor.stage).toBe(1);
  });
});
