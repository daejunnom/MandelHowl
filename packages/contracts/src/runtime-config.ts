import type {
  CanonicalOwnership,
  Sha256Hex,
} from "./contract-metadata";

export interface DialConfig {
  readonly $schema?: string;
  readonly schemaVersion: "mandelhowl.dial-config.v1";
  readonly canonicalOwner: CanonicalOwnership;
  readonly units: {
    readonly angle: "rad";
    readonly angularVelocity: "rad/s";
    readonly frequency: "Hz";
    readonly time: "s";
    readonly pointerRadius: "dial-radius-ratio";
  };
  readonly mapping: {
    readonly type: "logarithmic";
    readonly minimumFrequencyHz: number;
    readonly maximumFrequencyHz: number;
    readonly minimumUnwrappedAngleRad: number;
    readonly maximumUnwrappedAngleRad: number;
    readonly initialUnwrappedAngleRad: number;
    readonly clampFrequencyAtEndStops: true;
    readonly formula:
      "f=minHz*(maxHz/minHz)^((clamp(angle,minAngle,maxAngle)-minAngle)/(maxAngle-minAngle))";
  };
  readonly pointerSampling: {
    readonly unwrapPeriodRad: number;
    readonly minimumRadiusRatio: number;
    readonly maximumSampleGapSeconds: number;
    readonly maximumAngularDeltaPerSampleRad: number;
  };
  readonly velocityEstimator: {
    readonly historyWindowSeconds: number;
    readonly maximumAbsoluteRadPerSecond: number;
    readonly stationaryThresholdRadPerSecond: number;
    readonly approachDirectionThresholdHzPerSecond: number;
  };
  readonly inertia: {
    readonly enabled: true;
    readonly maximumInitialRadPerSecond: number;
    readonly frictionRadPerSecondSquared: number;
    readonly stopThresholdRadPerSecond: number;
    readonly maximumDurationSeconds: number;
  };
  readonly endStops: {
    readonly maximumOverscrollRad: number;
    readonly springStiffnessPerSecondSquared: number;
    readonly dampingPerSecond: number;
  };
  readonly keyboard: {
    readonly arrowStepRad: number;
    readonly pageStepRad: number;
    readonly homeEndMoveToPhysicalLimits: true;
  };
  readonly wheel: {
    readonly radiansPerDeltaPixel: number;
    readonly maximumDeltaRadPerEvent: number;
  };
  readonly resonanceResistance: {
    readonly maximumCounterTorqueNormalized: number;
    readonly maximumVisualJitterRad: number;
  };
  readonly determinism: {
    readonly timestampUnit: "s";
    readonly tieBreak: "input-sequence";
    readonly randomSource: "forbidden";
  };
}

export interface VolumeMapSpec {
  readonly $schema?: string;
  readonly schemaVersion: "mandelhowl.volume-map.v1";
  readonly canonicalOwner: CanonicalOwnership;
  readonly units: {
    readonly input: "virtual-normalized-rms";
    readonly output: "integer-0-to-100";
    readonly time: "s";
    readonly level: "dB-relative-to-virtual-limiter";
  };
  readonly measurement: {
    readonly rmsWindowSeconds: number;
    readonly minimumObservationSeconds: number;
    readonly stabilityWindowSeconds: number;
    readonly maximumRelativeRmsSlopePerSecond: number;
    readonly confirmationHoldSeconds: number;
  };
  readonly mapping: {
    readonly noiseFloorRms: number;
    readonly saturationRms: number;
    readonly curve: "logarithmic-db";
    readonly rounding: "nearest-integer";
    readonly belowNoiseFloor: 0;
    readonly atOrAboveSaturation: 100;
    readonly intermediateRange: readonly [1, 99];
    readonly dbDefinition: "20*log10(x)";
    readonly formula:
      "round(1+98*clamp(db(rms/noiseFloor)/db(saturation/noiseFloor),0,1))";
  };
  readonly display: {
    readonly widthDigits: 3;
    readonly measuringLabel: "MEASURING";
    readonly preserveLastSettledValueWhileMeasuring: true;
  };
}

export interface AudioSafetySpec {
  readonly $schema?: string;
  readonly schemaVersion: "mandelhowl.audio-safety.v1";
  readonly canonicalOwner: CanonicalOwnership;
  readonly units: {
    readonly time: "s";
    readonly frequency: "Hz";
    readonly level: "dBFS";
    readonly gain: "linear";
  };
  readonly activation: {
    readonly requiresUserGesture: true;
    readonly microphonePermission: "forbidden";
    readonly simulationRunsBeforeActivation: true;
  };
  readonly sourceMapping: {
    readonly source: "feedback-envelope-normalized";
    readonly directVirtualVolumeMapping: "forbidden";
    readonly maximumOutputGainLinear: number;
    readonly exponent: number;
  };
  readonly chain: readonly [
    "dc-blocker",
    "band-limiter",
    "soft-clipper",
    "rms-limiter",
    "peak-limiter",
    "gain-smoother",
  ];
  readonly bandLimiter: {
    readonly highPassHz: number;
    readonly lowPassHz: number;
    readonly q: number;
  };
  readonly softClipper: {
    readonly drive: number;
  };
  readonly rmsLimiter: {
    readonly maximumRmsDbfs: number;
    readonly windowSeconds: number;
    readonly attackSeconds: number;
    readonly releaseSeconds: number;
  };
  readonly peakLimiter: {
    readonly ceilingDbfs: number;
    readonly lookAheadSeconds: number;
    readonly releaseSeconds: number;
  };
  readonly gainSmoothing: {
    readonly maximumChangeDbPerSecond: number;
    readonly startupFadeSeconds: number;
    readonly hiddenFadeSeconds: number;
    readonly errorFadeSeconds: number;
  };
  readonly exposureGuard: {
    readonly highFrequencyThresholdHz: number;
    readonly maximumContinuousHighFrequencySeconds: number;
    readonly attenuationDb: number;
    readonly maximumContinuousSaturationSeconds: number;
  };
  readonly lifecycle: {
    readonly suspendWhenDocumentHidden: true;
    readonly fadeBeforeSuspend: true;
    readonly invalidNumberPolicy: "mute-and-diagnose";
  };
}

export interface RuntimeConfig {
  readonly schemaVersion: "mandelhowl.runtime-config.v1";
  readonly datasetManifestUrl: string;
  readonly expectedDatasetId: `sha256:${string}`;
  readonly dialConfig: {
    readonly url: string;
    readonly sha256: Sha256Hex;
  };
  readonly feedbackSpec: {
    readonly url: string;
    readonly sha256: Sha256Hex;
  };
  readonly volumeMapSpec: {
    readonly url: string;
    readonly sha256: Sha256Hex;
  };
  readonly audioSafetySpec: {
    readonly url: string;
    readonly sha256: Sha256Hex;
  };
}
