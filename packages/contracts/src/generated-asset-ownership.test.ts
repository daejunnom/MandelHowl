import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  manifestIdentityPayload,
} from "../../asset-runtime/src";
import {
  BAKER_REQUIRED_PATHS,
  BAKER_SOURCE_ROOTS,
  digestBakerSourceInventory,
} from "../../../tools/baker-supervisor/src/source-tree.mjs";
import type { ResonanceManifest } from "./resonance-manifest";

interface DatasetLock {
  readonly datasetId: `sha256:${string}`;
  readonly datasetDirectory: string;
  readonly manifestSha256: string;
}

interface DatasetProvenance {
  readonly canonicalInput: {
    readonly canonicalJsonSha256: string;
    readonly path: string;
    readonly plateId: string;
  };
  readonly generator: {
    readonly name: string;
    readonly randomSource: string;
  };
}

interface CanonicalPlateProjection {
  readonly canonicalOwner: {
    readonly path: string;
    readonly policy: string;
  };
  readonly plateId: string;
}

const workspace = process.cwd();
const lock = JSON.parse(
  readFileSync(resolve(workspace, "release/dataset-lock.json"), "utf8"),
) as DatasetLock;
const datasetRoot = resolve(workspace, lock.datasetDirectory);
const manifestBytes = readFileSync(resolve(datasetRoot, "manifest.json"));
const manifest = JSON.parse(
  manifestBytes.toString("utf8"),
) as ResonanceManifest;
const provenance = JSON.parse(
  readFileSync(resolve(datasetRoot, manifest.files.provenance.path), "utf8"),
) as DatasetProvenance;
const plateSpecBytes = readFileSync(
  resolve(datasetRoot, manifest.files.plateSpec.path),
);
const plateSpec = JSON.parse(
  plateSpecBytes.toString("utf8"),
) as CanonicalPlateProjection;

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("generated scientific asset ownership", () => {
  it("marks the baked package immutable and points every plate derivative back to the editable canonical specification", () => {
    expect(manifest.ownership).toEqual({
      kind: "generated",
      generator: expect.stringMatching(
        /^tools\/physics-baker(?:-rs)?$/,
      ),
      policy: "immutable-regenerate",
    });
    expect(plateSpec.canonicalOwner).toEqual({
      path: "specs/plate/mandelbrot-plate.v1.yaml",
      policy: "edit-source-regenerate-derived",
    });
    expect(provenance.canonicalInput).toEqual({
      canonicalJsonSha256: manifest.plate.specSha256,
      path: plateSpec.canonicalOwner.path,
      plateId: plateSpec.plateId,
    });
    expect(manifest.files.plateSpec.sha256).toBe(
      manifest.plate.specSha256,
    );
    expect(sha256(plateSpecBytes)).toBe(
      manifest.files.plateSpec.sha256,
    );
    expect(provenance.generator.name).toBe(
      manifest.ownership.generator,
    );
    expect(provenance.generator.randomSource).toBe("forbidden");
  });

  it("includes canonical specs and both independent generators in the source identity so source edits require a new bake", () => {
    expect(BAKER_REQUIRED_PATHS).toEqual(
      expect.arrayContaining([
        "specs/physics/baker-algorithm.v1.json",
        "specs/plate/mandelbrot-plate.v1.yaml",
        "tools/physics-baker/bake.py",
        "tools/physics-baker-rs/Cargo.toml",
      ]),
    );
    expect(BAKER_SOURCE_ROOTS).toEqual(
      expect.arrayContaining([
        "specs/physics",
        "specs/plate",
        "tools/physics-baker",
        "tools/physics-baker-rs",
      ]),
    );

    const inventory = [
      {
        path: "specs/physics/baker-algorithm.v1.json",
        sha256: "1".repeat(64),
      },
      {
        path: "specs/plate/mandelbrot-plate.v1.yaml",
        sha256: "2".repeat(64),
      },
      {
        path: "tools/physics-baker/bake.py",
        sha256: "3".repeat(64),
      },
      {
        path: "tools/physics-baker-rs/Cargo.toml",
        sha256: "4".repeat(64),
      },
    ];
    const baseline = digestBakerSourceInventory(inventory);
    for (const sourcePath of inventory.map(({ path }) => path)) {
      const mutated = inventory.map((entry) =>
        entry.path === sourcePath
          ? { ...entry, sha256: "f".repeat(64) }
          : entry,
      );
      expect(
        digestBakerSourceInventory(mutated).sourceTreeSha256,
        sourcePath,
      ).not.toBe(baseline.sourceTreeSha256);
    }
  });

  it("rejects direct generated-byte edits and changes identity when a regenerated descriptor changes", () => {
    expect(sha256(manifestBytes)).toBe(lock.manifestSha256);
    expect(manifest.datasetId).toBe(lock.datasetId);
    const canonicalIdentity = sha256(
      canonicalizeJson(manifestIdentityPayload(manifest)),
    );
    expect(manifest.datasetId).toBe(`sha256:${canonicalIdentity}`);

    const modesPath = resolve(datasetRoot, manifest.files.modes.path);
    const modesBytes = readFileSync(modesPath);
    expect(sha256(modesBytes)).toBe(manifest.files.modes.sha256);
    const editedModes = Uint8Array.from(modesBytes);
    const mutationIndex = Math.floor(editedModes.length / 2);
    editedModes[mutationIndex] =
      (editedModes[mutationIndex] ?? 0) ^ 1;
    const editedModesSha256 = sha256(editedModes);
    expect(editedModesSha256).not.toBe(manifest.files.modes.sha256);

    const regeneratedManifest = structuredClone(manifest) as unknown as {
      files: { modes: { sha256: string } };
    };
    regeneratedManifest.files.modes.sha256 = editedModesSha256;
    const regeneratedIdentity = sha256(
      canonicalizeJson(
        manifestIdentityPayload(
          regeneratedManifest as unknown as ResonanceManifest,
        ),
      ),
    );
    expect(regeneratedIdentity).not.toBe(canonicalIdentity);
    expect(`sha256:${regeneratedIdentity}`).not.toBe(manifest.datasetId);
  });
});
