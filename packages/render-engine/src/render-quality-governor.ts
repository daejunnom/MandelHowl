import {
  GENERATED_PERFORMANCE_BUDGET_SPEC,
  GENERATED_RENDER_QUALITY_TIERS_SPEC,
} from "../../contracts/src";

export type RenderDegradationStage = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const RENDER_DEGRADATION_LABELS = Object.freeze([
  "full",
  ...GENERATED_RENDER_QUALITY_TIERS_SPEC.degradationOrder,
] as const);

export interface RenderQualityGovernorOptions {
  readonly sampleWindow?: number;
  readonly frameBudgetMs?: number;
  readonly percentile?: number;
  readonly requiredOverBudgetWindows?: number;
}

/**
 * One-way runtime quality governor.
 *
 * A whole sample window must be over budget before one degradation step is
 * selected. Requiring consecutive windows prevents isolated GC, resize, and
 * asset-upload frames from lowering quality. It never changes or even reads
 * the canonical modal/feedback state.
 */
export class RenderQualityGovernor {
  private readonly samples: Float32Array;
  private readonly orderedSamples: Float32Array;
  private readonly frameBudgetMs: number;
  private readonly percentile: number;
  private readonly requiredOverBudgetWindows: number;
  private writeIndex = 0;
  private sampleCount = 0;
  private consecutiveOverBudgetWindows = 0;
  private currentStage: RenderDegradationStage = 0;

  constructor(options: RenderQualityGovernorOptions = {}) {
    const sampleWindow = Math.max(
      4,
      Math.trunc(
        options.sampleWindow ??
          GENERATED_PERFORMANCE_BUDGET_SPEC.runtimeDegradation
            .sampleWindowFrames,
      ),
    );
    this.samples = new Float32Array(sampleWindow);
    this.orderedSamples = new Float32Array(sampleWindow);
    this.frameBudgetMs = Math.max(
      1,
      options.frameBudgetMs ??
        1_000 /
          GENERATED_PERFORMANCE_BUDGET_SPEC.desktopTargetFramesPerSecond,
    );
    this.percentile = Math.min(
      1,
      Math.max(
        0.5,
        options.percentile ??
          GENERATED_PERFORMANCE_BUDGET_SPEC.runtimeDegradation.percentile,
      ),
    );
    this.requiredOverBudgetWindows = Math.max(
      1,
      Math.trunc(
        options.requiredOverBudgetWindows ??
          GENERATED_PERFORMANCE_BUDGET_SPEC.runtimeDegradation
            .requiredOverBudgetWindows,
      ),
    );
  }

  get stage(): RenderDegradationStage {
    return this.currentStage;
  }

  record(frameWorkMs: number): RenderDegradationStage {
    if (!Number.isFinite(frameWorkMs) || frameWorkMs < 0) {
      return this.currentStage;
    }
    this.samples[this.writeIndex] = frameWorkMs;
    this.writeIndex = (this.writeIndex + 1) % this.samples.length;
    this.sampleCount += 1;
    if (this.sampleCount < this.samples.length) return this.currentStage;
    this.sampleCount = 0;

    this.orderedSamples.set(this.samples);
    this.orderedSamples.sort();
    const percentileIndex = Math.max(
      0,
      Math.ceil(this.orderedSamples.length * this.percentile) - 1,
    );
    const p95 = this.orderedSamples[percentileIndex] ?? 0;
    if (p95 <= this.frameBudgetMs) {
      this.consecutiveOverBudgetWindows = 0;
      return this.currentStage;
    }

    this.consecutiveOverBudgetWindows += 1;
    if (
      this.consecutiveOverBudgetWindows >=
        this.requiredOverBudgetWindows &&
      this.currentStage < 6
    ) {
      this.currentStage = (this.currentStage + 1) as RenderDegradationStage;
      this.consecutiveOverBudgetWindows = 0;
    }
    return this.currentStage;
  }
}
