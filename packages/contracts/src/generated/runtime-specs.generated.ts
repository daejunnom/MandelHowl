/**
 * GENERATED FILE — edit specs/runtime/*.yaml and run
 * node packages/contracts/scripts/generate-runtime-specs.mjs.
 */
import type { AudioSafetySpec, DatasetReleaseSpec, DialConfig, VolumeMapSpec } from "../runtime-config";
import type { FeedbackSpec } from "../feedback-spec";

export const RUNTIME_SPEC_SOURCE_HASHES = Object.freeze({
  "dial": "925137e2e598491618d5b598e6b53e4f4a449d1bfdb35ab220ae868c9b59970b",
  "feedback": "b8ed42cb36648b68eb079515a7bb90fccb8d6258ef6c51786f30815cf7643b49",
  "volumeMap": "7fda34e109a98993a818e488aa5e0e81566659e085aec921f1e575822539c90a",
  "audioSafety": "1fef8451c07dfbf361b4c609d5e40604d923c9a2392b6b379133ed57ab77e8bc",
  "datasetRelease": "fc63800c9ec1c14e7581df90af717719ac22d20a105753a703fdf9b67227c8b3"
} as const);

export const N_VERSION_CONTRACT_DIGESTS = Object.freeze({
  "scientificAlgorithm": "sha256:89920ff6cd53b7c0207cc795555e5e7cacc3e10fdd2daa8aaa35c6ca3511332d",
  "presentationContract": "sha256:fd531ac216689df6981ea0b40c77ee271cba848e9b831eed0763615da658a4b1"
} as const);

export const GENERATED_DIAL_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.dial-config.v1",
  "canonicalOwner": {
    "path": "specs/runtime/dial.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "units": {
    "angle": "rad",
    "angularVelocity": "rad/s",
    "frequency": "Hz",
    "time": "s",
    "pointerRadius": "dial-radius-ratio"
  },
  "mapping": {
    "type": "logarithmic",
    "minimumFrequencyHz": 45,
    "maximumFrequencyHz": 6000,
    "minimumUnwrappedAngleRad": -9.42477796076938,
    "maximumUnwrappedAngleRad": 9.42477796076938,
    "initialUnwrappedAngleRad": 0,
    "clampFrequencyAtEndStops": true,
    "formula": "f=minHz*(maxHz/minHz)^((clamp(angle,minAngle,maxAngle)-minAngle)/(maxAngle-minAngle))"
  },
  "pointerSampling": {
    "unwrapPeriodRad": 6.283185307179586,
    "minimumRadiusRatio": 0.22,
    "maximumSampleGapSeconds": 0.08,
    "maximumAngularDeltaPerSampleRad": 1.2
  },
  "velocityEstimator": {
    "historyWindowSeconds": 0.12,
    "maximumAbsoluteRadPerSecond": 18,
    "stationaryThresholdRadPerSecond": 0.025,
    "approachDirectionThresholdHzPerSecond": 0.1
  },
  "inertia": {
    "enabled": true,
    "maximumInitialRadPerSecond": 8,
    "frictionRadPerSecondSquared": 7.5,
    "stopThresholdRadPerSecond": 0.03,
    "maximumDurationSeconds": 0.9
  },
  "endStops": {
    "maximumOverscrollRad": 0.22,
    "springStiffnessPerSecondSquared": 34,
    "dampingPerSecond": 11
  },
  "keyboard": {
    "arrowStepRad": 0.035,
    "pageStepRad": 0.35,
    "homeEndMoveToPhysicalLimits": true
  },
  "wheel": {
    "radiansPerDeltaPixel": 0.0015,
    "maximumDeltaRadPerEvent": 0.24
  },
  "resonanceResistance": {
    "maximumCounterTorqueNormalized": 0.18,
    "maximumVisualJitterRad": 0.012
  },
  "determinism": {
    "timestampUnit": "s",
    "tieBreak": "input-sequence",
    "randomSource": "forbidden"
  }
} as const) satisfies DialConfig;

export const GENERATED_FEEDBACK_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.feedback-spec.v1",
  "canonicalOwner": {
    "path": "specs/runtime/feedback.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "units": {
    "time": "s",
    "frequency": "Hz",
    "phase": "rad",
    "amplitude": "normalized",
    "gain": "linear"
  },
  "simulation": {
    "stateRepresentation": "rotating-complex-envelope",
    "integrator": "exponential-euler",
    "fixedStepSeconds": 0.004166666666666667,
    "maximumCatchUpSeconds": 0.1,
    "maximumStepsPerFrame": 24,
    "pausedGapResetSeconds": 0.5
  },
  "drive": {
    "amplitudeNormalized": 0.08,
    "phaseContinuity": "continuous-across-frequency-changes"
  },
  "modalSelection": {
    "maximumActiveModes": 12,
    "activationBandwidthRatio": 0.08,
    "residualEnergyThreshold": 0.000001
  },
  "calibration": {
    "modalResponse": {
      "minimumBandwidthHz": 1.6,
      "dampingBandwidthMultiplier": 3.4,
      "relativeBandwidthFloor": 0.0045,
      "couplingNormalization": "dataset-global-maximum-absolute-actuator-microphone-product",
      "directionalPhaseScale": 0.035,
      "captureSpeedHzPerSecond": 260
    },
    "modalEnergy": {
      "retainedDriveBase": 0.18,
      "feedbackDriveBase": 0.32,
      "feedbackEnvelopeMultiplier": 1.28,
      "feedbackSignalMultiplier": 0.18,
      "attackBasePerSecond": 2.4,
      "attackResponseMultiplierPerSecond": 3.8,
      "releaseBasePerSecond": 0.52,
      "releaseDampingMultiplierPerSecond": 18,
      "phaseDriftScale": 0.085,
      "activeModeScoreMinimum": 0.075
    },
    "loopMargin": {
      "adjacentModeGainLinear": 0.22,
      "residualHistoryGainMaximum": 0.0015,
      "residualHistoryStartEnvelope": 0.35,
      "residualHistorySpanEnvelope": 0.45
    },
    "energyDynamics": {
      "growthBasePerSecond": 0.42,
      "growthMarginMultiplierPerSecond": 2.25,
      "decayBasePerSecond": 0.68,
      "decayMarginMultiplierPerSecond": 1.55,
      "criticalFollowRatePerSecond": 0.92,
      "criticalLowerRmsMultiplier": 0.75,
      "criticalSaturationPosition": 0.82
    },
    "microphone": {
      "modeBaseWeight": 0.72,
      "modePhaseWeight": 0.12,
      "normalizationPerMode": 0.19,
      "radiationNormalizationPerMode": 0.22,
      "levelBase": 0.74,
      "modalResponseWeight": 0.2,
      "radiationWeight": 0.06,
      "beatBase": 0.96,
      "beatWeight": 0.04,
      "peakBase": 1.06,
      "peakAdjacentResponseWeight": 0.16,
      "waveformDryWeight": 0.32,
      "waveformFeedbackWeight": 0.68,
      "waveformModePhaseWeight": 0.18,
      "minimumCriticalScale": 0.2
    }
  },
  "loop": {
    "delaySeconds": 0.0175,
    "gainLinear": 1.16,
    "polarity": 1,
    "phaseOffsetRad": -0.18,
    "filter": {
      "type": "band-pass-biquad-cascade",
      "highPassHz": 45,
      "lowPassHz": 5200,
      "q": 0.7071067811865476
    }
  },
  "noiseGate": {
    "openThresholdNormalized": 0.003,
    "closeThresholdNormalized": 0.0015,
    "attackSeconds": 0.012,
    "releaseSeconds": 0.18,
    "closedAttenuationLinear": 0
  },
  "softClipper": {
    "function": "normalized-tanh",
    "drive": 2.2
  },
  "virtualSpeaker": {
    "maximumDisplacementNormalized": 1
  },
  "limiter": {
    "thresholdNormalized": 0.82,
    "ceilingNormalized": 0.95,
    "attackSeconds": 0.003,
    "releaseSeconds": 0.24,
    "holdSeconds": 0.06
  },
  "envelopeFollower": {
    "attackSeconds": 0.012,
    "releaseSeconds": 0.42
  },
  "regimeThresholds": {
    "criticalLoopMarginHalfWidth": 0.025,
    "decayingMaximumEnvelope": 0.004,
    "growingMinimumSlopePerSecond": 0.08,
    "saturatedMinimumEnvelope": 0.78,
    "saturatedUnconditionalEnvelope": 0.92,
    "saturatedMinimumGainReductionDb": 0.5
  },
  "determinism": {
    "randomSource": "forbidden",
    "clock": "injected-fixed-step",
    "delayedSamples": "preallocated-ring-buffer"
  }
} as const) satisfies FeedbackSpec;

export const GENERATED_VOLUME_MAP_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.volume-map.v1",
  "canonicalOwner": {
    "path": "specs/runtime/volume-map.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "units": {
    "input": "virtual-normalized-rms",
    "output": "integer-0-to-100",
    "time": "s",
    "level": "dB-relative-to-virtual-limiter"
  },
  "measurement": {
    "rmsWindowSeconds": 0.32,
    "minimumObservationSeconds": 0.75,
    "stabilityWindowSeconds": 0.5,
    "maximumRelativeRmsSlopePerSecond": 0.02,
    "confirmationHoldSeconds": 0.2
  },
  "mapping": {
    "noiseFloorRms": 0.003,
    "saturationRms": 0.62,
    "curve": "logarithmic-db",
    "rounding": "nearest-integer",
    "belowNoiseFloor": 0,
    "atOrAboveSaturation": 100,
    "intermediateRange": [
      1,
      99
    ],
    "dbDefinition": "20*log10(x)",
    "formula": "round(1+98*clamp(db(rms/noiseFloor)/db(saturation/noiseFloor),0,1))"
  },
  "display": {
    "widthDigits": 3,
    "measuringLabel": "MEASURING",
    "preserveLastSettledValueWhileMeasuring": true
  }
} as const) satisfies VolumeMapSpec;

export const GENERATED_AUDIO_SAFETY_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.audio-safety.v1",
  "canonicalOwner": {
    "path": "specs/runtime/audio-safety.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "units": {
    "time": "s",
    "frequency": "Hz",
    "level": "dBFS",
    "gain": "linear"
  },
  "activation": {
    "requiresUserGesture": true,
    "microphonePermission": "forbidden",
    "simulationRunsBeforeActivation": true
  },
  "sourceMapping": {
    "source": "feedback-envelope-normalized",
    "directVirtualVolumeMapping": "forbidden",
    "maximumOutputGainLinear": 0.1,
    "exponent": 0.72
  },
  "chain": [
    "dc-blocker",
    "band-limiter",
    "soft-clipper",
    "rms-limiter",
    "peak-limiter",
    "gain-smoother"
  ],
  "bandLimiter": {
    "highPassHz": 55,
    "lowPassHz": 6500,
    "q": 0.7071067811865476
  },
  "softClipper": {
    "drive": 1.4
  },
  "rmsLimiter": {
    "maximumRmsDbfs": -24,
    "windowSeconds": 0.4,
    "attackSeconds": 0.02,
    "releaseSeconds": 0.35
  },
  "peakLimiter": {
    "ceilingDbfs": -8,
    "lookAheadSeconds": 0.005,
    "releaseSeconds": 0.08
  },
  "gainSmoothing": {
    "maximumChangeDbPerSecond": 40,
    "startupFadeSeconds": 0.08,
    "hiddenFadeSeconds": 0.03,
    "errorFadeSeconds": 0.015
  },
  "exposureGuard": {
    "highFrequencyThresholdHz": 3000,
    "maximumContinuousHighFrequencySeconds": 8,
    "attenuationDb": 12,
    "maximumContinuousSaturationSeconds": 15
  },
  "lifecycle": {
    "suspendWhenDocumentHidden": true,
    "fadeBeforeSuspend": true,
    "invalidNumberPolicy": "mute-and-diagnose"
  }
} as const) satisfies AudioSafetySpec;

export const GENERATED_DATASET_RELEASE_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.dataset-release.v1",
  "canonicalOwner": {
    "path": "specs/runtime/dataset-release.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "manifestUrl": "/runtime/manifest.json",
  "datasetId": "sha256:d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98",
  "manifestSha256": "50e0df50dbd64b17324d62197bb53750a2bb9cd7bb69a9d918bb75e75ebc90ad",
  "modalModelId": "sha256:db567968bc4d628ebeb5f3a1fbce46ecf20881f83e0d0c9b0e501e1927b40953",
  "sourceDirectory": "assets/generated/d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98",
  "loadingPolicy": "verified-before-activation-with-analytical-fallback"
} as const) satisfies DatasetReleaseSpec;
