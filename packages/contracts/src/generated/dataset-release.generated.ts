/**
 * GENERATED PROMOTION PROJECTION — edit specs/runtime/dataset-release.v1.yaml
 * and run node packages/contracts/scripts/generate-runtime-specs.mjs.
 *
 * This file contains only the promoted dataset pin. Scientific/runtime source
 * attestations exclude this exact generated path to avoid a circular identity
 * dependency while continuing to bind runtime-specs.generated.ts.
 */
import type { DatasetReleaseSpec } from "../runtime-config";

export const DATASET_RELEASE_SOURCE_SHA256 = "1b1a6d9235d1c59ce66f5ca8ac9e2f6dde0b2f10edabe66365bd24fb235ce551";

export const GENERATED_DATASET_RELEASE_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.dataset-release.v1",
  "canonicalOwner": {
    "path": "specs/runtime/dataset-release.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "manifestUrl": "/runtime/manifest.json",
  "datasetId": "sha256:92d15f158419992bee4289328d8529f1cd8fdda82a4fbe2a6ba139200b28b19d",
  "manifestSha256": "16f0d8a00dfd7ef06b5fda9dade5b79114f22afc1298d48d10f7f234bcb94bb3",
  "modalModelId": "sha256:639f487e3b5ab92f23afed4fc8887017af30c4ee399e13a096d004a526c07c28",
  "sourceDirectory": "assets/generated/92d15f158419992bee4289328d8529f1cd8fdda82a4fbe2a6ba139200b28b19d",
  "loadingPolicy": "verified-before-activation-with-analytical-fallback"
} as const) satisfies DatasetReleaseSpec;
