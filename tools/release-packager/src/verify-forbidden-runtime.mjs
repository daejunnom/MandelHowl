import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(process.cwd());
const tracked = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "app",
    "packages",
    "worker",
    "specs",
    "public",
  ],
  { cwd: projectRoot, encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => /\.(?:ts|tsx|js|mjs|yaml|json)$/.test(file));

const forbidden = [
  {
    pattern: /\bMath\.random\s*\(/,
    reason: "Math.random is forbidden in deterministic runtime source",
  },
  {
    pattern: /\bgetUserMedia\s*\(/,
    reason: "real microphone/camera permission is forbidden",
  },
  {
    pattern: /\bdangerouslySetInnerHTML\b/,
    reason: "external or untrusted HTML injection is forbidden",
  },
  {
    pattern:
      /\b(?:volume|volumeValue|settledVolume)\s*={2,3}\s*(?:[1-9]|[1-9]\d)\b/,
    reason: "per-value runtime output exceptions are forbidden",
  },
  {
    pattern: /\bswitch\s*\([^)]*\b(?:volume|settledVolume)\b[^)]*\)/,
    reason: "per-value runtime output switches are forbidden",
  },
];

const failures = [];
for (const relativePath of tracked) {
  const source = await readFile(path.join(projectRoot, relativePath), "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) {
      failures.push(`${relativePath}: ${rule.reason}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

process.stdout.write(`Verified ${tracked.length} runtime source files.\n`);
