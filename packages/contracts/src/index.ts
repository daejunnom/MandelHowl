export { SCHEMA_VERSIONS } from "./contract-metadata";
export { MODES_BINARY_V1, RESPONSE_BINARY_V1 } from "./binary-formats";
export {
  GENERATED_AUDIO_SAFETY_SPEC,
  GENERATED_DIAL_SPEC,
  GENERATED_FEEDBACK_SPEC,
  GENERATED_MOTION_SAFETY_SPEC,
  GENERATED_PERFORMANCE_BUDGET_SPEC,
  GENERATED_RENDER_QUALITY_TIERS_SPEC,
  GENERATED_SCENE_SPEC,
  GENERATED_VOLUME_MAP_SPEC,
  COVERAGE_REPORT_SCHEMA_SHA256,
  N_VERSION_CONTRACT_DIGESTS,
  RUNTIME_SPEC_SOURCE_HASHES,
} from "./generated/runtime-specs.generated";
export {
  DATASET_RELEASE_SOURCE_SHA256,
  GENERATED_DATASET_RELEASE_SPEC,
} from "./generated/dataset-release.generated";

export type {
  AssetReference,
  CanonicalOwnership,
  ChecksumEntry,
  ChecksumsFile,
  ContentAddressedId,
  GeneratedArtifactOwnership,
  SchemaVersion,
  Sha256Hex,
} from "./contract-metadata";
export type {
  PlateCoordinateSystem,
  Point3Metres,
  SiUnitDeclaration,
  Vector3,
} from "./coordinate-system";
export type { PlateSpec } from "./plate-spec";
export type { FrequencyResponseTable, ModeRecord } from "./mode-record";
export type {
  PlateMaterialSectionProfile,
  ResonanceDataset,
  ResonanceManifest,
  TextureAtlasReference,
} from "./resonance-manifest";
export { VERSIONED_TEXTURE_LAYERS_PER_SHARD } from "./resonance-manifest";
export type { FeedbackSpec } from "./feedback-spec";
export type { PerformanceBudgetSpec } from "./performance-budget";
export type {
  MotionSafetySpec,
  RenderDegradationStep,
  RenderQualityTier,
  RenderQualityTierId,
  RenderQualityTiersSpec,
  SceneSpec,
} from "./visual-specs";
export type {
  AudioSafetySpec,
  DatasetReleaseSpec,
  DialConfig,
  RuntimeConfig,
  VolumeMapSpec,
} from "./runtime-config";
export type {
  DiagnosticEvidence,
  DiagnosticEvidenceState,
  DiagnosticRecord,
  DiagnosticRecordInput,
  DiagnosticSeverity,
} from "./diagnostic-record";
export {
  createDiagnosticRecord,
  DIAGNOSTIC_CODE_PATTERN,
  isDiagnosticCode,
} from "./diagnostic-record";
export type {
  DialGestureTrace,
  DialTraceCommand,
  DialTraceEvent,
} from "./dial-gesture-trace";
export type {
  ReachabilityCoverageReport,
  ResonanceTrajectoryKeyframe,
  ResonanceTrajectoryTrace,
  StaticDistributionReport,
} from "./resonance-trajectory";
export type {
  DialSnapshot,
  FeedbackSnapshot,
  MicrophoneSnapshot,
  ModalSnapshot,
  ResonanceRegime,
  RuntimeSnapshot,
  VolumeSnapshot,
} from "./runtime-snapshot";
