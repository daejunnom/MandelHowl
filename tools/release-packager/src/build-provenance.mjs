import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(process.cwd());
const manifestPath = path.join(projectRoot, "public", "runtime", "manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

const provenance = {
  schemaVersion: "mandelhowl.release-provenance.v1",
  webCommit: git("rev-parse", "HEAD"),
  webCommitTimestamp: git("show", "-s", "--format=%cI", "HEAD"),
  sourceTreeDirty:
    git("status", "--porcelain", "--untracked-files=no").length > 0,
  datasetId: manifest.datasetId,
  datasetManifestSha256: digest(manifestBytes),
  plateSpecSha256: manifest.plate?.specSha256 ?? null,
  solver: manifest.solverProvenance ?? null,
  inputs: {
    packageLockSha256: digest(
      await readFile(path.join(projectRoot, "package-lock.json")),
    ),
    licenseSha256: digest(
      await readFile(path.join(projectRoot, "LICENSE")),
    ),
    thirdPartyNoticesSha256: digest(
      await readFile(path.join(projectRoot, "THIRD_PARTY_NOTICES.md")),
    ),
    thirdPartyLicenseInventorySha256: digest(
      await readFile(
        path.join(
          projectRoot,
          "release",
          "third-party-license-inventory.json",
        ),
      ),
    ),
    securityHeadersSha256: digest(
      await readFile(path.join(projectRoot, "public", "_headers")),
    ),
  },
  buildContract: {
    packageManager: "npm",
    nodeVersion: process.version,
    buildCommand: "npm run build",
    workerEntrypoint: "dist/server/index.js",
  },
};

await Promise.all([
  copyFile(
    path.join(projectRoot, "LICENSE"),
    path.join(projectRoot, "public", "runtime", "LICENSE.txt"),
  ),
  copyFile(
    path.join(projectRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(
      projectRoot,
      "public",
      "runtime",
      "THIRD_PARTY_NOTICES.md",
    ),
  ),
]);

const serialized = `${JSON.stringify(provenance, null, 2)}\n`;
await writeFile(
  path.join(projectRoot, "public", "runtime", "release-provenance.json"),
  serialized,
  "utf8",
);
process.stdout.write(serialized);
