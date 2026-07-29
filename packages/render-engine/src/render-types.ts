import type { DiagnosticRecord } from "../../contracts/src/diagnostic-record";
import type { RuntimeSnapshot } from "../../contracts/src/runtime-snapshot";

export type RenderQualityTier = "high" | "balanced" | "reduced" | "canvas";
export type PlateRendererKind = "webgl2" | "canvas2d" | "static";

export type PlateTextureKind =
  "signed-displacement" | "normal" | "nodal-mask" | "sand-density";

export function expectedPlateTextureChannels(
  kind: PlateTextureKind,
): 1 | 2 {
  return kind === "normal" ? 2 : 1;
}

export interface PlateTextureAtlasSource {
  readonly kind: PlateTextureKind;
  readonly url: string;
  readonly mediaType: string;
  readonly modeIds: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  /** Integrity-verified bytes from asset-runtime; preferred over refetching. */
  readonly bytes?: Uint8Array;
}

/**
 * Browser-facing projection of an already integrity-verified runtime dataset.
 * Hash checking belongs to asset-runtime; renderer implementations receive
 * immutable URLs and layer metadata but never infer domain physics.
 */
export interface PlateTextureSource {
  readonly datasetId: string;
  readonly atlases: readonly PlateTextureAtlasSource[];
}

export interface RenderPreferences {
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly preferredQuality?: Exclude<RenderQualityTier, "canvas">;
}

export interface PlateRendererStatus {
  readonly kind: PlateRendererKind;
  readonly quality: RenderQualityTier;
  readonly datasetId: string | null;
  readonly textureReady: boolean;
  readonly contextLost: boolean;
  readonly framesRendered: number;
}

export interface PlateRendererOptions {
  readonly preferences: RenderPreferences;
  readonly logicalProcessors?: number | null;
  readonly deviceMemoryGb?: number | null;
  /** Canonical orders for the explicitly labelled analytical fixture only. */
  readonly fallbackModes?: readonly {
    readonly modeId: string;
    readonly radialOrder: number;
    readonly angularOrder: number;
  }[];
  readonly onDiagnostic?: (diagnostic: DiagnosticRecord) => void;
  readonly onStatus?: (status: PlateRendererStatus) => void;
}

export interface PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly status: PlateRendererStatus;
  setTextureSource(source: PlateTextureSource | null): Promise<void>;
  render(snapshot: RuntimeSnapshot): void;
  resize(): void;
  dispose(): void;
}

export interface RenderFrame {
  readonly dominantModeId: string | null;
  readonly dominantModePhase: number;
  readonly envelope: number;
}

type MutableRenderFrame = {
  dominantModeId: string | null;
  dominantModePhase: number;
  envelope: number;
};

/**
 * Reuses the small render projection on the animation hot path. The returned
 * view is valid only until the next `update` call and must not be retained.
 */
export class RenderFrameTracker {
  private readonly output: MutableRenderFrame;

  constructor(initialSnapshot: RuntimeSnapshot) {
    this.output = {
      dominantModeId: null,
      dominantModePhase: 0,
      envelope: 0,
    };
    this.update(initialSnapshot);
  }

  update(snapshot: RuntimeSnapshot): RenderFrame {
    let dominantModeId: string | null = null;
    let dominantModePhase = 0;
    let strongestEnergy = 1e-7;
    for (let index = 0; index < snapshot.modes.length; index += 1) {
      const mode = snapshot.modes[index];
      if (mode && mode.energyNormalized > strongestEnergy) {
        strongestEnergy = mode.energyNormalized;
        dominantModeId = mode.modeId;
        dominantModePhase = mode.phaseRad;
      }
    }
    this.output.dominantModeId = dominantModeId;
    this.output.dominantModePhase = dominantModePhase;
    this.output.envelope = Math.min(
      1,
      Math.max(0, snapshot.feedback.envelopeNormalized),
    );
    return this.output;
  }
}

export interface ModalBlendSelection {
  /**
   * Reused fixed-capacity output. Only entries below `count` are valid.
   * Sand weights are normalized across the selected modes.
   */
  readonly modeIds: readonly (string | null)[];
  readonly sandWeights: Float32Array;
  /**
   * Signed modal displacement coefficient:
   * amplitudeNormalized * cos(phaseRad).
   */
  readonly displacementWeights: Float32Array;
  readonly count: number;
  /** Overall modal presence before selected sand weights are normalized. */
  readonly presence: number;
}

type MutableModalBlendSelection = {
  modeIds: (string | null)[];
  sandWeights: Float32Array;
  displacementWeights: Float32Array;
  count: number;
  presence: number;
};

const VISUAL_ATTACK_SECONDS = 0.035;
const VISUAL_RELEASE_SECONDS = 0.58;
const ACTIVE_CAPTURE_FLOOR = 0.085;
const MAX_VISUAL_STEP_SECONDS = 0.1;
const MIN_MODAL_WEIGHT = 1e-6;

/**
 * Deterministic visual mixer for the pre-baked modal basis.
 *
 * Physics remains entirely in resonance-engine. This tracker only supplies
 * the handoff-prescribed visual attack and sand residual while reusing typed
 * buffers so the render loop does not create one object per mode per frame.
 */
export class ModalBlendTracker {
  private datasetId: RuntimeSnapshot["datasetId"] | null = null;
  private modeIds: string[] = [];
  private residualWeights = new Float32Array(0);
  private selectedIndices: Int32Array;
  private selectedScores: Float32Array;
  private lastSimulationTimeSeconds: number | null = null;
  private readonly outputModeIds: (string | null)[];
  private readonly outputSandWeights: Float32Array;
  private readonly outputDisplacementWeights: Float32Array;
  private readonly output: MutableModalBlendSelection;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Modal blend capacity must be a positive integer.");
    }
    this.selectedIndices = new Int32Array(capacity);
    this.selectedScores = new Float32Array(capacity);
    this.outputModeIds = Array.from({ length: capacity }, () => null);
    this.outputSandWeights = new Float32Array(capacity);
    this.outputDisplacementWeights = new Float32Array(capacity);
    this.output = {
      modeIds: this.outputModeIds,
      sandWeights: this.outputSandWeights,
      displacementWeights: this.outputDisplacementWeights,
      count: 0,
      presence: 0,
    };
  }

  update(snapshot: RuntimeSnapshot): ModalBlendSelection {
    const layoutChanged =
      snapshot.datasetId !== this.datasetId ||
      snapshot.modes.length !== this.modeIds.length ||
      snapshot.modes.some((mode, index) => mode.modeId !== this.modeIds[index]);
    const timeReset =
      this.lastSimulationTimeSeconds !== null &&
      snapshot.simulationTimeSeconds < this.lastSimulationTimeSeconds;

    if (layoutChanged || timeReset) {
      this.resetLayout(snapshot);
    }

    const isFirstFrame = this.lastSimulationTimeSeconds === null;
    const elapsedSeconds = isFirstFrame
      ? 0
      : Math.min(
          MAX_VISUAL_STEP_SECONDS,
          Math.max(
            0,
            snapshot.simulationTimeSeconds -
              (this.lastSimulationTimeSeconds ?? 0),
          ),
        );
    const attack = isFirstFrame
      ? 1
      : 1 - Math.exp(-elapsedSeconds / VISUAL_ATTACK_SECONDS);
    const release = isFirstFrame
      ? 1
      : 1 - Math.exp(-elapsedSeconds / VISUAL_RELEASE_SECONDS);
    let activeIndex = -1;

    for (let index = 0; index < snapshot.modes.length; index += 1) {
      const mode = snapshot.modes[index];
      const target = Math.min(1, Math.max(0, mode.energyNormalized));
      let current = this.residualWeights[index] ?? 0;
      const coefficient = target > current ? attack : release;
      current += (target - current) * coefficient;
      if (mode.modeId === snapshot.activeModeId) {
        activeIndex = index;
        // Capture identity is known synchronously by resonance-engine. The
        // small visual floor makes it observable on the very next paint while
        // older modal energy continues its deterministic release.
        current = Math.max(current, ACTIVE_CAPTURE_FLOOR);
      }
      this.residualWeights[index] = current < MIN_MODAL_WEIGHT ? 0 : current;
    }

    this.lastSimulationTimeSeconds = snapshot.simulationTimeSeconds;
    this.selectStrongest(activeIndex);
    this.populateOutput(snapshot);
    return this.output;
  }

  reset(): void {
    this.datasetId = null;
    this.modeIds = [];
    this.residualWeights = new Float32Array(0);
    this.lastSimulationTimeSeconds = null;
    this.clearOutput();
  }

  private resetLayout(snapshot: RuntimeSnapshot): void {
    this.datasetId = snapshot.datasetId;
    this.modeIds = snapshot.modes.map((mode) => mode.modeId);
    this.residualWeights = new Float32Array(snapshot.modes.length);
    this.lastSimulationTimeSeconds = null;
    this.clearOutput();
  }

  private selectStrongest(activeIndex: number): void {
    this.selectedIndices.fill(-1);
    this.selectedScores.fill(-1);
    let selectedCount = 0;

    for (
      let modeIndex = 0;
      modeIndex < this.residualWeights.length;
      modeIndex += 1
    ) {
      const score = this.residualWeights[modeIndex] ?? 0;
      if (score <= 0) continue;

      if (selectedCount === this.capacity) {
        const last = this.capacity - 1;
        const lastScore = this.selectedScores[last] ?? -1;
        const lastIndex = this.selectedIndices[last] ?? -1;
        if (
          score < lastScore ||
          (score === lastScore && modeIndex > lastIndex)
        ) {
          continue;
        }
      }
      let insertAt = Math.min(selectedCount, this.capacity - 1);
      while (
        insertAt > 0 &&
        (score > this.selectedScores[insertAt - 1] ||
          (score === this.selectedScores[insertAt - 1] &&
            modeIndex < this.selectedIndices[insertAt - 1]))
      ) {
        if (insertAt < this.capacity) {
          this.selectedScores[insertAt] = this.selectedScores[insertAt - 1];
          this.selectedIndices[insertAt] = this.selectedIndices[insertAt - 1];
        }
        insertAt -= 1;
      }
      if (insertAt < this.capacity) {
        this.selectedScores[insertAt] = score;
        this.selectedIndices[insertAt] = modeIndex;
        selectedCount = Math.min(this.capacity, selectedCount + 1);
      }
    }

    if (
      activeIndex >= 0 &&
      this.residualWeights[activeIndex] > 0 &&
      !this.containsSelected(activeIndex, selectedCount)
    ) {
      const slot = Math.min(this.capacity - 1, selectedCount);
      this.selectedIndices[slot] = activeIndex;
      this.selectedScores[slot] = this.residualWeights[activeIndex];
      selectedCount = Math.min(this.capacity, selectedCount + 1);
    }

    this.output.count = selectedCount;
  }

  private containsSelected(index: number, count: number): boolean {
    for (let slot = 0; slot < count; slot += 1) {
      if (this.selectedIndices[slot] === index) return true;
    }
    return false;
  }

  private populateOutput(snapshot: RuntimeSnapshot): void {
    let selectedTotal = 0;
    for (let slot = 0; slot < this.output.count; slot += 1) {
      const modeIndex = this.selectedIndices[slot] ?? -1;
      selectedTotal +=
        modeIndex >= 0 ? (this.residualWeights[modeIndex] ?? 0) : 0;
    }

    this.output.presence = Math.min(1, Math.sqrt(selectedTotal));
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (slot >= this.output.count || selectedTotal <= 0) {
        this.outputModeIds[slot] = null;
        this.outputSandWeights[slot] = 0;
        this.outputDisplacementWeights[slot] = 0;
        continue;
      }
      const modeIndex = this.selectedIndices[slot] ?? -1;
      const mode = snapshot.modes[modeIndex];
      const residual = this.residualWeights[modeIndex] ?? 0;
      this.outputModeIds[slot] = mode?.modeId ?? null;
      this.outputSandWeights[slot] = residual / selectedTotal;
      this.outputDisplacementWeights[slot] = mode
        ? Math.max(0, mode.amplitudeNormalized) * Math.cos(mode.phaseRad)
        : 0;
    }
  }

  private clearOutput(): void {
    this.output.count = 0;
    this.output.presence = 0;
    this.selectedIndices.fill(-1);
    this.selectedScores.fill(-1);
    this.outputModeIds.fill(null);
    this.outputSandWeights.fill(0);
    this.outputDisplacementWeights.fill(0);
  }
}

export function frameFromSnapshot(snapshot: RuntimeSnapshot): RenderFrame {
  return new RenderFrameTracker(snapshot).update(snapshot);
}

export function selectRenderQuality(
  renderer: PlateRendererKind,
  preferences: RenderPreferences,
  hardware: {
    readonly logicalProcessors?: number | null;
    readonly deviceMemoryGb?: number | null;
  } = {},
): RenderQualityTier {
  if (renderer !== "webgl2") return "canvas";
  if (preferences.reducedMotion || preferences.forcedColors) return "reduced";
  if (preferences.preferredQuality) return preferences.preferredQuality;

  const processors = hardware.logicalProcessors ?? 4;
  const memory = hardware.deviceMemoryGb ?? 4;
  return processors >= 8 && memory >= 6 ? "high" : "balanced";
}
