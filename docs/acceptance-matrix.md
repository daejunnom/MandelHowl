# MandelHowl acceptance matrix

기준 문서: `MandelHowl_핸드오프.md`

최종 감사일: 2026-07-30

고정 dataset:
`sha256:d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98`

`PASS`는 구현뿐 아니라 저장소의 자동 검증 증거가 있는 경우만 사용한다. 상세
파일·수치·표현 한계는 `docs/handoff-coverage.md`에 기록한다.

## 완료 품질 기준

| # | 완료 조건 | 자동 검증 증거 | 상태 |
|---:|---|---|---|
| 1 | 첫 화면의 인과관계 | presentation contract + 9-state actual-renderer visual regression | PASS |
| 2 | 입력은 다이얼 하나 | pointer/touch/keyboard/wheel E2E + control inventory | PASS |
| 3 | 출력은 0..100 정수 하나 | runtime snapshot contract + SSR/E2E | PASS |
| 4 | 안정 입력 대부분이 0/100 | coverage uniform sweep, extremes `99.5012%` | PASS |
| 5 | 모든 1..99 도달 가능 | 101 traces + independent runtime replay | PASS |
| 6 | 난수·값별 lookup 없음 | forbidden-runtime scan + deterministic replay | PASS |
| 7 | Chladni 무늬가 해석 자산에 연결 | 48-layer mode/atlas/coordinate/checksum + top-K/temporal framebuffer tests | PASS |
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
| B1 | discretization·solver adapter·mode normalization | PASS |
| B2 | convergence·MAC·독립 참조·provenance | PASS |
| C0 | coupling·response·nodal mask·normal/sand texture | PASS |
| C1 | content-addressed manifest·binary·KTX2·checksum | PASS |
| D0 | WebGL2 top-4·Canvas2D top-2 합성, 원형 변위 메시, grains, capture/residual temporal E2E | PASS |
| D1 | 같은 canonical state·sequence를 hot reusable lease(render/audio)와 owned immutable projection(DOM/challenge/diagnostics)으로 fanout | PASS |
| D2 | user gesture·audio chain·peak/RMS·lifecycle·fail-closed | PASS |
| E0 | 0/100 분포와 1..99 reachability/replay | PASS |
| E1 | 상태 전환·비팅·잔향·reduced-motion·1 frame/50 ms/250 ms 표현 회귀 | PASS |
| F0 | integrity/capability 진단과 접근성 fallback E2E | PASS |
| F1 | unit·science·integration·E2E·visual·soak 전체 suite | PASS |
| G0 | release pin·provenance·licenses·headers·archive | PASS |
| NUI0 | full-scene Svelte 5 primary + React 19 standby가 같은 UI port·single dial·single result·ARIA contract 구현 | PASS — Svelte check + React/Svelte presentation inventory + production mount E2E |
| NUI1 | 두 view가 공통 dial-input mapping과 canonical runtime을 사용하고 같은 gesture 결과 생성 | PASS — input contract unit + forced React/Svelte differential E2E |
| NUI2 | availability fault에서 session state를 보존하며 세대·중복 입력을 막고 one-way failover | PASS — supervisor unit + load/mount/active-view/attached-renderer fault E2E |
| NUI3 | digest mismatch 격리, 근거 진단, hidden heartbeat와 두 구현/supervisor/host source provenance | PASS — `MH-UI-*` unit + release provenance v3 verifier |
| M1 | 같은 `baker-algorithm.v1`을 독립 구현한 Rust native/Python stdlib 전체 generator | PASS — full-generation strict WSL differential |
| M2 | Rust primary, availability-only Python degraded fallback, scientific split-brain/LKG 정책 | PASS — broker policy/process/semantic-diff tests |
| M3 | 관리된 단일 native executable, 4551 구조화, report-file attestation과 release binding | PASS — artifact-path/process tests + release verifier |

## 최종 gate

```bash
npm run verify
npm run physics:validate
npm run physics:validate:strict
npm run release:verify -- --require-clean
npm run release:archive
npm run release:archive:check
```

개별 결과를 강제하는 값별 분기나 lookup table, 검증되지 않은 dataset의
프로덕션 승격, 실제 마이크 입력은 release blocker다.

Svelte 5 full scene은 primary로, 같은 계약의 React 19 full scene은 standby로
프로덕션 host에 연결됐다. NUI0–NUI3의 `PASS`는 framework view availability,
세션 연속성, 입력 exactly-once 경계와 provenance를 뜻한다. 두 구현은 같은
TypeScript scientific runtime, renderer/audio, dataset, CSS, supervisor와
hosting bootstrap을 공유하므로 과학 알고리즘이나 배포 전체의 독립 N-version을
뜻하지 않는다. shared contract digest mismatch는 자동 fallback하지 않고
split-brain으로 격리한다. 활성 view의 연결된 renderer가 실패하면 standby로
전환하며, 모든 view가 실패하면 정적 fatal 상태와 함께 오디오를 suspend한다.

`response.bin`의 공진 계산 재통합과 위 UI 공통-mode 제거는 현재 `PASS`에
포함하지 않는다.

M1 strict WSL full-generation 증거는 `dual-verified`,
`mismatchCount = 0`, Rust `3.041 s`, Python `62.283 s`였다. field, 네 종류의
decoded KTX2 atlas와 mesh는 exact였고 나머지 수치는 versioned 계약의
허용오차 안이었다. 이는 두 구현의 현재 계약 합의를 증명한다. 배포 중인
고정 dataset은 `algorithmRevision` 도입 전 legacy/unversioned pin이므로 현재
N-version으로 재생성됐다고 소급 주장하지 않는다.

atlas-v1은 종류별 48 layer가 monolithic이므로 per-mode/range lazy residency도
현재 `PASS`에 포함하지 않는다. 현재 D1은 검증된 core→sand prewarm→나머지
atlas 순서와 fail-closed 전체 dataset 승격을 뜻한다.

완료 기준 18의 `PASS`는 장시간 자원이 누적되지 않고 현재 성능 예산을
통과한다는 뜻이다. 48-mode inactive culling, 모든 short-lived allocation
제거, runtime frame-pressure 기반 자동 60→30 FPS 전환과 전체 품질 저하
ladder는 별도 성능 후속 항목이다.
