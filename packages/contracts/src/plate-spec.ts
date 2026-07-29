import type {
  CanonicalOwnership,
  Sha256Hex,
} from "./contract-metadata";
import type {
  PlateCoordinateSystem,
  Point3Metres,
  SiUnitDeclaration,
  Vector3,
} from "./coordinate-system";

export interface PlateSpec {
  readonly $schema?: string;
  readonly schemaVersion: "mandelhowl.plate-spec.v1";
  readonly plateId: string;
  readonly canonicalOwner: CanonicalOwnership;
  readonly units: SiUnitDeclaration;
  readonly coordinateSystem: PlateCoordinateSystem;
  readonly geometry: {
    readonly frontShape: "circle";
    readonly radiusM: number;
    readonly frontSurfaceZM: 0;
    readonly hub: {
      readonly shape: "circle";
      readonly radiusM: number;
      readonly centreM: Point3Metres;
    };
  };
  readonly boundaryCondition: {
    readonly hub: "clamped";
    readonly outerEdge: "free";
    readonly description: string;
  };
  readonly material: {
    readonly materialId: string;
    readonly name: string;
    readonly densityKgPerM3: number;
    readonly youngsModulusPa: number;
    readonly poissonRatio: number;
    readonly nominalModalDampingRatio: number;
  };
  readonly mandelbrotField: {
    readonly algorithm: "escape-time";
    readonly maximumIterations: number;
    readonly escapeRadius: number;
    readonly complexBounds: {
      readonly realMin: number;
      readonly realMax: number;
      readonly imaginaryMin: number;
      readonly imaginaryMax: number;
    };
    readonly coordinateMap:
      "linear-plate-diameter-to-complex-bounds";
    readonly sampleResolution: {
      readonly widthPx: number;
      readonly heightPx: number;
    };
    readonly normalization: {
      readonly method: "continuous-log-log";
      readonly insideValue: 1;
      readonly escapedRange: readonly [0, 1];
    };
    readonly manufacturingFilter: {
      readonly method: "gaussian-close-open";
      readonly minimumFeatureM: number;
      readonly radiusM: number;
      readonly quantizationLevels: number;
    };
  };
  readonly thicknessMapping: {
    readonly source: "filtered-normalized-mandelbrot-field";
    readonly minimumThicknessM: number;
    readonly maximumThicknessM: number;
    readonly curve: "smoothstep";
    readonly direction: "higher-field-is-thicker";
    readonly frontSurfaceRemainsPlanar: true;
  };
  readonly massMapping: {
    readonly type: "none";
    readonly addedArealDensityKgPerM2: readonly [0, 0];
  };
  readonly manufacturingLimits: {
    readonly minimumConnectedThicknessM: number;
    readonly maximumThicknessGradient: number;
    readonly totalMassRangeKg: readonly [number, number];
    readonly centreOfMassOffsetMaximumM: number;
  };
  readonly actuator: {
    readonly model: "normal-point-force-with-circular-footprint";
    readonly positionM: Point3Metres;
    readonly direction: Vector3;
    readonly footprintRadiusM: number;
  };
  readonly virtualMicrophone: {
    readonly model: "virtual-normal-velocity-probe";
    readonly positionM: Point3Metres;
    readonly aimDirection: Vector3;
    readonly apertureRadiusM: number;
  };
  readonly frequencyRange: {
    readonly minimumHz: number;
    readonly maximumHz: number;
  };
  readonly solverRequest: {
    readonly analysis: "undamped-eigenmodes-with-modal-damping";
    readonly elementFamily: "shell";
    readonly requestedModeCount: number;
    readonly frequencyRangeHz: readonly [number, number];
    readonly normalization: "unit-modal-mass";
    readonly signReference: "positive-at-actuator-or-first-nonzero-node";
    readonly meshLevels: readonly {
      readonly name: string;
      readonly targetElementSizeM: number;
    }[];
    readonly convergence: {
      readonly maximumRelativeFrequencyChange: number;
      readonly minimumModalAssuranceCriterion: number;
    };
  };
  readonly textureRequest: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly container: "KTX2";
    readonly uvOrigin: "negative-x-negative-y";
    readonly uvXAxis: "positive-x";
    readonly uvYAxis: "positive-y";
    readonly channels: readonly (
      | "signed-displacement-r16f"
      | "normal-rg16f"
      | "nodal-mask-r8"
      | "sand-density-r8"
    )[];
  };
  readonly determinism: {
    readonly randomSource: "forbidden";
    readonly offlineFloatPrecision: "float64";
    readonly modeSort: "frequency-then-mode-id";
  };
  /** Optional hash assigned by the baker after canonical JSON conversion. */
  readonly canonicalSha256?: Sha256Hex;
}
