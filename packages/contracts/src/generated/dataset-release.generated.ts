/**
 * GENERATED PROMOTION PROJECTION — edit specs/runtime/dataset-release.v1.yaml
 * and run node packages/contracts/scripts/generate-runtime-specs.mjs.
 *
 * This file contains only the promoted dataset pin. Scientific/runtime source
 * attestations exclude this exact generated path to avoid a circular identity
 * dependency while continuing to bind runtime-specs.generated.ts.
 */
import type { DatasetReleaseSpec } from "../runtime-config";

export const DATASET_RELEASE_SOURCE_SHA256 = "a8a088dbba352a6c326ed01dfc8268f91dd577f1c3d67b0a13792cf41a65b7d2";

export const GENERATED_DATASET_RELEASE_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.dataset-release.v1",
  "canonicalOwner": {
    "path": "specs/runtime/dataset-release.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "manifestUrl": "/runtime/manifest.json",
  "datasetId": "sha256:09bdf3f7023e677b5ad07cda9b69a67143dd7b589eec7e7dc6395962851b6f38",
  "manifestSha256": "c4e295af1d22d1025ddacf85858efef79a656920f255915e1f6fadc386de36c9",
  "modalModelId": "sha256:639f487e3b5ab92f23afed4fc8887017af30c4ee399e13a096d004a526c07c28",
  "sourceDirectory": "assets/generated/09bdf3f7023e677b5ad07cda9b69a67143dd7b589eec7e7dc6395962851b6f38",
  "loadingPolicy": "verified-before-activation-with-analytical-fallback"
} as const) satisfies DatasetReleaseSpec;
