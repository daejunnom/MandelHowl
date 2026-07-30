import type { ContentAddressedId } from "./contract-metadata";
import type { DiagnosticRecord } from "./diagnostic-record";

export type ResonanceRegime =
  | "decaying"
  | "critical"
  | "growing"
  | "saturated";

export interface DialSnapshot {
  readonly unwrappedAngleRad: number;
  readonly angularVelocityRadPerSecond: number;
  /** Canonical current drive value, stored as an integer 0.01 Hz unit. */
  readonly driveFrequencyCentiHz: number;
  /** Canonical previous drive value, stored as an integer 0.01 Hz unit. */
  readonly previousDriveFrequencyCentiHz: number;
  /** Physics-boundary projection of driveFrequencyCentiHz. */
  readonly driveFrequencyHz: number;
  /** Physics-boundary projection of previousDriveFrequencyCentiHz. */
  readonly previousDriveFrequencyHz: number;
  readonly sweepRateHzPerSecond: number;
  readonly approachDirection: "decreasing" | "stationary" | "increasing";
  readonly stationaryTimeSeconds: number;
  readonly atMinimumEndStop: boolean;
  readonly atMaximumEndStop: boolean;
}

export interface ModalSnapshot {
  readonly modeId: string;
  /** Verified modal eigenfrequency used by the audible modal voice bank. */
  readonly naturalFrequencyHz: number;
  /** Signed virtual-microphone/radiation projection for audible summation. */
  readonly audibleWeightNormalized: number;
  readonly amplitudeNormalized: number;
  readonly phaseRad: number;
  readonly energyNormalized: number;
}

export interface MicrophoneSnapshot {
  readonly rmsNormalized: number;
  readonly peakNormalized: number;
  /** Oldest-to-newest normalized samples for the read-only oscilloscope. */
  readonly recentSamples: readonly number[];
}

export interface FeedbackSnapshot {
  readonly envelopeNormalized: number;
  readonly loopSignalNormalized: number;
  readonly limiterGainReductionDb: number;
  readonly limiterActive: boolean;
}

export type VolumeSnapshot =
  | {
      readonly status: "measuring";
      readonly value: null;
      readonly lastSettledValue: number | null;
      readonly progress: number;
    }
  | {
      readonly status: "settled";
      readonly value: number;
      readonly lastSettledValue: number;
      readonly progress: 1;
    };

/**
 * Canonical snapshot shape shared by every consumer.
 *
 * Retaining presentation consumers receive an owned immutable instance.
 * Renderer/audio may receive a branded synchronous lease with identical
 * values and sequence; that lease is invalidated by the next writer update.
 * Numeric property names carry their wire units; virtual normalized levels are
 * dimensionless and never represent device or operating-system volume.
 */
export interface RuntimeSnapshot {
  readonly schemaVersion: "mandelhowl.runtime-snapshot.v2";
  readonly unitSystem: "SI";
  readonly datasetId: ContentAddressedId;
  readonly sequence: number;
  readonly simulationStep: number;
  readonly simulationTimeSeconds: number;
  readonly dial: DialSnapshot;
  readonly modes: readonly ModalSnapshot[];
  /**
   * Mode captured by the current drive response, independent of residual
   * modal-energy dominance. Null means no mode currently crosses the capture
   * threshold.
   */
  readonly activeModeId: string | null;
  readonly microphone: MicrophoneSnapshot;
  readonly feedback: FeedbackSnapshot;
  readonly regime: ResonanceRegime;
  readonly volume: VolumeSnapshot;
  readonly diagnostics: readonly DiagnosticRecord[];
}
