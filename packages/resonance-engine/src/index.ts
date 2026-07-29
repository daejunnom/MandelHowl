export {
  advanceResonance,
  classifyResonanceRegime,
  createResonanceState,
  estimateOpenLoopMarginAtFrequency,
  getResonanceSnapshot,
  initResonance,
  interpolateBakedFrequencyResponse,
  replaceResonanceDataset,
  resetResonanceAfterPausedGap,
  runtimeModalDatasetFromResonanceDataset,
  stepResonance,
  volumeFromVirtualRms,
  type CreateResonanceOptions,
  type InterpolatedFrequencyResponse,
  type ResonanceDrive,
  type ResonanceRegime,
  type ResonanceSnapshot,
  type ResonanceState,
  type RuntimeModalDataset,
  type RuntimeModalMode,
} from "./resonance-engine";
export {
  PROTOTYPE_MODAL_DATASET,
  type PrototypeModalDataset,
  type PrototypeModeRecord,
} from "./prototype-dataset";
export {
  advanceMandelHowlRuntime,
  createMandelHowlRuntime,
  createRuntimeSnapshotWriter,
  dispatchRuntimeDial,
  getRuntimeSnapshot,
  replaceMandelHowlDataset,
  resetMandelHowlRuntimeAfterPausedGap,
} from "./runtime-engine";
export type {
  CreateMandelHowlRuntimeOptions,
  MandelHowlRuntimeState,
  RuntimeSnapshotConsumer,
  RuntimeSnapshotLease,
  RuntimeSnapshotRebuildReason,
  RuntimeSnapshotWriter,
} from "./runtime-engine";
export {
  measureStaticDistribution,
  replayResonanceTrajectory,
  searchReachabilityCoverage,
  validateResonanceTrajectoryTrace,
} from "./trajectory-coverage";
export type {
  ReachabilitySearchOptions,
  ReachabilitySearchResult,
  ReplayTrajectoryResult,
} from "./trajectory-coverage";
