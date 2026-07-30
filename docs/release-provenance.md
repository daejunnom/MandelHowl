# MandelHowl release provenance

릴리스는 clean 웹 source commit과 불변 physics dataset ID를 하나의 증거
레코드로 고정한다. 사람이 편집하는 유일한 pin은
`specs/runtime/dataset-release.v1.yaml`이고, 생성된 TypeScript projection이
dataset ID, source directory, manifest·modal model SHA-256을 그대로
투영한다. `release/dataset-lock.json`은 파일 배포에 필요한 dataset ID,
source directory, manifest SHA-256만 투영하며, release verifier가 YAML과
projection의 modal model ID를 manifest의 `modes.bin` SHA-256에 직접
결속한다. 문서에 hash를 복제하지 않아 pin 교체 시 서로 다른 진실이 생기지
않게 한다.

`npm run build`의 prebuild 단계는 원본 dataset을 `public/runtime/`에 stage하고
다음 `mandelhowl.release-provenance.v4` 레코드를 생성한다.

- 정확한 `webCommit`과 commit timestamp
- ignored 파일을 제외한 untracked 파일까지 포함한 source tree의 dirty 여부
- dataset ID, manifest·plate spec SHA-256
- solver 이름·버전·옵션·실행 환경 evidence
- embedded-only WebGL shader allowlist, 정확히 컴파일되는 vertex/fragment
  source SHA-256, renderer와 동기 SHA-256 verifier source digest
- package lock, license, third-party notices, complete transitive SPDX
  inventory, security headers digest
- `mandelhowl.ui-nversion.v1` spec과 Svelte entry/full-scene source,
  React entry/full-scene source, framework-neutral supervisor와 route host의
  SHA-256
- UI primary `svelte5`, standby `react` 선택 정책
- `mandelhowl.handoff-verification.v1` acceptance contract의 경로·SHA-256과
  그 contract가 고정한 `MandelHowl_핸드오프.md`,
  `MandelHowl_파일_구조.md`의 경로·SHA-256
- `mandelhowl.baker-algorithm.v1` revision과 파일 raw SHA-256
- `specs/physics/baker-nversion.v1.json`에 고정한 Rust primary, Python
  standard-library standby fail-operational 정책과 policy raw SHA-256
- algorithm spec, broker, Python/Rust 구현, Cargo manifest/lock, 고정 Rust
  toolchain, native 검증 workflow를 포함하는 정렬된 source inventory와
  단일 SHA-256
- Node 버전, build command, worker entrypoint

stage 과정은 manifest-relative 경로를 보존하며 원본과 staged 파일의 byte
length와 SHA-256을 다시 비교한다. `latest` 같은 가변 별칭은 릴리스 증거에
사용하지 않는다.

물리 baker는 같은 versioned 알고리즘 계약을 독립 구현한 Rust native와 Python
standard-library 두 버전으로 구성한다. 정상 승격 시 Rust 결과를 선택하지만,
새 결과의 승격과 release eligibility는 두 구현이 모두 성공하고 semantic
differential이 equivalent일 때만 허용한다. 한 구현의 availability failure는
생존 구현으로 degraded 동작할 수 있으나 승격·릴리스는 금지한다. scientific
rejection이나 불일치는 split-brain으로 처리하고 last-known-good dataset을
보존한다.

KTX2 container는 공개 Khronos 사양을 구현하지만 Khronos 코드나 바이너리를
복사하지 않는다. Release Baker는 격리된 Linux OCI envelope에서 실행하며,
manifest의 `executionKind: oci-container`와 실제 inspect image ID는 committed
container runner/envelope attestation과 정확히 일치해야 한다. 별도 재빌드가
같은 image ID를 만든다고 가정하지 않는다.

## Gate

```bash
npm run handoff:check
npm run physics:validate
npm run build
npm run release:verify -- --require-clean
npm run release:verify:attested
npm run release:archive
npm run release:archive:check
npm run handoff:verify -- \
  --report <handoff-verification-report.json>
```

`release:verify`는 canonical dataset release YAML·생성 projection·dataset
lock을 staged manifest 및 `modes.bin` hash에 직접 결속하고, 모든 runtime
asset, source input digest, UI N-version policy·일곱 source digest, security
header, clean-tree provenance, Baker N-version source inventory digest에 더해
whole-handoff acceptance contract, 핸드오프 원문과 파일 구조 기준의 digest를
다시 검사한다. 또한 `specs/visual/webgl-shader-allowlist.v1.json`의
compile constant로 실제 embedded shader template을 다시 조립하고 두 source
SHA-256을 검증한 뒤, allowlist·renderer·runtime hasher digest가 provenance와
같은지 확인한다. shader URL이나 runtime fetch는 허용되지 않는다.
provenance의 plate spec·solver evidence는 manifest와 같아야 하고, commit
timestamp와 npm build command·worker entrypoint·Node engine/version 정책도
현재 검증 환경과 일치해야 한다. `--require-clean`은 tracked 변경뿐 아니라
non-ignored untracked source도
거부한다. 어느 UI/Baker source나 supervisor, toolchain, native workflow,
acceptance contract, 핸드오프 원문 또는 파일 구조 기준이 provenance 생성 뒤
바뀌면 release를 거부한다.

`handoff:check`는 핸드오프 원문과 파일 구조 기준의 exact digest를 먼저
검사하고, acceptance contract가 503개 bullet·ordered·narrative·blockquote·
table-row·code-flow 규범 의무, 모든 번호 heading, 16.1–16.5 validation,
A0–G0 구현 gate, NUI0–NUI3·M1–M3 확장 gate와 완료 품질 18개를 빠짐없이
suite/evidence에 연결하는지 정적으로 검사한다.
`handoff:verify`는 contract/type/lint/Svelte/Baker/security/unit/web/
integration/science/build/SSR/E2E/visual/performance suite를 각각 독립 stage로
실행·기록한 뒤, committed OCI evidence를 사용하는 attested clean release와
deterministic archive 생성·byte-identical 재검사를 순서대로 실행한다.
Windows에서는 Cargo, Rust PE,
`physics:validate:strict`를 실행하지 않는다. fmt·clippy·Rust unit·strict
validation과 fresh dual generation은 선행 Linux CI job이 담당한다. 기본은
clean tree이며 `--allow-dirty`는 개발 진단용으로만 허용되고 clean release
증거가 아니다. 실행 결과는 선택적으로
`mandelhowl.handoff-verification-report.v1` JSON에 기록한다.

`--pinned-nversion-attestation`은 외부 경로를 받지 않는다.
`release/dataset-lock.json`에서
`release/attestations/<dataset-id-hex>/attestation.json`을 계산하고
promotion-time OCI bundle을 검증한다. report는 `dual-verified`, 두 backend
`success`, semantic `equivalent`, `promotionAllowed`와 `releaseEligible`,
Rust 선택, 현재 algorithm revision/raw digest 일치, 실행한 native binary의
pre-run·post-run SHA-256 불변성과 Python interpreter SHA-256 기록을 모두
만족해야 한다. report와 각 backend output의 identity도
각각 `rust-native`, `python-stdlib`이어야 하고, comparison에 기록된 실제
generator는 각각 `tools/physics-baker-rs`, `tools/physics-baker`이어야 한다.
두 candidate 전체 복사본, container runner/envelope hash, Linux/amd64,
격리 설정, inspect image ID, manifest의 OCI digest, current source tree까지
다시 확인한다. 이 옵션을 생략한 일반 로컬 검증은 asset/source 검증만
수행하며 attested release라고 주장하지 않는다.

provenance의 `attestationScope`는 현재 versioned release에서 반드시
`dataset-bound`이다. versioned dataset의
strict report는 `selectedDataset`, Rust output의 `datasetId`·`datasetPath`와
manifest SHA-256, comparison의 left candidate identity를 staged Rust
manifest와 정확히 결속한다. Python output의 ID·path basename·manifest
SHA-256은 comparison의 right candidate와 서로 일치하고 올바른 SHA-256
형식이어야 하지만, 독립 generator provenance가 dataset identity에 포함되므로
Rust/staged ID와 같을 필요는 없다. 이 규칙으로 다른 Rust selected dataset의
dual-pass report를 재사용할 수 없다.

GitHub CI의 `native-baker-nversion` Linux job만 Cargo build와 native binary
실행을 담당한다. 이 job은 fmt, clippy, Rust unit, strict validate와 fresh
dual generation을 품질 gate로 실행하고 별도 quality artifact를 남긴다.
Windows job은 이 선행 job의 성공을 요구하지만 release identity로는
promotion 시점에 커밋된 OCI bundle만 사용한다.
`full-verification` Windows job은 이 job의 성공을 기다리되 quality artifact를
다운로드하거나 실행하지 않는다. `handoff:verify` 전체 gate는 커밋된
promotion-time OCI bundle만 attestation으로 검증하고 별도의 whole-handoff
report artifact를 남긴다.
Windows 기본 `npm run verify`와 release verifier는 Cargo를 실행하거나 native
binary를 spawn하지 않는다. 이에 따라 Application Control 4551에 노출되는
실행 표면은 Linux native gate 및 사용자가 명시적으로 실행하는
`baker:rust:*`, `baker:nversion:*`, `physics:validate*` 명령으로 제한된다.
Playwright의 visual/e2e/performance 로컬 서버도
`MANDELHOWL_PORTABLE_BROWSER_TEST_SERVER=1`로 순수 vinext/Vite 경로를
선택해 workerd/Miniflare를 spawn하지 않는다. 배포 build에서는 이 플래그를
설정하지 않으므로 Cloudflare plugin, Worker entry, binding 계약이 그대로
적용된다.

현재 pin은 manifest revision·raw algorithm evidence가
`kirchhoff-love-c1-finite-strip-r2` 계약과 일치하고, promotion-time OCI
bundle의 Rust candidate와 byte-for-byte 같은 dataset만 허용한다. verifier의
legacy compatibility 분기는 과거 자산의 정직한 진단을 위해 남아 있지만
attested release gate에서는 `implementation-only-legacy`를 성공으로
인정하지 않는다.

UI source digest는 두 view의 release 구성을 증명하지만, shared TypeScript
runtime·CSS·renderer/audio·hosting bootstrap이라는 공통-mode를 독립 배포로
바꾸지는 않는다.
staged `checksums.json`의 모든 row는 실제 파일과 byte length/SHA-256이
일치해야 하며, 반대로 release wrapper를 제외한 staged dataset payload도
빠짐없이 checksum inventory에 존재해야 한다. manifest가 직접 참조하는
payload는 checksum row와 같은 길이·digest를 가져야 한다.
`release:archive`는 고정 inventory 순서·mtime·권한으로 ZIP을 만들고,
`release:archive:check`가 같은 source에서 byte-identical artifact가 나오는지
확인한다. 배포할 commit은 이 검증에 사용한 commit과 같아야 한다.
