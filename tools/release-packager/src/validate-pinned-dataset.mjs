import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
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

const result = spawnSync(
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
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
