# Svelte 5 및 Rust native 이전 경계

## 결정

이번 변경에서 제거한 것은 검증된 과학 알고리즘이 아니라 구현체 결합이다.
thin-plate 모델, TypeScript fixed-step 공진 엔진, content-addressed dataset,
WebGL/Canvas 합성 및 오디오 안전 체인은 프레임워크와 baker 언어가 바뀌어도
동일한 계약으로 유지한다.

## 브라우저 UI 경계

React 앱 디렉터리에 있던 snapshot fanout, challenge host, health hook을
`packages/browser-runtime`으로 이동했다. 이 패키지는 React나 Next를 import하지
않고 다음 경계를 제공한다.

- `RuntimeSnapshotStore`: 구독 즉시 현재 owned snapshot을 전달하는
  Svelte-readable 호환 store
- `MandelHowlBrowserRuntimePort`: plate mount, dial command, audio activation,
  dispose의 최소 UI 포트
- reusable lease: renderer와 audio만 같은 RAF 안에서 동기 소비
- owned snapshot: React 또는 Svelte presentation만 보관·구독

`apps/svelte-prototype`은 Svelte 5 runes와 callback event를 사용해 동일한
snapshot store, oscilloscope presenter, `.mh-*` CSS 및 ARIA slider 계약을
소비한다. 현재 프로덕션 route는 아직 React이며 이 수직 slice는
`npm run svelte:check`에서 오류와 경고를 모두 차단하는 compile-only
경계다. `MandelHowlBrowserRuntimePort`의 production orchestration adapter,
pointer gesture, mount smoke는 아직 없으므로 실행 가능한 Svelte 앱 또는
완료된 framework migration으로 주장하지 않는다.

전체 shell 이전은 route metadata, authentication, fixtures, visual baseline과
Sites worker entry까지 같은 동작 계약으로 옮기고 기존 ADR의 JavaScript/CPU/
dial-to-paint 성능 게이트 중 하나를 만족한 뒤 진행한다.

## Rust native baker 경계

루트 Cargo workspace와 `tools/physics-baker-rs`를 추가했다. 현재 Rust
구현체는 Python 및 TypeScript와 독립적으로 `modes-v1`, `response-v1`의
header, 길이, 유한값, 주파수 순서, 각주파수 관계, damping 및 sign 계약을
검증한다.

`npm run physics:validate`는 Python oracle의 전체 dataset 검증 뒤 Rust
validator를 같은 pinned dataset에 실행하고 manifest의 mode 수·첫/마지막 ID와
response sample 수를 대조한다. 새 native 실행 파일을 Windows application
control이 차단하는 host에서는 Python 검증과 Rust compile/clippy gate를
통과시킨 뒤 native parity를 명시적으로 `SKIPPED`로 기록한다.
`npm run physics:validate:strict`는 이 skip을 허용하지 않으며
policy-compatible CI/release host에서 사용한다.

Rust CLI의 `generate`는 아직 의도적으로 실패한다. field → linear algebra/
solver → postprocess/KTX2 → packaging을 순서대로 이식하고 차등 검증하기 전에
성공한 generator처럼 표시하지 않는다.

Python과 Rust provenance가 다르므로 두 backend의 전체 `datasetId`가 같다고
주장하지 않는다. 대신 mode ID/order/layer/sign, 수치 허용오차, MAC/직교성,
complex response, decoded KTX pixel 및 backend별 반복 실행 결정성을 비교한다.
Python은 generator 기본값에서 제거된 뒤에도 독립 검증 oracle로 남긴다.

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
