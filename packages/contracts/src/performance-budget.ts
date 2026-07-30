export interface PerformanceBudgetSpec {
  readonly schemaVersion: "mandelhowl.performance-budget.v1";
  readonly canonicalOwner: {
    readonly path: "specs/visual/performance-budget.v1.yaml";
    readonly policy: "edit-source-update-tests";
  };
  readonly desktopTargetFramesPerSecond: number;
  readonly lowTierMinimumFramesPerSecond: number;
  readonly lowTierMaximumFrameWorkMs: number;
  readonly headlessSchedulerLivenessFramesPerSecond: number;
  readonly runtimeDegradation: {
    readonly sampleWindowFrames: number;
    readonly percentile: number;
    readonly requiredOverBudgetWindows: number;
  };
  readonly browserSoak: {
    readonly minimumSeconds: number;
    readonly maximumHeapGrowthBytes: number;
    readonly expectedSnapshotConsumers: number;
  };
  readonly simulationSoak: {
    readonly durationSeconds: number;
    readonly fixedBuffersMustRetainIdentity: boolean;
  };
}
