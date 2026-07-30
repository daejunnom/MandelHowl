import {
  COVERAGE_REPORT_SCHEMA_SHA256,
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_FEEDBACK_SPEC,
  N_VERSION_CONTRACT_DIGESTS,
  RUNTIME_SPEC_SOURCE_HASHES,
  toCentiHertz,
  type AssetReference,
  type ChecksumsFile,
  type DiagnosticRecord,
  type ModeRecord,
  type ResonanceDataset,
  type ResonanceManifest,
  type TextureAtlasReference,
} from "../../contracts/src";
import { decodeModesBinaryV1, decodeResponseBinaryV1 } from "./binary-decoders";
import { canonicalizeJson, manifestIdentityPayload } from "./canonical-json";
import {
  ASSET_DIAGNOSTIC_CODES,
  createDiagnostic,
  evidence,
} from "./diagnostics";
import {
  collectManifestAssets,
  isRuntimeCompatible,
  validateResonanceManifest,
} from "./manifest-validator";
import { validateTextureAtlasBytes } from "./ktx2-validator";
import { sha256Hex } from "./sha256";

export const MANDELHOWL_RUNTIME_VERSION = "0.1.0";
const VERSIONED_RUNTIME_FREQUENCY_QUANTUM_HZ = 2 ** -20;
const VERSIONED_RUNTIME_COUPLING_QUANTUM = 2 ** -27;

function quantizeTiesToEven(value: number, quantum: number): number {
  const scaled = value / quantum;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const ticks =
    fraction < 0.5
      ? lower
      : fraction > 0.5 || lower % 2 !== 0
        ? lower + 1
        : lower;
  return ticks === 0 ? 0 : ticks * quantum;
}

export type TextureAssetKind = TextureAtlasReference["kind"];

export interface TextureAssetUrl {
  readonly kind: TextureAssetKind;
  readonly url: string;
  readonly modeIds: readonly string[];
  readonly layers: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly mediaType: string;
}

export interface VerifiedAssetUrls {
  readonly manifest: string;
  readonly byPath: Readonly<Record<string, string>>;
  /** Ordered shard URLs for every texture kind (one entry for legacy atlases). */
  readonly textures: Readonly<
    Record<TextureAssetKind, readonly TextureAssetUrl[]>
  >;
}

export interface VerifiedTextureAssetMetadata {
  readonly kind: TextureAssetKind;
  readonly modeIds: readonly string[];
  readonly widthPx: number;
  readonly heightPx: number;
  readonly layers: number;
  readonly uvOrigin: TextureAtlasReference["uvOrigin"];
}

export interface VerifiedTextureAsset {
  readonly kind: TextureAssetKind;
  readonly path: string;
  /** Immutable content-addressed request URL. */
  readonly url: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly modeIds: readonly string[];
  readonly layers: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /**
   * Fetches, hashes, and validates this descriptor on demand. Concurrent
   * callers share only the in-flight operation; settled bytes are not retained
   * by asset-runtime.
   */
  readonly loadBytes: (signal?: AbortSignal) => Promise<Uint8Array>;
}

export type VerifiedTextureAssets = Readonly<
  Record<TextureAssetKind, readonly VerifiedTextureAsset[]>
>;

export interface VerifiedModePresentationMetadata {
  readonly modeId: string;
  readonly radialNodeIndex: number;
  readonly radialElementCount: number;
  readonly radialDof: "value" | "slope";
  readonly angularOrder: number;
  readonly symmetry: "axisymmetric" | "cosine" | "sine";
  readonly hubRadiusRatio: number;
}

/**
 * Progress for one descriptor-backed asset whose byte length and SHA-256 have
 * both passed. This does not mean that the complete dataset is valid: checksum
 * inventory, evidence, binary, and cross-asset validation still run before
 * `loadResonanceDataset` can return `status: "ready"`.
 *
 * `bytes` is an isolated copy so observer code cannot mutate the loader's
 * validation input.
 */
export interface VerifiedAssetProgressEvent {
  readonly schemaVersion: "mandelhowl.asset-progress.v1";
  readonly datasetId: `sha256:${string}`;
  readonly datasetReady: false;
  readonly path: string;
  readonly url: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly textureKind: TextureAssetKind | null;
  readonly texture: VerifiedTextureAssetMetadata | null;
  readonly verifiedCount: number;
  readonly totalCount: number;
  readonly bytes: Uint8Array;
}

export interface LoadResonanceDatasetOptions {
  readonly manifestUrl?: string;
  /** Base used only when manifestUrl is relative and location is unavailable. */
  readonly baseUrl?: string;
  readonly expectedDatasetId?: `sha256:${string}`;
  readonly runtimeVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly crypto?: Crypto;
  /** Cancels manifest and asset requests when the owning runtime is disposed. */
  readonly signal?: AbortSignal;
  /**
   * Receives individually verified assets while the complete dataset remains
   * pending. Observer failures are isolated from integrity validation.
   */
  readonly onAssetVerified?: (
    event: VerifiedAssetProgressEvent,
  ) => void | Promise<void>;
}

export type ResonanceDatasetLoadResult =
  | {
      readonly status: "ready";
      readonly manifest: ResonanceManifest;
      readonly dataset: ResonanceDataset;
      readonly assets: ReadonlyMap<string, Uint8Array>;
      readonly assetUrls: VerifiedAssetUrls;
      readonly textureAssets: VerifiedTextureAssets;
      readonly presentationModes: readonly VerifiedModePresentationMetadata[];
      readonly diagnostics: readonly DiagnosticRecord[];
    }
  | {
      readonly status: "failed";
      readonly manifest: ResonanceManifest | null;
      readonly dataset: null;
      readonly assets: ReadonlyMap<string, Uint8Array>;
      readonly assetUrls: VerifiedAssetUrls | null;
      readonly diagnostics: readonly DiagnosticRecord[];
    };

function diagnosticFailure(
  diagnostics: readonly DiagnosticRecord[],
  manifest: ResonanceManifest | null = null,
  assets: ReadonlyMap<string, Uint8Array> = new Map(),
  assetUrls: VerifiedAssetUrls | null = null,
): ResonanceDatasetLoadResult {
  return Object.freeze({
    status: "failed",
    manifest,
    dataset: null,
    assets,
    assetUrls,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function resolveManifestUrl(manifestUrl: string, baseUrl?: string): URL {
  const fallbackBase =
    baseUrl ??
    (typeof location === "object" && typeof location.href === "string"
      ? location.href
      : "http://localhost/");
  return new URL(manifestUrl, fallbackBase);
}

function resolveAssetUrl(manifestUrl: URL, path: string): string {
  return new URL(path, new URL(".", manifestUrl)).href;
}

async function readResponseBytes(
  fetcher: typeof globalThis.fetch,
  url: string,
  cache: RequestCache,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    cache,
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Keep non-critical atlas fetch/verification work out of one eager burst.
 *
 * Legacy datasets load modes, response, then their eager sand preview first.
 * Versioned datasets exclude every texture descriptor from this queue, so
 * modes and response lead while all mode shards remain at zero eager bytes.
 * Every remaining core/evidence asset begins in a later task and only after
 * the previous asset has been verified. This bounds network, hashing and
 * observer work while the mounted UI continues on its analytical fallback.
 */
async function yieldAssetLoadTurn(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
  signal?.throwIfAborted();
}

function immutableAssetRequestUrl(url: string, sha256: string): string {
  const immutableUrl = new URL(url);
  immutableUrl.searchParams.set("sha256", sha256);
  return immutableUrl.href;
}

function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createVerifiedTextureAssets(
  manifest: ResonanceManifest,
  assetUrls: VerifiedAssetUrls,
  fetcher: typeof globalThis.fetch,
  crypto: Crypto,
  datasetSignal?: AbortSignal,
): VerifiedTextureAssets {
  const grouped: Record<TextureAssetKind, VerifiedTextureAsset[]> = {
    "signed-displacement": [],
    normal: [],
    "nodal-mask": [],
    "sand-density": [],
  };
  for (const texture of manifest.files.textures) {
    const canonicalUrl = assetUrls.byPath[texture.path];
    const requestUrl = immutableAssetRequestUrl(
      canonicalUrl,
      texture.sha256,
    );
    let inFlight: Promise<Uint8Array> | null = null;
    const loadBytes = (signal?: AbortSignal): Promise<Uint8Array> => {
      datasetSignal?.throwIfAborted();
      signal?.throwIfAborted();
      if (inFlight === null) {
        const operation = (async () => {
          const bytes = await readResponseBytes(
            fetcher,
            requestUrl,
            "force-cache",
            datasetSignal,
          );
          if (bytes.byteLength !== texture.byteLength) {
            throw new Error(
              `${texture.path} byte length ${bytes.byteLength} does not match ${texture.byteLength}.`,
            );
          }
          const digest = await sha256Hex(bytes, crypto);
          if (digest !== texture.sha256) {
            throw new Error(
              `${texture.path} SHA-256 ${digest} does not match ${texture.sha256}.`,
            );
          }
          validateTextureAtlasBytes(bytes, texture);
          return bytes;
        })();
        inFlight = operation.finally(() => {
          inFlight = null;
        });
      }
      return waitForPromiseWithSignal(inFlight, signal).then((bytes) =>
        bytes.slice(),
      );
    };
    grouped[texture.kind].push(
      Object.freeze({
        kind: texture.kind,
        path: texture.path,
        url: requestUrl,
        sha256: texture.sha256,
        byteLength: texture.byteLength,
        mediaType: texture.mediaType,
        modeIds: Object.freeze([...texture.modeIds]),
        layers: texture.layers,
        widthPx: texture.widthPx,
        heightPx: texture.heightPx,
        loadBytes,
      }),
    );
  }
  return Object.freeze({
    "signed-displacement": Object.freeze(grouped["signed-displacement"]),
    normal: Object.freeze(grouped.normal),
    "nodal-mask": Object.freeze(grouped["nodal-mask"]),
    "sand-density": Object.freeze(grouped["sand-density"]),
  });
}

function prioritizedAssetReferences(
  manifest: ResonanceManifest,
  references: readonly AssetReference[],
): {
  readonly priority: readonly AssetReference[];
  readonly remaining: readonly AssetReference[];
} {
  const sandPath = manifest.files.textures.find(
    (texture) => texture.kind === "sand-density",
  )?.path;
  const byPath = new Map(references.map((asset) => [asset.path, asset]));
  const priorityPaths = [
    manifest.files.modes.path,
    manifest.files.response.path,
    sandPath,
  ].filter((path): path is string => typeof path === "string");
  const priority = priorityPaths
    .map((path) => byPath.get(path))
    .filter((asset): asset is AssetReference => asset !== undefined);
  const prioritySet = new Set(priority.map((asset) => asset.path));
  return Object.freeze({
    priority: Object.freeze(priority),
    remaining: Object.freeze(
      references.filter((asset) => !prioritySet.has(asset.path)),
    ),
  });
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(
      `${label} is not valid UTF-8 JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function freezeJsonTree<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeJsonTree(child);
  }
  return Object.freeze(value);
}

function validateChecksums(
  value: unknown,
  manifest: ResonanceManifest,
): readonly string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["root:not-object"];
  }
  const checksums = value as Partial<ChecksumsFile>;
  if (
    checksums.schemaVersion !== "mandelhowl.checksums.v1" ||
    checksums.algorithm !== "sha256" ||
    !Array.isArray(checksums.files)
  ) {
    return ["header"];
  }
  const expected = collectManifestAssets(manifest)
    .filter((asset) => asset.path !== manifest.files.checksums.path)
    .sort((left, right) => left.path.localeCompare(right.path));
  let previousPath = "";
  const entries = new Map<string, (typeof checksums.files)[number]>();
  for (const entry of checksums.files) {
    if (
      typeof entry?.path !== "string" ||
      typeof entry.byteLength !== "number" ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(
        entry.path,
      )
    ) {
      errors.push("entry-shape");
      continue;
    }
    if (entry.path <= previousPath) errors.push("entry-order");
    previousPath = entry.path;
    if (entries.has(entry.path)) errors.push("entry-duplicate");
    entries.set(entry.path, entry);
  }
  for (const asset of expected) {
    const entry = entries.get(asset.path);
    if (
      !entry ||
      entry.sha256 !== asset.sha256 ||
      entry.byteLength !== asset.byteLength
    ) {
      errors.push(`entry-mismatch:${asset.path}`);
    }
  }
  return Object.freeze([...new Set(errors)]);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return (
      canonicalizeJson(left as never) ===
      canonicalizeJson(right as never)
    );
  } catch {
    return false;
  }
}

function decodeVerifiedModePresentationMetadata(
  manifest: ResonanceManifest,
  assets: ReadonlyMap<string, Uint8Array>,
  decodedModes: readonly ModeRecord[],
): readonly VerifiedModePresentationMetadata[] {
  if (manifest.algorithmRevision === undefined) return Object.freeze([]);
  const provenance = parseJsonBytes(
    assets.get(manifest.files.provenance.path)!,
    manifest.files.provenance.path,
  );
  if (!isJsonRecord(provenance)) {
    throw new TypeError("Provenance presentation metadata is not an object");
  }
  const solver = provenance.solver;
  const options =
    isJsonRecord(solver) && isJsonRecord(solver.options)
      ? solver.options
      : null;
  const quadrature =
    options && isJsonRecord(options.quadrature)
      ? options.quadrature
      : null;
  const coordinateMap = provenance.renderingCoordinateTransform;
  const radialElementCount = quadrature?.radialElementCount;
  const radiusM =
    isJsonRecord(coordinateMap) ? coordinateMap.radiusM : undefined;
  const hubRadiusM =
    isJsonRecord(coordinateMap) ? coordinateMap.hubRadiusM : undefined;
  const maximumFourierOrder = quadrature?.maximumFourierOrder;
  if (
    !Number.isInteger(radialElementCount) ||
    (radialElementCount as number) < 1 ||
    !Number.isInteger(maximumFourierOrder) ||
    (maximumFourierOrder as number) < 0 ||
    !isFiniteNumber(radiusM) ||
    radiusM <= 0 ||
    !isFiniteNumber(hubRadiusM) ||
    hubRadiusM < 0 ||
    hubRadiusM >= radiusM ||
    !Array.isArray(provenance.modes) ||
    provenance.modes.length !== decodedModes.length
  ) {
    throw new TypeError(
      "Provenance presentation geometry is incomplete or invalid",
    );
  }
  const elementCount = radialElementCount as number;
  const hubRadiusRatio = hubRadiusM / radiusM;
  return Object.freeze(
    provenance.modes.map((value, index) => {
      if (!isJsonRecord(value) || !isJsonRecord(value.dominantBasis)) {
        throw new TypeError(
          `Provenance mode ${index} has no dominant finite-strip basis`,
        );
      }
      const basis = value.dominantBasis;
      const modeId = value.modeId;
      const radialNodeIndex = basis.radialNodeIndex;
      const radialDof = basis.radialDof;
      const angularOrder = basis.angularOrder;
      const symmetry = basis.symmetry;
      const decodedMode = decodedModes[index]!;
      const adjacentSpacing = value.adjacentFrequencySpacingHz;
      const surfaceKinematics = value.surfaceKinematics;
      const previousSpacing =
        index === 0
          ? null
          : decodedMode.naturalFrequencyHz -
            decodedModes[index - 1]!.naturalFrequencyHz;
      const nextSpacing =
        index + 1 === decodedModes.length
          ? null
          : decodedModes[index + 1]!.naturalFrequencyHz -
            decodedMode.naturalFrequencyHz;
      const nearestSpacing =
        previousSpacing === null
          ? nextSpacing
          : nextSpacing === null
            ? previousSpacing
            : Math.min(previousSpacing, nextSpacing);
      if (
        !hasExactKeys(value, [
          "modeId",
          "ordinal",
          "naturalFrequencyHz",
          "angularFrequencyRadPerSecond",
          "dampingRatio",
          "actuatorCoupling",
          "microphoneCoupling",
          "radiationEfficiency",
          "adjacentFrequencySpacingHz",
          "surfaceKinematics",
          "dominantBasis",
          "signReference",
          "textureLayer",
        ]) ||
        !hasExactKeys(basis, [
          "radialNodeIndex",
          "radialDof",
          "angularOrder",
          "symmetry",
        ]) ||
        modeId !== decodedMode.modeId ||
        value.ordinal !== decodedMode.ordinal ||
        value.naturalFrequencyHz !== decodedMode.naturalFrequencyHz ||
        value.angularFrequencyRadPerSecond !==
          decodedMode.angularFrequencyRadPerSecond ||
        value.dampingRatio !== decodedMode.dampingRatio ||
        value.actuatorCoupling !== decodedMode.actuatorCoupling ||
        value.microphoneCoupling !== decodedMode.microphoneCoupling ||
        value.radiationEfficiency !== decodedMode.radiationEfficiency ||
        value.signReference !== decodedMode.signReference ||
        value.textureLayer !== decodedMode.textureLayer ||
        !isJsonRecord(adjacentSpacing) ||
        !hasExactKeys(adjacentSpacing, [
          "previous",
          "next",
          "nearest",
        ]) ||
        adjacentSpacing.previous !== previousSpacing ||
        adjacentSpacing.next !== nextSpacing ||
        adjacentSpacing.nearest !== nearestSpacing ||
        !isJsonRecord(surfaceKinematics) ||
        !hasExactKeys(surfaceKinematics, [
          "signedDisplacementTextureLayer",
          "velocityScalePerUnitModalAmplitudePerSecond",
          "velocityPhaseOffsetRad",
          "accelerationScalePerUnitModalAmplitudePerSecondSquared",
          "accelerationPhaseOffsetRad",
        ]) ||
        surfaceKinematics.signedDisplacementTextureLayer !==
          decodedMode.textureLayer ||
        surfaceKinematics.velocityScalePerUnitModalAmplitudePerSecond !==
          decodedMode.angularFrequencyRadPerSecond ||
        surfaceKinematics.velocityPhaseOffsetRad !== Math.PI / 2 ||
        surfaceKinematics
          .accelerationScalePerUnitModalAmplitudePerSecondSquared !==
          decodedMode.angularFrequencyRadPerSecond *
            decodedMode.angularFrequencyRadPerSecond ||
        surfaceKinematics.accelerationPhaseOffsetRad !== Math.PI ||
        !Number.isInteger(radialNodeIndex) ||
        (radialNodeIndex as number) < 1 ||
        (radialNodeIndex as number) > elementCount ||
        (radialDof !== "value" && radialDof !== "slope") ||
        !Number.isInteger(angularOrder) ||
        (angularOrder as number) < 0 ||
        (angularOrder as number) > (maximumFourierOrder as number) ||
        (symmetry !== "axisymmetric" &&
          symmetry !== "cosine" &&
          symmetry !== "sine") ||
        ((angularOrder as number) === 0) !==
          (symmetry === "axisymmetric")
      ) {
        throw new TypeError(
          `Provenance mode ${index} is not exactly bound to modes.bin and its dominant basis`,
        );
      }
      return Object.freeze({
        modeId,
        radialNodeIndex: radialNodeIndex as number,
        radialElementCount: elementCount,
        radialDof,
        angularOrder: angularOrder as number,
        symmetry,
        hubRadiusRatio,
      });
    }),
  );
}

function validateVersionedEvidenceBindings(
  manifest: ResonanceManifest,
  plateSpec: Record<string, unknown>,
  provenance: Record<string, unknown>,
): readonly string[] {
  const errors: string[] = [];
  const canonicalInput = isJsonRecord(provenance.canonicalInput)
    ? provenance.canonicalInput
    : null;
  const generator = isJsonRecord(provenance.generator)
    ? provenance.generator
    : null;
  const solver = isJsonRecord(provenance.solver)
    ? provenance.solver
    : null;
  const solverOptions =
    solver && isJsonRecord(solver.options) ? solver.options : null;
  const quadrature =
    solverOptions && isJsonRecord(solverOptions.quadrature)
      ? solverOptions.quadrature
      : null;
  const finiteElementAssembly =
    solverOptions && isJsonRecord(solverOptions.finiteElementAssembly)
      ? solverOptions.finiteElementAssembly
      : null;
  const outputQuantization =
    solverOptions &&
    isJsonRecord(solverOptions.runtimeModalOutputQuantization)
      ? solverOptions.runtimeModalOutputQuantization
      : null;
  const canonicalRequest =
    solver && isJsonRecord(solver.canonicalRequest)
      ? solver.canonicalRequest
      : null;
  const coordinateSystem = isJsonRecord(plateSpec.coordinateSystem)
    ? plateSpec.coordinateSystem
    : null;
  const units = isJsonRecord(plateSpec.units) ? plateSpec.units : null;
  const frequencyRange = isJsonRecord(plateSpec.frequencyRange)
    ? plateSpec.frequencyRange
    : null;
  const geometry = isJsonRecord(plateSpec.geometry)
    ? plateSpec.geometry
    : null;
  const hub = geometry && isJsonRecord(geometry.hub) ? geometry.hub : null;
  const hubCentre =
    hub && isJsonRecord(hub.centreM) ? hub.centreM : null;
  const textureRequest = isJsonRecord(plateSpec.textureRequest)
    ? plateSpec.textureRequest
    : null;
  const solverRequest = isJsonRecord(plateSpec.solverRequest)
    ? plateSpec.solverRequest
    : null;
  const meshLevels =
    solverRequest && Array.isArray(solverRequest.meshLevels)
      ? solverRequest.meshLevels
      : null;
  const fineLevel =
    meshLevels && meshLevels.length > 0
      ? meshLevels[meshLevels.length - 1]
      : null;
  const analysisFiniteStrip =
    isJsonRecord(fineLevel) &&
    isJsonRecord(fineLevel.analysisFiniteStrip)
      ? fineLevel.analysisFiniteStrip
      : null;
  const transform = isJsonRecord(
    provenance.renderingCoordinateTransform,
  )
    ? provenance.renderingCoordinateTransform
    : null;
  const radiusM = geometry?.radiusM;
  const hubRadiusM = hub?.radiusM;
  const radialElementCount = quadrature?.radialElementCount;
  const angularSamples = quadrature?.angularSamples;
  const maximumFourierOrder = quadrature?.maximumFourierOrder;
  const expectedMinimumMappingJacobianM =
    isFiniteNumber(radiusM) &&
    isFiniteNumber(hubRadiusM) &&
    Number.isInteger(radialElementCount) &&
    (radialElementCount as number) > 0
      ? (radiusM - hubRadiusM) /
        (2 * (radialElementCount as number))
      : Number.NaN;
  const scientificAlgorithmSha256 =
    N_VERSION_CONTRACT_DIGESTS.scientificAlgorithm.slice(
      "sha256:".length,
    );

  if (
    !canonicalInput ||
    canonicalInput.plateId !== manifest.plate.plateId ||
    canonicalInput.path !== "specs/plate/mandelbrot-plate.v1.yaml" ||
    canonicalInput.canonicalJsonSha256 !==
      manifest.files.plateSpec.sha256
  ) {
    errors.push("provenance:canonical-input-binding");
  }
  if (
    !generator ||
    generator.name !== manifest.ownership.generator ||
    generator.version !== manifest.solverProvenance.solverVersion ||
    generator.algorithmRevision !== manifest.algorithmRevision ||
    generator.algorithmContractSha256 !==
      scientificAlgorithmSha256 ||
    generator.randomSource !== "forbidden"
  ) {
    errors.push("provenance:generator-binding");
  }

  if (
    !solver ||
    !solverOptions ||
    solver.name !== manifest.solverProvenance.solverName ||
    solver.version !== manifest.solverProvenance.solverVersion ||
    solver.executionKind !==
      manifest.solverProvenance.executionKind ||
    solver.containerImageDigest !==
      manifest.solverProvenance.containerImageDigest ||
    solver.optionsSha256 !==
      manifest.solverProvenance.optionsSha256 ||
    solver.normalization !== solverRequest?.normalization ||
    solver.signRule !== solverRequest?.signReference ||
    solver.executedMethod !==
      "c1-cubic-hermite-annular-finite-strip" ||
    solver.methodRequestMismatchRecorded !== false ||
    solver.strictLiteralSection10_3Conformance !== true ||
    !canonicalRequest ||
    canonicalRequest.elementFamily !== solverRequest?.elementFamily ||
    canonicalRequest.requestedModeCount !== manifest.modeCount
  ) {
    errors.push("provenance:solver-binding");
  }
  const executionKind = manifest.solverProvenance.executionKind;
  if (
    !solver ||
    (executionKind === "native-process"
      ? solver.containerized !== false ||
        solver.containerImageDigest !== null ||
        solver.containerRunnerAttestation !==
          "not-applicable-native-process"
      : executionKind === "oci-container"
        ? solver.containerized !== true ||
          solver.containerRunnerAttestation !==
            "trusted-runner-attested"
        : true)
  ) {
    errors.push("provenance:execution-binding");
  }

  if (
    !solverOptions ||
    !hasExactKeys(solverOptions, [
      "method",
      "algorithmRevision",
      "algorithmContractSha256",
      "basisCount",
      "quadrature",
      "finiteElementAssembly",
      "runtimeModalOutputQuantization",
      "floatPrecision",
      "fastMath",
      "randomSource",
    ]) ||
    solverOptions.method !==
      "variable-thickness-kirchhoff-love-c1-finite-strip-fem" ||
    solverOptions.algorithmRevision !== manifest.algorithmRevision ||
    solverOptions.algorithmContractSha256 !==
      scientificAlgorithmSha256 ||
    solverOptions.floatPrecision !== "binary64" ||
    solverOptions.fastMath !== false ||
    solverOptions.randomSource !== "forbidden" ||
    !Number.isInteger(solverOptions.basisCount) ||
    solverOptions.basisCount !== quadrature?.dofCount ||
    !finiteElementAssembly ||
    !hasExactKeys(finiteElementAssembly, [
      "radialInterpolation",
      "angularInterpolation",
      "innerBoundary",
      "outerBoundary",
    ]) ||
    finiteElementAssembly.radialInterpolation !== "cubic-hermite-c1" ||
    finiteElementAssembly.angularInterpolation !==
      "normalized-real-fourier" ||
    finiteElementAssembly.innerBoundary !==
      "value-and-radial-slope-dofs-eliminated" ||
    finiteElementAssembly.outerBoundary !== "natural-free-edge" ||
    !outputQuantization ||
    !hasExactKeys(outputQuantization, [
      "frequencyQuantumHz",
      "couplingQuantum",
      "rounding",
      "negativeZero",
    ]) ||
    outputQuantization.frequencyQuantumHz !==
      VERSIONED_RUNTIME_FREQUENCY_QUANTUM_HZ ||
    outputQuantization.couplingQuantum !==
      VERSIONED_RUNTIME_COUPLING_QUANTUM ||
    outputQuantization.rounding !== "ties-to-even" ||
    outputQuantization.negativeZero !==
      "canonicalize-to-positive-zero"
  ) {
    errors.push("provenance:algorithm-options-binding");
  }

  if (
    !quadrature ||
    !hasExactKeys(quadrature, [
      "radialElementCount",
      "maximumFourierOrder",
      "angularSamples",
      "radialGaussOrder",
      "pointCount",
      "dofCount",
      "minimumMappingJacobianM",
      "boundaryConditions",
    ]) ||
    !Number.isInteger(radialElementCount) ||
    (radialElementCount as number) < 1 ||
    !Number.isInteger(maximumFourierOrder) ||
    (maximumFourierOrder as number) < 0 ||
    !Number.isInteger(angularSamples) ||
    (angularSamples as number) < 1 ||
    quadrature.radialGaussOrder !== 5 ||
    quadrature.pointCount !==
      (radialElementCount as number) *
        (angularSamples as number) *
        5 ||
    quadrature.dofCount !==
      2 *
        (radialElementCount as number) *
        (1 + 2 * (maximumFourierOrder as number)) ||
    quadrature.boundaryConditions !==
      "inner-value-and-slope-eliminated;outer-natural-free" ||
    !isFiniteNumber(quadrature.minimumMappingJacobianM) ||
    quadrature.minimumMappingJacobianM <= 0 ||
    !Number.isFinite(expectedMinimumMappingJacobianM) ||
    Math.abs(
      quadrature.minimumMappingJacobianM -
        expectedMinimumMappingJacobianM,
    ) >
      Number.EPSILON *
        8 *
        Math.max(1, Math.abs(expectedMinimumMappingJacobianM)) ||
    !analysisFiniteStrip ||
    analysisFiniteStrip.radialElementCount !== radialElementCount ||
    analysisFiniteStrip.maximumFourierOrder !== maximumFourierOrder ||
    analysisFiniteStrip.angularQuadratureSamples !== angularSamples
  ) {
    errors.push("provenance:analysis-resolution-binding");
  }

  if (
    !coordinateSystem ||
    !units ||
    !frequencyRange ||
    !jsonValuesEqual(manifest.coordinateSystem, coordinateSystem) ||
    !jsonValuesEqual(manifest.units, units) ||
    !jsonValuesEqual(manifest.frequencyRange, frequencyRange) ||
    !solverRequest ||
    !Array.isArray(solverRequest.frequencyRangeHz) ||
    solverRequest.frequencyRangeHz.length !== 2 ||
    solverRequest.frequencyRangeHz[0] !==
      manifest.frequencyRange.minimumHz ||
    solverRequest.frequencyRangeHz[1] !==
      manifest.frequencyRange.maximumHz ||
    solverRequest.requestedModeCount !== manifest.modeCount
  ) {
    errors.push("plate-spec:runtime-binding");
  }

  if (
    !geometry ||
    geometry.frontShape !== "circle" ||
    geometry.frontSurfaceZM !== 0 ||
    !isFiniteNumber(radiusM) ||
    radiusM <= 0 ||
    !hub ||
    hub.shape !== "circle" ||
    !isFiniteNumber(hubRadiusM) ||
    hubRadiusM < 0 ||
    hubRadiusM >= radiusM ||
    !hubCentre ||
    hubCentre.x !== 0 ||
    hubCentre.y !== 0 ||
    hubCentre.z !== 0
  ) {
    errors.push("plate-spec:presentation-geometry");
  }

  if (
    !textureRequest ||
    !hasExactKeys(textureRequest, [
      "channels",
      "container",
      "widthPx",
      "heightPx",
      "uvOrigin",
      "uvXAxis",
      "uvYAxis",
    ]) ||
    !jsonValuesEqual(textureRequest.channels, [
      "signed-displacement-r8",
      "normal-rg8",
      "nodal-mask-r8",
      "sand-density-r8",
    ]) ||
    textureRequest.container !== "KTX2" ||
    !Number.isInteger(textureRequest.widthPx) ||
    (textureRequest.widthPx as number) < 16 ||
    !Number.isInteger(textureRequest.heightPx) ||
    (textureRequest.heightPx as number) < 16 ||
    textureRequest.uvOrigin !== "negative-x-negative-y" ||
    textureRequest.uvXAxis !== "positive-x" ||
    textureRequest.uvYAxis !== "positive-y" ||
    manifest.files.textures.some(
      (texture) =>
        texture.widthPx !== textureRequest.widthPx ||
        texture.heightPx !== textureRequest.heightPx ||
        texture.uvOrigin !== textureRequest.uvOrigin ||
        texture.mediaType !== "image/ktx2",
    )
  ) {
    errors.push("plate-spec:texture-request-binding");
  }

  if (
    !transform ||
    !hasExactKeys(transform, [
      "sourceFrame",
      "uvOrigin",
      "uAxis",
      "vAxis",
      "plateXFromU",
      "plateYFromV",
      "validSurfaceDomain",
      "radiusM",
      "hubRadiusM",
    ]) ||
    transform.sourceFrame !== coordinateSystem?.frame ||
    transform.uvOrigin !== textureRequest?.uvOrigin ||
    transform.uAxis !== textureRequest?.uvXAxis ||
    transform.vAxis !== textureRequest?.uvYAxis ||
    transform.plateXFromU !== "x=(2*u-1)*radiusM" ||
    transform.plateYFromV !== "y=(2*v-1)*radiusM" ||
    transform.validSurfaceDomain !==
      "hubRadiusM<hypot(x,y)<=radiusM" ||
    transform.radiusM !== radiusM ||
    transform.hubRadiusM !== hubRadiusM
  ) {
    errors.push("provenance:rendering-coordinate-binding");
  }

  return Object.freeze(errors);
}

function isCoverageTrace(
  value: unknown,
  modalModelId: string,
  expectedVolume: number,
  minimumFrequencyHz: number,
  maximumFrequencyHz: number,
): value is Record<string, unknown> {
  if (!isJsonRecord(value)) return false;
  const minimumFrequencyCentiHz = toCentiHertz(minimumFrequencyHz);
  const maximumFrequencyCentiHz = toCentiHertz(maximumFrequencyHz);
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "traceId",
      "modalModelId",
      "initialFrequencyCentiHz",
      "durationSeconds",
      "expectedSettledVolume",
      "keyframes",
    ]) ||
    value.schemaVersion !==
      "mandelhowl.resonance-trajectory-trace.v2" ||
    typeof value.traceId !== "string" ||
    value.traceId.length === 0 ||
    value.modalModelId !== modalModelId ||
    !isFiniteNumber(value.initialFrequencyCentiHz) ||
    !Number.isSafeInteger(value.initialFrequencyCentiHz) ||
    value.initialFrequencyCentiHz < minimumFrequencyCentiHz ||
    value.initialFrequencyCentiHz > maximumFrequencyCentiHz ||
    !isFiniteNumber(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    value.expectedSettledVolume !== expectedVolume ||
    !Array.isArray(value.keyframes) ||
    value.keyframes.length === 0
  ) {
    return false;
  }

  const durationSeconds = value.durationSeconds as number;
  const keyframes = value.keyframes as unknown[];
  let previousTime = -1;
  return keyframes.every((keyframe, index) => {
    if (
      !isJsonRecord(keyframe) ||
      !hasExactKeys(keyframe, [
        "sequence",
        "atSeconds",
        "frequencyCentiHz",
      ]) ||
      keyframe.sequence !== index ||
      !isFiniteNumber(keyframe.atSeconds) ||
      keyframe.atSeconds < previousTime ||
      keyframe.atSeconds > durationSeconds ||
      !isFiniteNumber(keyframe.frequencyCentiHz) ||
      !Number.isSafeInteger(keyframe.frequencyCentiHz) ||
      keyframe.frequencyCentiHz < minimumFrequencyCentiHz ||
      keyframe.frequencyCentiHz > maximumFrequencyCentiHz
    ) {
      return false;
    }
    previousTime = keyframe.atSeconds;
    return index !== 0 || keyframe.atSeconds === 0;
  });
}

function coverageTracesEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.traceId !== right.traceId ||
    left.modalModelId !== right.modalModelId ||
    left.initialFrequencyCentiHz !== right.initialFrequencyCentiHz ||
    left.durationSeconds !== right.durationSeconds ||
    left.expectedSettledVolume !== right.expectedSettledVolume ||
    !Array.isArray(left.keyframes) ||
    !Array.isArray(right.keyframes) ||
    left.keyframes.length !== right.keyframes.length
  ) {
    return false;
  }
  const leftKeyframes = left.keyframes as unknown[];
  const rightKeyframes = right.keyframes as unknown[];
  return leftKeyframes.every((leftKeyframe, index) => {
    const rightKeyframe = rightKeyframes[index];
    return (
      isJsonRecord(leftKeyframe) &&
      isJsonRecord(rightKeyframe) &&
      leftKeyframe.sequence === rightKeyframe.sequence &&
      leftKeyframe.atSeconds === rightKeyframe.atSeconds &&
      leftKeyframe.frequencyCentiHz ===
        rightKeyframe.frequencyCentiHz
    );
  });
}

function validateJsonEvidenceAssets(
  manifest: ResonanceManifest,
  assets: ReadonlyMap<string, Uint8Array>,
): readonly string[] {
  const errors: string[] = [];
  const values = new Map<string, Record<string, unknown>>();
  for (const asset of [
    manifest.files.plateSpec,
    manifest.files.provenance,
    manifest.files.convergenceReport,
    manifest.files.coverageReport,
  ]) {
    try {
      const bytes = assets.get(asset.path);
      if (!bytes) {
        errors.push(`${asset.path}:missing`);
        continue;
      }
      const value = parseJsonBytes(bytes, asset.path);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${asset.path}:not-object`);
      } else {
        values.set(asset.path, value as Record<string, unknown>);
      }
    } catch {
      errors.push(`${asset.path}:invalid-json`);
    }
  }
  const plateSpec = values.get(manifest.files.plateSpec.path);
  if (
    !plateSpec ||
    plateSpec.schemaVersion !== "mandelhowl.plate-spec.v1" ||
    plateSpec.plateId !== manifest.plate.plateId
  ) {
    errors.push("plate-spec:identity");
  }
  const thicknessMapping =
    plateSpec &&
    typeof plateSpec.thicknessMapping === "object" &&
    plateSpec.thicknessMapping !== null &&
    !Array.isArray(plateSpec.thicknessMapping)
      ? (plateSpec.thicknessMapping as Record<string, unknown>)
      : null;
  const materialSectionProfile =
    manifest.plate.materialSectionProfile;
  if (
    manifest.algorithmRevision !== undefined &&
    (!materialSectionProfile ||
      !thicknessMapping ||
      materialSectionProfile.minimumThicknessM !==
        thicknessMapping.minimumThicknessM ||
      materialSectionProfile.maximumThicknessM !==
        thicknessMapping.maximumThicknessM)
  ) {
    errors.push("plate-spec:material-section-range");
  }

  const provenance = values.get(manifest.files.provenance.path);
  const canonicalInput =
    provenance &&
    typeof provenance.canonicalInput === "object" &&
    provenance.canonicalInput !== null &&
    !Array.isArray(provenance.canonicalInput)
      ? (provenance.canonicalInput as Record<string, unknown>)
      : null;
  const generator =
    provenance &&
    typeof provenance.generator === "object" &&
    provenance.generator !== null &&
    !Array.isArray(provenance.generator)
      ? (provenance.generator as Record<string, unknown>)
      : null;
  const provenanceModes = provenance?.modes;
  if (
    provenance?.schemaVersion !== "mandelhowl.provenance.v1" ||
    canonicalInput?.plateId !== manifest.plate.plateId ||
    generator?.randomSource !== "forbidden" ||
    !Array.isArray(provenanceModes) ||
    provenanceModes.length !== manifest.modeCount
  ) {
    errors.push("provenance:semantic-invalid");
  }
  if (
    manifest.algorithmRevision !== undefined &&
    plateSpec &&
    provenance
  ) {
    errors.push(
      ...validateVersionedEvidenceBindings(
        manifest,
        plateSpec,
        provenance,
      ),
    );
  }

  const convergence = values.get(manifest.files.convergenceReport.path);
  const methodConformance =
    convergence &&
    typeof convergence.methodConformance === "object" &&
    convergence.methodConformance !== null &&
    !Array.isArray(convergence.methodConformance)
      ? (convergence.methodConformance as Record<string, unknown>)
      : null;
  const independentCrossValidation =
    convergence &&
    typeof convergence.independentCrossValidation === "object" &&
    convergence.independentCrossValidation !== null &&
    !Array.isArray(convergence.independentCrossValidation)
      ? (convergence.independentCrossValidation as Record<string, unknown>)
      : null;
  const versionedDataset = manifest.algorithmRevision !== undefined;
  const legacyConvergenceAccepted =
    convergence?.quadratureConvergenceAccepted === true ||
    convergence?.finiteElementMeshConvergenceAccepted === true;
  const versionedConvergenceAccepted =
    convergence?.finiteElementMeshConvergenceAccepted === true &&
    convergence.surfaceMeshQualityAccepted === true &&
    methodConformance?.thinPlateEigenanalysisSupported === true &&
    methodConformance.surfaceMeshQualityValidated === true &&
    methodConformance.finiteElementAssemblyUsed === true &&
    methodConformance
      .analysisSurfaceElementMeshCoupledToEigenproblem === true &&
    methodConformance
      .surfaceTriangleArchiveCoupledToEigenproblem === false &&
    methodConformance.strictLiteralSection10_3Conformance === true &&
    !("deviationCode" in methodConformance) &&
    methodConformance.operationalDisposition ===
      "strict-thin-plate-finite-element-adapter";
  if (
    convergence?.schemaVersion !== "mandelhowl.convergence-report.v1" ||
    convergence.accepted !== true ||
    methodConformance?.handoffThinPlateMethodAllowed !== true ||
    methodConformance.matchesCanonicalElementFamily !== true ||
    independentCrossValidation?.accepted !== true ||
    (versionedDataset
      ? !versionedConvergenceAccepted
      : !legacyConvergenceAccepted)
  ) {
    errors.push("convergence-report:not-accepted");
  }

  const coverage = values.get(manifest.files.coverageReport.path);
  const generatedBy =
    coverage &&
    typeof coverage.generatedBy === "object" &&
    coverage.generatedBy !== null &&
    !Array.isArray(coverage.generatedBy)
      ? (coverage.generatedBy as Record<string, unknown>)
      : null;
  const coverageContract =
    coverage &&
    typeof coverage.coverageContract === "object" &&
    coverage.coverageContract !== null &&
    !Array.isArray(coverage.coverageContract)
      ? (coverage.coverageContract as Record<string, unknown>)
      : null;
  const runtimeSpecSha256 =
    coverage &&
    typeof coverage.runtimeSpecSha256 === "object" &&
    coverage.runtimeSpecSha256 !== null &&
    !Array.isArray(coverage.runtimeSpecSha256)
      ? (coverage.runtimeSpecSha256 as Record<string, unknown>)
      : null;
  const staticDistribution =
    coverage &&
    typeof coverage.staticDistribution === "object" &&
    coverage.staticDistribution !== null &&
    !Array.isArray(coverage.staticDistribution)
      ? (coverage.staticDistribution as Record<string, unknown>)
      : null;
  const coveredValues = coverage?.coveredValues;
  const missingValues = coverage?.missingValues;
  const traces = coverage?.traces;
  const outputs = coverage?.outputs;
  const expectedValues = Array.from({ length: 101 }, (_, value) => value);
  const modalModelId = `sha256:${manifest.files.modes.sha256}`;
  const versionedCoverageKeys = [
    "schemaVersion",
    "modalModelId",
    "runtimeAlgorithmRevision",
    "coverageContract",
    "generatedBy",
    "perValueRuntimeExceptionTable",
    "verificationStatus",
    "runtimeSpecSha256",
    "staticDistribution",
    "replayVerified",
    "coveredValues",
    "missingValues",
    "traces",
    "outputs",
  ] as const;
  const legacyCoverageKeys = versionedCoverageKeys.filter(
    (key) =>
      key !== "runtimeAlgorithmRevision" &&
      key !== "coverageContract",
  );
  const coverageUsesVersionedBinding =
    coverage?.runtimeAlgorithmRevision !== undefined ||
    coverage?.coverageContract !== undefined;
  const coverageShapeValid =
    !!coverage &&
    hasExactKeys(
      coverage,
      versionedDataset || coverageUsesVersionedBinding
        ? versionedCoverageKeys
        : legacyCoverageKeys,
    );
  const coverageValuesValid =
    Array.isArray(coveredValues) &&
    coveredValues.length === expectedValues.length &&
    coveredValues.every((value, index) => value === expectedValues[index]);
  const tracesValid =
    Array.isArray(traces) &&
    traces.length === expectedValues.length &&
    traces.every((trace, index) =>
      isCoverageTrace(
        trace,
        modalModelId,
        index,
        manifest.frequencyRange.minimumHz,
        manifest.frequencyRange.maximumHz,
      ),
    ) &&
    new Set(
      traces.map((trace) =>
        isJsonRecord(trace) ? trace.traceId : undefined,
      ),
    ).size === expectedValues.length;
  const outputsValid =
    Array.isArray(outputs) &&
    outputs.length === expectedValues.length &&
    outputs.every((value, index) => {
      if (
        !isJsonRecord(value) ||
        !hasExactKeys(value, [
          "target",
          "verification",
          "verified",
          "trace",
        ])
      ) {
        return false;
      }
      const trace = Array.isArray(traces) ? traces[index] : null;
      return (
        value.target === index &&
        value.verified === true &&
        value.verification === "runtime-replay-verified" &&
        isCoverageTrace(
          value.trace,
          modalModelId,
          index,
          manifest.frequencyRange.minimumHz,
          manifest.frequencyRange.maximumHz,
        ) &&
        isJsonRecord(trace) &&
        coverageTracesEqual(value.trace, trace)
      );
    });
  const staticSampleCount = staticDistribution?.sampleCount;
  const staticZeroCount = staticDistribution?.zeroCount;
  const staticHundredCount = staticDistribution?.hundredCount;
  const staticIntermediateCount = staticDistribution?.intermediateCount;
  const staticExtremeFraction = staticDistribution?.extremeFraction;
  const staticRequiredExtremeFraction =
    staticDistribution?.requiredExtremeFraction;
  const staticDistributionValid =
    !!staticDistribution &&
    hasExactKeys(staticDistribution, [
      "sampleCount",
      "zeroCount",
      "hundredCount",
      "intermediateCount",
      "extremeFraction",
      "requiredExtremeFraction",
      "passed",
    ]) &&
    Number.isInteger(staticSampleCount) &&
    (staticSampleCount as number) > 0 &&
    Number.isInteger(staticZeroCount) &&
    (staticZeroCount as number) >= 0 &&
    Number.isInteger(staticHundredCount) &&
    (staticHundredCount as number) >= 0 &&
    Number.isInteger(staticIntermediateCount) &&
    (staticIntermediateCount as number) >= 0 &&
    (staticZeroCount as number) +
      (staticHundredCount as number) +
      (staticIntermediateCount as number) ===
      staticSampleCount &&
    isFiniteNumber(staticExtremeFraction) &&
    isFiniteNumber(staticRequiredExtremeFraction) &&
    staticRequiredExtremeFraction >= 0 &&
    staticRequiredExtremeFraction <= 1 &&
    Math.abs(
      staticExtremeFraction -
        ((staticZeroCount as number) +
          (staticHundredCount as number)) /
          (staticSampleCount as number),
    ) <= Number.EPSILON * 8 &&
    staticExtremeFraction >= staticRequiredExtremeFraction &&
    staticDistribution.passed === true;
  const versionedCoverageBindingValid =
    coverage?.runtimeAlgorithmRevision ===
      GENERATED_FEEDBACK_SPEC.algorithmRevision &&
    coverageContract?.schemaVersion ===
      "mandelhowl.coverage-report.v2" &&
    coverageContract?.schemaSha256 ===
      COVERAGE_REPORT_SCHEMA_SHA256 &&
    !!generatedBy &&
    hasExactKeys(generatedBy, [
      "algorithm",
      "feedbackAlgorithmRevision",
      "perValueRuntimeLookup",
      "randomSource",
    ]) &&
    generatedBy.feedbackAlgorithmRevision ===
      GENERATED_FEEDBACK_SPEC.algorithmRevision &&
    runtimeSpecSha256?.dial === RUNTIME_SPEC_SOURCE_HASHES.dial &&
    runtimeSpecSha256?.feedback ===
      RUNTIME_SPEC_SOURCE_HASHES.feedback &&
    runtimeSpecSha256?.volumeMap ===
      RUNTIME_SPEC_SOURCE_HASHES.volumeMap &&
    runtimeSpecSha256?.audioSafety ===
      RUNTIME_SPEC_SOURCE_HASHES.audioSafety &&
    runtimeSpecSha256?.uiNVersion ===
      N_VERSION_CONTRACT_DIGESTS.presentationContract.slice(
        "sha256:".length,
      ) &&
    hasExactKeys(coverageContract, [
      "schemaVersion",
      "schemaSha256",
    ]) &&
    !!runtimeSpecSha256 &&
    hasExactKeys(runtimeSpecSha256, [
      "dial",
      "feedback",
      "volumeMap",
      "audioSafety",
      "uiNVersion",
    ]);
  const legacyCoverageBindingValid =
    coverage?.runtimeAlgorithmRevision === undefined &&
    coverage?.coverageContract === undefined &&
    !!generatedBy &&
    hasExactKeys(generatedBy, [
      "algorithm",
      "perValueRuntimeLookup",
      "randomSource",
    ]) &&
    !!runtimeSpecSha256 &&
    hasExactKeys(runtimeSpecSha256, [
      "dial",
      "feedback",
      "volumeMap",
    ]) &&
    Object.values(runtimeSpecSha256).every(
      (digest) =>
        typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    );
  const coverageBindingValid = versionedDataset
    ? versionedCoverageBindingValid
    : versionedCoverageBindingValid || legacyCoverageBindingValid;
  if (
    !coverageShapeValid ||
    coverage?.schemaVersion !== "mandelhowl.coverage-report.v2" ||
    coverage.modalModelId !== modalModelId ||
    !coverageBindingValid ||
    coverage.perValueRuntimeExceptionTable !== false ||
    coverage.verificationStatus !== "runtime-replay-verified" ||
    coverage.replayVerified !== true ||
    !generatedBy ||
    generatedBy.algorithm !==
      "deterministic-global-trajectory-search-v2" ||
    generatedBy?.perValueRuntimeLookup !== "forbidden" ||
    generatedBy?.randomSource !== "forbidden" ||
    !staticDistributionValid ||
    !coverageValuesValid ||
    !Array.isArray(missingValues) ||
    missingValues.length !== 0 ||
    !tracesValid ||
    !outputsValid
  ) {
    errors.push("coverage-report:semantic-invalid");
  }
  return Object.freeze([...new Set(errors)]);
}

function createAssetUrls(
  manifestUrl: URL,
  manifest: ResonanceManifest,
): VerifiedAssetUrls {
  const byPath: Record<string, string> = {};
  for (const asset of collectManifestAssets(manifest)) {
    byPath[asset.path] = resolveAssetUrl(manifestUrl, asset.path);
  }
  const textures: Record<TextureAssetKind, TextureAssetUrl[]> = {
    "signed-displacement": [],
    normal: [],
    "nodal-mask": [],
    "sand-density": [],
  };
  for (const texture of manifest.files.textures) {
    textures[texture.kind].push(
      Object.freeze({
        kind: texture.kind,
        url: byPath[texture.path],
        modeIds: Object.freeze([...texture.modeIds]),
        layers: texture.layers,
        widthPx: texture.widthPx,
        heightPx: texture.heightPx,
        mediaType: texture.mediaType,
      }),
    );
  }
  return Object.freeze({
    manifest: manifestUrl.href,
    byPath: Object.freeze(byPath),
    textures: Object.freeze({
      "signed-displacement": Object.freeze(textures["signed-displacement"]),
      normal: Object.freeze(textures.normal),
      "nodal-mask": Object.freeze(textures["nodal-mask"]),
      "sand-density": Object.freeze(textures["sand-density"]),
    }),
  });
}

export async function loadResonanceDataset(
  options: LoadResonanceDatasetOptions = {},
): Promise<ResonanceDatasetLoadResult> {
  options.signal?.throwIfAborted();
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    return diagnosticFailure([
      createDiagnostic(
        ASSET_DIAGNOSTIC_CODES.manifestFetchFailed,
        "fatal",
        "confirmed",
        "dataset.manifest.fetch-unavailable",
      ),
    ]);
  }
  const manifestUrl = resolveManifestUrl(
    options.manifestUrl ?? GENERATED_DATASET_RELEASE_SPEC.manifestUrl,
    options.baseUrl,
  );
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await readResponseBytes(
      fetcher,
      manifestUrl.href,
      "no-cache",
      options.signal,
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    return diagnosticFailure([
      createDiagnostic(
        ASSET_DIAGNOSTIC_CODES.manifestFetchFailed,
        "fatal",
        "confirmed",
        "dataset.manifest.fetch-failed",
        [
          evidence("url", manifestUrl.href, "fetch"),
          evidence(
            "error",
            error instanceof Error ? error.message : String(error),
            "fetch",
          ),
        ],
      ),
    ]);
  }

  let manifestJson: unknown;
  try {
    manifestJson = parseJsonBytes(manifestBytes, "manifest.json");
  } catch (error) {
    return diagnosticFailure([
      createDiagnostic(
        ASSET_DIAGNOSTIC_CODES.manifestJsonInvalid,
        "fatal",
        "confirmed",
        "dataset.manifest.json-invalid",
        [
          evidence(
            "error",
            error instanceof Error ? error.message : String(error),
            "manifest.json",
          ),
        ],
      ),
    ]);
  }
  const validation = validateResonanceManifest(manifestJson);
  if (!validation.manifest) {
    return diagnosticFailure(validation.diagnostics);
  }
  const manifest = freezeJsonTree(validation.manifest);
  const assetUrls = createAssetUrls(manifestUrl, manifest);

  let identityDigest: string;
  try {
    identityDigest = await sha256Hex(
      canonicalizeJson(manifestIdentityPayload(manifest)),
      options.crypto ?? globalThis.crypto,
    );
  } catch (error) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.dataInvalid,
          "fatal",
          "confirmed",
          "dataset.crypto.unavailable",
          [
            evidence(
              "error",
              error instanceof Error ? error.message : String(error),
              "WebCrypto",
            ),
          ],
        ),
      ],
      manifest,
      new Map(),
      assetUrls,
    );
  }
  if (
    manifest.datasetId !== `sha256:${identityDigest}` ||
    manifest.contentAddressing.directoryName !== identityDigest
  ) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.datasetIdentityMismatch,
          "fatal",
          "confirmed",
          "dataset.identity.mismatch",
          [
            evidence("computedSha256", identityDigest, "manifest.json"),
            evidence("datasetId", manifest.datasetId, "manifest.json"),
            evidence(
              "directoryName",
              manifest.contentAddressing.directoryName,
              "manifest.json",
            ),
          ],
        ),
      ],
      manifest,
      new Map(),
      assetUrls,
    );
  }
  const expectedDatasetId =
    options.expectedDatasetId ??
    (options.manifestUrl === undefined
      ? GENERATED_DATASET_RELEASE_SPEC.datasetId
      : undefined);
  if (expectedDatasetId && expectedDatasetId !== manifest.datasetId) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.expectedDatasetMismatch,
          "fatal",
          "confirmed",
          "dataset.identity.unexpected",
          [
            evidence("expectedDatasetId", expectedDatasetId, "runtime-config"),
            evidence("actualDatasetId", manifest.datasetId, "manifest.json"),
          ],
        ),
      ],
      manifest,
      new Map(),
      assetUrls,
    );
  }
  const runtimeVersion = options.runtimeVersion ?? MANDELHOWL_RUNTIME_VERSION;
  if (!isRuntimeCompatible(manifest, runtimeVersion)) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.runtimeIncompatible,
          "fatal",
          "confirmed",
          "dataset.runtime.incompatible",
          [
            evidence("runtimeVersion", runtimeVersion, "asset-runtime"),
            evidence(
              "minimumRuntimeVersion",
              manifest.runtimeCompatibility.minimumRuntimeVersion,
              "manifest.json",
            ),
            evidence(
              "maximumRuntimeVersionExclusive",
              manifest.runtimeCompatibility.maximumRuntimeVersionExclusive,
              "manifest.json",
            ),
          ],
        ),
      ],
      manifest,
      new Map(),
      assetUrls,
    );
  }

  let references: readonly AssetReference[];
  try {
    references = collectManifestAssets(manifest);
  } catch (error) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.manifestSchemaInvalid,
          "fatal",
          "confirmed",
          "dataset.manifest.asset-inventory-invalid",
          [
            evidence(
              "error",
              error instanceof Error ? error.message : String(error),
              "manifest.json",
            ),
          ],
        ),
      ],
      manifest,
      new Map(),
      assetUrls,
    );
  }

  const assets = new Map<string, Uint8Array>();
  const diagnostics: DiagnosticRecord[] = [];
  const textureAssets = createVerifiedTextureAssets(
    manifest,
    assetUrls,
    fetcher,
    options.crypto ?? globalThis.crypto,
    options.signal,
  );
  let verifiedCount = 0;
  const texturesByPath = new Map(
    manifest.files.textures.map((texture) => [
      texture.path,
      Object.freeze({
        kind: texture.kind,
        modeIds: Object.freeze([...texture.modeIds]),
        widthPx: texture.widthPx,
        heightPx: texture.heightPx,
        layers: texture.layers,
        uvOrigin: texture.uvOrigin,
      }) satisfies VerifiedTextureAssetMetadata,
    ]),
  );
  const fetchAndVerify = async (asset: AssetReference): Promise<void> => {
    options.signal?.throwIfAborted();
    const canonicalUrl = assetUrls.byPath[asset.path];
    const requestUrl = immutableAssetRequestUrl(canonicalUrl, asset.sha256);
    let bytes: Uint8Array;
    try {
      bytes = await readResponseBytes(
        fetcher,
        requestUrl,
        "force-cache",
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      diagnostics.push(
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.assetFetchFailed,
          "fatal",
          "confirmed",
          "dataset.asset.fetch-failed",
          [
            evidence("path", asset.path, "manifest.json"),
            evidence(
              "error",
              error instanceof Error ? error.message : String(error),
              "fetch",
            ),
          ],
        ),
      );
      return;
    }
    options.signal?.throwIfAborted();
    if (bytes.byteLength !== asset.byteLength) {
      diagnostics.push(
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.assetByteLengthMismatch,
          "fatal",
          "confirmed",
          "dataset.asset.byte-length-mismatch",
          [
            evidence("path", asset.path, "manifest.json"),
            evidence("expected", asset.byteLength, "manifest.json"),
            evidence("actual", bytes.byteLength, "fetch"),
          ],
        ),
      );
      return;
    }
    const digest = await sha256Hex(bytes, options.crypto ?? globalThis.crypto);
    options.signal?.throwIfAborted();
    if (digest !== asset.sha256) {
      diagnostics.push(
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.assetHashMismatch,
          "fatal",
          "confirmed",
          "dataset.asset.hash-mismatch",
          [
            evidence("path", asset.path, "manifest.json"),
            evidence("expected", asset.sha256, "manifest.json"),
            evidence("actual", digest, "WebCrypto"),
          ],
        ),
      );
      return;
    }
    assets.set(asset.path, bytes);
    verifiedCount += 1;
    if (
      options.onAssetVerified &&
      manifest.algorithmRevision === undefined
    ) {
      const texture = texturesByPath.get(asset.path) ?? null;
      const progress = Object.freeze({
        schemaVersion: "mandelhowl.asset-progress.v1",
        datasetId: manifest.datasetId,
        datasetReady: false,
        path: asset.path,
        url: requestUrl,
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        textureKind: texture?.kind ?? null,
        texture,
        verifiedCount,
        totalCount: references.length,
        bytes: bytes.slice(),
      }) satisfies VerifiedAssetProgressEvent;
      try {
        const observerResult = options.onAssetVerified(progress);
        if (observerResult && typeof observerResult.then === "function") {
          void Promise.resolve(observerResult).catch(() => {
            // Async observers are isolated exactly like synchronous ones.
          });
        }
      } catch {
        // Progress is observational and must never change fail-closed validity.
      }
    }
  };
  const eagerReferences =
    manifest.algorithmRevision === undefined
      ? references
      : references.filter(
          (asset) =>
            !manifest.files.textures.some(
              (texture) => texture.path === asset.path,
            ),
        );
  const prioritized = prioritizedAssetReferences(
    manifest,
    eagerReferences,
  );
  for (const asset of prioritized.priority) {
    options.signal?.throwIfAborted();
    await fetchAndVerify(asset);
  }
  for (const asset of prioritized.remaining) {
    await yieldAssetLoadTurn(options.signal);
    await fetchAndVerify(asset);
  }
  options.signal?.throwIfAborted();
  if (diagnostics.length > 0) {
    return diagnosticFailure(diagnostics, manifest, assets, assetUrls);
  }

  const checksumValue = parseJsonBytes(
    assets.get(manifest.files.checksums.path)!,
    manifest.files.checksums.path,
  );
  const checksumErrors = validateChecksums(checksumValue, manifest);
  if (checksumErrors.length > 0) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.checksumsInvalid,
          "fatal",
          "confirmed",
          "dataset.checksums.invalid",
          [
            evidence(
              "violations",
              checksumErrors.join(","),
              manifest.files.checksums.path,
            ),
          ],
        ),
      ],
      manifest,
      assets,
      assetUrls,
    );
  }

  const evidenceErrors = validateJsonEvidenceAssets(manifest, assets);
  if (evidenceErrors.length > 0) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.dataInvalid,
          "fatal",
          "confirmed",
          "dataset.evidence.invalid",
          [evidence("violations", evidenceErrors.join(","), "dataset")],
        ),
      ],
      manifest,
      assets,
      assetUrls,
    );
  }

  try {
    if (manifest.algorithmRevision === undefined) {
      for (const texture of manifest.files.textures) {
        validateTextureAtlasBytes(assets.get(texture.path)!, texture);
      }
    }
  } catch (error) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.dataInvalid,
          "fatal",
          "confirmed",
          "dataset.texture.invalid",
          [
            evidence(
              "error",
              error instanceof Error ? error.message : String(error),
              "ktx2-validator",
            ),
          ],
        ),
      ],
      manifest,
      assets,
      assetUrls,
    );
  }

  try {
    const modes = decodeModesBinaryV1(assets.get(manifest.files.modes.path)!);
    const response = decodeResponseBinaryV1(
      assets.get(manifest.files.response.path)!,
    );
    if (modes.length !== manifest.modeCount) {
      throw new TypeError(
        `Decoded mode count ${modes.length} does not match ${manifest.modeCount}`,
      );
    }
    if (
      manifest.algorithmRevision !== undefined &&
      modes.some(
        (mode) =>
          !Object.is(
            mode.naturalFrequencyHz,
            quantizeTiesToEven(
              mode.naturalFrequencyHz,
              VERSIONED_RUNTIME_FREQUENCY_QUANTUM_HZ,
            ),
          ) ||
          !Object.is(
            mode.angularFrequencyRadPerSecond,
            mode.naturalFrequencyHz * (2 * Math.PI),
          ) ||
          !Object.is(
            mode.actuatorCoupling,
            quantizeTiesToEven(
              mode.actuatorCoupling,
              VERSIONED_RUNTIME_COUPLING_QUANTUM,
            ),
          ) ||
          !Object.is(
            mode.microphoneCoupling,
            quantizeTiesToEven(
              mode.microphoneCoupling,
              VERSIONED_RUNTIME_COUPLING_QUANTUM,
            ),
          ) ||
          !Object.is(
            mode.radiationEfficiency,
            quantizeTiesToEven(
              mode.radiationEfficiency,
              VERSIONED_RUNTIME_COUPLING_QUANTUM,
            ),
          ),
      )
    ) {
      throw new TypeError(
        "Decoded modes violate the versioned runtime modal output grid",
      );
    }
    const frequencyTolerance = 1e-9;
    if (
      modes[0]!.naturalFrequencyHz <
        manifest.frequencyRange.minimumHz - frequencyTolerance ||
      modes.at(-1)!.naturalFrequencyHz >
        manifest.frequencyRange.maximumHz + frequencyTolerance ||
      Math.abs(
        response.frequenciesHz[0]! - manifest.frequencyRange.minimumHz,
      ) > frequencyTolerance ||
      Math.abs(
        response.frequenciesHz.at(-1)! - manifest.frequencyRange.maximumHz,
      ) > frequencyTolerance
    ) {
      throw new TypeError(
        "Decoded modes or response do not match the manifest frequency range",
      );
    }
    const modeIds = new Set(modes.map((mode) => mode.modeId));
    const textureLayers = new Set(modes.map((mode) => mode.textureLayer));
    if (
      modeIds.size !== modes.length ||
      textureLayers.size !== modes.length ||
      modes.some(
        (mode) =>
          !Number.isInteger(mode.textureLayer) ||
          mode.textureLayer < 0 ||
          mode.textureLayer >= modes.length,
      )
    ) {
      throw new TypeError(
        "Decoded modes do not define a unique in-range texture layer",
      );
    }
    for (const kind of [
      "signed-displacement",
      "normal",
      "nodal-mask",
      "sand-density",
    ] as const) {
      const descriptors = manifest.files.textures.filter(
        (texture) => texture.kind === kind,
      );
      const descriptorModeIds = descriptors.flatMap(
        (texture) => texture.modeIds,
      );
      if (
        descriptorModeIds.length !== modes.length ||
        new Set(descriptorModeIds).size !== modes.length ||
        descriptorModeIds.some((modeId) => !modeIds.has(modeId)) ||
        modes.some(
          (mode) =>
            descriptorModeIds[mode.textureLayer] !== mode.modeId,
        )
      ) {
        throw new TypeError(
          `${kind} texture mode ids do not cover the modal dataset`,
        );
      }
    }
    const presentationModes = decodeVerifiedModePresentationMetadata(
      manifest,
      assets,
      modes,
    );
    const dataset: ResonanceDataset = Object.freeze({
      manifest,
      modes,
      response,
    });
    return Object.freeze({
      status: "ready",
      manifest,
      dataset,
      assets,
      assetUrls,
      textureAssets,
      presentationModes,
      diagnostics: Object.freeze([
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.ready,
          "info",
          "confirmed",
          "dataset.ready",
          [
            evidence("datasetId", manifest.datasetId, "manifest.json"),
            evidence("modeCount", modes.length, manifest.files.modes.path),
          ],
        ),
      ]),
    });
  } catch (error) {
    return diagnosticFailure(
      [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.binaryInvalid,
          "fatal",
          "confirmed",
          "dataset.binary.invalid",
          [
            evidence(
              "error",
              error instanceof Error ? error.message : String(error),
              "binary-decoder",
            ),
          ],
        ),
      ],
      manifest,
      assets,
      assetUrls,
    );
  }
}
