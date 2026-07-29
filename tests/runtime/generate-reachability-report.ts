import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeModesBinaryV1 } from "../../packages/asset-runtime/src";
import {
  createResonanceState,
  searchReachabilityCoverage,
  type RuntimeModalDataset,
} from "../../packages/resonance-engine/src";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const modesPath = option("--modes");
let dataset: RuntimeModalDataset;
if (modesPath) {
  const bytes = readFileSync(resolve(process.cwd(), modesPath));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const modes = decodeModesBinaryV1(bytes);
  const maximumModalCoupling = Math.max(
    Number.EPSILON,
    ...modes.map((mode) =>
      Math.abs(mode.actuatorCoupling * mode.microphoneCoupling),
    ),
  );
  dataset = Object.freeze({
    datasetId: `sha256:${digest}`,
    modalModelId: `sha256:${digest}`,
    frequencyRangeHz: Object.freeze([45, 6000] as const),
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
const outputPath = resolve(
  process.cwd(),
  option("--output") ??
    "tests/runtime/fixtures/reachability-report.json",
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");

if (!result.report.replayVerified || !result.report.staticDistribution.passed) {
  throw new Error(
    `Coverage failed: missing=${result.report.missingValues.join(",")} extremeFraction=${result.report.staticDistribution.extremeFraction}`,
  );
}

process.stdout.write(
  `Wrote ${outputPath}; attempts=${result.attempts}, traces=${result.report.traces.length}\n`,
);
