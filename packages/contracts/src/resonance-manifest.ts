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

export interface TextureAtlasReference extends AssetReference {
  readonly kind:
    | "signed-displacement"
    | "normal"
    | "nodal-mask"
    | "sand-density";
  readonly modeIds: readonly string[];
  readonly widthPx: number;
  readonly heightPx: number;
  readonly layers: number;
  readonly uvOrigin: "negative-x-negative-y";
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
    readonly containerImageDigest: ContentAddressedId;
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
