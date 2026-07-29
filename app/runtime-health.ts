import type { AudioSafetyTelemetry } from "@/packages/audio-engine/src";
import type { PlateRendererStatus } from "@/packages/render-engine/src";
import type { SnapshotFanoutMetrics } from "./snapshot-fanout";

export interface MandelHowlHealthSnapshot {
  readonly capturedAtMs: number;
  /** Owned immutable presentation snapshots (React/challenge/diagnostics). */
  readonly presentationFanout: SnapshotFanoutMetrics;
  /** Reusable synchronous leases (renderer/audio). */
  readonly hotPathFanout: SnapshotFanoutMetrics;
  readonly renderer: PlateRendererStatus | null;
  readonly audio: AudioSafetyTelemetry;
  readonly animationFrames: number;
  readonly frameWorkP95Ms: number;
  readonly longestFrameWorkMs: number;
  readonly longestFrameDeltaMs: number;
  readonly visibilityCycles: number;
  readonly pausedGapResets: number;
  readonly runtime: {
    readonly sequence: number;
    readonly simulationTimeSeconds: number;
    readonly driveFrequencyHz: number;
    readonly activeModeId: string | null;
  };
}

export interface RuntimeHealthHook {
  readonly getSnapshot: () => MandelHowlHealthSnapshot;
}

declare global {
  interface Window {
    __MANDELHOWL_HEALTH__?: RuntimeHealthHook;
    __MANDELHOWL_DATASET_URL__?: string;
  }
}

/**
 * Test/soak hook with no mutation commands. It makes node-count and frame
 * accumulation observable without granting an alternate experiment input.
 */
export function installRuntimeHealthHook(
  getSnapshot: () => MandelHowlHealthSnapshot,
): () => void {
  if (typeof window === "undefined") return () => {};
  const hook = Object.freeze({ getSnapshot });
  Object.defineProperty(window, "__MANDELHOWL_HEALTH__", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: hook,
  });
  return () => {
    if (window.__MANDELHOWL_HEALTH__ === hook) {
      delete window.__MANDELHOWL_HEALTH__;
    }
  };
}
