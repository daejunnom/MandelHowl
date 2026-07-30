interface CanonicalVisualOwner<Path extends string> {
  readonly path: Path;
  readonly policy: "edit-source-regenerate-derived";
}

type ApparatusPoint = readonly [number, number, number];

export interface SceneSpec {
  readonly schemaVersion: "mandelhowl.scene-spec.v1";
  readonly canonicalOwner: CanonicalVisualOwner<"specs/visual/scene.v1.yaml">;
  readonly coordinateSystem: {
    readonly type: "normalized-apparatus";
    readonly xDirection: "left-to-right";
    readonly yDirection: "top-to-bottom";
    readonly zDirection: "toward-viewer";
  };
  readonly camera: {
    readonly projection: "perspective";
    readonly fieldOfViewDegrees: number;
    readonly near: number;
    readonly far: number;
    readonly target: ApparatusPoint;
  };
  readonly apparatus: {
    readonly speaker: {
      readonly position: ApparatusPoint;
      readonly aimTarget: ApparatusPoint;
    };
    readonly plate: {
      readonly position: ApparatusPoint;
      readonly radius: number;
      readonly frontNormal: ApparatusPoint;
    };
    readonly microphone: {
      readonly position: ApparatusPoint;
      readonly aimTarget: ApparatusPoint;
    };
    readonly cable: {
      readonly direction: "microphone-to-feedback-to-speaker";
    };
  };
  readonly readOrder: readonly [
    "speaker",
    "plate",
    "microphone",
    "feedback-loop",
    "volume",
  ];
  readonly inputCount: 1;
  readonly outputCount: 1;
}

export interface MotionSafetySpec {
  readonly schemaVersion: "mandelhowl.motion-safety.v1";
  readonly canonicalOwner: CanonicalVisualOwner<"specs/visual/motion-safety.v1.yaml">;
  readonly limits: {
    readonly maximumFlashHz: number;
    readonly maximumFullFieldLuminanceDelta: number;
    readonly maximumPlateDisplacementPx: number;
    readonly maximumCablePulseHz: number;
  };
  readonly reducedMotion: {
    readonly plateDisplacementScale: number;
    readonly disableCableTravel: boolean;
    readonly disableCameraMotion: boolean;
    readonly preserve: readonly (
      | "regime-label"
      | "settled-volume"
      | "measurement-progress"
      | "nodal-pattern"
      | "limiter-state"
    )[];
  };
  readonly forcedColors: {
    readonly preserveOutlines: boolean;
    readonly minimumBorderWidthPx: number;
    readonly doNotUseColorAsSoleSignal: boolean;
  };
}

export type RenderQualityTierId =
  | "webgl-full"
  | "webgl-safe"
  | "webgl-reduced"
  | "canvas-data"
  | "static-safe";

export type RenderDegradationStep =
  | "reduce-sand-residual"
  | "reduce-normal-resolution"
  | "disable-post-processing"
  | "reduce-oscilloscope-samples"
  | "reduce-internal-resolution"
  | "switch-to-canvas-data";

export interface RenderQualityTier {
  readonly id: RenderQualityTierId;
  readonly requires: readonly (
    | "webgl2"
    | "float-texture"
    | "canvas2d"
  )[];
  readonly maximumDevicePixelRatio: number;
  readonly maximumTextureModesResident: number;
  readonly sandParticleBudget: number;
  readonly oscilloscopeSamples: number;
  readonly plateRadialSegments: number;
  readonly plateAngularSegments: number;
}

export interface RenderQualityTiersSpec {
  readonly schemaVersion: "mandelhowl.render-quality-tiers.v1";
  readonly canonicalOwner: CanonicalVisualOwner<"specs/visual/quality-tiers.v1.yaml">;
  readonly tiers: readonly RenderQualityTier[];
  readonly degradationOrder: readonly RenderDegradationStep[];
  readonly availabilityFallback: "static-safe";
  readonly invariant: {
    readonly simulationSnapshotMayChange: false;
    readonly volumeMayChange: false;
  };
}
