# Svelte 5 UI N-version 및 Rust native 경계

## 결정

이번 변경에서 제거한 것은 검증된 과학 알고리즘이 아니라 구현체 결합이다.
thin-plate 모델, TypeScript fixed-step 공진 엔진, content-addressed dataset,
WebGL/Canvas 합성 및 오디오 안전 체인은 프레임워크와 baker 언어가 바뀌어도
동일한 계약으로 유지한다.

## 브라우저 UI N-version 경계

프로덕션 UI는 `specs/runtime/ui-nversion.v1.json`을 canonical 선택 정책으로
사용한다. `apps/svelte-ui`가 primary이고 `apps/react-ui`가 standby다. 두
구현은 각각 완전한 장면, pointer·keyboard·wheel 다이얼, 접근성 의미와
계측기를 렌더하지만, 물리·다이얼·오디오·dataset·renderer 알고리즘은
재구현하지 않는다.

`packages/browser-runtime`은 다음 공통 경계를 소유한다.

- `MandelHowlBrowserRuntimePort`: canonical snapshot, presentation snapshot,
  plate attachment, dial command와 audio activation만 제공한다.
- `MandelHowlBrowserSessionOwner`: runtime·audio·dataset lifecycle의 유일한
  dispose capability다. 어느 UI view에도 전달하지 않는다.
- `UiNVersionSupervisor`: Svelte 5 primary의 load, mount, readiness와
  committed-snapshot heartbeat를 감독하고 확인된 availability failure에만
  React standby를 한 번 활성화한다.
- generation-scoped input lease: 이전 view의 명령을 거부하고 canonical
  `(event type, timestamp)` identity의 중복 replay를 세대 사이에서도 막는다.
- reusable lease: renderer와 audio만 같은 RAF 안에서 동기 소비한다.
- owned snapshot: UI, challenge와 diagnostics가 보관·구독한다.

Svelte load·mount·readiness·heartbeat·view failure는 이전 view resource만
detach한 뒤 같은 browser session과 snapshot sequence를 React에 넘긴다.
자동 fail-back이나 반복 전환은 없고, hidden document에서는 heartbeat
deadline을 중지한다. 반대로 두 구현의 scientific algorithm digest 또는
presentation contract digest가 다르면 availability 문제가 아니므로
`MH-UI-SPLIT-BRAIN`으로 둘 다 격리하며 임의의 한쪽을 선택하지 않는다.
활성 view에 연결된 plate renderer의 context/texture/render failure는 먼저
같은 attachment의 WebGL→Canvas fail-operational 경계에서 복구한다. Canvas
생성까지 실패하거나 attachment 자체가 unavailable일 때만 view-local
availability failure로 전달된다. 두 view가 모두 실패하면 host는 정적 fatal
상태를 남기고 safe audio engine을 suspend한다.

이 N-version은 framework presentation availability를 보호한다. 두 UI는 같은
TypeScript runtime, UI port, supervisor, dial-input mapping, presentation
model, CSS, renderer/audio 및 하나의 React/Vinext route·hosting bootstrap을
공유한다.
따라서 잘못된 canonical snapshot, shared runtime·CSS·host 오류, 브라우저
엔진·네트워크 전체 장애를 독립적으로 교정하는 두 번째 과학 런타임이나
독립 배포가 아니다. 그런 공통-mode 실패는 기존 dataset fail-closed,
WebGL→Canvas, audio mute 및 정적 fatal 진단 경계에서 처리한다.

## Rust native baker 경계

`specs/physics/baker-algorithm.v1.json`은 두 독립 구현의 공통 알고리즘
revision, binary64/fast-math 금지, 반복·합산 순서, ties-to-even 양자화와
semantic 허용오차를 고정한다. `tools/physics-baker-rs`와
`tools/physics-baker`는 각각 field → basis/assembly/eigensolver →
coupling/response → postprocess/4종×12개 4-layer KTX2 shard →
mesh/evidence → packaging 전체를 독립 구현한다. 어느 구현도 다른 구현의
executable이나 소스 함수를 호출하지 않는다.

`tools/baker-supervisor`의 정책은 다음과 같다.

- 두 candidate가 모두 성공하고 semantic comparator가 합의할 때만 Rust를
  primary로 선택하며 promotion/release를 허용한다.
- Rust executable missing/timeout/Application Control `4551` 같은 availability
  failure에서는 Python을 degraded fallback으로 선택할 수 있지만 promotion과
  release는 금지한다.
- scientific rejection 또는 semantic mismatch는 availability fallback이
  아니라 split-brain이다. 두 새 candidate를 모두 거부하고
  `release/dataset-lock.json`의 검증된 last-known-good를 유지한다.

운영 경로는
`tools/physics-baker-rs/bin/<platform>-<arch>/mandelhowl-baker-native[.exe]`
한 파일만 실행한다. `cargo run/test`나 `target/` 탐색은 운영 표면에 포함하지
않는다. managed CI/installer만 승인된 절대 경로와 SHA-256의 단일 executable을
주입할 수 있다. Cargo fmt/clippy/test/build와 strict native validation은
Linux CI/OCI 품질 gate에서만 실행한다. Windows whole verifier는 dataset
lock에서 선택한 `release/attestations/<dataset-id-hex>/`의 promotion-time
OCI bundle을 검증하며 Cargo나 로컬 Rust PE를 만들거나 실행하지 않는다.

모든 broker command의 `--report-file`은 terminal text를 scraping하지 않아도
backend status/duration, native binary SHA-256, algorithm revision/raw digest,
semantic metrics, degraded/split-brain 상태와 promotion/release eligibility를
검증할 수 있는 machine-readable attestation을 쓴다. release verifier는
committed strict OCI `generate` bundle의 두 candidate 전체와 container
runner/envelope를 다시 검사하고, Rust candidate identity·manifest·image ID를
현재 pin에 정확히 결속한다. Linux CI의 fresh native bundle은 구현 품질
gate이며 promotion identity로 재사용하지 않는다.

## Strict full-generation 증거

promotion-time Linux/amd64 OCI 실행은 다음 결과를
`release/attestations/<dataset-id>/`에 전체 candidate와 함께 기록한다.

| 항목 | 필수 결과 |
|---|---|
| supervisor | `dual-verified`, `mismatchCount = 0` |
| source | 고정 source-tree digest, network 없는 read-only envelope |
| field | exact |
| texture | displacement·normal·nodal·sand 48개 shard의 decoded pixel 비교 |
| mesh | node/evidence exact |

모드·응답·solver/report 수치는 아래 versioned 허용오차를 적용한다. 이번 strict
증거에서는 이 범위를 벗어난 차이가 하나도 없었다.

| 비교 | 허용오차 |
|---|---:|
| mode frequency relative | `1e-9` |
| mode scalar absolute | `1e-10` |
| response frequency relative | `1e-12` |
| response component absolute | `2e-10` |
| solver evidence relative / absolute | `2e-9` / `2e-10` |
| mesh evidence relative / absolute | `2e-9` / `2e-12` |
| mesh node absolute | `3e-8 m` |
| report scalar relative / absolute | `2e-9` / `2e-10` |
| texture | 최대 `1 LSB`, different fraction `1e-4` |
| field | 최대 `1 LSB` |

이 증거는 두 구현과 알고리즘 계약의 동등성뿐 아니라 exact Rust candidate,
manifest digest와 release pin의 동일성을 dataset-bound attestation으로
증명한다. Windows whole verifier는 native executable을 다시 만들거나
실행하지 않고 이 committed bundle의 inventory, source tree, OCI image와
현재 pin을 fail-closed로 재검증한다.

## 이번 UX 보정과 알고리즘 경계

- 오실로스코프는 물리 샘플을 수정하지 않고 framework-neutral presenter의
  표시 복사본만 auto-range한다. 화면에는 gain 배율을 명시하고 RMS/PEAK는
  물리 계측값으로 유지한다.
- 다이얼의 입력 기능이 없던 중앙 장식 cap을 제거해 주파수 문자열을 가리지
  않게 했다.
- 오디오 최대 gain slew를 `40 dB/s`로 조정해 `-100 → -20 dB` 최악 전이를
  2초로 제한한다. output ceiling, limiters, exposure guard는 그대로다.
- 모래 density·modal residual은 바꾸지 않고 presence의 표시 transfer,
  색 대비, grain contact shadow와 plate sheen만 조정했다.
