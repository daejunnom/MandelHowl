import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  forbiddenRuntimeReasons,
  isRuntimeSourcePath,
} from "./runtime-source-policy.mjs";
import { verifyWebglShaderIntegrity } from "./webgl-shader-integrity.mjs";

const projectRoot = path.resolve(process.cwd());
const tracked = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "app",
    "apps",
    "packages",
    "worker",
    "specs",
    "public",
  ],
  { cwd: projectRoot, encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .filter(isRuntimeSourcePath);

const failures = [];
let verifiedFiles = 0;
for (const relativePath of tracked) {
  let source;
  try {
    source = await readFile(path.join(projectRoot, relativePath), "utf8");
  } catch (error) {
    // `git ls-files --cached --others` includes tracked paths deleted by a
    // migration until the next commit. They have no runtime source left to
    // inspect; every existing untracked replacement remains in the result.
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  verifiedFiles += 1;
  for (const reason of forbiddenRuntimeReasons(source, relativePath)) {
    failures.push(`${relativePath}: ${reason}`);
  }
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

const shaderIntegrity = verifyWebglShaderIntegrity(projectRoot);
process.stdout.write(
  `Verified ${verifiedFiles} runtime source files and embedded shader program ${shaderIntegrity.program.id}.\n`,
);
