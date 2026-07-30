import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_INPUT_PATHS = Object.freeze([
  Object.freeze({
    key: "packageLockSha256",
    path: "package-lock.json",
  }),
  Object.freeze({
    key: "licenseSha256",
    path: "LICENSE",
  }),
  Object.freeze({
    key: "thirdPartyNoticesSha256",
    path: "THIRD_PARTY_NOTICES.md",
  }),
  Object.freeze({
    key: "thirdPartyLicenseInventorySha256",
    path: "release/third-party-license-inventory.json",
  }),
  Object.freeze({
    key: "securityHeadersSha256",
    path: "public/_headers",
  }),
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function collectReleaseInputDigests(projectRoot) {
  const entries = await Promise.all(
    RELEASE_INPUT_PATHS.map(async (input) => [
      input.key,
      sha256(await readFile(path.join(projectRoot, input.path))),
    ]),
  );
  return Object.freeze(Object.fromEntries(entries));
}

export function assertReleaseInputBindings({
  provenanceInputs,
  actualDigests,
}) {
  if (
    provenanceInputs === null ||
    typeof provenanceInputs !== "object" ||
    Array.isArray(provenanceInputs) ||
    actualDigests === null ||
    typeof actualDigests !== "object" ||
    Array.isArray(actualDigests)
  ) {
    throw new Error("Release provenance inputs must be closed digest maps.");
  }
  const expectedKeys = RELEASE_INPUT_PATHS.map(({ key }) => key).sort();
  for (const [label, value] of [
    ["provenance", provenanceInputs],
    ["actual", actualDigests],
  ]) {
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(
        `Release ${label} input digest fields are not the closed contract.`,
      );
    }
  }
  for (const { key, path: inputPath } of RELEASE_INPUT_PATHS) {
    const actual = actualDigests[key];
    if (
      typeof actual !== "string" ||
      !/^[a-f0-9]{64}$/u.test(actual) ||
      provenanceInputs[key] !== actual
    ) {
      throw new Error(`Release provenance input mismatch: ${inputPath}`);
    }
  }
  return Object.freeze({ ...actualDigests });
}
