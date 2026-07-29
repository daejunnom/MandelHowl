import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
const lockPath = path.join(projectRoot, "package-lock.json");
const outputPath = path.join(
  projectRoot,
  "release",
  "third-party-license-inventory.json",
);
const lock = JSON.parse(await readFile(lockPath, "utf8"));

if (lock.lockfileVersion !== 3 || !lock.packages) {
  throw new Error("A package-lock v3 package inventory is required.");
}

function packageName(packagePath, metadata) {
  if (typeof metadata.name === "string") return metadata.name;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return packagePath.slice(index + marker.length);
}

const localLinkTargets = new Set(
  Object.values(lock.packages)
    .filter(
      (metadata) =>
        metadata?.link === true &&
        typeof metadata.resolved === "string",
    )
    .map((metadata) => metadata.resolved.replaceAll("\\", "/")),
);

const packages = Object.entries(lock.packages)
  .filter(
    ([packagePath, metadata]) =>
      packagePath.includes("node_modules/") &&
      metadata &&
      metadata.link !== true &&
      !localLinkTargets.has(packagePath.replaceAll("\\", "/")),
  )
  .map(([packagePath, metadata]) => {
    if (
      typeof metadata.version !== "string" ||
      typeof metadata.license !== "string"
    ) {
      throw new Error(
        `Dependency lacks version or SPDX license metadata: ${packagePath}`,
      );
    }
    return {
      path: packagePath.replaceAll("\\", "/"),
      name: packageName(packagePath, metadata),
      version: metadata.version,
      license: metadata.license,
      integrity:
        typeof metadata.integrity === "string" ? metadata.integrity : null,
      developmentOnly: metadata.dev === true,
      optional: metadata.optional === true,
      peer: metadata.peer === true,
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path, "en"));

const serialized = `${JSON.stringify(
  {
    schemaVersion: "mandelhowl.third-party-license-inventory.v1",
    source: "package-lock.json",
    packageLockVersion: lock.lockfileVersion,
    packageCount: packages.length,
    packages,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== serialized) {
    throw new Error(
      "Third-party license inventory is stale. Run npm run licenses:generate.",
    );
  }
  process.stdout.write(`Verified ${packages.length} dependency licenses.\n`);
} else {
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(
    `Wrote ${outputPath} (${packages.length} dependency licenses).\n`,
  );
}
