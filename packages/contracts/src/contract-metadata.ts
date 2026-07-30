/**
 * Stable wire-format versions. A new value means a deliberate serialization
 * contract change; implementation package versions are tracked separately.
 */
export const SCHEMA_VERSIONS = {
  plateSpec: "mandelhowl.plate-spec.v1",
  resonanceManifest: "mandelhowl.resonance-manifest.v1",
  materialSectionProfile:
    "mandelhowl.material-section-profile.v1",
  runtimeSnapshot: "mandelhowl.runtime-snapshot.v2",
  dialGestureTrace: "mandelhowl.dial-gesture-trace.v2",
  resonanceTrajectoryTrace: "mandelhowl.resonance-trajectory-trace.v2",
  coverageReport: "mandelhowl.coverage-report.v2",
  datasetRelease: "mandelhowl.dataset-release.v1",
  dialConfig: "mandelhowl.dial-config.v1",
  feedbackSpec: "mandelhowl.feedback-spec.v1",
  volumeMap: "mandelhowl.volume-map.v1",
  audioSafety: "mandelhowl.audio-safety.v1",
} as const;

export type SchemaVersion =
  (typeof SCHEMA_VERSIONS)[keyof typeof SCHEMA_VERSIONS];

/**
 * Lower-case hexadecimal SHA-256 text. JSON Schema performs the exact length
 * and character validation at serialization boundaries.
 */
export type Sha256Hex = string;
export type ContentAddressedId = `sha256:${string}`;

export interface CanonicalOwnership {
  readonly path: string;
  readonly policy: "edit-source-regenerate-derived";
}

export type GeneratedArtifactGenerator =
  | "tools/physics-baker"
  | "tools/physics-baker-rs";

export interface GeneratedArtifactOwnership {
  readonly kind: "generated";
  readonly generator: GeneratedArtifactGenerator;
  readonly policy: "immutable-regenerate";
}

export interface AssetReference {
  /** POSIX-style path relative to the dataset root. */
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: Sha256Hex;
  readonly mediaType: string;
}

export interface ChecksumEntry {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: Sha256Hex;
}

export interface ChecksumsFile {
  readonly schemaVersion: "mandelhowl.checksums.v1";
  readonly algorithm: "sha256";
  /**
   * Every packaged file except manifest.json and checksums.json itself, sorted
   * by path. This includes offline scientific evidence not fetched by the web
   * runtime as well as every manifest-referenced runtime asset.
   */
  readonly files: readonly ChecksumEntry[];
}
