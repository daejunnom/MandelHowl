import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
const requireRust = process.argv.includes("--require-rust");
const lock = JSON.parse(
  readFileSync(
    path.join(projectRoot, "release", "dataset-lock.json"),
    "utf8",
  ),
);
if (
  lock?.schemaVersion !== "mandelhowl.dataset-lock.v1" ||
  typeof lock?.datasetDirectory !== "string"
) {
  throw new Error("release/dataset-lock.json is invalid.");
}
const datasetRoot = path.resolve(projectRoot, lock.datasetDirectory);
const generatedRoot = path.join(projectRoot, "assets", "generated");
const relativeDataset = path.relative(generatedRoot, datasetRoot);
if (
  relativeDataset.startsWith("..") ||
  path.isAbsolute(relativeDataset) ||
  !/^[a-f0-9]{64}$/.test(relativeDataset)
) {
  throw new Error("Pinned dataset must be a hashed child of assets/generated.");
}

const pythonResult = spawnSync(
  process.env.MANDELHOWL_PYTHON ?? "python",
  [
    "tools/physics-baker/bake.py",
    "validate",
    lock.datasetDirectory,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);
if (pythonResult.error) throw pythonResult.error;
if (pythonResult.status !== 0) {
  process.exit(pythonResult.status ?? 1);
}

const manifest = JSON.parse(
  readFileSync(path.join(datasetRoot, "manifest.json"), "utf8"),
);
const referenceTexture = manifest?.files?.textures?.[0];
const modeIds = referenceTexture?.modeIds;
const responseBytes = manifest?.files?.response?.byteLength;
const expectedResponseSamples =
  Number.isInteger(responseBytes) && responseBytes >= 16
    ? (responseBytes - 16) / 24
    : Number.NaN;
if (
  !Number.isInteger(referenceTexture?.layers) ||
  !Array.isArray(modeIds) ||
  modeIds.length !== referenceTexture.layers ||
  !Number.isInteger(expectedResponseSamples) ||
  !Number.isFinite(manifest?.frequencyRange?.minimumHz) ||
  !Number.isFinite(manifest?.frequencyRange?.maximumHz)
) {
  throw new Error("Pinned manifest lacks native parity expectations.");
}

const nativeResult = spawnSync(
  process.env.MANDELHOWL_CARGO ?? "cargo",
  [
    "test",
    "--quiet",
    "--locked",
    "-p",
    "mandelhowl-baker-native",
    "--test",
    "pinned_dataset",
    "--",
    "--ignored",
    "--exact",
    "validates_pinned_dataset",
  ],
  {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MANDELHOWL_PINNED_DATASET: datasetRoot,
      MANDELHOWL_EXPECTED_MODE_COUNT: String(referenceTexture.layers),
      MANDELHOWL_EXPECTED_RESPONSE_COUNT: String(expectedResponseSamples),
      MANDELHOWL_EXPECTED_FIRST_MODE: modeIds[0],
      MANDELHOWL_EXPECTED_LAST_MODE: modeIds.at(-1),
      MANDELHOWL_EXPECTED_MINIMUM_FREQUENCY: String(
        manifest.frequencyRange.minimumHz,
      ),
      MANDELHOWL_EXPECTED_MAXIMUM_FREQUENCY: String(
        manifest.frequencyRange.maximumHz,
      ),
    },
  },
);
if (nativeResult.stdout) process.stdout.write(nativeResult.stdout);
if (nativeResult.stderr) process.stderr.write(nativeResult.stderr);
const nativeFailure = [
  nativeResult.error?.message ?? "",
  nativeResult.stdout ?? "",
  nativeResult.stderr ?? "",
].join("\n");
const blockedByApplicationControl =
  /os error 4551|application control policy|애플리케이션 제어 정책/i.test(
    nativeFailure,
  );
if (nativeResult.error && !blockedByApplicationControl) {
  throw nativeResult.error;
}
if (nativeResult.status !== 0) {
  if (blockedByApplicationControl && !requireRust) {
    process.stderr.write(
      "Rust native binary parity: SKIPPED because this Windows host blocks " +
        "newly built executables. Use `npm run physics:validate:strict` on " +
        "a policy-compatible CI host to require native execution.\n",
    );
    process.exit(0);
  }
  process.exit(nativeResult.status ?? 1);
}
process.stdout.write(
  `Rust native binary parity: ${referenceTexture.layers} modes, ` +
    `${expectedResponseSamples} response samples.\n`,
);
