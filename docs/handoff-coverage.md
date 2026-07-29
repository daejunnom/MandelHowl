# MandelHowl 핸드오프 최종 구현 감사

감사 기준일: 2026-07-30

감사 범위: `MandelHowl_핸드오프.md`, `MandelHowl_파일_구조.md`, 배포 소스,
고정 물리 데이터셋, 자동 검증·릴리스 도구

## 결론

핸드오프의 완료 품질 기준 18개와 구현 단계 A0–G0의 release gate를 구현했다.
15장의 세부 성능 원칙 중 남은 한계는 아래에 별도로 기록한다. 또한
2026-07-30 재감사에서 기존 기준 7·D0의 `PASS` 근거가 충분하지 않았음을
확인했다. 48개 사전 계산 layer가 존재해도 렌더러가 가장 강한 모드 하나만
표시했기 때문이다. 현재 worktree는 이 마지막 연결을 top-K 합성, capture
identity, 결정적 잔류, 원형 변위 메시로 시정했고 관련 unit·web suite와
WebGL2·Canvas2D fixture 및 실제 다이얼 temporal E2E를 통과해 해당 `PASS`를
회복했다.

예상 파일 트리의 이름을 그대로 복제하는 대신 Vinext host 안에
framework-neutral browser session과 Svelte 5 primary/React 19 standby를 두고
같은 책임 경계와 의존성 방향을 유지했다. 브라우저는 PDE나 고유값 문제를 풀지
않고, 다음 content-addressed 프로덕션 데이터셋만 검증 후 사용한다.

```text
dataset ID  sha256:d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98
manifest    sha256:50e0df50dbd64b17324d62197bb53750a2bb9cd7bb69a9d918bb75e75ebc90ad
modes       48
range       45..6000 Hz
```

자산 로딩·무결성·텍스처 업로드가 끝나기 전에는 분석적 fixture 상태를 정확히
표시하고, 어느 검증 단계라도 실패하면 프로덕션 `VERIFIED` 상태로 승격하지
않는다.

## 완료 품질 기준 18개

| # | 상태 | 구현 및 검증 증거 |
|---:|---|---|
| 1 | PASS | Svelte와 React full scene이 스피커→판→가상 마이크→피드백→볼륨을 같은 읽기 순서로 구성한다. `tests/visual/mandelhowl-states.spec.ts`의 9개 실제 렌더 회귀와 cross-framework presentation inventory가 구조를 고정한다. |
| 2 | PASS | 두 UI의 포인터·터치 Pointer Event·키보드·휠이 `packages/browser-runtime/src/dial-input.ts`를 거쳐 같은 `packages/dial-engine` 명령으로 수렴한다. E2E는 어느 UI에도 개념적 조절 입력이 ARIA slider 하나뿐임을 검증한다. |
| 3 | PASS | `RuntimeSnapshot.volume`의 measuring/settled union과 resonance-engine의 유일한 volume mapper가 `000..100` 정수 하나를 소유한다. UI는 측정 중 마지막 확정값을 보존한다. |
| 4 | PASS | 고정 dataset coverage의 균일 정적 입력 중 극단값은 `99.5012%`로 90% 기준을 넘는다. `coverage-report.json`과 science validator가 수치를 독립 재계산한다. |
| 5 | PASS | coverage에는 `0..100` 전부에 대한 101개 재현 trace가 있으며, `1..99`를 포함한 각 결과를 runtime engine으로 독립 replay해 정확히 일치시킨다. |
| 6 | PASS | 코어는 고정 스텝과 전역 피드백 수식만 사용한다. security static 검사에서 난수, 값별 출력 lookup/예외, 실제 입력 장치 API를 금지하고 동일 trace의 결정성도 검증한다. |
| 7 | PASS | 48-layer signed displacement·normal·nodal mask·sand density KTX2가 manifest mode ID와 같은 좌표계를 사용한다. WebGL2는 top 4를 변위·normal·nodal·sand에, Canvas2D는 top 2를 sand에 합성한다. temporal E2E가 새 capture의 다음 paint와 이전 layer 잔류를 실제 framebuffer로 검증한다. |
| 8 | PASS | `mandelbrot-plate.v1.yaml`에서 escape-time field, 최소 특징 필터, 두께 매핑, 질량·무게중심·강성 제약, 얇은 판 고유값 해석으로 이어진다. science tests가 생성물과 사양 hash를 다시 검증한다. |
| 9 | PASS | 물성장과 모래 마디선은 별도 자산이다. 화면·문서·provenance는 만델브로가 두께의 원인임을 설명하며 모래를 만델브로 실루엣이라고 주장하지 않는다. |
| 10 | PASS | 가상 `100`은 audio gain과 독립이다. DC blocker, band limiter, soft clip, RMS/peak 제한, exposure guard를 수식·실제 graph 양쪽에서 고정하며 offline sweep E2E가 peak/RMS ceiling을 검증한다. |
| 11 | PASS | 실제 마이크는 사용하지 않는다. 가상 microphone coupling만 데이터셋과 runtime에 존재하며 forbidden-runtime 검사가 `getUserMedia`·permission 경로를 차단한다. |
| 12 | PASS | dataset ID, 초기 상태, 고정 스텝, gesture trace가 결과를 완전히 결정한다. 단위·통합 검증이 다른 frame cadence, pause/resume, 반복 replay에서 같은 snapshot을 확인한다. |
| 13 | PASS | 렌더러는 snapshot read-only consumer다. `renderer-integrity.spec.ts`가 실제 프로덕션 dataset으로 WebGL2와 Canvas2D의 주파수·볼륨·측정 상태·regime 결과가 완전히 같음을 확인한다. |
| 14 | PASS | manifest는 plate spec, solver·옵션, mesh quality, convergence, 독립 참조, 파일 길이·SHA-256, coordinate system, coverage를 연결한다. dataset loader와 release validator가 모든 pin을 재검증한다. |
| 15 | PASS | diagnostics 패키지는 stable code, severity, evidence state, 사용자 문구, redacted 개발 근거를 분리한다. 손상 manifest, 잘못된 pin, texture upload, WebGL, AudioContext와 UI load/mount/readiness/heartbeat/split-brain fixture가 fail-closed 또는 지정된 failover를 증명한다. |
| 16 | PASS | 두 UI의 다이얼은 `45..6000 Hz` ARIA slider이며 키보드·터치·포인터·휠이 같은 의미를 사용한다. 확정 출력만 별도 polite live region으로 알리고 pointer capture 손실도 종료한다. |
| 17 | PASS | reduced motion은 흔들림·펄스 품질만 줄이고 canonical 상태·숫자·문구를 유지한다. reduced-motion E2E와 실제 renderer golden을 함께 검증한다. |
| 18 | PASS | fixed-size delay/RMS/trace/frame buffers와 재사용 GPU·audio node를 사용한다. 시각 top-K와 48-mode hot snapshot graph도 고정 buffer/writer를 재사용한다. 1시간 가상 실행은 buffer identity를 확인하고, 브라우저 soak와 3회 hide/resume/pagehide E2E는 node·consumer·heap·teardown 상한을 검증한다. 작은 immutable runtime wrapper 할당은 남지만 누적 보유하지 않는다. |

## 구현 단계 A0–G0

| 단계 | 상태 | 완료 증거 |
|---|---|---|
| A0 | PASS | YAML canonical spec→generated TypeScript metadata→contract/schema drift 검사, 단위·범위·진단 코드 고정 |
| A1 | PASS | unwrap, dead zone, sample gap, 속도, 로그 매핑, 관성, end stop, pointer history, gesture record/replay |
| A2 | PASS | `1/240 s` modal integration, feedback delay/filter/gate/soft clip/limiter, RMS 측정, 상태 분류와 finite guard |
| B0 | PASS | 만델브로 물성장, 제조 특징 `2.8125 mm`, 질량 `0.641844 kg`, COM `9.854 mm`, 두께 gradient `0.4137` 검증 |
| B1 | PASS | 판 discretization·품질 검증, 중앙 고정/자유 외곽, 가변 두께 Kirchhoff–Love Rayleigh–Ritz 고유값 해석, 정규화·구조화 오류 |
| B2 | PASS | fine evidence `209,612` nodes/`417,716` triangles, 최대 주파수 변화 `0.0362%`, 최소 MAC `0.999937`, 독립 유한차분 최대 오차 `5.03%` |
| C0 | PASS | actuator/microphone coupling, response, 부호 정규화, displacement·normal·nodal·sand 후처리와 좌표 검사 |
| C1 | PASS | modal/response binary, 4종 KTX2 atlas, content-addressed directory, manifest/checksums/schema 검증 |
| D0 | PASS | WebGL2 top-4 modal atlas 합성, signed-displacement polar disc, 결정적 grains와 Canvas2D top-2 sand 합성. 다음 paint·50 ms·250 ms temporal framebuffer 회귀를 포함한다. |
| D1 | PASS | capability probe, content-hash immutable asset request, 우선순위별 검증 진행 이벤트, fixed-step loop, lifecycle·오류 복구. render/audio는 같은 reusable lease를 매 RAF 동기 소비하고, UI/challenge/diagnostics는 같은 canonical state·sequence의 owned immutable projection을 최대 24 Hz로 받는다. UI view detach와 browser-session dispose가 분리되고 Svelte→React failover에서도 같은 session을 유지한다. |
| D2 | PASS | user gesture activation, modal oscillator bank, 안전 체인, peak/RMS offline audit, visibility fade/suspend, graph 생성 실패와 teardown |
| E0 | PASS | 극단값 `99.5012%`, `0..100` 전체 trace/replay, 전역 파라미터 보정, per-value branch 금지 검사 |
| E1 | PASS | decaying·critical·growing·saturated, burst·beating·reverse reverb, cable circulation, reduced-motion 9-state golden과 실제 capture/residual temporal framebuffer 회귀 |
| F0 | PASS | integrity/capability diagnostics, capability-time WebGL2 unavailable→Canvas2D 선택, runtime context-lost 진단·복구 시도, Audio fail-closed, UI N-version availability/split-brain 진단, 키보드·터치·screen-reader semantics |
| F1 | PASS | TypeScript unit/web/integration, Python science, Rust/Python baker differential, SSR, React/Svelte failover E2E, visual, offline audio, 장시간 resource/performance suite |
| G0 | PASS | dataset lock, clean-tree release provenance v3의 UI/Baker N-version spec·source tree digest와 optional strict attestation verifier, security headers, audit, license notices, deterministic ZIP와 inventory/check |

## 중앙 판 재감사와 시정

재감사 전 코드는 네 종류의 48-layer KTX2를 모두 검증·업로드했지만
`dominantModeId` 하나의 layer만 바인딩했다. `activeModeIndex`도 공진 엔진
내부에는 있었으나 snapshot 경계에서 손실됐고, WebGL 판은 네 정점 quad였다.
따라서 “사전 계산 자산을 사용한다”는 기존 기준 7·D0의 증거만으로는 핸드오프
10.5의 모달 에너지 혼합을 충족했다고 볼 수 없었다.

현재 시정 내용은 다음과 같다.

- `RuntimeSnapshot.activeModeId`가 현재 포획과 과거 에너지 우세를 분리한다.
- WebGL2는 top 4, Canvas2D는 top 2의 사전 계산 sand layer를 혼합한다.
- 새 capture에는 다음 paint용 시각 bias를 주고 이전 모드는 결정적 release로
  남긴다. 이 상태는 물리 에너지·볼륨을 변경하지 않는다.
- WebGL2는 품질 단계별 tessellated polar disc에서 signed displacement를
  실제 정점 위치에 적용한다.
- WebGL2와 Canvas2D 모두 좌표 hash 기반 grains를 사용하며 시간 난수를 쓰지
  않는다.
- temporal fixture는 baseline, 다음 animation frame, 50 ms, 250 ms의 실제
  픽셀 signature를 비교한다.

상수, 수식, 구현체 이전 판단과 검증 명령은
`docs/adr-runtime-rendering-and-migration.md`에 고정한다.

## Critical 범위 보정

요청한 변경은 사양, generated config, runtime, coverage dataset에 함께 반영했다.

- critical loop-margin 반폭: `±0.025`
- 전체 critical 폭: `0.050`
- 포화 우선 판정: `feedbackEnvelope >= 0.92` 유지
- 모드별 잔향/loop 감쇠: `0.68 + |loopMargin| × 1.55` 유지
- 잔류 envelope만으로 critical을 넓히던 보조 판정은 사용하지 않음

따라서 잔향 시간을 줄이지 않고, 실제 loop gain이 임계점에 더 가까운 경우에만
`critical` 상태와 비팅 표현이 나타난다.

## UI N-version 승격

`specs/runtime/ui-nversion.v1.json`은 Svelte 5 primary와 React 19 standby,
세션당 최대 한 번의 one-way failover, 자동 fail-back 금지와 view/session
ownership 분리를 고정한다.

| Gate | 상태 | 자동 증거 |
|---|---|---|
| NUI0 | PASS | 두 full scene의 region·single slider·single integer result·ARIA inventory, Svelte compile, production mount |
| NUI1 | PASS | shared dial-input unit과 forced React/Svelte gesture differential이 같은 canonical frequency를 확인 |
| NUI2 | PASS | supervisor unit과 fault E2E가 load/mount/readiness/heartbeat/view/attached-renderer failure, generation revoke, duplicate rejection과 failover 전후 state continuity 확인 |
| NUI3 | PASS | structured `MH-UI-*` evidence, split-brain quarantine, hidden heartbeat suspension, release provenance v3의 UI spec·candidate·supervisor·host source digest 검증 |

Fail-operational 범위는 framework view availability다. 두 UI는 하나의
TypeScript scientific runtime, dataset loader, renderer/audio graph,
presentation model, CSS, supervisor와 React/Vinext route·Sites bootstrap을
공유한다.
따라서 shared snapshot이나 공통 알고리즘이 잘못된 경우 한 view를 다른 view로
바꾸지 않는다. digest mismatch는 `MH-UI-SPLIT-BRAIN`으로 둘 다 격리하고,
renderer·audio·dataset 오류는 각각 Canvas, safe mute,
`verified-before-activation` 경계를 사용한다.

활성 view가 소유한 plate attachment의 renderer failure는 view availability로
supervisor에 전달된다. Svelte attachment가 실패하면 같은 canonical session의
React standby로 전환하고, 두 view가 모두 unavailable이면 정적 fatal 진단을
남기면서 오디오를 suspend한다. 반면 canonical renderer/runtime/dataset 오류는
공통-mode이므로 framework 전환으로 숨기지 않는다.

## Baker N-version 승격

`specs/physics/baker-algorithm.v1.json`은 Python stdlib과 Rust native가 동일하게
구현할 알고리즘 revision, 부동소수점·반복·양자화 정책과 differential
tolerance를 고정한다. 두 backend는 field, solver, 48 modes/response, 네 KTX2
atlas, mesh/evidence와 package를 서로 호출하지 않고 독립 생성한다.

| Gate | 상태 | 자동 증거 |
|---|---|---|
| M1 | PASS | full strict WSL generation이 `dual-verified`, mismatch 0; Rust `3.041 s`, Python `62.283 s` |
| M2 | PASS | field·네 decoded texture atlas·mesh exact, 나머지 수치가 versioned tolerance 이내 |
| M3 | PASS | availability-only degraded fallback, scientific split-brain/LKG, managed binary·4551 분류·report attestation tests |

Rust가 primary지만 둘의 semantic 합의 없이는 promotion/release할 수 없다.
Rust executable missing/timeout/Application Control `4551`은 Python degraded
fallback을 허용하되 승격하지 않는다. scientific rejection 또는 mismatch는
split-brain이며 검증된 last-known-good만 선택한다. 운영은 관리된
platform/architecture별 단일 executable을 사용하고 Cargo는 개발·Linux CI
gate로 제한한다.

`--report-file`은 backend 상태·시간, native SHA-256, algorithm revision/digest,
semantic metrics와 promotion/release 판정을 저장하며 release verifier가 이를
별도 attestation으로 검증한다. 현재 배포 pin은 `algorithmRevision` 이전
legacy/unversioned dataset이다. N-version strict proof는 구현 동등성을
증명하지만 이 기존 dataset이 현재 계약으로 재생성됐다고 소급 주장하지 않는다.

## 정직한 표현 한계

- 수치 adapter는 가변 두께 Kirchhoff–Love 얇은 판의 Rayleigh–Ritz 해석이다.
  shell FEM이 아니며 데이터셋과 UI 어디에서도 FEM이라고 주장하지 않는다.
  mesh 품질·수렴성·독립 유한차분 교차검증은 포함하지만 공학 인증은 아니다.
- `.ktx2`는 Khronos container와 R8/RG8 texture-array semantics를 따르되 현재
  payload는 이식성을 위한 비압축 형식이다. GPU block compression을 주장하지
  않는다.
- WebGL2는 판 변위·normal·모래 합성을 담당하고, 장면의 스피커·마이크·케이블
  계측은 접근 가능한 DOM/CSS presenter다. 이 분리는 핵심 수치나 인과관계를
  바꾸지 않는다.
- 화면의 `VOLUME`과 마이크는 가상 모델이다. 실제 제작판의 음압, 실제 입자
  운동, 공간 음향, 운영체제 음량을 측정하거나 보증하지 않는다.
- `response.bin`은 검증·디코딩되어 런타임 dataset에 보존되고 로그 주파수
  complex 보간도 제공한다. 다만 v1은 전 모드 aggregate이므로 모드별 공진
  적분에 대입하지 않는다. 해당 변경은 response-v2와 coverage 재생성이
  필요하다.
- loader는 modes→response→sand 우선 검증과 자산별 진행 이벤트를 제공하며,
  sand는 최종 승격 전에 GPU prewarm한다. 그러나 전체 dataset이 `ready`가
  되기 전 runtime이나 화면을 `VERIFIED`로 승격하지 않는다.
- 고정 atlas-v1은 종류별 48 layer가 한 파일이므로 per-mode/range lazy
  fetch·eviction은 지원하지 않는다. 현재는 core→sand prewarm→나머지 atlas
  순서이며, 세분화에는 atlas-v2와 새 dataset content hash가 필요하다.
- reusable writer는 매 RAF의 48-mode snapshot graph 할당을 제거하지만
  immutable runtime-state wrapper와 dial의 작은 임시 객체까지 제거한 것은
  아니다. soak 기준의 비누적 자원 계약은 통과한다.
- 고정 적분기는 현재 예산이 작은 48개 mode를 모두 순회한다. inactive-mode
  active-set/culling은 구현하지 않았다.
- 렌더 품질은 startup hardware tier와 reduced-motion/forced-colors에서
  선택한다. runtime frame-pressure 기반 자동 `60→30 FPS` 전환과 핸드오프
  15.3의 전체 degradation ladder는 구현하지 않았다. 현재 기기 예산 통과와
  물리 결과 불변은 soak/performance suite로 검증한다.
- Svelte primary와 React standby는 각각 full production view지만 공통 runtime,
  CSS, renderer/audio, supervisor와 hosting bootstrap을 사용한다. UI
  N-version을 독립 scientific runtime이나 독립 배포로 주장하지 않는다.
- Rust/Python full generator N-version은 오프라인 자산 생성 경계다. 브라우저
  TypeScript runtime의 두 번째 scientific implementation이나 Rust/WASM
  runtime을 뜻하지 않는다.

이 한계들은 미구현 항목을 문구로 덮은 것이 아니라, 검증된 구현이 주장할 수
있는 범위를 고정한다.
