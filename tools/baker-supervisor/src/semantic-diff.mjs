import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

const MODE_HEADER_BYTES = 16;
const MODE_RECORD_BYTES = 96;
const RESPONSE_HEADER_BYTES = 16;
const RESPONSE_RECORD_BYTES = 24;
const KTX2_IDENTIFIER = Buffer.from("ab4b5458203230bb0d0a1a0a", "hex");

function assertRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`${label} is truncated`);
  }
}

function assertMagic(buffer, expected, label) {
  assertRange(buffer, 0, expected.length, `${label} magic`);
  if (!buffer.subarray(0, expected.length).equals(expected)) {
    throw new Error(`${label} magic is invalid`);
  }
}

function assertFinite(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function readModes(datasetRoot) {
  const buffer = readFileSync(path.join(datasetRoot, "modes.bin"));
  assertMagic(buffer, Buffer.from("MHMODES1"), "modes");
  const version = buffer.readUInt16LE(8);
  const headerBytes = buffer.readUInt16LE(10);
  const count = buffer.readUInt32LE(12);
  if (
    version !== 1 ||
    headerBytes !== MODE_HEADER_BYTES ||
    buffer.length !== headerBytes + count * MODE_RECORD_BYTES
  ) {
    throw new Error("modes dimensions are invalid");
  }
  const modes = [];
  for (let index = 0; index < count; index += 1) {
    const base = headerBytes + index * MODE_RECORD_BYTES;
    const idBytes = buffer.subarray(base, base + 24);
    const terminator = idBytes.indexOf(0);
    modes.push({
      modeId: idBytes
        .subarray(0, terminator < 0 ? idBytes.length : terminator)
        .toString("utf8"),
      ordinal: buffer.readUInt32LE(base + 24),
      textureLayer: buffer.readUInt32LE(base + 28),
      naturalFrequencyHz: assertFinite(
        buffer.readDoubleLE(base + 32),
        `modes[${index}].naturalFrequencyHz`,
      ),
      angularFrequencyRadPerS: assertFinite(
        buffer.readDoubleLE(base + 40),
        `modes[${index}].angularFrequencyRadPerS`,
      ),
      dampingRatio: assertFinite(
        buffer.readDoubleLE(base + 48),
        `modes[${index}].dampingRatio`,
      ),
      actuatorCoupling: assertFinite(
        buffer.readDoubleLE(base + 56),
        `modes[${index}].actuatorCoupling`,
      ),
      microphoneCoupling: assertFinite(
        buffer.readDoubleLE(base + 64),
        `modes[${index}].microphoneCoupling`,
      ),
      radiationEfficiency: assertFinite(
        buffer.readDoubleLE(base + 72),
        `modes[${index}].radiationEfficiency`,
      ),
      phaseReferenceRad: assertFinite(
        buffer.readDoubleLE(base + 80),
        `modes[${index}].phaseReferenceRad`,
      ),
      signCode: buffer[base + 88],
    });
  }
  return modes;
}

function readResponse(datasetRoot) {
  const buffer = readFileSync(path.join(datasetRoot, "response.bin"));
  assertMagic(buffer, Buffer.from("MHRESPN1"), "response");
  const version = buffer.readUInt16LE(8);
  const headerBytes = buffer.readUInt16LE(10);
  const count = buffer.readUInt32LE(12);
  if (
    version !== 1 ||
    headerBytes !== RESPONSE_HEADER_BYTES ||
    buffer.length !== headerBytes + count * RESPONSE_RECORD_BYTES
  ) {
    throw new Error("response dimensions are invalid");
  }
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const base = headerBytes + index * RESPONSE_RECORD_BYTES;
    samples.push({
      frequencyHz: assertFinite(
        buffer.readDoubleLE(base),
        `response[${index}].frequencyHz`,
      ),
      real: assertFinite(
        buffer.readDoubleLE(base + 8),
        `response[${index}].real`,
      ),
      imaginary: assertFinite(
        buffer.readDoubleLE(base + 16),
        `response[${index}].imaginary`,
      ),
    });
  }
  return samples;
}

function readField(datasetRoot) {
  const buffer = readFileSync(
    path.join(datasetRoot, "field", "mandelbrot-field.bin"),
  );
  assertMagic(buffer, Buffer.from("MHFIELD1"), "field");
  const version = buffer.readUInt32LE(8);
  const size = buffer.readUInt32LE(12);
  if (version !== 1 || size < 1 || buffer.length !== 24 + size * size) {
    throw new Error("field dimensions are invalid");
  }
  return {
    size,
    minimumM: assertFinite(buffer.readFloatLE(16), "field.minimumM"),
    maximumM: assertFinite(buffer.readFloatLE(20), "field.maximumM"),
    pixels: buffer.subarray(24),
  };
}

function readSolverEvidence(datasetRoot) {
  const buffer = readFileSync(
    path.join(datasetRoot, "science", "solver-evidence.bin"),
  );
  assertMagic(buffer, Buffer.from("MHEVID01"), "solver evidence");
  const version = buffer.readUInt32LE(8);
  const basisCount = buffer.readUInt32LE(12);
  const modeCount = buffer.readUInt32LE(16);
  const valueCount = basisCount * basisCount + basisCount * modeCount;
  if (
    version !== 1 ||
    basisCount < 1 ||
    modeCount < 1 ||
    !Number.isSafeInteger(valueCount) ||
    buffer.length !== 20 + valueCount * 8
  ) {
    throw new Error("solver evidence dimensions are invalid");
  }
  const values = new Float64Array(valueCount);
  for (let index = 0; index < valueCount; index += 1) {
    values[index] = assertFinite(
      buffer.readDoubleLE(20 + index * 8),
      `solverEvidence.values[${index}]`,
    );
  }
  return { basisCount, modeCount, values };
}

function decodeKtx2(buffer, label) {
  assertMagic(buffer, KTX2_IDENTIFIER, `${label} KTX2`);
  assertRange(buffer, 0, 104, `${label} KTX2 header`);
  const format = buffer.readUInt32LE(12);
  const width = buffer.readUInt32LE(20);
  const height = buffer.readUInt32LE(24);
  const layers = buffer.readUInt32LE(32);
  const supercompressionScheme = buffer.readUInt32LE(44);
  const levelOffset = Number(buffer.readBigUInt64LE(80));
  const levelLength = Number(buffer.readBigUInt64LE(88));
  const uncompressedLength = Number(buffer.readBigUInt64LE(96));
  const channels = format === 9 ? 1 : format === 16 ? 2 : 0;
  const expectedLength = width * height * layers * channels;
  if (
    channels === 0 ||
    ![0, 3].includes(supercompressionScheme) ||
    uncompressedLength !== expectedLength ||
    (supercompressionScheme === 0 && levelLength !== expectedLength) ||
    (supercompressionScheme === 3 && levelLength >= expectedLength)
  ) {
    throw new Error(`${label} KTX2 dimensions are invalid`);
  }
  assertRange(buffer, levelOffset, levelLength, `${label} KTX2 level`);
  const encoded = buffer.subarray(levelOffset, levelOffset + levelLength);
  const pixels =
    supercompressionScheme === 3 ? inflateSync(encoded) : encoded;
  if (pixels.length !== expectedLength) {
    throw new Error(`${label} decoded KTX2 level length is invalid`);
  }
  return {
    format,
    width,
    height,
    layers,
    channels,
    supercompressionScheme,
    pixels,
  };
}

function readKtx2(datasetRoot, kind) {
  const manifest = JSON.parse(
    readFileSync(path.join(datasetRoot, "manifest.json"), "utf8"),
  );
  const descriptors = manifest?.files?.textures?.filter(
    (descriptor) => descriptor.kind === kind,
  );
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new Error(`${kind} texture descriptors are missing`);
  }
  let aggregate = null;
  const pixels = [];
  const modeIds = [];
  const paths = [];
  for (const descriptor of descriptors) {
    const relative = descriptor.path;
    const decoded = decodeKtx2(
      readFileSync(path.join(datasetRoot, relative)),
      relative,
    );
    if (
      decoded.width !== descriptor.widthPx ||
      decoded.height !== descriptor.heightPx ||
      decoded.layers !== descriptor.layers ||
      !Array.isArray(descriptor.modeIds) ||
      descriptor.modeIds.length !== decoded.layers ||
      (aggregate &&
        (decoded.format !== aggregate.format ||
          decoded.width !== aggregate.width ||
          decoded.height !== aggregate.height ||
          decoded.channels !== aggregate.channels ||
          decoded.supercompressionScheme !==
            aggregate.supercompressionScheme))
    ) {
      throw new Error(`${relative} texture shard metadata is invalid`);
    }
    aggregate ??= decoded;
    pixels.push(decoded.pixels);
    modeIds.push(...descriptor.modeIds);
    paths.push(relative);
  }
  if (modeIds.length !== manifest.modeCount) {
    throw new Error(`${kind} texture shards do not cover every mode`);
  }
  return {
    ...aggregate,
    layers: modeIds.length,
    shardCount: descriptors.length,
    paths,
    modeIds,
    pixels: Buffer.concat(pixels),
  };
}

function readMeshEvidence(datasetRoot) {
  const evidence = JSON.parse(
    readFileSync(
      path.join(datasetRoot, "mesh", "mesh-evidence.json"),
      "utf8",
    ),
  );
  if (
    evidence?.schemaVersion !== "mandelhowl.mesh-evidence.v1" ||
    !Array.isArray(evidence.levels)
  ) {
    throw new Error("mesh evidence contract is invalid");
  }
  const levels = evidence.levels.map((level, index) => {
    const numeric = {};
    for (const key of [
      "targetElementSizeM",
      "radialDivisions",
      "angularDivisions",
      "nodeCount",
      "triangleCount",
      "minimumEdgeM",
      "minimumSignedAreaM2",
      "maximumAspectRatio",
      "invertedTriangleCount",
      "connectedComponentCount",
    ]) {
      numeric[key] = assertFinite(level?.[key], `mesh.levels[${index}].${key}`);
    }
    if (
      typeof level?.levelName !== "string" ||
      !/^[a-f0-9]{64}$/.test(level?.fingerprintSha256 ?? "")
    ) {
      throw new Error(`mesh evidence level ${index} metadata is invalid`);
    }
    return {
      levelName: level.levelName,
      fingerprintSha256: level.fingerprintSha256,
      ...numeric,
    };
  });
  return {
    domain: evidence.domain,
    qualityPolicy: evidence.qualityPolicy,
    levels,
  };
}

function readMeshArchive(datasetRoot) {
  const compressed = readFileSync(
    path.join(datasetRoot, "mesh", "fine-polar-mesh.mhmz"),
  );
  const buffer = inflateSync(compressed);
  assertMagic(buffer, Buffer.from("MHMESH01"), "mesh archive");
  assertRange(buffer, 0, 24, "mesh archive header");
  const version = buffer.readUInt32LE(8);
  const nodeCount = buffer.readUInt32LE(12);
  const triangleCount = buffer.readUInt32LE(16);
  const components = buffer.readUInt32LE(20);
  const expectedLength = 24 + nodeCount * 12 + triangleCount * 12;
  if (
    version !== 1 ||
    components !== 3 ||
    !Number.isSafeInteger(expectedLength) ||
    buffer.length !== expectedLength
  ) {
    throw new Error("mesh archive dimensions are invalid");
  }
  const nodes = new Float32Array(nodeCount * components);
  for (let index = 0; index < nodes.length; index += 1) {
    nodes[index] = assertFinite(
      buffer.readFloatLE(24 + index * 4),
      `mesh.nodes[${index}]`,
    );
  }
  const indexOffset = 24 + nodes.length * 4;
  const indices = new Uint32Array(triangleCount * 3);
  for (let index = 0; index < indices.length; index += 1) {
    indices[index] = buffer.readUInt32LE(indexOffset + index * 4);
    if (indices[index] >= nodeCount) {
      throw new Error(`mesh index ${index} is out of range`);
    }
  }
  return { nodeCount, triangleCount, components, nodes, indices };
}

function readFiniteJson(datasetRoot, relative) {
  const value = JSON.parse(
    readFileSync(path.join(datasetRoot, relative), "utf8"),
  );
  const validate = (candidate, jsonPath) => {
    if (typeof candidate === "number") {
      assertFinite(candidate, jsonPath);
    } else if (Array.isArray(candidate)) {
      candidate.forEach((child, index) =>
        validate(child, `${jsonPath}[${index}]`),
      );
    } else if (candidate && typeof candidate === "object") {
      for (const [key, child] of Object.entries(candidate)) {
        validate(child, `${jsonPath}.${key}`);
      }
    }
  };
  validate(value, relative);
  return value;
}

function scientificProvenance(datasetRoot) {
  const provenance = readFiniteJson(datasetRoot, "provenance.json");
  const solver = provenance.solver ?? {};
  return {
    canonicalInput: provenance.canonicalInput ?? null,
    solver: {
      name: solver.name ?? null,
      options: solver.options ?? null,
      canonicalRequest: solver.canonicalRequest ?? null,
      executedMethod: solver.executedMethod ?? null,
      methodRequestMismatchRecorded:
        solver.methodRequestMismatchRecorded ?? null,
      normalization: solver.normalization ?? null,
      signRule: solver.signRule ?? null,
    },
    manufacturing: provenance.manufacturing ?? null,
    response: provenance.response ?? null,
    textures: provenance.textures ?? null,
    derivedRuntimeFields: provenance.derivedRuntimeFields ?? null,
    renderingCoordinateTransform:
      provenance.renderingCoordinateTransform ?? null,
    modes: provenance.modes ?? null,
    scientificScope: provenance.scientificScope ?? null,
  };
}

function compareJsonTree({
  left,
  right,
  jsonPath,
  absoluteTolerance,
  relativeTolerance,
  toleranceForPath = null,
  addMismatch,
}) {
  let maximumAbsolute = 0;
  let maximumRelative = 0;
  const visit = (leftValue, rightValue, currentPath) => {
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      assertFinite(leftValue, `${currentPath}.left`);
      assertFinite(rightValue, `${currentPath}.right`);
      const absolute = Math.abs(leftValue - rightValue);
      const relative = relativeDifference(leftValue, rightValue, 1e-30);
      const selectedTolerance =
        toleranceForPath?.(currentPath) ?? {
          absolute: absoluteTolerance,
          relative: relativeTolerance,
        };
      maximumAbsolute = Math.max(maximumAbsolute, absolute);
      maximumRelative = Math.max(maximumRelative, relative);
      if (
        absolute > selectedTolerance.absolute &&
        relative > selectedTolerance.relative
      ) {
        addMismatch(currentPath, leftValue, rightValue, selectedTolerance);
      }
      return;
    }
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      if (leftValue.length !== rightValue.length) {
        addMismatch(
          `${currentPath}.length`,
          leftValue.length,
          rightValue.length,
          "exact",
        );
      }
      const count = Math.min(leftValue.length, rightValue.length);
      for (let index = 0; index < count; index += 1) {
        visit(leftValue[index], rightValue[index], `${currentPath}[${index}]`);
      }
      return;
    }
    if (
      leftValue &&
      rightValue &&
      typeof leftValue === "object" &&
      typeof rightValue === "object" &&
      !Array.isArray(leftValue) &&
      !Array.isArray(rightValue)
    ) {
      const leftKeys = Object.keys(leftValue).sort();
      const rightKeys = Object.keys(rightValue).sort();
      if (JSON.stringify(leftKeys) !== JSON.stringify(rightKeys)) {
        addMismatch(
          `${currentPath}.keys`,
          leftKeys,
          rightKeys,
          "exact",
        );
      }
      for (const key of leftKeys.filter(
        (key) =>
          key !== "fingerprintSha256" && Object.hasOwn(rightValue, key),
      )) {
        visit(leftValue[key], rightValue[key], `${currentPath}.${key}`);
      }
      return;
    }
    if (leftValue !== rightValue) {
      addMismatch(currentPath, leftValue, rightValue, "exact");
    }
  };
  visit(left, right, jsonPath);
  return { maximumAbsolute, maximumRelative };
}

function relativeDifference(left, right, floor = Number.MIN_VALUE) {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), floor);
}

function compensatedDot(left, right) {
  let sum = 0;
  let compensation = 0;
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const product = left[index] * right[index];
    const corrected = product - compensation;
    const next = sum + corrected;
    compensation = (next - sum) - corrected;
    sum = next;
  }
  return sum;
}

function euclideanRelativeDifference(left, right) {
  const difference = new Float64Array(Math.min(left.length, right.length));
  for (let index = 0; index < difference.length; index += 1) {
    difference[index] = left[index] - right[index];
  }
  const differenceNorm = Math.sqrt(compensatedDot(difference, difference));
  const leftNorm = Math.sqrt(compensatedDot(left, left));
  const rightNorm = Math.sqrt(compensatedDot(right, right));
  return differenceNorm / Math.max(leftNorm, rightNorm, 1e-300);
}

function averageMassBilinear(left, right, leftMass, rightMass, basisCount) {
  let sum = 0;
  let compensation = 0;
  for (let row = 0; row < basisCount; row += 1) {
    let weighted = 0;
    let weightedCompensation = 0;
    const rowOffset = row * basisCount;
    for (let column = 0; column < basisCount; column += 1) {
      const averageMass =
        0.5 * (leftMass[rowOffset + column] + rightMass[rowOffset + column]);
      const product = averageMass * right[column];
      const corrected = product - weightedCompensation;
      const next = weighted + corrected;
      weightedCompensation = (next - weighted) - corrected;
      weighted = next;
    }
    const product = left[row] * weighted;
    const corrected = product - compensation;
    const next = sum + corrected;
    compensation = (next - sum) - corrected;
    sum = next;
  }
  return sum;
}

function modalAssuranceCriterion(
  left,
  right,
  leftMass,
  rightMass,
  basisCount,
) {
  const cross = averageMassBilinear(
    left,
    right,
    leftMass,
    rightMass,
    basisCount,
  );
  const leftNorm = averageMassBilinear(
    left,
    left,
    leftMass,
    rightMass,
    basisCount,
  );
  const rightNorm = averageMassBilinear(
    right,
    right,
    leftMass,
    rightMass,
    basisCount,
  );
  const denominator = leftNorm * rightNorm;
  if (!(denominator > 0) || !Number.isFinite(denominator)) {
    return Number.NaN;
  }
  return Math.min(1, Math.max(0, (cross * cross) / denominator));
}

function compareByteArrays(left, right) {
  if (left.length !== right.length) {
    return {
      sameLength: false,
      maximumLsb: Number.POSITIVE_INFINITY,
      differentCount: Math.max(left.length, right.length),
      differentFraction: 1,
    };
  }
  let maximumLsb = 0;
  let differentCount = 0;
  for (let index = 0; index < left.length; index += 1) {
    const difference = Math.abs(left[index] - right[index]);
    maximumLsb = Math.max(maximumLsb, difference);
    if (difference !== 0) differentCount += 1;
  }
  return {
    sameLength: true,
    maximumLsb,
    differentCount,
    differentFraction: left.length === 0 ? 0 : differentCount / left.length,
  };
}

export function loadAlgorithmContract(projectRoot) {
  const contractPath = path.join(
    projectRoot,
    "specs",
    "physics",
    "baker-algorithm.v1.json",
  );
  const bytes = readFileSync(contractPath);
  const contract = JSON.parse(bytes.toString("utf8"));
  return {
    ...contract,
    contractSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function manifestMetadata(datasetRoot) {
  const manifestBytes = readFileSync(path.join(datasetRoot, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  return {
    algorithmRevision: manifest.algorithmRevision ?? null,
    generator: manifest.ownership?.generator ?? null,
    datasetId: manifest.datasetId ?? null,
    materialSectionProfile:
      manifest.plate?.materialSectionProfile ?? null,
    manifestSha256: createHash("sha256")
      .update(manifestBytes)
      .digest("hex"),
  };
}

function algorithmEvidenceDigest(datasetRoot) {
  const evidencePath = path.join(
    datasetRoot,
    "science",
    "baker-algorithm.v1.json",
  );
  if (!existsSync(evidencePath)) return null;
  return createHash("sha256")
    .update(readFileSync(evidencePath))
    .digest("hex");
}

export function compareDatasets({
  projectRoot,
  leftRoot,
  rightRoot,
  mismatchLimit = 64,
  expectedLeftGenerator = null,
  expectedRightGenerator = null,
}) {
  const algorithm = loadAlgorithmContract(projectRoot);
  const tolerance = algorithm.differentialTolerance;
  const mismatches = [];
  let mismatchCount = 0;
  const addMismatch = (pathName, left, right, toleranceValue) => {
    mismatchCount += 1;
    if (mismatches.length < mismatchLimit) {
      mismatches.push({
        path: pathName,
        left,
        right,
        tolerance: toleranceValue,
      });
    }
  };

  const leftManifest = manifestMetadata(leftRoot);
  const rightManifest = manifestMetadata(rightRoot);
  const leftRevision = leftManifest.algorithmRevision;
  const rightRevision = rightManifest.algorithmRevision;
  const strictAlgorithmEvidence =
    expectedLeftGenerator !== null || expectedRightGenerator !== null;
  for (const [label, actual, expected] of [
    ["left", leftManifest.generator, expectedLeftGenerator],
    ["right", rightManifest.generator, expectedRightGenerator],
  ]) {
    if (expected !== null && actual !== expected) {
      addMismatch(
        `${label}.manifest.ownership.generator`,
        actual,
        expected,
        "exact",
      );
    }
  }
  for (const [label, revision] of [
    ["left", leftRevision],
    ["right", rightRevision],
  ]) {
    if (
      (strictAlgorithmEvidence && revision === null) ||
      (revision !== null && revision !== algorithm.algorithmRevision)
    ) {
      addMismatch(
        `${label}.manifest.algorithmRevision`,
        revision,
        algorithm.algorithmRevision,
        "exact",
      );
    }
  }
  if (
    leftRevision !== null &&
    rightRevision !== null &&
    leftRevision !== rightRevision
  ) {
    addMismatch(
      "manifest.algorithmRevision",
      leftRevision,
      rightRevision,
      "exact",
    );
  }
  for (const [label, revision, profile] of [
    [
      "left",
      leftRevision,
      leftManifest.materialSectionProfile,
    ],
    [
      "right",
      rightRevision,
      rightManifest.materialSectionProfile,
    ],
  ]) {
    if (
      revision === algorithm.algorithmRevision &&
      profile === null
    ) {
      addMismatch(
        `${label}.manifest.plate.materialSectionProfile`,
        null,
        "required for versioned datasets",
        "exact",
      );
    }
  }
  const materialSectionProfileReport = compareJsonTree({
    left: leftManifest.materialSectionProfile,
    right: rightManifest.materialSectionProfile,
    jsonPath: "manifest.plate.materialSectionProfile",
    absoluteTolerance: 0,
    relativeTolerance: 0,
    addMismatch,
  });
  for (const [label, digest] of [
    ["left", algorithmEvidenceDigest(leftRoot)],
    ["right", algorithmEvidenceDigest(rightRoot)],
  ]) {
    if (
      (strictAlgorithmEvidence && digest === null) ||
      (digest !== null && digest !== algorithm.contractSha256)
    ) {
      addMismatch(
        `${label}.algorithmContractSha256`,
        digest,
        algorithm.contractSha256,
        "exact",
      );
    }
  }

  const leftModesBytes = readFileSync(path.join(leftRoot, "modes.bin"));
  const rightModesBytes = readFileSync(path.join(rightRoot, "modes.bin"));
  const modesByteIdentical = leftModesBytes.equals(rightModesBytes);
  const leftModesSha256 = createHash("sha256")
    .update(leftModesBytes)
    .digest("hex");
  const rightModesSha256 = createHash("sha256")
    .update(rightModesBytes)
    .digest("hex");
  if (
    algorithm.runtimeModalOutput &&
    leftRevision === algorithm.algorithmRevision &&
    rightRevision === algorithm.algorithmRevision &&
    !modesByteIdentical
  ) {
    addMismatch(
      "modes.binarySha256",
      leftModesSha256,
      rightModesSha256,
      "exact-versioned-runtime-modal-output",
    );
  }
  const leftModes = readModes(leftRoot);
  const rightModes = readModes(rightRoot);
  if (leftModes.length !== rightModes.length) {
    addMismatch(
      "modes.count",
      leftModes.length,
      rightModes.length,
      "exact",
    );
  }
  let maximumModeFrequencyRelative = 0;
  let maximumModeScalarAbsolute = 0;
  const modeCount = Math.min(leftModes.length, rightModes.length);
  for (let index = 0; index < modeCount; index += 1) {
    const left = leftModes[index];
    const right = rightModes[index];
    for (const key of ["modeId", "ordinal", "textureLayer", "signCode"]) {
      if (left[key] !== right[key]) {
        addMismatch(`modes[${index}].${key}`, left[key], right[key], "exact");
      }
    }
    for (const key of ["naturalFrequencyHz", "angularFrequencyRadPerS"]) {
      const difference = relativeDifference(left[key], right[key]);
      maximumModeFrequencyRelative = Math.max(
        maximumModeFrequencyRelative,
        difference,
      );
      if (difference > tolerance.modeFrequencyRelative) {
        addMismatch(
          `modes[${index}].${key}`,
          left[key],
          right[key],
          tolerance.modeFrequencyRelative,
        );
      }
    }
    for (const key of [
      "dampingRatio",
      "actuatorCoupling",
      "microphoneCoupling",
      "radiationEfficiency",
      "phaseReferenceRad",
    ]) {
      const difference = Math.abs(left[key] - right[key]);
      maximumModeScalarAbsolute = Math.max(
        maximumModeScalarAbsolute,
        difference,
      );
      if (difference > tolerance.modeScalarAbsolute) {
        addMismatch(
          `modes[${index}].${key}`,
          left[key],
          right[key],
          tolerance.modeScalarAbsolute,
        );
      }
    }
  }

  const leftResponse = readResponse(leftRoot);
  const rightResponse = readResponse(rightRoot);
  if (leftResponse.length !== rightResponse.length) {
    addMismatch(
      "response.count",
      leftResponse.length,
      rightResponse.length,
      "exact",
    );
  }
  let maximumResponseFrequencyRelative = 0;
  let maximumResponseComponentAbsolute = 0;
  const responseCount = Math.min(leftResponse.length, rightResponse.length);
  for (let index = 0; index < responseCount; index += 1) {
    const left = leftResponse[index];
    const right = rightResponse[index];
    const frequencyDifference = relativeDifference(
      left.frequencyHz,
      right.frequencyHz,
    );
    maximumResponseFrequencyRelative = Math.max(
      maximumResponseFrequencyRelative,
      frequencyDifference,
    );
    if (frequencyDifference > tolerance.responseFrequencyRelative) {
      addMismatch(
        `response[${index}].frequencyHz`,
        left.frequencyHz,
        right.frequencyHz,
        tolerance.responseFrequencyRelative,
      );
    }
    for (const key of ["real", "imaginary"]) {
      const difference = Math.abs(left[key] - right[key]);
      maximumResponseComponentAbsolute = Math.max(
        maximumResponseComponentAbsolute,
        difference,
      );
      if (difference > tolerance.responseComponentAbsolute) {
        addMismatch(
          `response[${index}].${key}`,
          left[key],
          right[key],
          tolerance.responseComponentAbsolute,
        );
      }
    }
  }

  const leftField = readField(leftRoot);
  const rightField = readField(rightRoot);
  for (const key of ["size", "minimumM", "maximumM"]) {
    if (leftField[key] !== rightField[key]) {
      addMismatch(`field.${key}`, leftField[key], rightField[key], "exact");
    }
  }
  const fieldDifference = compareByteArrays(
    leftField.pixels,
    rightField.pixels,
  );
  if (
    !fieldDifference.sameLength ||
    fieldDifference.maximumLsb > tolerance.fieldMaximumLsb
  ) {
    addMismatch(
      "field.pixels",
      fieldDifference,
      null,
      { maximumLsb: tolerance.fieldMaximumLsb },
    );
  }

  const plateReport = compareJsonTree({
    left: readFiniteJson(leftRoot, "plate-spec.json"),
    right: readFiniteJson(rightRoot, "plate-spec.json"),
    jsonPath: "plateSpec",
    absoluteTolerance: 0,
    relativeTolerance: 0,
    addMismatch,
  });
  const convergenceReport = compareJsonTree({
    left: readFiniteJson(leftRoot, "convergence-report.json"),
    right: readFiniteJson(rightRoot, "convergence-report.json"),
    jsonPath: "convergenceReport",
    absoluteTolerance: tolerance.reportScalarAbsolute,
    relativeTolerance: tolerance.reportScalarRelative,
    addMismatch,
  });
  const coverageReport = compareJsonTree({
    left: readFiniteJson(leftRoot, "coverage-report.json"),
    right: readFiniteJson(rightRoot, "coverage-report.json"),
    jsonPath: "coverageReport",
    absoluteTolerance: tolerance.reportScalarAbsolute,
    relativeTolerance: tolerance.reportScalarRelative,
    addMismatch,
  });
  const scientificProvenanceReport = compareJsonTree({
    left: scientificProvenance(leftRoot),
    right: scientificProvenance(rightRoot),
    jsonPath: "provenance.scientific",
    absoluteTolerance: tolerance.reportScalarAbsolute,
    relativeTolerance: tolerance.reportScalarRelative,
    toleranceForPath: (currentPath) =>
      currentPath.includes(".adjacentFrequencySpacingHz.")
        ? {
            absolute: tolerance.adjacentFrequencySpacingAbsoluteHz,
            relative: tolerance.reportScalarRelative,
          }
        : null,
    addMismatch,
  });

  const leftEvidence = readSolverEvidence(leftRoot);
  const rightEvidence = readSolverEvidence(rightRoot);
  for (const key of ["basisCount", "modeCount"]) {
    if (leftEvidence[key] !== rightEvidence[key]) {
      addMismatch(
        `solverEvidence.${key}`,
        leftEvidence[key],
        rightEvidence[key],
        "exact",
      );
    }
  }

  const leftMeshEvidence = readMeshEvidence(leftRoot);
  const rightMeshEvidence = readMeshEvidence(rightRoot);
  const meshPolicyReport = compareJsonTree({
    left: {
      domain: leftMeshEvidence.domain,
      qualityPolicy: leftMeshEvidence.qualityPolicy,
    },
    right: {
      domain: rightMeshEvidence.domain,
      qualityPolicy: rightMeshEvidence.qualityPolicy,
    },
    jsonPath: "mesh.evidence",
    absoluteTolerance: 0,
    relativeTolerance: 0,
    addMismatch,
  });
  if (leftMeshEvidence.levels.length !== rightMeshEvidence.levels.length) {
    addMismatch(
      "mesh.evidence.levelCount",
      leftMeshEvidence.levels.length,
      rightMeshEvidence.levels.length,
      "exact",
    );
  }
  let maximumMeshEvidenceRelative = 0;
  let maximumMeshEvidenceAbsolute = 0;
  const meshLevelCount = Math.min(
    leftMeshEvidence.levels.length,
    rightMeshEvidence.levels.length,
  );
  let meshEvidenceFingerprintsEqual = true;
  for (let index = 0; index < meshLevelCount; index += 1) {
    const left = leftMeshEvidence.levels[index];
    const right = rightMeshEvidence.levels[index];
    for (const key of [
      "levelName",
      "radialDivisions",
      "angularDivisions",
      "nodeCount",
      "triangleCount",
      "invertedTriangleCount",
      "connectedComponentCount",
    ]) {
      if (left[key] !== right[key]) {
        addMismatch(
          `mesh.evidence.levels[${index}].${key}`,
          left[key],
          right[key],
          "exact",
        );
      }
    }
    meshEvidenceFingerprintsEqual &&=
      left.fingerprintSha256 === right.fingerprintSha256;
    for (const key of [
      "targetElementSizeM",
      "minimumEdgeM",
      "minimumSignedAreaM2",
      "maximumAspectRatio",
    ]) {
      const absolute = Math.abs(left[key] - right[key]);
      const relative = relativeDifference(left[key], right[key], 1e-30);
      maximumMeshEvidenceAbsolute = Math.max(
        maximumMeshEvidenceAbsolute,
        absolute,
      );
      maximumMeshEvidenceRelative = Math.max(
        maximumMeshEvidenceRelative,
        relative,
      );
      if (
        absolute > tolerance.meshEvidenceAbsolute &&
        relative > tolerance.meshEvidenceRelative
      ) {
        addMismatch(
          `mesh.evidence.levels[${index}].${key}`,
          left[key],
          right[key],
          {
            absolute: tolerance.meshEvidenceAbsolute,
            relative: tolerance.meshEvidenceRelative,
          },
        );
      }
    }
  }

  const leftMesh = readMeshArchive(leftRoot);
  const rightMesh = readMeshArchive(rightRoot);
  for (const key of ["nodeCount", "triangleCount", "components"]) {
    if (leftMesh[key] !== rightMesh[key]) {
      addMismatch(`mesh.archive.${key}`, leftMesh[key], rightMesh[key], "exact");
    }
  }
  let maximumMeshNodeAbsoluteM = 0;
  const meshNodeValueCount = Math.min(
    leftMesh.nodes.length,
    rightMesh.nodes.length,
  );
  for (let index = 0; index < meshNodeValueCount; index += 1) {
    const difference = Math.abs(
      leftMesh.nodes[index] - rightMesh.nodes[index],
    );
    maximumMeshNodeAbsoluteM = Math.max(
      maximumMeshNodeAbsoluteM,
      difference,
    );
    if (difference > tolerance.meshNodeAbsoluteM) {
      addMismatch(
        `mesh.archive.nodes[${index}]`,
        leftMesh.nodes[index],
        rightMesh.nodes[index],
        tolerance.meshNodeAbsoluteM,
      );
    }
  }
  if (leftMesh.indices.length !== rightMesh.indices.length) {
    addMismatch(
      "mesh.archive.indexCount",
      leftMesh.indices.length,
      rightMesh.indices.length,
      "exact",
    );
  }
  const meshIndexCount = Math.min(
    leftMesh.indices.length,
    rightMesh.indices.length,
  );
  for (let index = 0; index < meshIndexCount; index += 1) {
    if (leftMesh.indices[index] !== rightMesh.indices[index]) {
      addMismatch(
        `mesh.archive.indices[${index}]`,
        leftMesh.indices[index],
        rightMesh.indices[index],
        "exact",
      );
    }
  }
  let maximumSolverEvidenceRelative = 0;
  let maximumSolverEvidenceAbsolute = 0;
  const evidenceCount = Math.min(
    leftEvidence.values.length,
    rightEvidence.values.length,
  );
  for (let index = 0; index < evidenceCount; index += 1) {
    const absoluteDifference = Math.abs(
      leftEvidence.values[index] - rightEvidence.values[index],
    );
    const difference = relativeDifference(
      leftEvidence.values[index],
      rightEvidence.values[index],
      1e-30,
    );
    maximumSolverEvidenceAbsolute = Math.max(
      maximumSolverEvidenceAbsolute,
      absoluteDifference,
    );
    maximumSolverEvidenceRelative = Math.max(
      maximumSolverEvidenceRelative,
      difference,
    );
    if (
      absoluteDifference > tolerance.solverEvidenceAbsolute &&
      difference > tolerance.solverEvidenceRelative
    ) {
      addMismatch(
        `solverEvidence.values[${index}]`,
        leftEvidence.values[index],
        rightEvidence.values[index],
        {
          relative: tolerance.solverEvidenceRelative,
          absolute: tolerance.solverEvidenceAbsolute,
        },
      );
    }
  }

  let maximumSolverModeCoefficientL2Relative = 0;
  let minimumSolverModeModalAssuranceCriterion = 1;
  if (
    leftEvidence.basisCount === rightEvidence.basisCount &&
    leftEvidence.modeCount === rightEvidence.modeCount
  ) {
    const basisCount = leftEvidence.basisCount;
    const massValueCount = basisCount * basisCount;
    const leftMass = leftEvidence.values.subarray(0, massValueCount);
    const rightMass = rightEvidence.values.subarray(0, massValueCount);
    for (let modeIndex = 0; modeIndex < leftEvidence.modeCount; modeIndex += 1) {
      const start = massValueCount + modeIndex * basisCount;
      const end = start + basisCount;
      const leftCoefficients = leftEvidence.values.subarray(start, end);
      const rightCoefficients = rightEvidence.values.subarray(start, end);
      const l2Relative = euclideanRelativeDifference(
        leftCoefficients,
        rightCoefficients,
      );
      const mac = modalAssuranceCriterion(
        leftCoefficients,
        rightCoefficients,
        leftMass,
        rightMass,
        basisCount,
      );
      maximumSolverModeCoefficientL2Relative = Math.max(
        maximumSolverModeCoefficientL2Relative,
        l2Relative,
      );
      minimumSolverModeModalAssuranceCriterion = Math.min(
        minimumSolverModeModalAssuranceCriterion,
        mac,
      );
      if (
        !Number.isFinite(l2Relative) ||
        l2Relative > tolerance.solverModeCoefficientL2Relative
      ) {
        addMismatch(
          `solverEvidence.modes[${modeIndex}].coefficientL2Relative`,
          l2Relative,
          0,
          tolerance.solverModeCoefficientL2Relative,
        );
      }
      if (
        !Number.isFinite(mac) ||
        mac < tolerance.solverModeMinimumModalAssuranceCriterion
      ) {
        addMismatch(
          `solverEvidence.modes[${modeIndex}].modalAssuranceCriterion`,
          mac,
          1,
          {
            minimum:
              tolerance.solverModeMinimumModalAssuranceCriterion,
            massMetric: "average-of-left-and-right-mass-matrices",
          },
        );
      }
    }
  } else {
    minimumSolverModeModalAssuranceCriterion = 0;
  }

  const textureMetrics = {};
  for (const kind of [
    "signed-displacement",
    "normal",
    "nodal-mask",
    "sand-density",
  ]) {
    const left = readKtx2(leftRoot, kind);
    const right = readKtx2(rightRoot, kind);
    for (const key of [
      "format",
      "width",
      "height",
      "layers",
      "channels",
      "supercompressionScheme",
      "shardCount",
    ]) {
      if (left[key] !== right[key]) {
        addMismatch(
          `textures.${kind}.${key}`,
          left[key],
          right[key],
          "exact",
        );
      }
    }
    for (const key of ["paths", "modeIds"]) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
        addMismatch(
          `textures.${kind}.${key}`,
          left[key],
          right[key],
          "exact",
        );
      }
    }
    const difference = compareByteArrays(left.pixels, right.pixels);
    textureMetrics[kind] = difference;
    if (
      !difference.sameLength ||
      difference.maximumLsb > tolerance.textureMaximumLsb ||
      difference.differentFraction >
        tolerance.textureMaximumDifferentFraction
    ) {
      addMismatch(
        `textures.${kind}.pixels`,
        difference,
        null,
        {
          maximumLsb: tolerance.textureMaximumLsb,
          maximumDifferentFraction:
            tolerance.textureMaximumDifferentFraction,
        },
      );
    }
  }

  return {
    schemaVersion: "mandelhowl.baker-semantic-diff.v1",
    equivalent: mismatchCount === 0,
    algorithmRevision: algorithm.algorithmRevision,
    algorithmContractSha256: algorithm.contractSha256,
    compatibility: {
      leftManifestRevision: leftRevision,
      rightManifestRevision: rightRevision,
      leftGenerator: leftManifest.generator,
      rightGenerator: rightManifest.generator,
      leftDatasetId: leftManifest.datasetId,
      rightDatasetId: rightManifest.datasetId,
      leftManifestSha256: leftManifest.manifestSha256,
      rightManifestSha256: rightManifest.manifestSha256,
      legacyManifestRevisionAssumed:
        leftRevision === null || rightRevision === null,
    },
    metrics: {
      modeCount,
      modesByteIdentical,
      leftModesSha256,
      rightModesSha256,
      responseSampleCount: responseCount,
      maximumModeFrequencyRelative,
      maximumModeScalarAbsolute,
      maximumResponseFrequencyRelative,
      maximumResponseComponentAbsolute,
      maximumSolverEvidenceRelative,
      maximumSolverEvidenceAbsolute,
      maximumSolverModeCoefficientL2Relative,
      minimumSolverModeModalAssuranceCriterion,
      maximumMeshEvidenceRelative,
      maximumMeshEvidenceAbsolute,
      maximumMeshNodeAbsoluteM,
      meshNodeCount: Math.min(leftMesh.nodeCount, rightMesh.nodeCount),
      meshTriangleCount: Math.min(
        leftMesh.triangleCount,
        rightMesh.triangleCount,
      ),
      meshEvidenceFingerprintsEqual,
      meshPolicy: meshPolicyReport,
      materialSectionProfile: materialSectionProfileReport,
      plateSpec: plateReport,
      convergenceReport,
      coverageReport,
      scientificProvenance: scientificProvenanceReport,
      field: fieldDifference,
      textures: textureMetrics,
    },
    mismatchCount,
    mismatches,
  };
}

export function compareDatasetsSafely(options) {
  try {
    return compareDatasets(options);
  } catch (error) {
    return {
      schemaVersion: "mandelhowl.baker-semantic-diff.v1",
      equivalent: false,
      mismatchCount: 1,
      mismatches: [
        {
          path: "dataset",
          left: null,
          right: null,
          tolerance: "valid finite scientific dataset",
          error: error instanceof Error ? error.message : String(error),
        },
      ],
      comparatorError: error instanceof Error ? error.message : String(error),
    };
  }
}
