import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
const outputPath = path.join(projectRoot, "public", "_headers");
const expected = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN

/runtime/*
  Cache-Control: public, max-age=31536000, immutable

/runtime/manifest.json
  Cache-Control: no-cache, max-age=0, must-revalidate

/runtime/release-provenance.json
  Cache-Control: no-cache, max-age=0, must-revalidate
`;

if (process.argv.includes("--check")) {
  const actual = await readFile(outputPath, "utf8");
  if (actual !== expected) {
    throw new Error("public/_headers has drifted from the release policy.");
  }
  process.stdout.write("Security headers are current.\n");
} else {
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(`${outputPath}\n`);
}
