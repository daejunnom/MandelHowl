# MandelHowl release provenance

릴리스는 clean 웹 source commit과 불변 physics dataset ID를 하나의 증거 레코드로
고정한다. 현재 dataset pin은 `release/dataset-lock.json`의 다음 값이다.

```text
dataset ID
sha256:d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98

manifest SHA-256
50e0df50dbd64b17324d62197bb53750a2bb9cd7bb69a9d918bb75e75ebc90ad
```

`npm run build`의 prebuild 단계는 원본 dataset을 `public/runtime/`에 stage하고
다음 `mandelhowl.release-provenance.v3` 레코드를 생성한다.

- 정확한 `webCommit`과 commit timestamp
- ignored 파일을 제외한 untracked 파일까지 포함한 source tree의 dirty 여부
- dataset ID, manifest·plate spec SHA-256
- solver 이름·버전·옵션·실행 환경 evidence
- package lock, license, third-party notices, complete transitive SPDX
  inventory, security headers digest
- `mandelhowl.ui-nversion.v1` spec과 Svelte entry/full-scene source,
  React entry/full-scene source, framework-neutral supervisor와 route host의
  SHA-256
- UI primary `svelte5`, standby `react` 선택 정책
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
복사하지 않는다. 현재 실행이 containerized되지 않았다는 사실과 sentinel
digest를 provenance에 그대로 기록하며, 이를 실제 container image 실행
증거로 해석하지 않는다.

## Gate

```bash
npm run physics:validate
npm run build
npm run release:verify -- --require-clean
npm run release:verify:attested -- <broker-generate-report.json>
npm run release:archive
npm run release:archive:check
```

`release:verify`는 dataset lock, staged manifest와 모든 runtime asset, source
input digest, UI N-version policy·일곱 source digest, security header,
clean-tree provenance, Baker N-version source inventory digest를 다시
검사한다. `--require-clean`은 tracked 변경뿐 아니라 non-ignored untracked
source도 거부한다. 어느 UI/Baker source나 supervisor, toolchain, native
workflow가 provenance 생성 뒤 바뀌면 release를 거부한다.

`--nversion-attestation <path>`는 broker의 `generate --strict --report-file
<path>` 결과를 별도 증거로 검증한다. report는 `dual-verified`, 두 backend
`success`, semantic `equivalent`, `promotionAllowed`와 `releaseEligible`,
Rust 선택, 현재 algorithm revision/raw digest 일치, 실행한 native binary의
pre-run·post-run SHA-256 불변성과 Python interpreter SHA-256 기록을 모두
만족해야 한다. report와 각 backend output의 identity도
각각 `rust-native`, `python-stdlib`이어야 하고, comparison에 기록된 실제
generator는 각각 `tools/physics-baker-rs`, `tools/physics-baker`이어야 한다.
이 옵션을 생략한 일반 로컬 검증은 asset/source 검증만 수행하며 attested
release라고 주장하지 않는다. provenance 자체도 외부 report를 내장하거나
attested라고 표시하지 않는다.

provenance의 `attestationScope`는 versioned dataset이면 `dataset-bound`,
아래 legacy pin이면 `implementation-only-legacy`이다. versioned dataset의
strict report는 `selectedDataset`, Rust output의 `datasetId`·`datasetPath`와
manifest SHA-256, comparison의 left candidate identity를 staged Rust
manifest와 정확히 결속한다. Python output의 ID·path basename·manifest
SHA-256은 comparison의 right candidate와 서로 일치하고 올바른 SHA-256
형식이어야 하지만, 독립 generator provenance가 dataset identity에 포함되므로
Rust/staged ID와 같을 필요는 없다. 이 규칙으로 다른 Rust selected dataset의
dual-pass report를 재사용할 수 없다.

GitHub CI의 `native-baker-nversion` Linux job만 Cargo build와 native binary
실행을 담당한다. 이 job은 strict full generation 종료 후
`baker-nversion-report.json` 하나만 artifact로 전달한다.
`full-verification` Windows job은 이 job에 의존하고 artifact를 workspace
밖의 runner temp에 내려받은 다음 `release:verify:attested`로 검증한다.
Windows 기본 `npm run verify`와 release verifier는 Cargo를 실행하거나 native
binary를 spawn하지 않는다. 이에 따라 Application Control 4551에 노출되는
실행 표면은 Linux native gate 및 사용자가 명시적으로 실행하는
`baker:rust:*`, `baker:nversion:*`, `physics:validate*` 명령으로 제한된다.

현재 고정 dataset
`sha256:d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98`
manifest는 `algorithmRevision` 도입 전 형식이다. 따라서 v3는 이를
`legacy-unversioned-pinned-dataset`, `contractBound: false`로 명시하고
계속 검증하지만, 현재 알고리즘 계약으로 재생성되었다고 소급 주장하지 않는다.
legacy dataset과 함께 새 N-version report를 검사하더라도 성공 문구와 scope는
`Baker implementation attestation`, `implementation-only-legacy`로 제한된다.
report는 두 구현과 현재 계약의 합의만 증명하며 legacy dataset의 재생성
증거는 아니다. 새로 승격할 dataset은 manifest revision·raw evidence가 현재
계약과 일치하고 dataset-bound 검사를 통과해야 한다.

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
