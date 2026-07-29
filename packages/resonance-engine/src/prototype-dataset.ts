export interface PrototypeModeRecord {
  readonly id: string;
  readonly frequencyHz: number;
  readonly dampingRatio: number;
  readonly driveCoupling: number;
  readonly microphoneCoupling: number;
  readonly phaseOffsetRadians: number;
  readonly radialOrder: number;
  readonly angularOrder: number;
}

export interface PrototypeModalDataset {
  readonly schemaVersion: "mandelhowl.prototype-modal-dataset.v1";
  readonly datasetId: "prototype-analytical-plate-v1";
  readonly provenance: {
    readonly kind: "analytical-prototype";
    readonly productionFemRequired: true;
    readonly note: string;
  };
  readonly frequencyRangeHz: readonly [number, number];
  readonly modes: readonly PrototypeModeRecord[];
}

/**
 * A deterministic analytical fixture for the first vertical slice.
 *
 * It intentionally declares itself as a prototype. Production releases can
 * replace this object with decoded FEM data without changing the runtime
 * engine or snapshot consumers.
 */
export const PROTOTYPE_MODAL_DATASET: PrototypeModalDataset = Object.freeze({
  schemaVersion: "mandelhowl.prototype-modal-dataset.v1",
  datasetId: "prototype-analytical-plate-v1",
  provenance: Object.freeze({
    kind: "analytical-prototype",
    productionFemRequired: true,
    note:
      "Deterministic modal fixture for interaction, feedback and rendering integration; not a finite-element result.",
  }),
  frequencyRangeHz: Object.freeze([52, 1_250] as const),
  modes: Object.freeze([
    {
      id: "p01",
      frequencyHz: 67.4,
      dampingRatio: 0.021,
      driveCoupling: 0.82,
      microphoneCoupling: 0.76,
      phaseOffsetRadians: 0.18,
      radialOrder: 2,
      angularOrder: 2,
    },
    {
      id: "p02",
      frequencyHz: 91.8,
      dampingRatio: 0.018,
      driveCoupling: 0.93,
      microphoneCoupling: 0.79,
      phaseOffsetRadians: 0.73,
      radialOrder: 3,
      angularOrder: 3,
    },
    {
      id: "p03",
      frequencyHz: 126.6,
      dampingRatio: 0.016,
      driveCoupling: 0.88,
      microphoneCoupling: 0.91,
      phaseOffsetRadians: 1.12,
      radialOrder: 2,
      angularOrder: 5,
    },
    {
      id: "p04",
      frequencyHz: 171.9,
      dampingRatio: 0.014,
      driveCoupling: 0.97,
      microphoneCoupling: 0.87,
      phaseOffsetRadians: 1.76,
      radialOrder: 4,
      angularOrder: 2,
    },
    {
      id: "p05",
      frequencyHz: 221.4,
      dampingRatio: 0.012,
      driveCoupling: 1,
      microphoneCoupling: 0.96,
      phaseOffsetRadians: 2.24,
      radialOrder: 3,
      angularOrder: 6,
    },
    {
      id: "p06",
      frequencyHz: 287.7,
      dampingRatio: 0.013,
      driveCoupling: 0.91,
      microphoneCoupling: 0.84,
      phaseOffsetRadians: 2.82,
      radialOrder: 5,
      angularOrder: 3,
    },
    {
      id: "p07",
      frequencyHz: 369.2,
      dampingRatio: 0.011,
      driveCoupling: 0.98,
      microphoneCoupling: 0.93,
      phaseOffsetRadians: 3.37,
      radialOrder: 4,
      angularOrder: 7,
    },
    {
      id: "p08",
      frequencyHz: 463.8,
      dampingRatio: 0.012,
      driveCoupling: 0.87,
      microphoneCoupling: 0.78,
      phaseOffsetRadians: 3.91,
      radialOrder: 6,
      angularOrder: 4,
    },
    {
      id: "p09",
      frequencyHz: 578.6,
      dampingRatio: 0.01,
      driveCoupling: 0.96,
      microphoneCoupling: 0.89,
      phaseOffsetRadians: 4.46,
      radialOrder: 5,
      angularOrder: 8,
    },
    {
      id: "p10",
      frequencyHz: 714.1,
      dampingRatio: 0.011,
      driveCoupling: 0.9,
      microphoneCoupling: 0.82,
      phaseOffsetRadians: 5.02,
      radialOrder: 7,
      angularOrder: 5,
    },
    {
      id: "p11",
      frequencyHz: 887.5,
      dampingRatio: 0.009,
      driveCoupling: 0.99,
      microphoneCoupling: 0.94,
      phaseOffsetRadians: 5.61,
      radialOrder: 6,
      angularOrder: 9,
    },
    {
      id: "p12",
      frequencyHz: 1_108.3,
      dampingRatio: 0.01,
      driveCoupling: 0.92,
      microphoneCoupling: 0.86,
      phaseOffsetRadians: 6.03,
      radialOrder: 8,
      angularOrder: 6,
    },
  ] satisfies readonly PrototypeModeRecord[]),
});
