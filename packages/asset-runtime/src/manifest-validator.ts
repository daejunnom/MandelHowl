import {
  GENERATED_DIAL_SPEC,
  VERSIONED_TEXTURE_LAYERS_PER_SHARD,
  type AssetReference,
  type DiagnosticRecord,
  type ResonanceManifest,
  type TextureAtlasReference,
} from "../../contracts/src";
import {
  ASSET_DIAGNOSTIC_CODES,
  createDiagnostic,
  evidence,
} from "./diagnostics";

const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_ID = /^sha256:[a-f0-9]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const TEXTURE_KIND_ORDER = [
  "signed-displacement",
  "normal",
  "nodal-mask",
  "sand-density",
] as const;
const TEXTURE_KINDS = new Set<string>(TEXTURE_KIND_ORDER);
const IDENTITY_SCOPE =
  "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests";
const ALGORITHM_REVISION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUPPORTED_ALGORITHM_REVISION =
  "kirchhoff-love-c1-finite-strip-r2";
const GENERATED_ARTIFACT_GENERATORS = new Set([
  "tools/physics-baker",
  "tools/physics-baker-rs",
]);
const MATERIAL_SECTION_SAMPLE_COUNT = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allowlist = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowlist.has(key)) errors.push(`${label}.additional:${key}`);
  }
}

export function isSafeDatasetRelativePath(path: string): boolean {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("://")
  ) {
    return false;
  }
  /*
   * Keep the manifest vocabulary narrower than WHATWG URL parsing.
   *
   * A value such as `data:...` or `https:host/file` is a URL even without
   * `://`, while `%2e%2e/file` may become a parent traversal when a browser,
   * proxy, or origin decodes it. Rejecting every non-canonical path character
   * also prevents a second decoding pass from turning `%252e%252e` into a dot
   * segment. Generated dataset paths use only portable ASCII filename
   * characters, so accepting anything broader creates ambiguity without
   * adding a valid asset name.
   */
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path)) {
    return false;
  }
  return !path
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function validateAsset(
  value: unknown,
  label: string,
  errors: string[],
  additionalKeys: readonly string[] = [],
): value is AssetReference {
  if (!isRecord(value)) {
    errors.push(`${label}:not-object`);
    return false;
  }
  validateKeys(
    value,
    ["path", "byteLength", "sha256", "mediaType", ...additionalKeys],
    label,
    errors,
  );
  if (
    typeof value.path !== "string" ||
    !isSafeDatasetRelativePath(value.path)
  ) {
    errors.push(`${label}.path`);
  }
  if (
    typeof value.byteLength !== "number" ||
    !Number.isInteger(value.byteLength) ||
    value.byteLength < 0
  ) {
    errors.push(`${label}.byteLength`);
  }
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    errors.push(`${label}.sha256`);
  }
  if (typeof value.mediaType !== "string" || value.mediaType === "") {
    errors.push(`${label}.mediaType`);
  }
  return true;
}

function validateTexture(
  value: unknown,
  index: number,
  errors: string[],
): value is TextureAtlasReference {
  if (
    !validateAsset(value, `files.textures[${index}]`, errors, [
      "kind",
      "modeIds",
      "widthPx",
      "heightPx",
      "layers",
      "supercompressionScheme",
      "uvOrigin",
    ])
  ) {
    return false;
  }
  const texture = value as unknown as Record<string, unknown>;
  if (typeof texture.kind !== "string" || !TEXTURE_KINDS.has(texture.kind)) {
    errors.push(`files.textures[${index}].kind`);
  }
  if (
    !Array.isArray(texture.modeIds) ||
    texture.modeIds.length === 0 ||
    texture.modeIds.some(
      (modeId) => typeof modeId !== "string" || modeId === "",
    )
  ) {
    errors.push(`files.textures[${index}].modeIds`);
  } else if (new Set(texture.modeIds).size !== texture.modeIds.length) {
    errors.push(`files.textures[${index}].modeIds:duplicate`);
  }
  for (const key of ["widthPx", "heightPx", "layers"] as const) {
    if (
      typeof texture[key] !== "number" ||
      !Number.isInteger(texture[key]) ||
      texture[key] < 1
    ) {
      errors.push(`files.textures[${index}].${key}`);
    }
  }
  if (
    Array.isArray(texture.modeIds) &&
    typeof texture.layers === "number" &&
    texture.layers !== texture.modeIds.length
  ) {
    errors.push(`files.textures[${index}].layers:modeIds`);
  }
  if (texture.uvOrigin !== "negative-x-negative-y") {
    errors.push(`files.textures[${index}].uvOrigin`);
  }
  if (
    texture.supercompressionScheme !== undefined &&
    texture.supercompressionScheme !== 3
  ) {
    errors.push(`files.textures[${index}].supercompressionScheme`);
  }
  return true;
}

function validateMaterialSectionProfile(
  value: unknown,
  errors: string[],
): void {
  const label = "plate.materialSectionProfile";
  if (!isRecord(value)) {
    errors.push(`${label}:not-object`);
    return;
  }
  validateKeys(
    value,
    [
      "schemaVersion",
      "axis",
      "sampleCount",
      "minimumThicknessM",
      "maximumThicknessM",
      "thicknessUnorm8",
    ],
    label,
    errors,
  );
  if (
    value.schemaVersion !==
    "mandelhowl.material-section-profile.v1"
  ) {
    errors.push(`${label}.schemaVersion`);
  }
  if (value.axis !== "x-at-y-zero") {
    errors.push(`${label}.axis`);
  }
  if (value.sampleCount !== MATERIAL_SECTION_SAMPLE_COUNT) {
    errors.push(`${label}.sampleCount`);
  }
  if (
    typeof value.minimumThicknessM !== "number" ||
    !Number.isFinite(value.minimumThicknessM) ||
    value.minimumThicknessM <= 0
  ) {
    errors.push(`${label}.minimumThicknessM`);
  }
  if (
    typeof value.maximumThicknessM !== "number" ||
    !Number.isFinite(value.maximumThicknessM) ||
    value.maximumThicknessM <= 0
  ) {
    errors.push(`${label}.maximumThicknessM`);
  }
  if (
    typeof value.minimumThicknessM === "number" &&
    typeof value.maximumThicknessM === "number" &&
    Number.isFinite(value.minimumThicknessM) &&
    Number.isFinite(value.maximumThicknessM) &&
    value.maximumThicknessM <= value.minimumThicknessM
  ) {
    errors.push(`${label}.thicknessRange`);
  }
  if (
    !Array.isArray(value.thicknessUnorm8) ||
    value.thicknessUnorm8.length !== MATERIAL_SECTION_SAMPLE_COUNT ||
    value.thicknessUnorm8.some(
      (sample) =>
        typeof sample !== "number" ||
        !Number.isInteger(sample) ||
        sample < 0 ||
        sample > 255,
    )
  ) {
    errors.push(`${label}.thicknessUnorm8`);
  }
}

export interface ManifestValidationResult {
  readonly manifest: ResonanceManifest | null;
  readonly diagnostics: readonly DiagnosticRecord[];
}

export function validateResonanceManifest(
  input: unknown,
): ManifestValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return {
      manifest: null,
      diagnostics: [
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.manifestSchemaInvalid,
          "fatal",
          "confirmed",
          "dataset.manifest.schema-invalid",
          [evidence("reason", "root:not-object", "manifest.json")],
        ),
      ],
    };
  }
  validateKeys(
    input,
    [
      "$schema",
      "schemaVersion",
      "algorithmRevision",
      "datasetId",
      "ownership",
      "contentAddressing",
      "plate",
      "runtimeCompatibility",
      "units",
      "coordinateSystem",
      "modeCount",
      "frequencyRange",
      "solverProvenance",
      "files",
    ],
    "manifest",
    errors,
  );

  if (input.schemaVersion !== "mandelhowl.resonance-manifest.v1") {
    errors.push("schemaVersion");
  }
  if (
    input.algorithmRevision !== undefined &&
    (typeof input.algorithmRevision !== "string" ||
      !ALGORITHM_REVISION.test(input.algorithmRevision) ||
      input.algorithmRevision !== SUPPORTED_ALGORITHM_REVISION)
  ) {
    errors.push("algorithmRevision");
  }
  if (
    typeof input.datasetId !== "string" ||
    !CONTENT_ID.test(input.datasetId)
  ) {
    errors.push("datasetId");
  }
  const ownership = input.ownership;
  if (
    !isRecord(ownership) ||
    ownership.kind !== "generated" ||
    typeof ownership.generator !== "string" ||
    !GENERATED_ARTIFACT_GENERATORS.has(ownership.generator) ||
    ownership.policy !== "immutable-regenerate"
  ) {
    errors.push("ownership");
  } else {
    validateKeys(
      ownership,
      ["kind", "generator", "policy"],
      "ownership",
      errors,
    );
  }
  const addressing = input.contentAddressing;
  if (
    !isRecord(addressing) ||
    addressing.algorithm !== "sha256" ||
    addressing.canonicalization !== "RFC8785" ||
    addressing.identityScope !== IDENTITY_SCOPE ||
    typeof addressing.directoryName !== "string" ||
    !SHA256.test(addressing.directoryName)
  ) {
    errors.push("contentAddressing");
  } else {
    validateKeys(
      addressing,
      ["algorithm", "canonicalization", "identityScope", "directoryName"],
      "contentAddressing",
      errors,
    );
  }
  const plate = input.plate;
  if (!isRecord(plate)) {
    errors.push("plate");
  } else {
    validateKeys(
      plate,
      ["plateId", "specSha256", "materialSectionProfile"],
      "plate",
      errors,
    );
    if (typeof plate.plateId !== "string" || plate.plateId === "") {
      errors.push("plate.plateId");
    }
    if (
      typeof plate.specSha256 !== "string" ||
      !SHA256.test(plate.specSha256)
    ) {
      errors.push("plate.specSha256");
    }
    if (plate.materialSectionProfile !== undefined) {
      validateMaterialSectionProfile(
        plate.materialSectionProfile,
        errors,
      );
    } else if (input.algorithmRevision !== undefined) {
      errors.push("plate.materialSectionProfile:required");
    }
  }
  const compatibility = input.runtimeCompatibility;
  if (
    !isRecord(compatibility) ||
    typeof compatibility.minimumRuntimeVersion !== "string" ||
    !SEMVER.test(compatibility.minimumRuntimeVersion) ||
    typeof compatibility.maximumRuntimeVersionExclusive !== "string" ||
    !SEMVER.test(compatibility.maximumRuntimeVersionExclusive) ||
    compatibility.modeBinaryFormat !== "mandelhowl-modes-v1" ||
    compatibility.responseBinaryFormat !== "mandelhowl-response-v1"
  ) {
    errors.push("runtimeCompatibility");
  } else {
    validateKeys(
      compatibility,
      [
        "minimumRuntimeVersion",
        "maximumRuntimeVersionExclusive",
        "modeBinaryFormat",
        "responseBinaryFormat",
      ],
      "runtimeCompatibility",
      errors,
    );
  }
  const units = input.units;
  if (
    !isRecord(units) ||
    units.system !== "SI" ||
    units.length !== "m" ||
    units.mass !== "kg" ||
    units.time !== "s" ||
    units.frequency !== "Hz" ||
    units.angle !== "rad" ||
    units.pressure !== "Pa" ||
    units.density !== "kg/m^3"
  ) {
    errors.push("units");
  } else {
    validateKeys(
      units,
      [
        "system",
        "length",
        "mass",
        "time",
        "frequency",
        "angle",
        "pressure",
        "density",
      ],
      "units",
      errors,
    );
  }
  const coordinate = input.coordinateSystem;
  if (
    !isRecord(coordinate) ||
    coordinate.frame !== "plate-local" ||
    coordinate.handedness !== "right" ||
    coordinate.origin !== "plate-centre-front-surface" ||
    coordinate.xAxis !== "mandelbrot-real-positive" ||
    coordinate.yAxis !== "mandelbrot-imaginary-positive" ||
    coordinate.zAxis !== "front-normal"
  ) {
    errors.push("coordinateSystem");
  } else {
    validateKeys(
      coordinate,
      ["frame", "handedness", "origin", "xAxis", "yAxis", "zAxis"],
      "coordinateSystem",
      errors,
    );
  }
  if (
    typeof input.modeCount !== "number" ||
    !Number.isInteger(input.modeCount) ||
    input.modeCount < 1
  ) {
    errors.push("modeCount");
  }
  const range = input.frequencyRange;
  if (
    !isRecord(range) ||
    range.minimumHz !== GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz ||
    range.maximumHz !== GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz
  ) {
    errors.push("frequencyRange");
  } else {
    validateKeys(range, ["minimumHz", "maximumHz"], "frequencyRange", errors);
  }
  const solver = input.solverProvenance;
  const versioned = input.algorithmRevision !== undefined;
  const executionKindValid =
    isRecord(solver) &&
    (solver.executionKind === undefined
      ? !versioned
      : solver.executionKind === "native-process"
        ? solver.containerImageDigest === null
        : solver.executionKind === "oci-container"
          ? typeof solver.containerImageDigest === "string" &&
            CONTENT_ID.test(solver.containerImageDigest)
          : false);
  if (
    !isRecord(solver) ||
    typeof solver.solverName !== "string" ||
    solver.solverName === "" ||
    typeof solver.solverVersion !== "string" ||
    solver.solverVersion === "" ||
    !executionKindValid ||
    (solver.executionKind === undefined &&
      solver.containerImageDigest !== null &&
      (typeof solver.containerImageDigest !== "string" ||
        !CONTENT_ID.test(solver.containerImageDigest))) ||
    typeof solver.optionsSha256 !== "string" ||
    !SHA256.test(solver.optionsSha256)
  ) {
    errors.push("solverProvenance");
  } else {
    validateKeys(
      solver,
      [
        "solverName",
        "solverVersion",
        "executionKind",
        "containerImageDigest",
        "optionsSha256",
      ],
      "solverProvenance",
      errors,
    );
  }
  const files = input.files;
  if (!isRecord(files)) {
    errors.push("files");
  } else {
    validateKeys(
      files,
      [
        "plateSpec",
        "modes",
        "response",
        "textures",
        "provenance",
        "convergenceReport",
        "coverageReport",
        "checksums",
      ],
      "files",
      errors,
    );
    for (const key of [
      "plateSpec",
      "modes",
      "response",
      "provenance",
      "convergenceReport",
      "coverageReport",
      "checksums",
    ] as const) {
      validateAsset(files[key], `files.${key}`, errors);
    }
    if (!Array.isArray(files.textures)) {
      errors.push("files.textures");
    } else {
      files.textures.forEach((texture, index) =>
        validateTexture(texture, index, errors),
      );
      if (versioned) {
        files.textures.forEach((texture, index) => {
          if (
            !isRecord(texture) ||
            texture.supercompressionScheme !== 3
          ) {
            errors.push(
              `files.textures[${index}].supercompressionScheme:required`,
            );
          }
        });
        const modeCount =
          typeof input.modeCount === "number" &&
          Number.isInteger(input.modeCount)
            ? input.modeCount
            : 0;
        if (
          modeCount < 1 ||
          modeCount % VERSIONED_TEXTURE_LAYERS_PER_SHARD !== 0
        ) {
          errors.push("files.textures.shards:modeCount");
        } else {
          const shardsPerKind =
            modeCount / VERSIONED_TEXTURE_LAYERS_PER_SHARD;
          if (
            files.textures.length !==
            TEXTURE_KIND_ORDER.length * shardsPerKind
          ) {
            errors.push("files.textures.shards:count");
          }
          for (
            let kindIndex = 0;
            kindIndex < TEXTURE_KIND_ORDER.length;
            kindIndex += 1
          ) {
            const kind = TEXTURE_KIND_ORDER[kindIndex];
            const firstTexture =
              files.textures[kindIndex * shardsPerKind];
            const expectedWidthPx =
              isRecord(firstTexture) &&
              typeof firstTexture.widthPx === "number"
                ? firstTexture.widthPx
                : null;
            const expectedHeightPx =
              isRecord(firstTexture) &&
              typeof firstTexture.heightPx === "number"
                ? firstTexture.heightPx
                : null;
            for (
              let shardIndex = 0;
              shardIndex < shardsPerKind;
              shardIndex += 1
            ) {
              const descriptorIndex =
                kindIndex * shardsPerKind + shardIndex;
              const texture = files.textures[descriptorIndex];
              const firstLayer =
                shardIndex * VERSIONED_TEXTURE_LAYERS_PER_SHARD;
              const lastLayer =
                firstLayer + VERSIONED_TEXTURE_LAYERS_PER_SHARD - 1;
              const expectedPath =
                `textures/${kind}-${String(firstLayer).padStart(2, "0")}-${String(lastLayer).padStart(2, "0")}.ktx2`;
              if (
                !isRecord(texture) ||
                texture.kind !== kind ||
                texture.layers !== VERSIONED_TEXTURE_LAYERS_PER_SHARD ||
                !Array.isArray(texture.modeIds) ||
                texture.modeIds.length !==
                  VERSIONED_TEXTURE_LAYERS_PER_SHARD ||
                texture.path !== expectedPath
              ) {
                errors.push(
                  `files.textures[${descriptorIndex}].shard-contract`,
                );
              }
              if (
                isRecord(texture) &&
                (texture.widthPx !== expectedWidthPx ||
                  texture.heightPx !== expectedHeightPx)
              ) {
                errors.push(
                  `files.textures[${descriptorIndex}].shard-dimensions`,
                );
              }
            }
          }
        }
      } else {
        if (files.textures.length !== TEXTURE_KIND_ORDER.length) {
          errors.push("files.textures");
        }
        const kinds = new Set(
          files.textures
            .filter(isRecord)
            .map((texture) => texture.kind)
            .filter((kind): kind is string => typeof kind === "string"),
        );
        if (kinds.size !== files.textures.length) {
          errors.push("files.textures.kind:duplicate");
        }
        for (const kind of TEXTURE_KIND_ORDER) {
          if (!kinds.has(kind)) {
            errors.push(`files.textures.missing:${kind}`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    const unsafePath = errors.some((error) => error.endsWith(".path"));
    return Object.freeze({
      manifest: null,
      diagnostics: Object.freeze([
        createDiagnostic(
          unsafePath
            ? ASSET_DIAGNOSTIC_CODES.assetPathUnsafe
            : ASSET_DIAGNOSTIC_CODES.manifestSchemaInvalid,
          "fatal",
          "confirmed",
          unsafePath
            ? "dataset.manifest.asset-path-unsafe"
            : "dataset.manifest.schema-invalid",
          [
            evidence(
              "violations",
              [...new Set(errors)].join(","),
              "resonance-manifest.schema.json",
            ),
          ],
        ),
      ]),
    });
  }
  const manifest = input as unknown as ResonanceManifest;
  if (manifest.plate.specSha256 !== manifest.files.plateSpec.sha256) {
    return Object.freeze({
      manifest: null,
      diagnostics: Object.freeze([
        createDiagnostic(
          ASSET_DIAGNOSTIC_CODES.manifestSchemaInvalid,
          "fatal",
          "confirmed",
          "dataset.manifest.plate-hash-inconsistent",
          [
            evidence(
              "plate.specSha256",
              manifest.plate.specSha256,
              "manifest.json",
            ),
            evidence(
              "files.plateSpec.sha256",
              manifest.files.plateSpec.sha256,
              "manifest.json",
            ),
          ],
        ),
      ]),
    });
  }
  return Object.freeze({
    manifest,
    diagnostics: Object.freeze([]),
  });
}

function parseSemver(value: string): readonly [number, number, number] {
  const [major, minor, patch] = value.split("-", 1)[0].split(".").map(Number);
  return [major, minor, patch];
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function isRuntimeCompatible(
  manifest: ResonanceManifest,
  runtimeVersion: string,
): boolean {
  return (
    SEMVER.test(runtimeVersion) &&
    compareSemver(
      runtimeVersion,
      manifest.runtimeCompatibility.minimumRuntimeVersion,
    ) >= 0 &&
    compareSemver(
      runtimeVersion,
      manifest.runtimeCompatibility.maximumRuntimeVersionExclusive,
    ) < 0
  );
}

export function collectManifestAssets(
  manifest: ResonanceManifest,
): readonly AssetReference[] {
  const assets = [
    manifest.files.plateSpec,
    manifest.files.modes,
    manifest.files.response,
    ...manifest.files.textures,
    manifest.files.provenance,
    manifest.files.convergenceReport,
    manifest.files.coverageReport,
    manifest.files.checksums,
  ];
  const paths = new Set<string>();
  for (const asset of assets) {
    if (paths.has(asset.path)) {
      throw new TypeError(`Duplicate manifest asset path: ${asset.path}`);
    }
    paths.add(asset.path);
  }
  return Object.freeze(assets);
}
