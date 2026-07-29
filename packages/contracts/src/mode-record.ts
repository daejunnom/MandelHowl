export interface ModeRecord {
  readonly modeId: string;
  readonly ordinal: number;
  readonly naturalFrequencyHz: number;
  readonly angularFrequencyRadPerSecond: number;
  readonly dampingRatio: number;
  readonly actuatorCoupling: number;
  readonly microphoneCoupling: number;
  readonly radiationEfficiency: number;
  readonly signReference: "actuator-positive" | "first-nonzero-node-positive";
  readonly phaseReferenceRad: number;
  readonly textureLayer: number;
}

/**
 * Runtime-decoded complex transfer response. All arrays have sampleCount
 * entries and use the frequency order stored in the dataset.
 */
export interface FrequencyResponseTable {
  readonly sampleCount: number;
  readonly frequenciesHz: ReadonlyArray<number>;
  readonly real: ReadonlyArray<number>;
  readonly imaginary: ReadonlyArray<number>;
}
