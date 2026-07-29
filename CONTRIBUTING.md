# Contributing to MandelHowl

## Canonical ownership

Edit human-owned files under `specs/` first. Generated runtime configuration,
physics assets, manifests, reports, and release provenance must be regenerated;
do not patch generated values by hand.

## Required checks

Every change must preserve:

1. one conceptual dial input and one integer volume output;
2. deterministic results for the same dataset and gesture trace;
3. separation between virtual volume and audible gain;
4. actual microphone permission denial;
5. dataset schema, coordinate, and SHA-256 integrity;
6. the absence of value-specific output lookup tables.

Run the repository validation command before proposing a change. Physics
changes must also regenerate convergence, texture-alignment, and reachability
reports. UI changes must preserve keyboard, touch, screen-reader, reduced-motion,
forced-colors, and Canvas fallback behavior.

## Generated assets

Each production dataset lives in `assets/generated/<sha256>/`. A release pins
one immutable dataset directory and stages it under `public/runtime/` during the
build. Never use a mutable `latest` alias in release metadata.
