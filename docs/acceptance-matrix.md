# MandelHowl acceptance matrix

기준 문서: `MandelHowl_핸드오프.md`

최종 감사일: 2026-07-29

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
| 7 | Chladni 무늬가 해석 자산에 연결 | mode/atlas/coordinate/checksum + actual renderer tests | PASS |
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
| D0 | WebGL2와 Canvas2D가 같은 mode dataset 소비 | PASS |
| D1 | 같은 immutable snapshot을 render/audio/DOM consumer에 fanout; DOM은 재계산 없이 표시 cadence만 제한 | PASS |
| D2 | user gesture·audio chain·peak/RMS·lifecycle·fail-closed | PASS |
| E0 | 0/100 분포와 1..99 reachability/replay | PASS |
| E1 | 상태 전환·비팅·잔향·reduced-motion 표현 회귀 | PASS |
| F0 | integrity/capability 진단과 접근성 fallback E2E | PASS |
| F1 | unit·science·integration·E2E·visual·soak 전체 suite | PASS |
| G0 | release pin·provenance·licenses·headers·archive | PASS |

## 최종 gate

```bash
npm run verify
npm run physics:validate
npm run release:verify -- --require-clean
npm run release:archive
npm run release:archive:check
```

개별 결과를 강제하는 값별 분기나 lookup table, 검증되지 않은 dataset의
프로덕션 승격, 실제 마이크 입력은 release blocker다.
