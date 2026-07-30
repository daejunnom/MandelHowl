# MandelHowl acceptance matrix

기준 문서: `MandelHowl_핸드오프.md`

최종 감사일: 2026-07-30

고정 dataset은 `release/dataset-lock.json`이 가리키는 content-addressed
production pin을 기준으로 검증한다.

`PASS`는 구현뿐 아니라 저장소의 자동 검증 증거가 있는 경우만 사용한다. 상세
파일·수치·표현 한계는 `docs/handoff-coverage.md`에 기록한다.

## 완료 품질 기준

| # | 완료 조건 | 자동 검증 증거 | 상태 |
|---:|---|---|---|
| 1 | 첫 화면의 인과관계 | presentation contract + 9-state actual-renderer visual regression | PASS |
| 2 | 입력은 다이얼 하나 | pointer/touch/keyboard/wheel E2E + control inventory | PASS |
| 3 | 출력은 0..100 정수 하나 | runtime snapshot contract + SSR/E2E | PASS |
| 4 | 안정 입력 대부분이 0/100 | coverage uniform sweep, extremes `100%` | PASS |
| 5 | 모든 1..99 도달 가능 | 101 traces + independent runtime replay | PASS |
| 6 | 난수·값별 runtime lookup 없음 | forbidden-runtime scan + offline reachability-tool boundary + deterministic replay | PASS |
| 7 | Chladni 무늬가 해석 자산에 연결 | 48-mode/4-layer shard/coordinate/checksum + lazy top-K/temporal framebuffer tests | PASS |
| 8 | 만델브로가 판 물성에 반영 | field→thickness→solver provenance + science validation | PASS |
| 9 | 모래와 만델브로를 혼동하지 않음 | copy contract + separated asset provenance | PASS |
| 10 | 가상 100과 실제 음량 분리 | independent gain envelope + offline peak/RMS sweep | PASS |
| 11 | 실제 마이크 권한 없음 | virtual coupling + forbidden API scan | PASS |
| 12 | 동일 trace 결정성 | fixed-step replay across frame cadence/pause/resume | PASS |
| 13 | 렌더 품질이 볼륨에 무관 | actual WebGL2/Canvas2D core-result equivalence E2E | PASS |
| 14 | 완전한 dataset provenance | schema/hash/solver/mesh/convergence/coverage validator | PASS |
| 15 | 근거 있는 진단 | corrupt pin/manifest/texture/audio capability fixtures | PASS |
| 16 | 입력 접근성 의미 일치 | ARIA slider, keyboard, touch/pointer history E2E | PASS |
| 17 | reduced motion 의미 유지 | semantic E2E + reduced-motion golden | PASS |
| 18 | 장시간 자원 누적 없음 | 1-hour buffer identity + browser soak/lifecycle | PASS |

## 구현 단계 게이트

| 단계 | 통과 조건 | 상태 |
|---|---|---|
| A0 | 사양·계약·단위·진단 코드와 generated config drift 검사 | PASS |
| A1 | dial unit/trace/replay/input-adapter | PASS |
| A2 | feedback·measurement·limiter·frame-rate·pause | PASS |
| B0 | 물성장·제조성·질량 보고서 | PASS |
| B1 | discretization·solver adapter·mode normalization | PASS — C1 cubic-Hermite annular finite-strip 요소로 Kirchhoff–Love K/M을 조립하고 hub value/slope DOF 제거, 자연 자유 외곽, 단위 modal mass를 검증 |
| B2 | convergence·MAC·독립 참조·provenance | PASS |
| C0 | coupling·response·nodal mask·normal/sand texture | PASS |
| C1 | content-addressed manifest·binary·KTX2 scheme 3·checksum와 embedded shader allowlist·source SHA-256 | PASS |
| D0 | WebGL2 top-4·Canvas2D top-2 합성, 원형 변위 메시, grains, WebGL 스피커·마이크·방향성 cable mesh와 Canvas/CSS fallback, capture/residual temporal E2E | PASS |
| D1 | 같은 canonical state·sequence를 hot reusable lease(render/audio)와 owned immutable projection(DOM/challenge/diagnostics)으로 fanout; GPU top-K residency/eviction | PASS |
| D2 | user gesture·audio chain·peak/RMS·lifecycle·fail-closed | PASS |
| E0 | 0/100 분포와 1..99 reachability/replay | PASS |
| E1 | 상태 전환·비팅·잔향·reduced-motion·1 frame/50 ms/250 ms 표현 회귀 | PASS |
| F0 | asset·embedded shader integrity/capability 진단과 접근성 fallback E2E | PASS |
| F1 | unit·science·integration·E2E·visual·soak 전체 suite | PASS |
| G0 | release pin·provenance v4·shader source binding·strict dataset-bound attestation·licenses·headers·archive | PASS |
| NUI0 | full-scene Svelte 5 primary + React 19 standby가 같은 UI port·single dial·single result·ARIA contract 구현 | PASS — Svelte check + React/Svelte presentation inventory + production mount E2E |
| NUI1 | 두 view가 공통 dial-input mapping과 canonical runtime을 사용하고 같은 gesture 결과 생성 | PASS — input contract unit + forced React/Svelte differential E2E |
| NUI2 | availability fault에서 session state를 보존하며 세대·중복 입력을 막고 one-way failover | PASS — supervisor unit + load/mount/active-view/attached-renderer fault E2E |
| NUI3 | digest mismatch 격리, 근거 진단, hidden heartbeat와 두 구현/supervisor/host source provenance | PASS — `MH-UI-*` unit + release provenance v4 verifier |
| M1 | 같은 `baker-algorithm.v1`을 독립 구현한 Rust native/Python stdlib 전체 generator | PASS — 격리된 Linux/amd64 OCI full-generation differential과 committed candidate bundle |
| M2 | Rust primary, availability-only Python degraded fallback, scientific split-brain/LKG 정책 | PASS — broker policy/process/semantic-diff tests |
| M3 | 4551 구조화, Linux/OCI-only native 실행, committed OCI bundle과 provenance v4 release binding | PASS — no-native Windows plan + envelope mutation tests + release verifier |

## 최종 gate

```bash
npm run verify
npm run release:verify:attested
npm run handoff:verify
npm run release:archive
npm run release:archive:check
```

`physics:validate`·Rust fmt·clippy·unit·`physics:validate:strict`·fresh dual
generation은 Linux CI/OCI gate에서만 실행한다. Windows final gate는
dataset lock으로 선택한
`release/attestations/<dataset-id-hex>/`의 full candidate/envelope evidence를
검증하며 Cargo나 Rust PE를 실행하지 않는다.

개별 결과를 강제하는 값별 분기나 lookup table, 검증되지 않은 dataset의
프로덕션 승격, 실제 마이크 입력은 release blocker다.

Svelte 5 full scene은 primary로, 같은 계약의 React 19 full scene은 standby로
프로덕션 host에 연결됐다. NUI0–NUI3의 `PASS`는 framework view availability,
세션 연속성, 입력 exactly-once 경계와 provenance를 뜻한다. 두 구현은 같은
TypeScript scientific runtime, renderer/audio, dataset, CSS, supervisor와
hosting bootstrap을 공유한다. 이는 의도된 UI 계층 N-version 범위이며,
과학 알고리즘의 독립 검증은 Rust/Python baker N-version이 담당한다.
shared contract digest mismatch는 자동 fallback하지 않고
split-brain으로 격리한다. 활성 view의 연결된 renderer가 실패하면 standby로
바로 교체하지 않고 WebGL→Canvas2D로 먼저 복구한다. attachment 전체가
unavailable할 때만 standby로 전환하며, 모든 view가 실패하면 정적 fatal
상태와 함께 오디오를 suspend한다.

`response.bin`은 aggregate frequency-response table 계약으로 로드·해시
검증·디코드·보간된다. canonical per-mode 적분기는 같은 dataset의 modal
coefficients를 직접 사용하므로 aggregate table을 다시 모달 힘으로 중복
적용하지 않는다.

M1 strict full-generation attestation은 두 backend 성공, `dual-verified`,
`mismatchCount = 0`, semantic equivalence, 실행 바이너리·인터프리터
불변 digest와 선택 dataset 결속을 검사한다. field, 네 종류의 decoded KTX2
scheme-3 4-layer shard 48개와 mesh는 exact 비교하고 나머지 수치는 versioned
계약의 허용오차로 비교한다.

atlas는 scheme-3으로 압축된 종류별 12개 4-layer shard를 manifest 순서로
정의한다. core/evidence `ready`는 texture를 0 byte로 유지하고, 현재 top-K와
포획 전 대역의 최근접 mode shard만 요청 시 hash·KTX2 검증한다. WebGL은
종류별 5-shard bounded cache와 top-K residency planner로 필요한 layer만 GPU
slot에 올리고 교체 시 결정적으로 evict하며, Canvas fallback은 sand만
3-shard bounded cache에서 같은 canonical selection을 읽는다.

완료 기준 18은 주파수 정렬 window와 nonzero residual 집합만 갱신하는 최대
12개 활성 모드 culling, runtime·dial·resonance·render·audio hot-path 고정
버퍼, 장시간 identity/자원 누적 검사, frame-pressure p95 예산과 사양 순서의
one-way 6단계 품질 governor를 함께 검증한다.
