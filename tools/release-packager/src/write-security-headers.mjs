import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  assertSecurityHeadersPolicy,
  SECURITY_HEADERS_POLICY,
} from "./security-headers-policy.mjs";

const projectRoot = path.resolve(process.cwd());
const outputPath = path.join(projectRoot, "public", "_headers");

if (process.argv.includes("--check")) {
  const actual = await readFile(outputPath, "utf8");
  assertSecurityHeadersPolicy(actual);
  process.stdout.write("Security headers are current.\n");
} else {
  await writeFile(outputPath, SECURITY_HEADERS_POLICY, "utf8");
  process.stdout.write(`${outputPath}\n`);
}
