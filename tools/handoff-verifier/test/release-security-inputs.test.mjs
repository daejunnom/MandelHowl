import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertReleaseInputBindings,
  collectReleaseInputDigests,
  RELEASE_INPUT_PATHS,
} from "../../release-packager/src/release-input-bindings.mjs";
import {
  assertSecurityHeadersPolicy,
  SECURITY_HEADERS_POLICY,
} from "../../release-packager/src/security-headers-policy.mjs";

function releaseInputFixture() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "mandelhowl-release-inputs-"),
  );
  for (const { path: relativePath } of RELEASE_INPUT_PATHS) {
    const target = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      relativePath === "public/_headers"
        ? SECURITY_HEADERS_POLICY
        : `fixture:${relativePath}\n`,
      "utf8",
    );
  }
  return root;
}

test("release CSP rejects directive, permission, and cache-policy mutations", () => {
  const policy = assertSecurityHeadersPolicy(SECURITY_HEADERS_POLICY);
  assert.equal(policy.contentSecurityPolicy, "closed-self-origin");
  assert.deepEqual(policy.permissions, {
    camera: false,
    geolocation: false,
    microphone: false,
    payment: false,
    usb: false,
  });
  for (const mutation of [
    SECURITY_HEADERS_POLICY.replace("connect-src 'self'", "connect-src *"),
    SECURITY_HEADERS_POLICY.replace(
      "camera=(), geolocation=(), microphone=()",
      "camera=(self), geolocation=(), microphone=(self)",
    ),
    SECURITY_HEADERS_POLICY.replace(
      "public, max-age=31536000, immutable",
      "public, max-age=60",
    ),
  ]) {
    assert.notEqual(mutation, SECURITY_HEADERS_POLICY);
    assert.throws(
      () => assertSecurityHeadersPolicy(mutation),
      /exact release policy/u,
    );
  }
});

test("release verifier rejects license inventory, security-header, and provenance digest mutations", async () => {
  const root = releaseInputFixture();
  try {
    const baseline = await collectReleaseInputDigests(root);
    assert.deepEqual(
      assertReleaseInputBindings({
        provenanceInputs: baseline,
        actualDigests: baseline,
      }),
      baseline,
    );

    const inventoryPath = path.join(
      root,
      "release",
      "third-party-license-inventory.json",
    );
    writeFileSync(inventoryPath, "mutated-license-inventory\n", "utf8");
    const changedLicenseInputs = await collectReleaseInputDigests(root);
    assert.throws(
      () =>
        assertReleaseInputBindings({
          provenanceInputs: baseline,
          actualDigests: changedLicenseInputs,
        }),
      /third-party-license-inventory\.json/u,
    );

    writeFileSync(
      inventoryPath,
      "fixture:release/third-party-license-inventory.json\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "public", "_headers"),
      SECURITY_HEADERS_POLICY.replace(
        "object-src 'none'",
        "object-src 'self'",
      ),
      "utf8",
    );
    const changedHeaderInputs = await collectReleaseInputDigests(root);
    assert.throws(
      () =>
        assertReleaseInputBindings({
          provenanceInputs: baseline,
          actualDigests: changedHeaderInputs,
        }),
      /public\/_headers/u,
    );

    const forgedProvenance = {
      ...baseline,
      licenseSha256: "0".repeat(64),
    };
    assert.throws(
      () =>
        assertReleaseInputBindings({
          provenanceInputs: forgedProvenance,
          actualDigests: baseline,
        }),
      /LICENSE/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
