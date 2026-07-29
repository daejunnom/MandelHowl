import {
  GENERATED_DATASET_RELEASE_SPEC,
  RUNTIME_SPEC_SOURCE_HASHES,
  type AssetReference,
  type ChecksumsFile,
  type DiagnosticRecord,
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
import { sha256Hex } from "./sha256";

export const MANDELHOWL_RUNTIME_VERSION = "0.1.0";

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
  readonly textures: Readonly<
    Partial<Record<TextureAssetKind, TextureAssetUrl>>
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

function immutableAssetRequestUrl(url: string, sha256: string): string {
  const immutableUrl = new URL(url);
  immutableUrl.searchParams.set("sha256", sha256);
  return immutableUrl.href;
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
  if (
    convergence?.schemaVersion !== "mandelhowl.convergence-report.v1" ||
    convergence.accepted !== true ||
    convergence.quadratureConvergenceAccepted !== true ||
    methodConformance?.handoffThinPlateMethodAllowed !== true ||
    methodConformance.matchesCanonicalElementFamily !== true ||
    independentCrossValidation?.accepted !== true
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
  const outputs = coverage?.outputs;
  const expectedValues = Array.from({ length: 101 }, (_, value) => value);
  const coverageValuesValid =
    Array.isArray(coveredValues) &&
    coveredValues.length === expectedValues.length &&
    coveredValues.every((value, index) => value === expectedValues[index]);
  const outputsValid =
    Array.isArray(outputs) &&
    outputs.length === expectedValues.length &&
    outputs.every((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const output = value as Record<string, unknown>;
      return (
        output.target === index &&
        output.verified === true &&
        output.verification === "runtime-replay-verified"
      );
    });
  if (
    coverage?.schemaVersion !== "mandelhowl.coverage-report.v1" ||
    coverage.modalModelId !== `sha256:${manifest.files.modes.sha256}` ||
    coverage.perValueRuntimeExceptionTable !== false ||
    coverage.verificationStatus !== "runtime-replay-verified" ||
    coverage.replayVerified !== true ||
    generatedBy?.perValueRuntimeLookup !== "forbidden" ||
    generatedBy?.randomSource !== "forbidden" ||
    runtimeSpecSha256?.dial !== RUNTIME_SPEC_SOURCE_HASHES.dial ||
    runtimeSpecSha256?.feedback !== RUNTIME_SPEC_SOURCE_HASHES.feedback ||
    runtimeSpecSha256?.volumeMap !== RUNTIME_SPEC_SOURCE_HASHES.volumeMap ||
    staticDistribution?.passed !== true ||
    typeof staticDistribution.extremeFraction !== "number" ||
    typeof staticDistribution.requiredExtremeFraction !== "number" ||
    staticDistribution.extremeFraction <
      staticDistribution.requiredExtremeFraction ||
    !coverageValuesValid ||
    !Array.isArray(missingValues) ||
    missingValues.length !== 0 ||
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
  const textures: Partial<Record<TextureAssetKind, TextureAssetUrl>> = {};
  for (const texture of manifest.files.textures) {
    textures[texture.kind] = Object.freeze({
      kind: texture.kind,
      url: byPath[texture.path],
      modeIds: Object.freeze([...texture.modeIds]),
      layers: texture.layers,
      widthPx: texture.widthPx,
      heightPx: texture.heightPx,
      mediaType: texture.mediaType,
    });
  }
  return Object.freeze({
    manifest: manifestUrl.href,
    byPath: Object.freeze(byPath),
    textures: Object.freeze(textures),
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
  const manifest = validation.manifest;
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
    if (options.onAssetVerified) {
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
  const prioritized = prioritizedAssetReferences(manifest, references);
  for (const asset of prioritized.priority) {
    options.signal?.throwIfAborted();
    await fetchAndVerify(asset);
  }
  options.signal?.throwIfAborted();
  await Promise.all(prioritized.remaining.map(fetchAndVerify));
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
    const modes = decodeModesBinaryV1(assets.get(manifest.files.modes.path)!);
    const response = decodeResponseBinaryV1(
      assets.get(manifest.files.response.path)!,
    );
    if (modes.length !== manifest.modeCount) {
      throw new TypeError(
        `Decoded mode count ${modes.length} does not match ${manifest.modeCount}`,
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
    for (const texture of manifest.files.textures) {
      if (
        texture.layers !== modes.length ||
        texture.modeIds.length !== modes.length ||
        new Set(texture.modeIds).size !== modes.length ||
        texture.modeIds.some((modeId) => !modeIds.has(modeId)) ||
        modes.some((mode) => texture.modeIds[mode.textureLayer] !== mode.modeId)
      ) {
        throw new TypeError(
          `${texture.kind} texture mode ids do not cover the modal dataset`,
        );
      }
    }
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
