import type {
  AssetReference,
  ContentAddressedId,
  GeneratedArtifactOwnership,
  Sha256Hex,
} from "./contract-metadata";
import type {
  PlateCoordinateSystem,
  SiUnitDeclaration,
} from "./coordinate-system";
import type { FrequencyResponseTable, ModeRecord } from "./mode-record";

/**
 * Mirrors specs/physics/baker-algorithm.v1.json texture.layersPerShard.
 * Versioned dataset generation and runtime validation both pin this value;
 * changing it requires an algorithm-contract revision and N-version rebake.
 */
export const VERSIONED_TEXTURE_LAYERS_PER_SHARD = 4;

export interface TextureAtlasReference extends AssetReference {
  readonly kind:
    | "signed-displacement"
    | "normal"
    | "nodal-mask"
    | "sand-density";
  /**
   * Local KTX2 layer order. Versioned datasets shard each kind into groups of
   * four; the ordered descriptors for one kind cover every modal id exactly
   * once. Legacy v1 datasets may retain one full-kind atlas.
   */
  readonly modeIds: readonly string[];
  readonly widthPx: number;
  readonly heightPx: number;
  readonly layers: number;
  /** Standard KTX2 ZLIB scheme for current algorithm-revision datasets. */
  readonly supercompressionScheme?: 3;
  readonly uvOrigin: "negative-x-negative-y";
}

/**
 * Compact, content-addressed presentation projection of the canonical
 * Mandelbrot-derived rear thickness. The baker samples the physical
 * thickness field; the browser only displays these verified values and never
 * re-runs the Mandelbrot or manufacturing algorithms.
 */
export interface PlateMaterialSectionProfile {
  readonly schemaVersion: "mandelhowl.material-section-profile.v1";
  readonly axis: "x-at-y-zero";
  readonly sampleCount: 64;
  readonly minimumThicknessM: number;
  readonly maximumThicknessM: number;
  readonly thicknessUnorm8: readonly number[];
}

export interface ResonanceManifest {
  readonly $schema?: string;
  readonly schemaVersion: "mandelhowl.resonance-manifest.v1";
  /**
   * Optional for compatibility with v1 datasets produced before the
   * cross-language algorithm contract was introduced.
   */
  readonly algorithmRevision?: string;
  readonly datasetId: ContentAddressedId;
  readonly ownership: GeneratedArtifactOwnership;
  readonly contentAddressing: {
    readonly algorithm: "sha256";
    readonly canonicalization: "RFC8785";
    readonly identityScope:
      "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests";
    readonly directoryName: Sha256Hex;
  };
  readonly plate: {
    readonly plateId: string;
    readonly specSha256: Sha256Hex;
    /**
     * Required for algorithm-revision datasets. Optional only so manifests
     * produced before the cross-language algorithm contract remain readable.
     */
    readonly materialSectionProfile?: PlateMaterialSectionProfile;
  };
  readonly runtimeCompatibility: {
    readonly minimumRuntimeVersion: string;
    readonly maximumRuntimeVersionExclusive: string;
    readonly modeBinaryFormat: "mandelhowl-modes-v1";
    readonly responseBinaryFormat: "mandelhowl-response-v1";
  };
  readonly units: SiUnitDeclaration;
  readonly coordinateSystem: PlateCoordinateSystem;
  readonly modeCount: number;
  readonly frequencyRange: {
    readonly minimumHz: number;
    readonly maximumHz: number;
  };
  readonly solverProvenance: {
    readonly solverName: string;
    readonly solverVersion: string;
    /** Required for algorithm-revision datasets; absent in legacy v1 data. */
    readonly executionKind?: "native-process" | "oci-container";
    readonly containerImageDigest: ContentAddressedId | null;
    readonly optionsSha256: Sha256Hex;
  };
  readonly files: {
    readonly plateSpec: AssetReference;
    readonly modes: AssetReference;
    readonly response: AssetReference;
    readonly textures: readonly TextureAtlasReference[];
    readonly provenance: AssetReference;
    readonly convergenceReport: AssetReference;
    readonly coverageReport: AssetReference;
    readonly checksums: AssetReference;
  };
}

/**
 * Immutable, fully decoded runtime data. Loading and hash verification happen
 * before this shape is constructed; GPU texture objects are deliberately not
 * part of the domain contract.
 */
export interface ResonanceDataset {
  readonly manifest: ResonanceManifest;
  readonly modes: readonly ModeRecord[];
  readonly response: FrequencyResponseTable;
}
