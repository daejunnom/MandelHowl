export {
  advanceResonance,
  classifyResonanceRegime,
  createResonanceState,
  estimateOpenLoopMarginAtFrequency,
  getResonanceSnapshot,
  initResonance,
  replaceResonanceDataset,
  resetResonanceAfterPausedGap,
  runtimeModalDatasetFromResonanceDataset,
  stepResonance,
  volumeFromVirtualRms,
  type CreateResonanceOptions,
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
  dispatchRuntimeDial,
  getRuntimeSnapshot,
  replaceMandelHowlDataset,
  resetMandelHowlRuntimeAfterPausedGap,
} from "./runtime-engine";
export type {
  CreateMandelHowlRuntimeOptions,
  MandelHowlRuntimeState,
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
