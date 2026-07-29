import {
  GENERATED_DIAL_SPEC,
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
const TEXTURE_KINDS = new Set([
  "signed-displacement",
  "normal",
  "nodal-mask",
  "sand-density",
]);
const IDENTITY_SCOPE =
  "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests";

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
  return !path.split("/").some((segment) => segment === "" || segment === "..");
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
  return true;
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
    typeof input.datasetId !== "string" ||
    !CONTENT_ID.test(input.datasetId)
  ) {
    errors.push("datasetId");
  }
  const ownership = input.ownership;
  if (
    !isRecord(ownership) ||
    ownership.kind !== "generated" ||
    ownership.generator !== "tools/physics-baker" ||
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
  if (
    !isRecord(plate) ||
    typeof plate.plateId !== "string" ||
    plate.plateId === "" ||
    typeof plate.specSha256 !== "string" ||
    !SHA256.test(plate.specSha256)
  ) {
    errors.push("plate");
  } else {
    validateKeys(plate, ["plateId", "specSha256"], "plate", errors);
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
  if (
    !isRecord(solver) ||
    typeof solver.solverName !== "string" ||
    solver.solverName === "" ||
    typeof solver.solverVersion !== "string" ||
    solver.solverVersion === "" ||
    typeof solver.containerImageDigest !== "string" ||
    !CONTENT_ID.test(solver.containerImageDigest) ||
    typeof solver.optionsSha256 !== "string" ||
    !SHA256.test(solver.optionsSha256)
  ) {
    errors.push("solverProvenance");
  } else {
    validateKeys(
      solver,
      ["solverName", "solverVersion", "containerImageDigest", "optionsSha256"],
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
    if (
      !Array.isArray(files.textures) ||
      files.textures.length !== TEXTURE_KINDS.size
    ) {
      errors.push("files.textures");
    } else {
      files.textures.forEach((texture, index) =>
        validateTexture(texture, index, errors),
      );
      const kinds = new Set(
        files.textures
          .filter(isRecord)
          .map((texture) => texture.kind)
          .filter((kind): kind is string => typeof kind === "string"),
      );
      if (kinds.size !== files.textures.length) {
        errors.push("files.textures.kind:duplicate");
      }
      for (const kind of TEXTURE_KINDS) {
        if (!kinds.has(kind)) errors.push(`files.textures.missing:${kind}`);
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
