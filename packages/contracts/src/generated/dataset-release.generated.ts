/**
 * GENERATED PROMOTION PROJECTION — edit specs/runtime/dataset-release.v1.yaml
 * and run node packages/contracts/scripts/generate-runtime-specs.mjs.
 *
 * This file contains only the promoted dataset pin. Scientific/runtime source
 * attestations exclude this exact generated path to avoid a circular identity
 * dependency while continuing to bind runtime-specs.generated.ts.
 */
import type { DatasetReleaseSpec } from "../runtime-config";

export const DATASET_RELEASE_SOURCE_SHA256 = "532a6614f705fe68cfeca06d6a0b4df8fa3e76e9725d66c0010e60e1301bf371";

export const GENERATED_DATASET_RELEASE_SPEC = Object.freeze({
  "schemaVersion": "mandelhowl.dataset-release.v1",
  "canonicalOwner": {
    "path": "specs/runtime/dataset-release.v1.yaml",
    "policy": "edit-source-regenerate-derived"
  },
  "manifestUrl": "/runtime/manifest.json",
  "datasetId": "sha256:a958193dbe4468f353db6c0973eda5b78181ae878689bfdd4b65afd683a2d9d7",
  "manifestSha256": "165da94c3d75b2d204bc0c003838fe7e63adeba50c0f9921da92a6f6f50e336f",
  "modalModelId": "sha256:639f487e3b5ab92f23afed4fc8887017af30c4ee399e13a096d004a526c07c28",
  "sourceDirectory": "assets/generated/a958193dbe4468f353db6c0973eda5b78181ae878689bfdd4b65afd683a2d9d7",
  "loadingPolicy": "verified-before-activation-with-analytical-fallback"
} as const) satisfies DatasetReleaseSpec;
