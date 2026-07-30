import type { DiagnosticRecord } from "../../contracts/src/diagnostic-record";
import type { RuntimeSnapshot } from "../../contracts/src/runtime-snapshot";
import {
  GENERATED_MOTION_SAFETY_SPEC,
  GENERATED_RENDER_QUALITY_TIERS_SPEC,
  type PlateMaterialSectionProfile,
  type RenderQualityTier as RenderQualityTierSpec,
} from "../../contracts/src";
import type { RenderDegradationStage } from "./render-quality-governor";

export type RenderQualityTier = "high" | "balanced" | "reduced" | "canvas";
export type PlateRendererKind = "webgl2" | "canvas2d" | "static";

export type PlateTextureKind =
  "signed-displacement" | "normal" | "nodal-mask" | "sand-density";

function requireGeneratedQualityTier(
  id: RenderQualityTierSpec["id"],
): RenderQualityTierSpec {
  const tier = GENERATED_RENDER_QUALITY_TIERS_SPEC.tiers.find(
    (candidate) => candidate.id === id,
  );
  if (!tier) {
    throw new Error(`Canonical render quality tier ${id} is missing.`);
  }
  return tier;
}

const RUNTIME_QUALITY_CONFIG = Object.freeze({
  high: requireGeneratedQualityTier("webgl-full"),
  balanced: requireGeneratedQualityTier("webgl-safe"),
  reduced: requireGeneratedQualityTier("webgl-reduced"),
  canvas: requireGeneratedQualityTier("canvas-data"),
});

export function renderQualityConfiguration(
  quality: RenderQualityTier,
): RenderQualityTierSpec {
  return RUNTIME_QUALITY_CONFIG[quality];
}

export function oscilloscopeSampleCountForQuality(
  quality: RenderQualityTier,
  degradationStage: number,
): number {
  return degradationStage >= 4 && quality !== "canvas"
    ? RUNTIME_QUALITY_CONFIG.canvas.oscilloscopeSamples
    : RUNTIME_QUALITY_CONFIG[quality].oscilloscopeSamples;
}

export function plateDisplacementScale(reducedMotion: boolean): number {
  return reducedMotion
    ? GENERATED_MOTION_SAFETY_SPEC.reducedMotion.plateDisplacementScale
    : 1;
}

export function expectedPlateTextureChannels(kind: PlateTextureKind): 1 | 2 {
  return kind === "normal" ? 2 : 1;
}

export const SAND_VISIBILITY_EXPONENT = 0.55;
export const SAND_MAX_OPACITY = 0.95;
export const MATERIAL_SECTION_PROFILE_SAMPLE_COUNT = 64;
/** Fixed session component required by the handoff's deterministic grain seed. */
export const RENDER_SESSION_FIXED_SEED = 0x4d_48_4f_57;

/**
 * Derives one stable uint32 from the immutable dataset identity and the fixed
 * session seed. This is presentation-only; it never enters modal physics.
 */
export function renderSeedFromDatasetId(datasetId: string | null): number {
  const identity = datasetId ?? "analytical-fallback";
  let hash = (0x81_1c_9d_c5 ^ RENDER_SESSION_FIXED_SEED) >>> 0;
  for (let index = 0; index < identity.length; index += 1) {
    const codeUnit = identity.charCodeAt(index);
    hash = Math.imul(hash ^ (codeUnit & 0xff), 0x01_00_01_93) >>> 0;
    hash = Math.imul(hash ^ (codeUnit >>> 8), 0x01_00_01_93) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7f_eb_35_2d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x84_6c_a6_8b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Presentation-only transfer curve for the already blended sand density.
 *
 * Modal weights and residuals remain untouched. The sub-linear exponent keeps
 * a newly captured, pre-baked pattern legible while preserving zero as truly
 * empty and retaining a hard opacity ceiling.
 */
export function sandVisibilityFromPresence(presence: number): number {
  if (!Number.isFinite(presence) || presence <= 0) return 0;
  return (
    SAND_MAX_OPACITY * Math.pow(Math.min(1, presence), SAND_VISIBILITY_EXPONENT)
  );
}

/**
 * Provenance-pinned local emissive envelope. The nodal basis remains spatial;
 * this scalar only enables its bounded luminance response at saturation.
 */
export function localSaturationEnvelope(
  regime: RuntimeSnapshot["regime"],
  envelopeNormalized: number,
): number {
  if (regime !== "saturated" || !Number.isFinite(envelopeNormalized)) {
    return 0;
  }
  return Math.min(1, Math.max(0, envelopeNormalized));
}

/**
 * Fail-closed projection of the verified manifest profile into a fixed GPU /
 * Canvas buffer. This is presentation decoding only: all field sampling and
 * quantization happened in the attested offline baker.
 */
export function normalizeMaterialSectionProfile(
  profile: PlateMaterialSectionProfile | null | undefined,
): Float32Array | null {
  if (
    profile?.schemaVersion !== "mandelhowl.material-section-profile.v1" ||
    profile.axis !== "x-at-y-zero" ||
    profile.sampleCount !== MATERIAL_SECTION_PROFILE_SAMPLE_COUNT ||
    !Number.isFinite(profile.minimumThicknessM) ||
    profile.minimumThicknessM <= 0 ||
    !Number.isFinite(profile.maximumThicknessM) ||
    profile.maximumThicknessM <= profile.minimumThicknessM ||
    !Array.isArray(profile.thicknessUnorm8) ||
    profile.thicknessUnorm8.length !== MATERIAL_SECTION_PROFILE_SAMPLE_COUNT
  ) {
    return null;
  }
  const normalized = new Float32Array(MATERIAL_SECTION_PROFILE_SAMPLE_COUNT);
  for (
    let index = 0;
    index < MATERIAL_SECTION_PROFILE_SAMPLE_COUNT;
    index += 1
  ) {
    const sample = profile.thicknessUnorm8[index];
    if (
      typeof sample !== "number" ||
      !Number.isInteger(sample) ||
      sample < 0 ||
      sample > 255
    ) {
      return null;
    }
    normalized[index] = sample / 255;
  }
  return normalized;
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
  /**
   * Deferred integrity boundary for a versioned mode shard. It must perform
   * immutable fetch, byte-length, SHA-256, and KTX2 descriptor validation.
   */
  readonly loadBytes?: (signal?: AbortSignal) => Promise<Uint8Array>;
}

export interface PlateModePresentationMetadata {
  readonly modeId: string;
  readonly radialNodeIndex: number;
  readonly radialElementCount: number;
  readonly radialDof: "value" | "slope";
  readonly angularOrder: number;
  readonly symmetry: "axisymmetric" | "cosine" | "sine";
  readonly hubRadiusRatio: number;
}

/**
 * Browser-facing projection of an already integrity-verified runtime dataset.
 * Hash checking belongs to asset-runtime; renderer implementations receive
 * immutable URLs and layer metadata but never infer domain physics.
 */
export interface PlateTextureSource {
  readonly datasetId: string;
  readonly materialSectionProfile?: PlateMaterialSectionProfile;
  /** Verified provenance projection used only while a texture shard is pending. */
  readonly presentationModes?: readonly PlateModePresentationMetadata[];
  readonly loadingPolicy?: "eager-verified" | "mode-sharded-lazy-verified";
  readonly atlases: readonly PlateTextureAtlasSource[];
}

export function evaluateDominantBasisFallback(
  mode: PlateModePresentationMetadata,
  x: number,
  y: number,
): number {
  const radius = Math.hypot(x, y);
  if (radius <= mode.hubRadiusRatio || radius > 1) return 0;
  const normalizedRadius =
    (radius - mode.hubRadiusRatio) / (1 - mode.hubRadiusRatio);
  const scaled = Math.min(
    mode.radialElementCount - Number.EPSILON,
    normalizedRadius * mode.radialElementCount,
  );
  const elementIndex = Math.floor(scaled);
  const xi = scaled - elementIndex;
  const xi2 = xi * xi;
  const xi3 = xi2 * xi;
  let radial = 0;
  if (mode.radialNodeIndex === elementIndex) {
    radial =
      mode.radialDof === "value"
        ? 1 - 3 * xi2 + 2 * xi3
        : (xi - 2 * xi2 + xi3) * 6;
  } else if (mode.radialNodeIndex === elementIndex + 1) {
    radial = mode.radialDof === "value" ? 3 * xi2 - 2 * xi3 : (-xi2 + xi3) * 6;
  }
  const angle = Math.atan2(y, x);
  const angular =
    mode.symmetry === "axisymmetric"
      ? 1
      : mode.symmetry === "cosine"
        ? Math.cos(angle * mode.angularOrder)
        : Math.sin(angle * mode.angularOrder);
  return Math.max(-1, Math.min(1, radial * angular));
}

export interface RenderPreferences {
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly preferredQuality?: Exclude<RenderQualityTier, "canvas">;
}

export interface PlateRendererStatus {
  readonly kind: PlateRendererKind;
  readonly quality: RenderQualityTier;
  readonly degradationStage: RenderDegradationStage;
  readonly datasetId: string | null;
  readonly textureReady: boolean;
  /** Exact pre-baked plate-thickness profile is decoded and renderable. */
  readonly materialSectionReady: boolean;
  readonly contextLost: boolean;
  readonly framesRendered: number;
  /** Last canonical snapshot consumed by the visible renderer. */
  readonly lastSnapshotSequence: number | null;
}

type MutablePlateRendererStatus = {
  -readonly [Key in keyof PlateRendererStatus]: PlateRendererStatus[Key];
};

/**
 * Reuses renderer telemetry on the RAF path. `view` is an ephemeral live
 * view for synchronous health reads; `update` returns an owned frozen copy
 * only for low-frequency status observers such as React/Svelte presenters.
 */
export class PlateRendererStatusTracker {
  private readonly output: MutablePlateRendererStatus;

  constructor(initial: PlateRendererStatus) {
    this.output = { ...initial };
  }

  get view(): PlateRendererStatus {
    return this.output;
  }

  recordFrame(snapshotSequence: number): void {
    this.output.framesRendered += 1;
    this.output.lastSnapshotSequence = snapshotSequence;
  }

  update(patch: Partial<PlateRendererStatus>): Readonly<PlateRendererStatus> {
    Object.assign(this.output, patch);
    return Object.freeze({ ...this.output });
  }
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

/**
 * Renderer observers belong to the presentation shell and must never become
 * part of the rendering control flow. In particular, a broken status sink
 * must not turn a healthy WebGL renderer into a false Canvas failover.
 */
export function reportPlateRendererDiagnostic(
  options: PlateRendererOptions,
  diagnostic: DiagnosticRecord,
): void {
  try {
    options.onDiagnostic?.(diagnostic);
  } catch {
    // The renderer remains authoritative; presentation observers are isolated.
  }
}

export function reportPlateRendererStatus(
  options: PlateRendererOptions,
  status: PlateRendererStatus,
): void {
  try {
    options.onStatus?.(status);
  } catch {
    // The renderer remains authoritative; presentation observers are isolated.
  }
}

export interface PlateRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly status: PlateRendererStatus;
  setTextureSource(source: PlateTextureSource | null): Promise<void>;
  render(snapshot: RuntimeSnapshot): void;
  /**
   * Reports whole-frame work to the presentation-only quality governor.
   * Implementations must never use this telemetry to modify core state.
   */
  recordFrameTiming(frameWorkMs: number): void;
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
export const ACTIVE_CAPTURE_FLOOR = 0.085;
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
  private releaseSeconds = VISUAL_RELEASE_SECONDS;
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
    let layoutChanged =
      snapshot.datasetId !== this.datasetId ||
      snapshot.modes.length !== this.modeIds.length;
    if (!layoutChanged) {
      for (let index = 0; index < snapshot.modes.length; index += 1) {
        if (snapshot.modes[index]?.modeId !== this.modeIds[index]) {
          layoutChanged = true;
          break;
        }
      }
    }
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
      : 1 - Math.exp(-elapsedSeconds / this.releaseSeconds);
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

  /**
   * Presentation-only residual control used by the first runtime degradation
   * step. It cannot alter modal energy or any canonical snapshot field.
   */
  setReleaseSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.releaseSeconds = Math.max(
      0.08,
      Math.min(VISUAL_RELEASE_SECONDS, seconds),
    );
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
