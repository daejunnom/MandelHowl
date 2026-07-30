# MandelHowl 현재 파일 구조

## 1. 구조 전제

이 문서는 2026-07-30 현재 저장소에 실제로 존재하는 source와 contract를
기준으로 한다. 초기 예상안의 단일 web app, pnpm workspace, Web Components,
외부 FEM adapter 같은 가정은 현재 구현이 아니므로 포함하지 않는다.

- 웹 host: npm, Vinext/Vite, React 19 route bootstrap
- UI N-version: Svelte 5 primary, React 19 cold standby
- 브라우저 hot path: TypeScript fixed-step runtime, WebGL2/Canvas2D, Web Audio
- 오프라인 물리: Rust native primary와 Python stdlib standby의 독립 baker
- 배포: Cloudflare worker/hosting 설정과 content-addressed runtime dataset
- 검증: Vitest, Playwright, Python unittest, baker differential, release 및
  whole-handoff verifier
- 핵심 입력/출력: 하나의 `DRIVE FREQUENCY` 다이얼과 하나의 정수
  `VOLUME 000..100`

브라우저는 PDE나 입자 물리를 다시 풀지 않는다. 두 baker가 미리 계산한 모드와
KTX2 atlas를 검증한 뒤, canonical runtime snapshot의 현재 모달 상태만
합성한다.

## 2. 실제 source tree

아래 트리는 반복되는 snapshot 이미지의 파일명만 축약하고, 이름을 적은
source·contract·dataset 경로는 모두 현재 저장소에 존재한다.

```text
MandelHowl/
├─ .github/
│  └─ workflows/
│     └─ verify.yml
├─ .openai/
│  └─ hosting.json
├─ app/
│  ├─ page.tsx
│  ├─ layout.tsx
│  ├─ globals.css
│  ├─ mandelhowl-lab.tsx
│  ├─ mandelhowl-scene.tsx
│  ├─ mandelhowl-ui-host.tsx
│  ├─ mandelhowl.css
│  ├─ chatgpt-auth.ts
│  ├─ audio-safety-fixture/
│  │  ├─ page.tsx
│  │  └─ audio-safety-fixture.tsx
│  └─ visual-fixture/
│     ├─ [state]/page.tsx
│     └─ visual-fixture.tsx
├─ apps/
│  ├─ svelte-ui/
│  │  ├─ src/entry.ts
│  │  ├─ src/MandelHowlApp.svelte
│  │  ├─ README.md
│  │  ├─ svelte.config.js
│  │  └─ tsconfig.json
│  └─ react-ui/
│     ├─ src/entry.tsx
│     ├─ src/MandelHowlReactApp.tsx
│     └─ README.md
├─ assets/
│  └─ generated/
│     └─ <dataset-id>/
│        ├─ manifest.json
│        ├─ checksums.json
│        ├─ plate-spec.json
│        ├─ modes.bin
│        ├─ response.bin
│        ├─ field/mandelbrot-field.bin
│        ├─ mesh/fine-polar-mesh.mhmz
│        ├─ mesh/mesh-evidence.json
│        ├─ textures/
│        │  ├─ signed-displacement-00-03.ktx2 … -44-47.ktx2
│        │  ├─ normal-00-03.ktx2 … -44-47.ktx2
│        │  ├─ nodal-mask-00-03.ktx2 … -44-47.ktx2
│        │  └─ sand-density-00-03.ktx2 … -44-47.ktx2
│        ├─ science/solver-evidence.bin
│        ├─ provenance.json
│        ├─ convergence-report.json
│        ├─ coverage-report.json
│        └─ generation-report.json
├─ docs/
│  ├─ acceptance-matrix.md
│  ├─ handoff-coverage.md
│  ├─ adr-runtime-rendering-and-migration.md
│  ├─ asset-pipeline.md
│  ├─ audio-safety.md
│  ├─ diagnostics.md
│  ├─ feedback-model.md
│  ├─ interaction-contract.md
│  ├─ migration-seams.md
│  ├─ plate-model.md
│  ├─ release-provenance.md
│  └─ scientific-basis.md
├─ packages/
│  ├─ asset-runtime/src/
│  │  ├─ asset-loader.ts
│  │  ├─ binary-decoders.ts
│  │  ├─ canonical-json.ts
│  │  ├─ diagnostics.ts
│  │  ├─ ktx2-validator.ts
│  │  ├─ manifest-validator.ts
│  │  ├─ sha256.ts
│  │  ├─ index.ts
│  │  └─ asset-runtime.test.ts
│  ├─ audio-engine/src/
│  │  ├─ audio-safety-graph.ts
│  │  ├─ audio-safety-math.ts
│  │  ├─ modal-voice-bank.ts
│  │  ├─ offline-audio-safety.ts
│  │  ├─ safe-audio-engine.ts
│  │  ├─ index.ts
│  │  ├─ audio-safety-math.test.ts
│  │  ├─ modal-voice-bank.test.ts
│  │  └─ safe-audio-engine.test.ts
│  ├─ browser-runtime/src/
│  │  ├─ challenge-host.ts
│  │  ├─ dial-input.ts
│  │  ├─ runtime-health.ts
│  │  ├─ runtime-port.ts
│  │  ├─ snapshot-fanout.ts
│  │  ├─ ui-nversion-health.ts
│  │  ├─ ui-nversion-supervisor.ts
│  │  └─ index.ts
│  ├─ contracts/
│  │  ├─ schemas/
│  │  │  ├─ checksums.schema.json
│  │  │  ├─ coverage-report.schema.json
│  │  │  ├─ dataset-release.schema.json
│  │  │  ├─ dial-gesture-trace.schema.json
│  │  │  ├─ plate-spec.schema.json
│  │  │  ├─ resonance-manifest.schema.json
│  │  │  ├─ resonance-trajectory-trace.schema.json
│  │  │  └─ runtime-snapshot.schema.json
│  │  ├─ scripts/generate-runtime-specs.mjs
│  │  └─ src/
│  │     ├─ generated/runtime-specs.generated.ts
│  │     ├─ generated/dataset-release.generated.ts
│  │     ├─ binary-formats.ts
│  │     ├─ contract-metadata.ts
│  │     ├─ coordinate-system.ts
│  │     ├─ diagnostic-record.ts
│  │     ├─ dial-gesture-trace.ts
│  │     ├─ feedback-spec.ts
│  │     ├─ mode-record.ts
│  │     ├─ performance-budget.ts
│  │     ├─ plate-spec.ts
│  │     ├─ resonance-manifest.ts
│  │     ├─ resonance-trajectory.ts
│  │     ├─ runtime-config.ts
│  │     ├─ runtime-snapshot.ts
│  │     ├─ visual-specs.ts
│  │     ├─ index.ts
│  │     ├─ architecture-boundary.test.ts
│  │     ├─ coverage-report-contract.test.ts
│  │     ├─ generated-asset-ownership.test.ts
│  │     ├─ runtime-snapshot-contract.test.ts
│  │     └─ generated/runtime-specs.generated.test.ts
│  ├─ diagnostics/src/
│  │  ├─ diagnostic-presenter.ts
│  │  ├─ runtime-diagnostics.ts
│  │  ├─ runtime-diagnostics.test.ts
│  │  └─ index.ts
│  ├─ dial-engine/src/
│  │  ├─ angular-velocity.ts
│  │  ├─ dial-command.ts
│  │  ├─ dial-engine.ts
│  │  ├─ dial-state.ts
│  │  ├─ end-stop.ts
│  │  ├─ frequency-scale.ts
│  │  ├─ gesture-trace.ts
│  │  ├─ inertia.ts
│  │  ├─ math.ts
│  │  ├─ radial-dead-zone.ts
│  │  ├─ unwrap-angle.ts
│  │  ├─ index.ts
│  │  └─ dial-engine.test.ts
│  ├─ presentation-model/src/
│  │  ├─ causal-motion-presenter.ts
│  │  ├─ instrument-output-presenter.ts
│  │  ├─ oscilloscope-presenter.ts
│  │  ├─ scene-layout-presenter.ts
│  │  ├─ index.ts
│  │  ├─ causal-motion-presenter.test.ts
│  │  ├─ instrument-output-presenter.test.ts
│  │  ├─ oscilloscope-presenter.test.ts
│  │  └─ scene-layout-presenter.test.ts
│  ├─ render-engine/src/
│  │  ├─ plate-renderer.ts
│  │  ├─ webgl-plate-renderer.ts
│  │  ├─ canvas-plate-renderer.ts
│  │  ├─ render-types.ts
│  │  ├─ render-quality-governor.ts
│  │  ├─ shader-integrity.ts
│  │  ├─ texture-layer-residency.ts
│  │  ├─ texture-shard-cache.ts
│  │  ├─ ktx2-texture.ts
│  │  ├─ index.ts
│  │  ├─ render-engine.test.ts
│  │  ├─ render-quality-governor.test.ts
│  │  ├─ texture-layer-residency.test.ts
│  │  └─ texture-shard-cache.test.ts
│  └─ resonance-engine/src/
│     ├─ prototype-dataset.ts
│     ├─ resonance-engine.ts
│     ├─ runtime-engine.ts
│     ├─ index.ts
│     ├─ resonance-engine.test.ts
│     ├─ runtime-compliance.test.ts
│     └─ runtime-snapshot-writer.test.ts
├─ release/
│  ├─ attestations/
│  │  ├─ README.md
│  │  └─ <dataset-id>/
│  │     ├─ attestation.json
│  │     ├─ candidates/{rust,python}/<candidate-id>/
│  │     └─ container-envelope.json
│  ├─ dataset-lock.json
│  └─ third-party-license-inventory.json
├─ specs/
│  ├─ acceptance/handoff-verification.v1.json
│  ├─ challenge/
│  │  ├─ host-contract.v1.json
│  │  └─ sample-targets.v1.json
│  ├─ physics/
│  │  ├─ baker-algorithm.v1.json
│  │  └─ baker-nversion.v1.json
│  ├─ plate/mandelbrot-plate.v1.yaml
│  ├─ runtime/
│  │  ├─ audio-safety.v1.yaml
│  │  ├─ dataset-release.v1.yaml
│  │  ├─ dial.v1.yaml
│  │  ├─ feedback.v1.yaml
│  │  ├─ ui-nversion.v1.json
│  │  └─ volume-map.v1.yaml
│  └─ visual/
│     ├─ motion-safety.v1.yaml
│     ├─ performance-budget.v1.yaml
│     ├─ quality-tiers.v1.yaml
│     ├─ scene.v1.yaml
│     └─ webgl-shader-allowlist.v1.json
├─ tests/
│  ├─ e2e/
│  │  ├─ runtime-ready.ts
│  │  ├─ audio-activation.spec.ts
│  │  ├─ audio-lifecycle.spec.ts
│  │  ├─ audio-safety-offline.spec.ts
│  │  ├─ causal-presentation.spec.ts
│  │  ├─ challenge-host.spec.ts
│  │  ├─ direct-dial-rotation.spec.ts
│  │  ├─ dial-input-modalities.spec.ts
│  │  ├─ keyboard-dial.spec.ts
│  │  ├─ one-input-one-output.spec.ts
│  │  ├─ plate-temporal-transition.spec.ts
│  │  ├─ reduced-motion.spec.ts
│  │  ├─ render-degradation.spec.ts
│  │  ├─ renderer-integrity.spec.ts
│  │  ├─ ui-nversion-failover.spec.ts
│  │  ├─ webgl-apparatus.spec.ts
│  │  └─ webgl-fallback.spec.ts
│  ├─ integration/
│  │  ├─ production-dataset.test.ts
│  │  └─ vitest.config.ts
│  ├─ performance/resource-soak.spec.ts
│  ├─ runtime/
│  │  ├─ generate-reachability-report.ts
│  │  └─ fixtures/reachability-report.json
│  ├─ science/
│  │  ├─ common.py
│  │  ├─ test_convergence_and_response.py
│  │  ├─ test_dataset_integrity.py
│  │  ├─ test_handoff_physics_contract.py
│  │  ├─ test_material_and_mesh.py
│  │  ├─ test_modal_orthogonality.py
│  │  ├─ test_reachability_foundation.py
│  │  └─ test_texture_mode_match.py
│  ├─ visual/
│  │  ├─ mandelhowl-states.spec.ts
│  │  └─ mandelhowl-states.spec.ts-snapshots/
│  ├─ web/
│  │  ├─ challenge-host.test.ts
│  │  ├─ instrument-presentation.test.ts
│  │  ├─ presentation-contract.test.ts
│  │  ├─ runtime-source-policy.test.ts
│  │  ├─ scientific-copy-policy.test.ts
│  │  ├─ snapshot-boundary.test.ts
│  │  ├─ snapshot-fanout.test.ts
│  │  ├─ texture-preview-queue.test.ts
│  │  ├─ ui-input-contract.test.ts
│  │  ├─ ui-nversion-supervisor.test.ts
│  │  └─ vitest.config.ts
│  └─ rendered-html.test.mjs
├─ tools/
│  ├─ baker-supervisor/
│  │  ├─ src/
│  │  │  ├─ attestation-bundle.mjs
│  │  │  ├─ backend-process.mjs
│  │  │  ├─ package-integrity.mjs
│  │  │  ├─ policy.mjs
│  │  │  ├─ semantic-diff.mjs
│  │  │  ├─ source-tree.mjs
│  │  │  └─ supervisor.mjs
│  │  ├─ test/
│  │  └─ README.md
│  ├─ handoff-verifier/
│  │  ├─ src/check-handoff-coverage.mjs
│  │  ├─ src/full-verification-plan.mjs
│  │  ├─ src/run-full-verification.mjs
│  │  ├─ src/verification-core.mjs
│  │  ├─ test/
│  │  │  ├─ full-verification-plan.test.mjs
│  │  │  ├─ release-contract-bindings.test.mjs
│  │  │  ├─ release-security-inputs.test.mjs
│  │  │  ├─ verification-core.test.mjs
│  │  │  └─ webgl-shader-integrity.test.mjs
│  │  └─ README.md
│  ├─ reachability-generator/
│  │  ├─ src/trajectory-coverage.ts
│  │  └─ README.md
│  ├─ container-baker-runner/
│  │  ├─ Dockerfile
│  │  ├─ src/
│  │  ├─ test/
│  │  └─ README.md
│  ├─ physics-baker/
│  │  ├─ bake.py
│  │  ├─ pyproject.toml
│  │  ├─ README.md
│  │  └─ src/mandelhowl_baker/
│  ├─ physics-baker-rs/
│  │  ├─ Cargo.toml
│  │  ├─ README.md
│  │  ├─ bin/README.md
│  │  └─ src/
│  ├─ release-packager/
│  │  ├─ package.json
│  │  └─ src/
│  │     ├─ build-provenance.mjs
│  │     ├─ create-release-archive.mjs
│  │     ├─ generate-license-inventory.mjs
│  │     ├─ runtime-source-policy.mjs
│  │     ├─ stage-runtime-assets.mjs
│  │     ├─ validate-pinned-dataset.mjs
│  │     ├─ pinned-attestation.mjs
│  │     ├─ release-contract-bindings.mjs
│  │     ├─ release-input-bindings.mjs
│  │     ├─ security-headers-policy.mjs
│  │     ├─ webgl-shader-integrity.mjs
│  │     ├─ verify-forbidden-runtime.mjs
│  │     ├─ verify-release.mjs
│  │     └─ write-security-headers.mjs
│  └─ minimatch-legacy-bridge/
│     ├─ index.cjs
│     └─ package.json
├─ worker/index.ts
├─ public/
│  ├─ _headers
│  └─ og.png
├─ .editorconfig
├─ .dockerignore
├─ .gitattributes
├─ .gitignore
├─ .python-version
├─ .tool-versions
├─ Cargo.toml
├─ Cargo.lock
├─ rust-toolchain.toml
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
├─ playwright.config.ts
├─ next.config.ts
├─ svelte.config.js
├─ eslint.config.mjs
├─ postcss.config.mjs
├─ MandelHowl_핸드오프.md
├─ MandelHowl_파일_구조.md
├─ README.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ LICENSE
└─ THIRD_PARTY_NOTICES.md
```

`public/runtime/`, `dist/`, Playwright report와 그 밖의 build output은
source tree가 아니라 stage/test가 만드는 산출물이다. `target/`,
`node_modules/`도 문서 구조와 release source inventory에 포함하지 않는다.

## 3. 브라우저 실행 경계

```text
app/page.tsx
  → app/mandelhowl-lab.tsx
    → 하나의 MandelHowl browser session
      → app/mandelhowl-ui-host.tsx
        → UiNVersionSupervisor
          ├─ Svelte 5 primary view
          └─ React 19 standby view
      → dial/resonance fixed-step runtime
      → verified asset loader
      → renderer + safe audio
```

- `mandelhowl-lab.tsx`가 dataset, runtime, renderer/audio lifecycle의 단일
  owner다.
- `mandelhowl-ui-host.tsx`는 framework view의 load, mount, readiness,
  heartbeat와 one-way failover만 감독한다.
- 두 view는 generation-scoped UI port만 받고 session을 dispose할 수 없다.
- Svelte/React는 같은 dial-input mapping, presentation model, generated visual
  spec, `.mh-*` CSS와 ARIA contract를 소비한다. 이 공유 알고리즘은 의도적인
  canonical 경계이며 별도의 미구현 UI 항목이 아니다.
- renderer/audio는 같은 RAF의 reusable snapshot lease를 동기 소비하고,
  retaining UI/challenge/diagnostics는 최대 24 Hz owned immutable snapshot을
  받는다.

## 4. 런타임·렌더 hot path

- `resonance-engine.ts`는 `1/240 s` fixed step에서 주파수 정렬 인덱스로
  activation bandwidth의 mode와 nonzero residual mode만 모은 뒤, 그
  결정적 합집합에서 상위 최대 12개를 완전 적분한다.
- active indices, score, energy, phase, response, delay/ring buffer는 초기화 때
  할당하고 매 step 재사용한다.
- production RAF는 dial/resonance state를 in-place로 갱신하며
  `RuntimeSnapshotWriter`, modal render blend와 audio voice bank의 고정
  buffer identity를 유지한다.
- WebGL2는 top-4 mode를 실제 polar plate displacement, normal, nodal,
  sand에 합성한다. 종류별 GPU texture array도 네 layer만 resident로 두고
  선택 밖 최저 slot을 결정적으로 교체한다.
- embedded WebGL 프로그램의 별도 apparatus draw pass가 snapshot의
  주파수·시간·feedback envelope·microphone RMS에서 스피커 cone, 압력
  ring과 마이크, 방향성 cable pulse를 그린다. WebGL이 unavailable이면 같은
  위치의 DOM/CSS 장치와 Canvas 판이 전체 apparatus fallback을 이룬다.
- Canvas2D는 verified CPU atlas에서 top-2 sand layer를 합성한다.
- KTX2 scheme 3 decoder는 fixed-Huffman/stored DEFLATE만 동기적으로
  bounded inflate하며 length, range, trailing data와 Adler-32를 검증한다.
  legacy scheme 0은 zero-copy `subarray` 호환 경로다.
- frame-pressure governor는 120-frame p95가 60 FPS budget을 두 window 연속
  초과할 때 다음 one-way 단계를 하나씩 적용한다.

```text
reduce-sand-residual
→ reduce-normal-resolution
→ disable-post-processing
→ reduce-oscilloscope-samples
→ reduce-internal-resolution
→ switch-to-canvas-data
```

이 단계는 presentation work만 바꾸며 canonical simulation snapshot과
`VOLUME`은 바꾸지 않는다.

## 5. canonical ownership

| 계약 source | 주요 소비자 |
|---|---|
| `specs/runtime/dial.v1.yaml` | generated runtime specs, dial engine |
| `specs/runtime/feedback.v1.yaml` | generated runtime specs, resonance engine |
| `specs/runtime/volume-map.v1.yaml` | generated runtime specs, volume projection |
| `specs/runtime/audio-safety.v1.yaml` | generated runtime specs, audio engine |
| `specs/visual/*.v1.yaml` | generated runtime specs, scene/presentation/render |
| `specs/plate/mandelbrot-plate.v1.yaml` | Python/Rust baker |
| `specs/physics/baker-algorithm.v1.json` | Python/Rust algorithm implementation |
| `specs/physics/baker-nversion.v1.json` | broker와 release verifier |
| `specs/runtime/ui-nversion.v1.json` | UI supervisor와 release verifier |
| `specs/acceptance/handoff-verification.v1.json` | handoff verifier와 provenance v4 |
| `release/dataset-lock.json` | stage와 release verifier |

YAML runtime/visual source를 수정한 뒤에는
`npm run contracts:generate`로
`packages/contracts/src/generated/runtime-specs.generated.ts`를 다시 만들고
`npm run contracts:check`로 drift가 없는지 확인한다. generated 파일을
canonical source처럼 직접 수정하지 않는다.

## 6. 오프라인 baker와 release

`tools/physics-baker-rs`와 `tools/physics-baker`는 field, 세 해상도 solve,
48 modes, response, 4종×12개 4-layer KTX2 shard, mesh/evidence와
content-addressed package를 각각 독립 구현한다. `tools/baker-supervisor`는
두 candidate의 source identity와 semantic 결과를 비교한다.

- 두 결과가 합의해야 Rust primary를 승격하고 release할 수 있다.
- Rust missing/timeout/Application Control 4551은 availability failure로
  Python degraded 실행을 허용하지만 새 dataset 승격과 release는 금지한다.
- scientific rejection이나 mismatch는 split-brain이며 last-known-good를
  유지한다.
- 운영 native 실행 표면은 관리되는 플랫폼별 단일 executable 또는 CI가
  주입한 exact absolute binary로 제한한다.

`tools/release-packager`는 dataset을 `public/runtime/`에 stage하고
`mandelhowl.release-provenance.v4`를 생성한다. v4는 source commit, dataset,
UI/Baker N-version source, license/security 입력뿐 아니라 검토한 핸드오프
원문, 이 파일 구조 기준과 whole-handoff acceptance contract의 SHA-256까지
묶는다.

## 7. 검증 진입점

```bash
npm run handoff:check
npm run contracts:check
npm run verify
npm run physics:validate
npm run release:verify -- --require-clean
npm run handoff:verify -- \
  --report <handoff-verification-report.json>
```

- `handoff:check`는 핸드오프 원문·파일 구조 기준의 exact digest와 503개
  bullet·ordered·narrative·blockquote·table-row·code-flow 규범 obligation
  각각의 exact acceptance case, validation, A0–G0,
  NUI0–NUI3, M1–M3, 완료 품질 18개의 실행 증거를 검사한다.
- `verify`는 contract, type/lint, Svelte, broker, security, unit/web/
  integration/science/build/SSR와 browser suite를 실행한다. `handoff:verify`는
  이 각 npm suite를 별도 stage로 실행·기록해 aggregate 성공만으로 누락된
  suite를 숨길 수 없게 한다.
- `handoff:verify`는 dataset lock에서 committed promotion-time OCI
  Rust/Python attestation을 스스로 계산하고 위 구현 gate, pinned physics,
  attested clean release, deterministic archive 생성과 byte-identical
  재검사를 하나의 machine-readable report로 묶는다. Windows에서는 Cargo나
  Rust PE를 생성·실행하지 않는다.
