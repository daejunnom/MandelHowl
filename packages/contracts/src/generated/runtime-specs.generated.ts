/**
 * GENERATED FILE — edit specs/runtime/*.yaml or specs/visual/*.yaml and run
 * node packages/contracts/scripts/generate-runtime-specs.mjs.
 */
import type { AudioSafetySpec, DialConfig, VolumeMapSpec } from "../runtime-config";
import type { FeedbackSpec } from "../feedback-spec";
import type { PerformanceBudgetSpec } from "../performance-budget";
import type { MotionSafetySpec, RenderQualityTiersSpec, SceneSpec } from "../visual-specs";

export const RUNTIME_SPEC_SOURCE_HASHES = Object.freeze({
  "dial": "07f831116a2193ae88dc2b98b8d29d020d77e6bdd83de1b845afbf1aa7a98e76",
  "feedback": "3031dc82b8f3f9e9d4279e2bcde7fb92d06e5601767dbcce67b576a4caf386a4",
  "volumeMap": "7fda34e109a98993a818e488aa5e0e81566659e085aec921f1e575822539c90a",
  "audioSafety": "ec7e0358f7ce0bc16c9295ffc0797be0bbd0b2c3876d7438e85144856cfc00e6",
  "performanceBudget": "91ed596c5c25a1606bb2a481878ac164be156664f813bc2602a98e27301d8e81",
  "motionSafety": "8479993cab1ee14e6b3e59a36830b2ace92d1c054af25cacc6c07318dfb49b8d",
  "renderQuality": "fb97f419a4d4a9b89787535cf4700e59e1a00116795a991001ee29df0335f2bd",
  "scene": "2072d7a2e8494b37c8a6ed499d361f6e7bb4add1a6e8348c826e3480237504ec"
} as const);

export const COVERAGE_REPORT_SCHEMA_SHA256 = "f4d1fedda16dc4dd0bd8774d476227ebf50f9566d64f0d84b47c55015696163e";

export const N_VERSION_CONTRACT_DIGESTS = Object.freeze({
  "scientificAlgorithm": "sha256:4fac7c12618d1e561dab27214ce47e2b94cbc91e734ce9a100f32a143dc222ca",
  "presentationContract": "sha256:6d2da47fbae613748a920516c5d303c1e92970703a23897ae10acc7f191cfb26"
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
  "fixedPoint": {
    "canonicalUnit": "centihertz",
    "centihertzPerHertz": 100,
    "decimalPlaces": 2,
    "quantization": "nearest-centihertz",
    "tieBreak": "half-away-from-zero",
    "physicsBoundary": "hertz-from-centihertz"
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
    "timestampUnit": "ms",
    "tieBreak": "input-sequence",
    "randomSource": "forbidden"
  }
} as const) satisfies DialConfig;

export const GENERATED_FEEDBACK_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.feedback-spec.v1",
  "algorithmRevision": "fixed-step-modal-feedback-v4",
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
      "criticalLowerRmsMultiplier": 1,
      "criticalSaturationPosition": 1
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
  "modalTimbre": {
    "maximumVoices": 8,
    "minimumEnergyNormalized": 0.000001,
    "driveToneWeight": 0.18,
    "modalVoiceWeight": 0.82,
    "frequencySmoothingSeconds": 0.025,
    "gainAttackSeconds": 0.035,
    "gainReleaseSeconds": 0.08
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

export const GENERATED_PERFORMANCE_BUDGET_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.performance-budget.v1",
  "canonicalOwner": {
    "path": "specs/visual/performance-budget.v1.yaml",
    "policy": "edit-source-update-tests"
  },
  "desktopTargetFramesPerSecond": 60,
  "lowTierMinimumFramesPerSecond": 30,
  "lowTierMaximumFrameWorkMs": 33.333333333333336,
  "headlessSchedulerLivenessFramesPerSecond": 10,
  "runtimeDegradation": {
    "sampleWindowFrames": 120,
    "percentile": 0.95,
    "requiredOverBudgetWindows": 2
  },
  "browserSoak": {
    "minimumSeconds": 15,
    "maximumHeapGrowthBytes": 33554432,
    "expectedSnapshotConsumers": 5
  },
  "simulationSoak": {
    "durationSeconds": 3600,
    "fixedBuffersMustRetainIdentity": true
  }
} as const) satisfies PerformanceBudgetSpec;

export const GENERATED_MOTION_SAFETY_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.motion-safety.v1",
  "canonicalOwner": {
    "path": "specs/visual/motion-safety.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "limits": {
    "maximumFlashHz": 2.5,
    "maximumFullFieldLuminanceDelta": 0.18,
    "maximumPlateDisplacementPx": 3,
    "maximumCablePulseHz": 2
  },
  "reducedMotion": {
    "plateDisplacementScale": 0.18,
    "disableCableTravel": true,
    "disableCameraMotion": true,
    "preserve": [
      "regime-label",
      "settled-volume",
      "measurement-progress",
      "nodal-pattern",
      "limiter-state"
    ]
  },
  "forcedColors": {
    "preserveOutlines": true,
    "minimumBorderWidthPx": 1,
    "doNotUseColorAsSoleSignal": true
  }
} as const) satisfies MotionSafetySpec;

export const GENERATED_RENDER_QUALITY_TIERS_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.render-quality-tiers.v1",
  "canonicalOwner": {
    "path": "specs/visual/quality-tiers.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "tiers": [
    {
      "id": "webgl-full",
      "requires": [
        "webgl2",
        "float-texture"
      ],
      "maximumDevicePixelRatio": 2,
      "maximumTextureModesResident": 4,
      "sandParticleBudget": 3600,
      "oscilloscopeSamples": 40,
      "plateRadialSegments": 32,
      "plateAngularSegments": 96
    },
    {
      "id": "webgl-safe",
      "requires": [
        "webgl2"
      ],
      "maximumDevicePixelRatio": 1.5,
      "maximumTextureModesResident": 4,
      "sandParticleBudget": 2400,
      "oscilloscopeSamples": 40,
      "plateRadialSegments": 24,
      "plateAngularSegments": 72
    },
    {
      "id": "webgl-reduced",
      "requires": [
        "webgl2"
      ],
      "maximumDevicePixelRatio": 1,
      "maximumTextureModesResident": 4,
      "sandParticleBudget": 1600,
      "oscilloscopeSamples": 24,
      "plateRadialSegments": 16,
      "plateAngularSegments": 48
    },
    {
      "id": "canvas-data",
      "requires": [
        "canvas2d"
      ],
      "maximumDevicePixelRatio": 1.25,
      "maximumTextureModesResident": 2,
      "sandParticleBudget": 900,
      "oscilloscopeSamples": 20,
      "plateRadialSegments": 0,
      "plateAngularSegments": 0
    },
    {
      "id": "static-safe",
      "requires": [],
      "maximumDevicePixelRatio": 1,
      "maximumTextureModesResident": 0,
      "sandParticleBudget": 0,
      "oscilloscopeSamples": 0,
      "plateRadialSegments": 0,
      "plateAngularSegments": 0
    }
  ],
  "degradationOrder": [
    "reduce-sand-residual",
    "reduce-normal-resolution",
    "disable-post-processing",
    "reduce-oscilloscope-samples",
    "reduce-internal-resolution",
    "switch-to-canvas-data"
  ],
  "availabilityFallback": "static-safe",
  "invariant": {
    "simulationSnapshotMayChange": false,
    "volumeMayChange": false
  }
} as const) satisfies RenderQualityTiersSpec;

export const GENERATED_SCENE_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.scene-spec.v1",
  "canonicalOwner": {
    "path": "specs/visual/scene.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "coordinateSystem": {
    "type": "normalized-apparatus",
    "xDirection": "left-to-right",
    "yDirection": "top-to-bottom",
    "zDirection": "toward-viewer"
  },
  "camera": {
    "projection": "perspective",
    "fieldOfViewDegrees": 38,
    "near": 0.1,
    "far": 100,
    "target": [
      0,
      0,
      0
    ]
  },
  "apparatus": {
    "speaker": {
      "position": [
        -1.35,
        0.18,
        0.1
      ],
      "aimTarget": [
        0,
        0,
        0
      ]
    },
    "plate": {
      "position": [
        0,
        0,
        0
      ],
      "radius": 1,
      "frontNormal": [
        0,
        0,
        1
      ]
    },
    "microphone": {
      "position": [
        1.34,
        -0.12,
        0.42
      ],
      "aimTarget": [
        0,
        0,
        0
      ]
    },
    "cable": {
      "direction": "microphone-to-feedback-to-speaker"
    }
  },
  "readOrder": [
    "speaker",
    "plate",
    "microphone",
    "feedback-loop",
    "volume"
  ],
  "inputCount": 1,
  "outputCount": 1
} as const) satisfies SceneSpec;
