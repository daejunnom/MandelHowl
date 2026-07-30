FROM rust:1.96.0-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc AS native-builder

WORKDIR /workspace

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY specs/physics/baker-algorithm.v1.json specs/physics/baker-algorithm.v1.json
COPY tools/physics-baker-rs/Cargo.toml tools/physics-baker-rs/Cargo.toml
COPY tools/physics-baker-rs/src tools/physics-baker-rs/src

RUN set -eux; \
    RUSTUP_TOOLCHAIN=1.96.0 rustc --version \
      | grep -F "rustc 1.96.0"; \
    RUSTUP_TOOLCHAIN=1.96.0 cargo build --release --locked \
      --package mandelhowl-baker-native \
      --bin mandelhowl-baker-native

FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git python3; \
    rm -rf /var/lib/apt/lists/*; \
    node --version | grep -Fx "v22.19.0"; \
    python3 --version

COPY --from=native-builder /workspace/target/release/mandelhowl-baker-native \
  /opt/mandelhowl/bin/mandelhowl-baker-native

RUN set -eux; \
    chmod 0555 /opt/mandelhowl/bin/mandelhowl-baker-native; \
    sha256sum /opt/mandelhowl/bin/mandelhowl-baker-native \
      | cut -d ' ' -f 1 \
      > /opt/mandelhowl/bin/mandelhowl-baker-native.sha256; \
    chmod 0444 /opt/mandelhowl/bin/mandelhowl-baker-native.sha256; \
    git config --system --add safe.directory /workspace

ENV PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace

COPY .dockerignore package.json Cargo.toml Cargo.lock rust-toolchain.toml /workspace/
COPY .github/workflows /workspace/.github/workflows
COPY assets/generated /workspace/assets/generated
COPY packages/asset-runtime/src /workspace/packages/asset-runtime/src
COPY packages/contracts/schemas /workspace/packages/contracts/schemas
COPY packages/contracts/src /workspace/packages/contracts/src
COPY packages/resonance-engine/src /workspace/packages/resonance-engine/src
COPY packages/render-engine/src /workspace/packages/render-engine/src
COPY release/dataset-lock.json /workspace/release/dataset-lock.json
COPY specs/acceptance /workspace/specs/acceptance
COPY specs/physics /workspace/specs/physics
COPY specs/plate /workspace/specs/plate
COPY specs/runtime /workspace/specs/runtime
COPY specs/visual /workspace/specs/visual
COPY tests/runtime /workspace/tests/runtime
COPY tools/baker-supervisor /workspace/tools/baker-supervisor
COPY tools/container-baker-runner /workspace/tools/container-baker-runner
COPY tools/handoff-verifier /workspace/tools/handoff-verifier
COPY tools/physics-baker /workspace/tools/physics-baker
COPY tools/physics-baker-rs /workspace/tools/physics-baker-rs
COPY tools/reachability-generator /workspace/tools/reachability-generator
COPY tools/release-packager /workspace/tools/release-packager

RUN set -eux; \
    cd /workspace; \
    git init; \
    git add --all

WORKDIR /workspace
USER 65532:65532

CMD ["node", "--version"]
