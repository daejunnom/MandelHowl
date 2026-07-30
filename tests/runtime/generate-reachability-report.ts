import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  decodeModesBinaryV1,
  validateResonanceManifest,
} from "../../packages/asset-runtime/src";
import {
  createResonanceState,
  type RuntimeModalDataset,
} from "../../packages/resonance-engine/src";
import { searchReachabilityCoverage } from "../../tools/reachability-generator/src/trajectory-coverage";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const modesPath = option("--modes");
let dataset: RuntimeModalDataset;
if (modesPath) {
  const manifestOption = option("--manifest");
  if (!manifestOption) {
    throw new Error("--manifest is required whenever --modes is supplied");
  }
  const manifestPath = resolve(process.cwd(), manifestOption);
  const validation = validateResonanceManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  if (!validation.manifest) {
    throw new Error(
      `Invalid manifest: ${validation.diagnostics
        .map(({ code }) => code)
        .join(",")}`,
    );
  }
  const manifest = validation.manifest;
  const resolvedModesPath = resolve(process.cwd(), modesPath);
  const manifestModesPath = resolve(
    dirname(manifestPath),
    manifest.files.modes.path,
  );
  if (resolvedModesPath !== manifestModesPath) {
    throw new Error(
      "--modes must resolve to the modes asset owned by --manifest",
    );
  }
  const bytes = readFileSync(resolvedModesPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.files.modes.sha256) {
    throw new Error(
      `modes.bin SHA-256 mismatch: manifest=${manifest.files.modes.sha256} actual=${digest}`,
    );
  }
  const modes = decodeModesBinaryV1(bytes);
  if (modes.length !== manifest.modeCount) {
    throw new Error(
      `Mode count mismatch: manifest=${manifest.modeCount} actual=${modes.length}`,
    );
  }
  if (
    modes.some(
      ({ naturalFrequencyHz }) =>
        naturalFrequencyHz < manifest.frequencyRange.minimumHz ||
        naturalFrequencyHz > manifest.frequencyRange.maximumHz,
    )
  ) {
    throw new Error("A modal frequency is outside the manifest range");
  }
  const maximumModalCoupling = Math.max(
    Number.EPSILON,
    ...modes.map((mode) =>
      Math.abs(mode.actuatorCoupling * mode.microphoneCoupling),
    ),
  );
  dataset = Object.freeze({
    datasetId: manifest.datasetId,
    modalModelId: `sha256:${digest}`,
    frequencyRangeHz: Object.freeze([
      manifest.frequencyRange.minimumHz,
      manifest.frequencyRange.maximumHz,
    ] as const),
    maximumModalCoupling,
    modes: Object.freeze(
      modes.map((mode) =>
        Object.freeze({
          id: mode.modeId,
          frequencyHz: mode.naturalFrequencyHz,
          dampingRatio: mode.dampingRatio,
          driveCoupling: Math.abs(mode.actuatorCoupling),
          microphoneCoupling: Math.abs(mode.microphoneCoupling),
          phaseOffsetRadians:
            mode.phaseReferenceRad +
            (mode.actuatorCoupling * mode.microphoneCoupling < 0
              ? Math.PI
              : 0),
          radiationEfficiency: mode.radiationEfficiency,
          textureLayer: mode.textureLayer,
        }),
      ),
    ),
  });
} else {
  dataset = createResonanceState().dataset;
}
const result = searchReachabilityCoverage(dataset);
if (!result.report.replayVerified || !result.report.staticDistribution.passed) {
  throw new Error(
    `Coverage failed: missing=${result.report.missingValues.join(",")} extremeFraction=${result.report.staticDistribution.extremeFraction}`,
  );
}
const outputPath = resolve(
  process.cwd(),
  option("--output") ??
    "tests/runtime/fixtures/reachability-report.json",
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");

process.stdout.write(
  `Wrote ${outputPath}; attempts=${result.attempts}, traces=${result.report.traces.length}\n`,
);
