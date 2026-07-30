import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { constants as zlibConstants, deflateSync } from "node:zlib";
import type {
  AssetReference,
  ResonanceManifest,
  TextureAtlasReference,
} from "../../contracts/src";
import {
  COVERAGE_REPORT_SCHEMA_SHA256,
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_FEEDBACK_SPEC,
  MODES_BINARY_V1,
  N_VERSION_CONTRACT_DIGESTS,
  RESPONSE_BINARY_V1,
  RUNTIME_SPEC_SOURCE_HASHES,
} from "../../contracts/src";
import {
  canonicalizeJson,
  collectManifestAssets,
  decodeModesBinaryV1,
  decodeResponseBinaryV1,
  loadResonanceDataset,
  manifestIdentityPayload,
  sha256Hex,
  validateTextureAtlasBytes,
  validateResonanceManifest,
  isSafeDatasetRelativePath,
  isRuntimeCompatible,
  type VerifiedAssetProgressEvent,
} from "./index";

const encoder = new TextEncoder();
const BASE = "https://example.test/runtime/";

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function modesBytes(textureLayer = 0, count = 1): Uint8Array {
  const bytes = new Uint8Array(
    MODES_BINARY_V1.headerBytes + MODES_BINARY_V1.recordBytes * count,
  );
  bytes.set(encoder.encode(MODES_BINARY_V1.magic), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, MODES_BINARY_V1.version, true);
  view.setUint16(10, MODES_BINARY_V1.headerBytes, true);
  view.setUint32(12, count, true);
  const couplingQuantum = 2 ** -27;
  for (let index = 0; index < count; index += 1) {
    const base =
      MODES_BINARY_V1.headerBytes + index * MODES_BINARY_V1.recordBytes;
    const frequency = 220 + index * 110;
    bytes.set(
      encoder.encode(`mode-${String(index + 1).padStart(3, "0")}`),
      base,
    );
    view.setUint32(base + 24, index + 1, true);
    view.setUint32(
      base + 28,
      count === 1 ? textureLayer : index,
      true,
    );
    view.setFloat64(base + 32, frequency, true);
    view.setFloat64(base + 40, frequency * (2 * Math.PI), true);
    view.setFloat64(base + 48, 0.01, true);
    view.setFloat64(
      base + 56,
      Math.round(0.95 / couplingQuantum) * couplingQuantum,
      true,
    );
    view.setFloat64(
      base + 64,
      Math.round(0.9 / couplingQuantum) * couplingQuantum,
      true,
    );
    view.setFloat64(
      base + 72,
      Math.round(0.8 / couplingQuantum) * couplingQuantum,
      true,
    );
    view.setFloat64(base + 80, 0.25, true);
    view.setUint8(base + 88, 0);
  }
  return bytes;
}

function responseBytes(): Uint8Array {
  const bytes = new Uint8Array(
    RESPONSE_BINARY_V1.headerBytes + RESPONSE_BINARY_V1.recordBytes * 2,
  );
  bytes.set(encoder.encode(RESPONSE_BINARY_V1.magic), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, RESPONSE_BINARY_V1.version, true);
  view.setUint16(10, RESPONSE_BINARY_V1.headerBytes, true);
  view.setUint32(12, 2, true);
  view.setFloat64(16, 45, true);
  view.setFloat64(24, 0.1, true);
  view.setFloat64(32, -0.2, true);
  view.setFloat64(40, 6000, true);
  view.setFloat64(48, 0.01, true);
  view.setFloat64(56, 0.02, true);
  return bytes;
}

function portableKtx2Bytes(
  width: number,
  height: number,
  layers: number,
  channels: 1 | 2,
  supercompressionScheme: 0 | 3 = 0,
): Uint8Array {
  const identifier = new Uint8Array([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a,
    0x0a,
  ]);
  const dfdLength = 28 + channels * 16;
  const key = encoder.encode("KTXorientation");
  const value = encoder.encode("ru\0");
  const kvdPayloadLength = key.byteLength + 1 + value.byteLength;
  const kvdLength = 4 + kvdPayloadLength + ((4 - (kvdPayloadLength % 4)) % 4);
  const kvdOffset = 104 + dfdLength;
  const unalignedLevelOffset = kvdOffset + kvdLength;
  const levelOffset = (unalignedLevelOffset + 3) & ~3;
  const uncompressedLength = width * height * layers * channels;
  const levelData =
    supercompressionScheme === 3
      ? new Uint8Array(
          deflateSync(new Uint8Array(uncompressedLength), {
            strategy: zlibConstants.Z_FIXED,
          }),
        )
      : new Uint8Array(uncompressedLength);
  const levelLength = levelData.byteLength;
  const bytes = new Uint8Array(levelOffset + levelLength);
  bytes.set(identifier);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, channels === 1 ? 9 : 16, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, layers, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  view.setUint32(44, supercompressionScheme, true);
  view.setUint32(48, 104, true);
  view.setUint32(52, dfdLength, true);
  view.setUint32(56, kvdOffset, true);
  view.setUint32(60, kvdLength, true);
  view.setBigUint64(64, BigInt(0), true);
  view.setBigUint64(72, BigInt(0), true);
  view.setBigUint64(80, BigInt(levelOffset), true);
  view.setBigUint64(88, BigInt(levelLength), true);
  view.setBigUint64(96, BigInt(uncompressedLength), true);
  view.setUint32(104, dfdLength, true);
  bytes[124] = channels;
  view.setUint32(kvdOffset, kvdPayloadLength, true);
  bytes.set(key, kvdOffset + 4);
  bytes[kvdOffset + 4 + key.byteLength] = 0;
  bytes.set(value, kvdOffset + 5 + key.byteLength);
  bytes.set(levelData, levelOffset);
  return bytes;
}

async function reference(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<AssetReference> {
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    mediaType,
  };
}

async function fixture(
  options: {
    readonly textureLayer?: number;
    readonly generator?: "tools/physics-baker" | "tools/physics-baker-rs";
    readonly algorithmRevision?: string;
    readonly modeCount?: number;
    readonly mutateCoverage?: (
      coverage: Record<string, unknown>,
    ) => void;
    readonly mutateProvenance?: (
      provenance: Record<string, unknown>,
    ) => void;
    readonly mutatePlateSpec?: (
      plateSpec: Record<string, unknown>,
    ) => void;
  } = {},
) {
  const assets = new Map<string, Uint8Array>();
  const modeCount = options.algorithmRevision ? (options.modeCount ?? 4) : 1;
  const fixtureUnits = {
    system: "SI",
    length: "m",
    mass: "kg",
    time: "s",
    frequency: "Hz",
    angle: "rad",
    pressure: "Pa",
    density: "kg/m^3",
  } as const;
  const fixtureCoordinateSystem = {
    frame: "plate-local",
    handedness: "right",
    origin: "plate-centre-front-surface",
    xAxis: "mandelbrot-real-positive",
    yAxis: "mandelbrot-imaginary-positive",
    zAxis: "front-normal",
  } as const;
  const fixtureFrequencyRange = {
    minimumHz: 45,
    maximumHz: 6000,
  } as const;
  const plateSpecPayload: Record<string, unknown> = {
    schemaVersion: "mandelhowl.plate-spec.v1",
    plateId: "test-plate",
    ...(options.algorithmRevision
      ? {
          coordinateSystem: fixtureCoordinateSystem,
          units: fixtureUnits,
          frequencyRange: fixtureFrequencyRange,
          geometry: {
            frontShape: "circle",
            frontSurfaceZM: 0,
            radiusM: 0.19,
            hub: {
              shape: "circle",
              centreM: { x: 0, y: 0, z: 0 },
              radiusM: 0.018,
            },
          },
          textureRequest: {
            channels: [
              "signed-displacement-r8",
              "normal-rg8",
              "nodal-mask-r8",
              "sand-density-r8",
            ],
            container: "KTX2",
            widthPx: 128,
            heightPx: 128,
            uvOrigin: "negative-x-negative-y",
            uvXAxis: "positive-x",
            uvYAxis: "positive-y",
          },
          solverRequest: {
            elementFamily: "kirchhoff-love-thin-plate",
            requestedModeCount: modeCount,
            frequencyRangeHz: [45, 6000],
            normalization: "unit-modal-mass",
            signReference:
              "positive-at-actuator-or-first-nonzero-node",
            meshLevels: [
              {
                name: "fine",
                targetElementSizeM: 0.0015,
                analysisFiniteStrip: {
                  radialElementCount: 8,
                  angularQuadratureSamples: 64,
                  maximumFourierOrder: 3,
                },
              },
            ],
          },
        }
      : {}),
    thicknessMapping: {
      minimumThicknessM: 0.0018,
      maximumThicknessM: 0.0042,
    },
  };
  options.mutatePlateSpec?.(plateSpecPayload);
  assets.set("plate-spec.json", jsonBytes(plateSpecPayload));
  assets.set(
    "modes.bin",
    modesBytes(options.textureLayer, modeCount),
  );
  assets.set("response.bin", responseBytes());
  assets.set("provenance.json", jsonBytes({ solver: "test" }));
  assets.set("convergence-report.json", jsonBytes({ passed: true }));
  assets.set("coverage-report.json", jsonBytes({ replayVerified: true }));
  for (const kind of [
    "signed-displacement",
    "normal",
    "nodal-mask",
    "sand-density",
  ] as const) {
    const layersPerShard = options.algorithmRevision ? 4 : modeCount;
    for (
      let firstLayer = 0;
      firstLayer < modeCount;
      firstLayer += layersPerShard
    ) {
      const lastLayer = firstLayer + layersPerShard - 1;
      const texturePath = options.algorithmRevision
        ? `textures/${kind}-${String(firstLayer).padStart(2, "0")}-${String(lastLayer).padStart(2, "0")}.ktx2`
        : `textures/${kind}.ktx2`;
      assets.set(
        texturePath,
        portableKtx2Bytes(
          128,
          128,
          layersPerShard,
          kind === "normal" ? 2 : 1,
          options.algorithmRevision ? 3 : 0,
        ),
      );
    }
  }

  const plateSpec = await reference(
    "plate-spec.json",
    assets.get("plate-spec.json")!,
    "application/json",
  );
  const modes = await reference(
    "modes.bin",
    assets.get("modes.bin")!,
    "application/vnd.mandelhowl.modes-v1",
  );
  const decodedFixtureModes = decodeModesBinaryV1(
    assets.get("modes.bin")!,
  );
  const response = await reference(
    "response.bin",
    assets.get("response.bin")!,
    "application/vnd.mandelhowl.response-v1",
  );
  const modalModelId = `sha256:${modes.sha256}`;
  const traces = Array.from({ length: 101 }, (_, target) => ({
    schemaVersion: "mandelhowl.resonance-trajectory-trace.v1",
    traceId: `fixture-${target.toString().padStart(3, "0")}`,
    modalModelId,
    initialFrequencyHz: 45,
    durationSeconds: 1,
    expectedSettledVolume: target,
    keyframes: [{ sequence: 0, atSeconds: 0, frequencyHz: 45 }],
  }));
  const solverOptions = {
    method:
      "variable-thickness-kirchhoff-love-c1-finite-strip-fem",
    algorithmRevision:
      options.algorithmRevision ??
      "kirchhoff-love-c1-finite-strip-r2",
    algorithmContractSha256:
      N_VERSION_CONTRACT_DIGESTS.scientificAlgorithm.slice(
        "sha256:".length,
      ),
    basisCount: 112,
    quadrature: {
      radialElementCount: 8,
      maximumFourierOrder: 3,
      angularSamples: 64,
      radialGaussOrder: 5,
      pointCount: 2_560,
      dofCount: 112,
      minimumMappingJacobianM: 0.01075,
      boundaryConditions:
        "inner-value-and-slope-eliminated;outer-natural-free",
    },
    finiteElementAssembly: {
      radialInterpolation: "cubic-hermite-c1",
      angularInterpolation: "normalized-real-fourier",
      innerBoundary: "value-and-radial-slope-dofs-eliminated",
      outerBoundary: "natural-free-edge",
    },
    runtimeModalOutputQuantization: {
      frequencyQuantumHz: 2 ** -20,
      couplingQuantum: 2 ** -27,
      rounding: "ties-to-even",
      negativeZero: "canonicalize-to-positive-zero",
    },
    floatPrecision: "binary64",
    fastMath: false,
    randomSource: "forbidden",
  };
  const solverOptionsSha256 = await sha256Hex(
    encoder.encode(canonicalizeJson(solverOptions)),
  );
  const generatorName =
    options.generator ?? "tools/physics-baker";
  const containerImageDigest =
    `sha256:${"1".repeat(64)}` as const;
  const provenancePayload: Record<string, unknown> = {
    schemaVersion: "mandelhowl.provenance.v1",
    canonicalInput: {
      plateId: "test-plate",
      path: "specs/plate/mandelbrot-plate.v1.yaml",
      canonicalJsonSha256: plateSpec.sha256,
    },
    generator: {
      name: generatorName,
      version: "1.0.0",
      ...(options.algorithmRevision
        ? {
            algorithmRevision: options.algorithmRevision,
            algorithmContractSha256:
              N_VERSION_CONTRACT_DIGESTS.scientificAlgorithm.slice(
                "sha256:".length,
              ),
          }
        : {}),
      randomSource: "forbidden",
    },
    ...(options.algorithmRevision
      ? {
          solver: {
            name: "test-solver",
            version: "1.0.0",
            options: solverOptions,
            optionsSha256: solverOptionsSha256,
            executionKind: "oci-container",
            containerized: true,
            containerImageDigest,
            containerRunnerAttestation: "trusted-runner-attested",
            canonicalRequest: {
              elementFamily: "kirchhoff-love-thin-plate",
              requestedModeCount: modeCount,
            },
            executedMethod:
              "c1-cubic-hermite-annular-finite-strip",
            methodRequestMismatchRecorded: false,
            strictLiteralSection10_3Conformance: true,
            normalization: "unit-modal-mass",
            signRule:
              "positive-at-actuator-or-first-nonzero-node",
          },
          renderingCoordinateTransform: {
            sourceFrame: "plate-local",
            uvOrigin: "negative-x-negative-y",
            uAxis: "positive-x",
            vAxis: "positive-y",
            plateXFromU: "x=(2*u-1)*radiusM",
            plateYFromV: "y=(2*v-1)*radiusM",
            validSurfaceDomain:
              "hubRadiusM<hypot(x,y)<=radiusM",
            radiusM: 0.19,
            hubRadiusM: 0.018,
          },
        }
      : {}),
    modes: decodedFixtureModes.map((mode, index) => {
      if (!options.algorithmRevision) {
        return { modeId: mode.modeId };
      }
      const previous =
        index === 0
          ? null
          : mode.naturalFrequencyHz -
            decodedFixtureModes[index - 1]!.naturalFrequencyHz;
      const next =
        index + 1 === decodedFixtureModes.length
          ? null
          : decodedFixtureModes[index + 1]!.naturalFrequencyHz -
            mode.naturalFrequencyHz;
      return {
        modeId: mode.modeId,
        ordinal: mode.ordinal,
        naturalFrequencyHz: mode.naturalFrequencyHz,
        angularFrequencyRadPerSecond:
          mode.angularFrequencyRadPerSecond,
        dampingRatio: mode.dampingRatio,
        actuatorCoupling: mode.actuatorCoupling,
        microphoneCoupling: mode.microphoneCoupling,
        radiationEfficiency: mode.radiationEfficiency,
        adjacentFrequencySpacingHz: {
          previous,
          next,
          nearest:
            previous === null
              ? next
              : next === null
                ? previous
                : Math.min(previous, next),
        },
        surfaceKinematics: {
          signedDisplacementTextureLayer: mode.textureLayer,
          velocityScalePerUnitModalAmplitudePerSecond:
            mode.angularFrequencyRadPerSecond,
          velocityPhaseOffsetRad: Math.PI / 2,
          accelerationScalePerUnitModalAmplitudePerSecondSquared:
            mode.angularFrequencyRadPerSecond *
            mode.angularFrequencyRadPerSecond,
          accelerationPhaseOffsetRad: Math.PI,
        },
        dominantBasis: {
          radialNodeIndex: (index % 8) + 1,
          radialDof: index % 2 === 0 ? "value" : "slope",
          angularOrder: index % 4,
          symmetry:
            index % 4 === 0
              ? "axisymmetric"
              : index % 2 === 0
                ? "cosine"
                : "sine",
        },
        signReference: mode.signReference,
        textureLayer: mode.textureLayer,
      };
    }),
  };
  options.mutateProvenance?.(provenancePayload);
  assets.set("provenance.json", jsonBytes(provenancePayload));
  assets.set(
    "convergence-report.json",
    jsonBytes({
      schemaVersion: "mandelhowl.convergence-report.v1",
      accepted: true,
      finiteElementMeshConvergenceAccepted: true,
      surfaceMeshQualityAccepted: true,
      methodConformance: {
        handoffThinPlateMethodAllowed: true,
        matchesCanonicalElementFamily: true,
        thinPlateEigenanalysisSupported: true,
        surfaceMeshQualityValidated: true,
        finiteElementAssemblyUsed: true,
        analysisSurfaceElementMeshCoupledToEigenproblem: true,
        surfaceTriangleArchiveCoupledToEigenproblem: false,
        strictLiteralSection10_3Conformance: true,
        operationalDisposition: "strict-thin-plate-finite-element-adapter",
      },
      independentCrossValidation: { accepted: true },
    }),
  );
  const coverage: Record<string, unknown> = {
    schemaVersion: "mandelhowl.coverage-report.v1",
    modalModelId,
    runtimeAlgorithmRevision:
      GENERATED_FEEDBACK_SPEC.algorithmRevision,
    coverageContract: {
      schemaVersion: "mandelhowl.coverage-report.v1",
      schemaSha256: COVERAGE_REPORT_SCHEMA_SHA256,
    },
    generatedBy: {
      algorithm: "deterministic-global-trajectory-search-v1",
      feedbackAlgorithmRevision:
        GENERATED_FEEDBACK_SPEC.algorithmRevision,
      perValueRuntimeLookup: "forbidden",
      randomSource: "forbidden",
    },
    perValueRuntimeExceptionTable: false,
    verificationStatus: "runtime-replay-verified",
    runtimeSpecSha256: {
      dial: RUNTIME_SPEC_SOURCE_HASHES.dial,
      feedback: RUNTIME_SPEC_SOURCE_HASHES.feedback,
      volumeMap: RUNTIME_SPEC_SOURCE_HASHES.volumeMap,
      audioSafety: RUNTIME_SPEC_SOURCE_HASHES.audioSafety,
      uiNVersion:
        N_VERSION_CONTRACT_DIGESTS.presentationContract.slice(
          "sha256:".length,
        ),
    },
    staticDistribution: {
      sampleCount: 1,
      zeroCount: 1,
      hundredCount: 0,
      intermediateCount: 0,
      extremeFraction: 1,
      requiredExtremeFraction: 0.9,
      passed: true,
    },
    replayVerified: true,
    coveredValues: Array.from({ length: 101 }, (_, value) => value),
    missingValues: [],
    traces,
    outputs: traces.map((trace, target) => ({
      target,
      verification: "runtime-replay-verified",
      verified: true,
      trace,
    })),
  };
  options.mutateCoverage?.(coverage);
  assets.set("coverage-report.json", jsonBytes(coverage));
  const provenance = await reference(
    "provenance.json",
    assets.get("provenance.json")!,
    "application/json",
  );
  const convergenceReport = await reference(
    "convergence-report.json",
    assets.get("convergence-report.json")!,
    "application/json",
  );
  const coverageReport = await reference(
    "coverage-report.json",
    assets.get("coverage-report.json")!,
    "application/json",
  );
  const textures: TextureAtlasReference[] = [];
  for (const kind of [
    "signed-displacement",
    "normal",
    "nodal-mask",
    "sand-density",
  ] as const) {
    const layersPerShard = options.algorithmRevision ? 4 : modeCount;
    for (
      let firstLayer = 0;
      firstLayer < modeCount;
      firstLayer += layersPerShard
    ) {
      const lastLayer = firstLayer + layersPerShard - 1;
      const texturePath = options.algorithmRevision
        ? `textures/${kind}-${String(firstLayer).padStart(2, "0")}-${String(lastLayer).padStart(2, "0")}.ktx2`
        : `textures/${kind}.ktx2`;
      const asset = await reference(
        texturePath,
        assets.get(texturePath)!,
        "image/ktx2",
      );
      textures.push({
        ...asset,
        kind,
        modeIds: Array.from(
          { length: layersPerShard },
          (_, localLayer) =>
            `mode-${String(firstLayer + localLayer + 1).padStart(3, "0")}`,
        ),
        widthPx: 128,
        heightPx: 128,
        layers: layersPerShard,
        ...(options.algorithmRevision
          ? { supercompressionScheme: 3 as const }
          : {}),
        uvOrigin: "negative-x-negative-y",
      });
    }
  }
  const beforeChecksums = [
    plateSpec,
    modes,
    response,
    ...textures,
    provenance,
    convergenceReport,
    coverageReport,
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const checksumBytes = jsonBytes({
    schemaVersion: "mandelhowl.checksums.v1",
    algorithm: "sha256",
    files: [
      ...beforeChecksums.map(({ path, byteLength, sha256 }) => ({
        path,
        byteLength,
        sha256,
      })),
      {
        path: "science/solver-evidence.bin",
        byteLength: 3_145_728,
        sha256: "a".repeat(64),
      },
    ].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  });
  assets.set("checksums.json", checksumBytes);
  const checksums = await reference(
    "checksums.json",
    checksumBytes,
    "application/json",
  );

  const zero = "0".repeat(64);
  const manifestDraft = {
    schemaVersion: "mandelhowl.resonance-manifest.v1",
    ...(options.algorithmRevision
      ? { algorithmRevision: options.algorithmRevision }
      : {}),
    datasetId: `sha256:${zero}`,
    ownership: {
      kind: "generated",
      generator: options.generator ?? "tools/physics-baker",
      policy: "immutable-regenerate",
    },
    contentAddressing: {
      algorithm: "sha256",
      canonicalization: "RFC8785",
      identityScope:
        "manifest-with-datasetId-and-directoryName-omitted-and-all-referenced-file-digests",
      directoryName: zero,
    },
    plate: {
      plateId: "test-plate",
      specSha256: plateSpec.sha256,
      ...(options.algorithmRevision
        ? {
            materialSectionProfile: {
              schemaVersion:
                "mandelhowl.material-section-profile.v1",
              axis: "x-at-y-zero",
              sampleCount: 64,
              minimumThicknessM: 0.0018,
              maximumThicknessM: 0.0042,
              thicknessUnorm8: Array.from(
                { length: 64 },
                (_, index) => index * 4,
              ),
            },
          }
        : {}),
    },
    runtimeCompatibility: {
      minimumRuntimeVersion: "0.1.0",
      maximumRuntimeVersionExclusive: "1.0.0",
      modeBinaryFormat: "mandelhowl-modes-v1",
      responseBinaryFormat: "mandelhowl-response-v1",
    },
    units: fixtureUnits,
    coordinateSystem: fixtureCoordinateSystem,
    modeCount,
    frequencyRange: fixtureFrequencyRange,
    solverProvenance: {
      solverName: "test-solver",
      solverVersion: "1.0.0",
      executionKind: "oci-container",
      containerImageDigest,
      optionsSha256: solverOptionsSha256,
    },
    files: {
      plateSpec,
      modes,
      response,
      textures,
      provenance,
      convergenceReport,
      coverageReport,
      checksums,
    },
  } as ResonanceManifest;
  const digest = await sha256Hex(
    canonicalizeJson(manifestIdentityPayload(manifestDraft)),
  );
  const manifest = {
    ...manifestDraft,
    datasetId: `sha256:${digest}`,
    contentAddressing: {
      ...manifestDraft.contentAddressing,
      directoryName: digest,
    },
  } as ResonanceManifest;
  assets.set("manifest.json", jsonBytes(manifest));
  return { assets, manifest };
}

interface RecordedFetch {
  readonly url: URL;
  readonly cache: RequestCache | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly signal: AbortSignal | null | undefined;
}

function fetchFrom(
  assets: ReadonlyMap<string, Uint8Array>,
  requests: RecordedFetch[] = [],
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      url,
      cache: init?.cache,
      credentials: init?.credentials,
      signal: init?.signal,
    });
    const path = url.pathname.replace("/runtime/", "");
    const bytes = assets.get(path);
    const body = bytes ? Uint8Array.from(bytes).buffer : "missing";
    return bytes
      ? new Response(body, { status: 200 })
      : new Response(body, { status: 404 });
  };
}

describe("asset runtime", () => {
  it("accepts complete Python and Rust N-version manifest ownership", async () => {
    for (const generator of [
      "tools/physics-baker",
      "tools/physics-baker-rs",
    ] as const) {
      const { assets, manifest } = await fixture({
        generator,
        algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
      });
      expect(validateResonanceManifest(manifest).manifest).not.toBeNull();
      const result = await loadResonanceDataset({
        manifestUrl: `${BASE}manifest.json`,
        expectedDatasetId: manifest.datasetId,
        fetch: fetchFrom(assets) as typeof fetch,
      });
      expect(
        result.status,
        result.diagnostics
          .map(({ code, evidence }) => `${code}:${JSON.stringify(evidence)}`)
          .join("\n"),
      ).toBe("ready");
    }
  });

  it("rejects dimension drift between versioned shards of one texture kind", async () => {
    const { manifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
      modeCount: 8,
    });
    expect(validateResonanceManifest(manifest).manifest).not.toBeNull();

    const mutated = {
      ...manifest,
      files: {
        ...manifest.files,
        textures: manifest.files.textures.map((texture, index) =>
          index === 1
            ? {
                ...texture,
                widthPx: texture.widthPx + 1,
              }
            : texture,
        ),
      },
    };
    const result = validateResonanceManifest(mutated);
    expect(result.manifest).toBeNull();
    expect(
      result.diagnostics[0]?.evidence.some(({ value }) =>
        String(value).includes("files.textures[1].shard-dimensions"),
      ),
    ).toBe(true);
  });

  it("rejects unphysical dominant-basis presentation metadata", async () => {
    const { assets, manifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
      mutateProvenance: (provenance) => {
        const modes = provenance.modes as Record<string, unknown>[];
        const first = modes[0]!;
        first.dominantBasis = {
          ...(first.dominantBasis as Record<string, unknown>),
          radialNodeIndex: 9,
        };
      },
    });
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: fetchFrom(assets) as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(
      result.diagnostics.some(
        ({ messageKey, evidence }) =>
          messageKey === "dataset.binary.invalid" &&
          evidence.some(({ value }) =>
            String(value).includes("dominant basis"),
          ),
      ),
      JSON.stringify(result.diagnostics),
    ).toBe(true);
  });

  it("rejects every detached versioned provenance binding used by the analytical renderer", async () => {
    const cases: readonly {
      readonly label: string;
      readonly violation: string;
      readonly mutate: (
        provenance: Record<string, unknown>,
      ) => void;
    }[] = [
      {
        label: "canonical plate digest",
        violation: "provenance:canonical-input-binding",
        mutate: (provenance) => {
          const canonicalInput =
            provenance.canonicalInput as Record<string, unknown>;
          canonicalInput.canonicalJsonSha256 = "0".repeat(64);
        },
      },
      {
        label: "algorithm revision",
        violation: "provenance:generator-binding",
        mutate: (provenance) => {
          const generator =
            provenance.generator as Record<string, unknown>;
          generator.algorithmRevision =
            "kirchhoff-love-c1-finite-strip-r3";
        },
      },
      {
        label: "detailed solver identity",
        violation: "provenance:solver-binding",
        mutate: (provenance) => {
          const solver = provenance.solver as Record<
            string,
            unknown
          >;
          solver.name = "detached-solver";
        },
      },
      {
        label: "fine radial analysis resolution",
        violation: "provenance:analysis-resolution-binding",
        mutate: (provenance) => {
          const solver = provenance.solver as Record<
            string,
            unknown
          >;
          const solverOptions = solver.options as Record<
            string,
            unknown
          >;
          const quadrature = solverOptions.quadrature as Record<
            string,
            unknown
          >;
          quadrature.radialElementCount = 7;
        },
      },
      {
        label: "rendering coordinate axis",
        violation: "provenance:rendering-coordinate-binding",
        mutate: (provenance) => {
          const transform =
            provenance.renderingCoordinateTransform as Record<
              string,
              unknown
            >;
          transform.uAxis = "negative-x";
        },
      },
    ];

    for (const testCase of cases) {
      const { assets, manifest } = await fixture({
        algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
        mutateProvenance: testCase.mutate,
      });
      const result = await loadResonanceDataset({
        manifestUrl: `${BASE}manifest.json`,
        expectedDatasetId: manifest.datasetId,
        fetch: fetchFrom(assets) as typeof fetch,
      });
      expect(result.status, testCase.label).toBe("failed");
      expect(
        result.diagnostics.some(
          ({ messageKey, evidence }) =>
            messageKey === "dataset.evidence.invalid" &&
            evidence.some(({ value }) =>
              String(value).includes(testCase.violation),
            ),
        ),
        testCase.label,
      ).toBe(true);
    }
  });

  it("rejects canonical plate geometry and texture requests detached from renderer metadata", async () => {
    const cases: readonly {
      readonly label: string;
      readonly violation: string;
      readonly mutate: (
        plateSpec: Record<string, unknown>,
      ) => void;
    }[] = [
      {
        label: "plate radius",
        violation: "provenance:rendering-coordinate-binding",
        mutate: (plateSpec) => {
          const geometry = plateSpec.geometry as Record<
            string,
            unknown
          >;
          geometry.radiusM = 0.2;
        },
      },
      {
        label: "texture dimensions",
        violation: "plate-spec:texture-request-binding",
        mutate: (plateSpec) => {
          const textureRequest = plateSpec.textureRequest as Record<
            string,
            unknown
          >;
          textureRequest.widthPx = 64;
        },
      },
    ];

    for (const testCase of cases) {
      const { assets, manifest } = await fixture({
        algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
        mutatePlateSpec: testCase.mutate,
      });
      const result = await loadResonanceDataset({
        manifestUrl: `${BASE}manifest.json`,
        expectedDatasetId: manifest.datasetId,
        fetch: fetchFrom(assets) as typeof fetch,
      });
      expect(result.status, testCase.label).toBe("failed");
      expect(
        result.diagnostics.some(
          ({ messageKey, evidence }) =>
            messageKey === "dataset.evidence.invalid" &&
            evidence.some(({ value }) =>
              String(value).includes(testCase.violation),
            ),
        ),
        testCase.label,
      ).toBe(true);
    }
  });

  it("rejects provenance mode summaries detached from modes.bin", async () => {
    const { assets, manifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
      mutateProvenance: (provenance) => {
        const modes = provenance.modes as Record<
          string,
          unknown
        >[];
        modes[0]!.naturalFrequencyHz = 221;
      },
    });
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: fetchFrom(assets) as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(
      result.diagnostics.some(
        ({ messageKey, evidence }) =>
          messageKey === "dataset.binary.invalid" &&
          evidence.some(({ value }) =>
            String(value).includes("modes.bin"),
          ),
      ),
    ).toBe(true);
  });

  it("keeps versioned texture shards at zero eager fetches and verifies only a requested shard", async () => {
    const { assets, manifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
      modeCount: 8,
    });
    const requests: RecordedFetch[] = [];
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: fetchFrom(assets, requests) as typeof fetch,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.files)).toBe(true);
    expect(Object.isFrozen(result.manifest.files.textures)).toBe(true);
    expect(Object.isFrozen(result.manifest.files.textures[0]?.modeIds)).toBe(
      true,
    );
    expect(
      Reflect.set(result.manifest.files.textures[0]!, "sha256", "0".repeat(64)),
    ).toBe(false);
    expect(
      requests.filter(({ url }) => url.pathname.includes("/textures/")),
    ).toHaveLength(0);
    expect(
      [...result.assets.keys()].some((path) =>
        path.startsWith("textures/"),
      ),
    ).toBe(false);
    expect(
      Object.values(result.assetUrls.textures).map((shards) => shards.length),
    ).toEqual([2, 2, 2, 2]);
    expect(result.presentationModes).toHaveLength(8);
    expect(result.presentationModes[0]).toMatchObject({
      modeId: "mode-001",
      radialNodeIndex: 1,
      radialElementCount: 8,
      radialDof: "value",
      angularOrder: 0,
      symmetry: "axisymmetric",
    });

    const sandShard = result.textureAssets["sand-density"][0]!;
    const [first, concurrent] = await Promise.all([
      sandShard.loadBytes(),
      sandShard.loadBytes(),
    ]);
    expect(first).toEqual(concurrent);
    expect(first).not.toBe(concurrent);
    const verifiedFirstByte = concurrent[0];
    first[0] ^= 0xff;
    expect(concurrent[0]).toBe(verifiedFirstByte);
    expect(
      requests.filter(({ url }) => url.pathname.includes("/textures/")),
    ).toHaveLength(1);
    expect(requests.at(-1)?.url.searchParams.get("sha256")).toBe(
      sandShard.sha256,
    );

    await sandShard.loadBytes();
    expect(
      requests.filter(({ url }) => url.pathname.includes("/textures/")),
    ).toHaveLength(2);
  });

  it("rejects a lazily requested shard whose immutable bytes fail SHA-256", async () => {
    const { assets, manifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
    });
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: (async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/textures/")) {
          const path = url.pathname.replace("/runtime/", "");
          const original = assets.get(path)!;
          const corrupt = Uint8Array.from(original);
          corrupt[corrupt.length - 1] ^= 1;
          return new Response(corrupt, { status: 200 });
        }
        return fetchFrom(assets)(input, init);
      }) as typeof fetch,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    await expect(
      result.textureAssets["sand-density"][0]!.loadBytes(),
    ).rejects.toThrow(/SHA-256/u);
  });

  it("rejects malformed algorithm revisions and unknown generators", async () => {
    const { manifest } = await fixture();
    const {
      executionKind: _legacyExecutionKind,
      ...legacySolverProvenance
    } = manifest.solverProvenance;
    expect(_legacyExecutionKind).toBe("oci-container");
    expect(
      validateResonanceManifest({
        ...manifest,
        solverProvenance: legacySolverProvenance,
      }).manifest,
    ).not.toBeNull();
    expect(
      validateResonanceManifest({
        ...manifest,
        algorithmRevision: "INVALID revision",
      }).manifest,
    ).toBeNull();
    expect(
      validateResonanceManifest({
        ...manifest,
        algorithmRevision:
          "kirchhoff-love-c1-finite-strip-r3",
      }).manifest,
    ).toBeNull();
    expect(
      validateResonanceManifest({
        ...manifest,
        ownership: {
          ...manifest.ownership,
          generator: "tools/unattested-baker",
        },
      }).manifest,
    ).toBeNull();

    const { manifest: versionedManifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
    });
    const {
      executionKind: _versionedExecutionKind,
      ...versionedSolverProvenance
    } = versionedManifest.solverProvenance;
    expect(_versionedExecutionKind).toBe("oci-container");
    expect(
      validateResonanceManifest({
        ...versionedManifest,
        solverProvenance: versionedSolverProvenance,
      }).manifest,
    ).toBeNull();
    expect(
      validateResonanceManifest({
        ...versionedManifest,
        plate: {
          plateId: versionedManifest.plate.plateId,
          specSha256: versionedManifest.plate.specSha256,
        },
      }).manifest,
    ).toBeNull();
    expect(
      validateResonanceManifest({
        ...versionedManifest,
        plate: {
          ...versionedManifest.plate,
          materialSectionProfile: {
            ...versionedManifest.plate.materialSectionProfile,
            thicknessUnorm8: [0, 255],
          },
        },
      }).manifest,
    ).toBeNull();
  });

  it("rejects a material section range detached from its canonical plate spec", async () => {
    const { assets, manifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
    });
    const detachedDraft = {
      ...manifest,
      plate: {
        ...manifest.plate,
        materialSectionProfile: {
          ...manifest.plate.materialSectionProfile!,
          maximumThicknessM: 0.0041,
        },
      },
    } as ResonanceManifest;
    const digest = await sha256Hex(
      canonicalizeJson(manifestIdentityPayload(detachedDraft)),
    );
    const detached = {
      ...detachedDraft,
      datasetId: `sha256:${digest}`,
      contentAddressing: {
        ...detachedDraft.contentAddressing,
        directoryName: digest,
      },
    } as ResonanceManifest;
    assets.set("manifest.json", jsonBytes(detached));

    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: detached.datasetId,
      fetch: fetchFrom(assets) as typeof fetch,
    });
    expect(result.status).toBe("failed");
    expect(
      result.diagnostics.some(
        ({ messageKey, evidence }) =>
          messageKey === "dataset.evidence.invalid" &&
          evidence.some(({ value }) =>
            String(value).includes(
              "plate-spec:material-section-range",
            ),
          ),
      ),
    ).toBe(true);
  });

  it("rejects a manifest plate digest detached from the plate-spec descriptor", async () => {
    const { assets, manifest } = await fixture({
      algorithmRevision: "kirchhoff-love-c1-finite-strip-r2",
    });
    const detachedDraft = {
      ...manifest,
      plate: {
        ...manifest.plate,
        specSha256: "f".repeat(64),
      },
    } as ResonanceManifest;
    const digest = await sha256Hex(
      canonicalizeJson(manifestIdentityPayload(detachedDraft)),
    );
    const detached = {
      ...detachedDraft,
      datasetId: `sha256:${digest}`,
      contentAddressing: {
        ...detachedDraft.contentAddressing,
        directoryName: digest,
      },
    } as ResonanceManifest;
    assets.set("manifest.json", jsonBytes(detached));

    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: detached.datasetId,
      fetch: fetchFrom(assets) as typeof fetch,
    });
    expect(result.status).toBe("failed");
    expect(
      result.diagnostics.some(
        ({ messageKey }) =>
          messageKey ===
          "dataset.manifest.plate-hash-inconsistent",
      ),
      JSON.stringify(result.diagnostics),
    ).toBe(true);
  });

  it("rejects empty/noncanonical modal and response binary contracts", () => {
    const zeroModes = modesBytes();
    new DataView(zeroModes.buffer).setUint32(12, 0, true);
    expect(() => decodeModesBinaryV1(zeroModes.subarray(0, 16))).toThrow(
      /at least one mode/,
    );

    const wrongOrdinal = modesBytes();
    new DataView(wrongOrdinal.buffer).setUint32(
      MODES_BINARY_V1.headerBytes + 24,
      2,
      true,
    );
    expect(() => decodeModesBinaryV1(wrongOrdinal)).toThrow(
      /ordering or bounds/,
    );

    const oneResponse = responseBytes();
    new DataView(oneResponse.buffer).setUint32(12, 1, true);
    expect(() =>
      decodeResponseBinaryV1(
        oneResponse.subarray(
          0,
          RESPONSE_BINARY_V1.headerBytes + RESPONSE_BINARY_V1.recordBytes,
        ),
      ),
    ).toThrow(/at least two samples/);
  });

  it("validates KTX2 channels, layers, level range, and ru orientation", () => {
    const bytes = portableKtx2Bytes(32, 32, 2, 1, 3);
    const descriptor: TextureAtlasReference = {
      kind: "sand-density",
      path: "textures/sand-density.ktx2",
      byteLength: bytes.byteLength,
      sha256: "0".repeat(64),
      mediaType: "image/ktx2",
      modeIds: ["mode-001", "mode-002"],
      widthPx: 32,
      heightPx: 32,
      layers: 2,
      supercompressionScheme: 3,
      uvOrigin: "negative-x-negative-y",
    };
    expect(() => validateTextureAtlasBytes(bytes, descriptor)).not.toThrow();
    const wrongOrientation = Uint8Array.from(bytes);
    const orientation = encoder.encode("KTXorientation");
    const keyStart = wrongOrientation.findIndex((_, index) =>
      orientation.every((byte, offset) => wrongOrientation[index + offset] === byte),
    );
    wrongOrientation[keyStart + orientation.byteLength + 1] =
      "l".charCodeAt(0);
    expect(() =>
      validateTextureAtlasBytes(wrongOrientation, descriptor),
    ).toThrow(/orientation/);
    const overlappingLevel = Uint8Array.from(bytes);
    const overlappingView = new DataView(overlappingLevel.buffer);
    overlappingView.setBigUint64(80, BigInt(104), true);
    overlappingView.setBigUint64(
      88,
      BigInt(overlappingLevel.byteLength - 104),
      true,
    );
    expect(() =>
      validateTextureAtlasBytes(overlappingLevel, descriptor),
    ).toThrow(/level range/);
    expect(() =>
      validateTextureAtlasBytes(bytes, { ...descriptor, layers: 1 }),
    ).toThrow(/header/);
  });

  it("loads a manifest-relative dataset only after schema and every hash pass", async () => {
    const { assets, manifest } = await fixture();
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: fetchFrom(assets) as typeof fetch,
    });

    expect(
      result.status,
      result.diagnostics
        .map(({ code, evidence }) => `${code}:${JSON.stringify(evidence)}`)
        .join("\n"),
    ).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.dataset.modes).toHaveLength(1);
    expect(result.dataset.response.sampleCount).toBe(2);
    expect(result.assetUrls.textures.normal[0]?.url).toBe(
      `${BASE}textures/normal.ktx2`,
    );
    expect(result.diagnostics.at(-1)?.code).toBe("DATASET_READY");
  });

  it("rejects legacy coverage algorithms and detached trace evidence", async () => {
    const mutations: readonly ((
      coverage: Record<string, unknown>,
    ) => void)[] = [
      (coverage) => {
        const generatedBy = coverage.generatedBy as Record<
          string,
          unknown
        >;
        generatedBy.algorithm =
          "deterministic-global-trajectory-search-v0";
      },
      (coverage) => {
        coverage.runtimeAlgorithmRevision =
          "fixed-step-modal-feedback-v1";
      },
      (coverage) => {
        const contract = coverage.coverageContract as Record<
          string,
          unknown
        >;
        contract.schemaSha256 = "0".repeat(64);
      },
      (coverage) => {
        const hashes = coverage.runtimeSpecSha256 as Record<
          string,
          unknown
        >;
        hashes.uiNVersion = "0".repeat(64);
      },
      (coverage) => {
        const traces = coverage.traces as Record<string, unknown>[];
        traces.pop();
      },
      (coverage) => {
        const traces = coverage.traces as Record<string, unknown>[];
        traces[42]!.modalModelId = `sha256:${"f".repeat(64)}`;
      },
      (coverage) => {
        const traces = coverage.traces as Record<string, unknown>[];
        const outputs = coverage.outputs as Record<string, unknown>[];
        outputs[50] = {
          ...outputs[50],
          trace: {
            ...traces[50],
            traceId: "detached-output-trace",
          },
        };
      },
    ];

    for (const mutateCoverage of mutations) {
      const { assets, manifest } = await fixture({ mutateCoverage });
      const result = await loadResonanceDataset({
        manifestUrl: `${BASE}manifest.json`,
        expectedDatasetId: manifest.datasetId,
        fetch: fetchFrom(assets) as typeof fetch,
      });
      expect(result.status).toBe("failed");
      expect(
        result.diagnostics.some(
          ({ code, evidence }) =>
            code === "DATASET_CONTENT_INVALID" &&
            evidence.some(
              ({ value }) =>
                value === "coverage-report:semantic-invalid",
            ),
        ),
      ).toBe(true);
    }
  });

  it("aborts an in-flight manifest request with its owning runtime", async () => {
    const controller = new AbortController();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const pending = loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      signal: controller.signal,
      fetch: (async (_input, init) => {
        notifyStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      }) as typeof fetch,
    });

    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses revalidated manifest and immutable hash-keyed asset requests while reporting verified priority assets first", async () => {
    const { assets, manifest } = await fixture();
    const requests: RecordedFetch[] = [];
    const progress: VerifiedAssetProgressEvent[] = [];
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: fetchFrom(assets, requests) as typeof fetch,
      onAssetVerified(event) {
        progress.push(event);
        event.bytes[0] ^= 0xff;
        if (event.path === "response.bin") {
          return Promise.reject(
            new Error("async observer failures must be isolated"),
          );
        }
      },
    });

    expect(
      result.status,
      result.diagnostics
        .map(({ code, evidence }) => `${code}:${JSON.stringify(evidence)}`)
        .join("\n"),
    ).toBe("ready");
    expect(requests[0]?.url.href).toBe(`${BASE}manifest.json`);
    expect(requests[0]?.cache).toBe("no-cache");
    expect(requests[0]?.credentials).toBe("same-origin");
    expect(requests.every(({ signal }) => signal === undefined)).toBe(true);
    expect(
      requests
        .slice(1, 4)
        .map(({ url }) => url.pathname.replace("/runtime/", "")),
    ).toEqual(["modes.bin", "response.bin", "textures/sand-density.ktx2"]);
    expect(
      requests.slice(1).every(({ cache }) => cache === "force-cache"),
    ).toBe(true);
    expect(
      requests
        .slice(1)
        .every(({ url }) =>
          /^[a-f0-9]{64}$/.test(url.searchParams.get("sha256") ?? ""),
        ),
    ).toBe(true);

    const expectedPaths = collectManifestAssets(manifest)
      .map((asset) => asset.path)
      .sort();
    expect(progress.slice(0, 3).map(({ path }) => path)).toEqual([
      "modes.bin",
      "response.bin",
      "textures/sand-density.ktx2",
    ]);
    expect(progress.map(({ path }) => path).sort()).toEqual(expectedPaths);
    expect(progress.map(({ verifiedCount }) => verifiedCount)).toEqual(
      Array.from({ length: progress.length }, (_, index) => index + 1),
    );
    expect(
      progress.every(
        (event) =>
          event.schemaVersion === "mandelhowl.asset-progress.v1" &&
          event.datasetReady === false &&
          event.datasetId === manifest.datasetId &&
          event.totalCount === expectedPaths.length,
      ),
    ).toBe(true);
    const modesProgress = progress.find(({ path }) => path === "modes.bin");
    const sandProgress = progress.find(
      ({ path }) => path === "textures/sand-density.ktx2",
    );
    expect(modesProgress?.textureKind).toBeNull();
    expect(modesProgress?.texture).toBeNull();
    expect(sandProgress?.textureKind).toBe("sand-density");
    expect(sandProgress?.texture).toEqual({
      kind: "sand-density",
      modeIds: ["mode-001"],
      widthPx: 128,
      heightPx: 128,
      layers: 1,
      uvOrigin: "negative-x-negative-y",
    });
    expect(Object.isFrozen(sandProgress?.texture)).toBe(true);
    expect(Object.isFrozen(sandProgress?.texture?.modeIds)).toBe(true);
    expect(new URL(sandProgress!.url).searchParams.get("sha256")).toBe(
      sandProgress?.sha256,
    );
    expect(sandProgress?.bytes).toBeInstanceOf(Uint8Array);
    expect(sandProgress?.bytes.byteLength).toBe(sandProgress?.byteLength);
  });

  it("stages non-priority manifest assets without an eager concurrent fetch burst", async () => {
    const { assets, manifest } = await fixture();
    const priorityPaths = new Set([
      "manifest.json",
      "modes.bin",
      "response.bin",
      "textures/sand-density.ktx2",
    ]);
    const baseFetch = fetchFrom(assets);
    let nonPriorityInFlight = 0;
    let maximumNonPriorityInFlight = 0;

    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: (async (input, init) => {
        const path = new URL(String(input)).pathname.replace("/runtime/", "");
        if (priorityPaths.has(path)) {
          return baseFetch(input, init);
        }
        nonPriorityInFlight += 1;
        maximumNonPriorityInFlight = Math.max(
          maximumNonPriorityInFlight,
          nonPriorityInFlight,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        try {
          return await baseFetch(input, init);
        } finally {
          nonPriorityInFlight -= 1;
        }
      }) as typeof fetch,
    });

    expect(result.status).toBe("ready");
    expect(maximumNonPriorityInFlight).toBe(1);
  });

  it("fails closed with confirmed evidence when a fetched asset is tampered", async () => {
    const { assets } = await fixture();
    const tampered = new Map(assets);
    const modes = new Uint8Array(tampered.get("modes.bin")!);
    modes[modes.length - 1] ^= 1;
    tampered.set("modes.bin", modes);
    const verifiedPaths: string[] = [];
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      fetch: fetchFrom(tampered) as typeof fetch,
      onAssetVerified(event) {
        verifiedPaths.push(event.path);
      },
    });

    expect(result.status).toBe("failed");
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "DATASET_ASSET_HASH_MISMATCH" &&
          diagnostic.evidenceState === "confirmed",
      ),
    ).toBe(true);
    expect(verifiedPaths).not.toContain("modes.bin");
    expect(verifiedPaths.slice(0, 2)).toEqual([
      "response.bin",
      "textures/sand-density.ktx2",
    ]);
  });

  it("rejects a valid dataset when it is not the canonical release pin", async () => {
    const { assets, manifest } = await fixture();
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: `sha256:${"f".repeat(64)}`,
      fetch: fetchFrom(assets) as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(result.manifest?.datasetId).toBe(manifest.datasetId);
    expect(
      result.diagnostics.some(
        ({ code }) => code === "DATASET_EXPECTED_ID_MISMATCH",
      ),
    ).toBe(true);
  });

  it("rejects traversal paths at the manifest schema boundary", async () => {
    const { manifest } = await fixture();
    const invalid = {
      ...manifest,
      files: {
        ...manifest.files,
        modes: {
          ...manifest.files.modes,
          path: "../modes.bin",
        },
      },
    };
    const result = validateResonanceManifest(invalid);
    expect(result.manifest).toBeNull();
    expect(result.diagnostics[0]?.code).toBe("DATASET_ASSET_PATH_UNSAFE");
  });

  it("rejects URL schemes and encoded traversal before resolving asset URLs", async () => {
    const unsafePaths = [
      "data:application/octet-stream;base64,AAAA",
      "https:example.invalid/modes.bin",
      "https://example.invalid/modes.bin",
      "//example.invalid/modes.bin",
      "C:/runtime/modes.bin",
      "textures\\modes.bin",
      "textures/./modes.bin",
      "textures/%2e%2e/modes.bin",
      "textures/%2E%2E/modes.bin",
      "textures/%252e%252e/modes.bin",
      "textures/%2foutside.bin",
    ];
    for (const path of unsafePaths) {
      expect(isSafeDatasetRelativePath(path), path).toBe(false);
    }
    for (const path of [
      "modes.bin",
      "science/solver-evidence.bin",
      "textures/sand-density-000-003.ktx2",
    ]) {
      expect(isSafeDatasetRelativePath(path), path).toBe(true);
    }

    const { manifest } = await fixture();
    for (const path of unsafePaths) {
      const result = validateResonanceManifest({
        ...manifest,
        files: {
          ...manifest.files,
          modes: {
            ...manifest.files.modes,
            path,
          },
        },
      });
      expect(result.manifest, path).toBeNull();
      expect(result.diagnostics[0]?.code, path).toBe(
        "DATASET_ASSET_PATH_UNSAFE",
      );
    }
  });

  it("rejects duplicate texture kinds, mode ids, and mismatched layer counts", async () => {
    const { manifest } = await fixture();
    const first = manifest.files.textures[0]!;
    const duplicateKind = validateResonanceManifest({
      ...manifest,
      files: {
        ...manifest.files,
        textures: [
          ...manifest.files.textures,
          { ...first, path: "textures/duplicate.ktx2" },
        ],
      },
    });
    expect(duplicateKind.manifest).toBeNull();

    const duplicateModeId = validateResonanceManifest({
      ...manifest,
      files: {
        ...manifest.files,
        textures: manifest.files.textures.map((texture, index) =>
          index === 0
            ? {
                ...texture,
                layers: 2,
                modeIds: ["mode-001", "mode-001"],
              }
            : texture,
        ),
      },
    });
    expect(duplicateModeId.manifest).toBeNull();
  });

  it("fails closed when decoded mode texture layers do not match every atlas", async () => {
    const { assets, manifest } = await fixture({ textureLayer: 1 });
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: manifest.datasetId,
      fetch: fetchFrom(assets) as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(
      result.diagnostics.some(
        ({ code, messageKey }) =>
          code === "DATASET_BINARY_INVALID" &&
          messageKey === "dataset.binary.invalid",
      ),
    ).toBe(true);
  });

  it("loads the pinned production thin-plate release with all 48 modes", async () => {
    const datasetRoot = resolve(
      process.cwd(),
      GENERATED_DATASET_RELEASE_SPEC.sourceDirectory,
    );
    const fileFetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const prefix = "/runtime/";
      if (!url.pathname.startsWith(prefix)) {
        return new Response("outside dataset", { status: 404 });
      }
      const relative = url.pathname.slice(prefix.length);
      if (
        relative === "" ||
        relative.includes("\\") ||
        relative.split("/").includes("..")
      ) {
        return new Response("unsafe", { status: 400 });
      }
      try {
        const bytes = await readFile(resolve(datasetRoot, relative));
        return new Response(Uint8Array.from(bytes).buffer, {
          status: 200,
        });
      } catch {
        return new Response("missing", { status: 404 });
      }
    };
    const result = await loadResonanceDataset({
      manifestUrl: `${BASE}manifest.json`,
      expectedDatasetId: GENERATED_DATASET_RELEASE_SPEC.datasetId,
      fetch: fileFetch as typeof fetch,
    });

    expect(
      result.status,
      JSON.stringify(result.diagnostics),
    ).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(
        result.diagnostics.map((diagnostic) => diagnostic.code).join(","),
      );
    }
    expect(result.dataset.modes).toHaveLength(48);
    expect(isRuntimeCompatible(result.manifest, "0.1.0")).toBe(true);
    expect(isRuntimeCompatible(result.manifest, "0.0.9")).toBe(false);
    expect(isRuntimeCompatible(result.manifest, "1.0.0")).toBe(false);
    expect(`sha256:${result.manifest.files.modes.sha256}`).toBe(
      GENERATED_DATASET_RELEASE_SPEC.modalModelId,
    );
    const coverage = JSON.parse(
      new TextDecoder().decode(
        result.assets.get(result.manifest.files.coverageReport.path),
      ),
    ) as { outputs?: unknown[]; replayVerified?: boolean };
    expect(coverage.outputs).toHaveLength(101);
    expect(coverage.replayVerified).toBe(true);
  }, 30_000);
});
