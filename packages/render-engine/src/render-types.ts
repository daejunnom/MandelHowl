import type { DiagnosticRecord } from "../../contracts/src/diagnostic-record";
import type { RuntimeSnapshot } from "../../contracts/src/runtime-snapshot";

export type RenderQualityTier = "high" | "balanced" | "reduced" | "canvas";
export type PlateRendererKind = "webgl2" | "canvas2d" | "static";

export type PlateTextureKind =
  | "signed-displacement"
  | "normal"
  | "nodal-mask"
  | "sand-density";

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
  readonly snapshot: RuntimeSnapshot;
  readonly dominantModeId: string | null;
  readonly dominantModePhase: number;
  readonly envelope: number;
}

export function frameFromSnapshot(snapshot: RuntimeSnapshot): RenderFrame {
  let dominantModeId: string | null = null;
  let dominantModePhase = 0;
  let strongestEnergy = 1e-7;

  snapshot.modes.forEach((mode) => {
    if (mode.energyNormalized > strongestEnergy) {
      strongestEnergy = mode.energyNormalized;
      dominantModeId = mode.modeId;
      dominantModePhase = mode.phaseRad;
    }
  });

  return {
    snapshot,
    dominantModeId,
    dominantModePhase,
    envelope: Math.min(
      1,
      Math.max(0, snapshot.feedback.envelopeNormalized),
    ),
  };
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
