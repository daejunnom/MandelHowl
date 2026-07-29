# MandelHowl 핸드오프 최종 구현 감사

감사 기준일: 2026-07-29  
감사 범위: `MandelHowl_핸드오프.md`, `MandelHowl_파일_구조.md`, 배포 소스,
고정 물리 데이터셋, 자동 검증·릴리스 도구

## 결론

핸드오프의 완료 품질 기준 18개와 구현 단계 A0–G0을 모두 구현했다. 예상 파일
트리의 이름을 그대로 복제하는 대신 현재 React/Vinext 구조에서 같은 책임
경계와 의존성 방향을 유지했다. 브라우저는 PDE나 고유값 문제를 풀지 않고,
다음 content-addressed 프로덕션 데이터셋만 검증 후 사용한다.

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
| 1 | PASS | `app/mandelhowl-scene.tsx`가 스피커→판→가상 마이크→피드백→볼륨을 한 화면의 읽기 순서로 구성한다. `tests/visual/mandelhowl-states.spec.ts`의 9개 실제 렌더 회귀와 presentation contract가 구조를 고정한다. |
| 2 | PASS | `app/mandelhowl-lab.tsx`의 포인터·터치 Pointer Event·키보드·휠이 모두 `packages/dial-engine` 명령으로 수렴한다. E2E는 개념적 조절 입력이 ARIA slider 하나뿐임과 직접 회전을 검증한다. |
| 3 | PASS | `RuntimeSnapshot.volume`의 measuring/settled union과 resonance-engine의 유일한 volume mapper가 `000..100` 정수 하나를 소유한다. UI는 측정 중 마지막 확정값을 보존한다. |
| 4 | PASS | 고정 dataset coverage의 균일 정적 입력 중 극단값은 `99.5012%`로 90% 기준을 넘는다. `coverage-report.json`과 science validator가 수치를 독립 재계산한다. |
| 5 | PASS | coverage에는 `0..100` 전부에 대한 101개 재현 trace가 있으며, `1..99`를 포함한 각 결과를 runtime engine으로 독립 replay해 정확히 일치시킨다. |
| 6 | PASS | 코어는 고정 스텝과 전역 피드백 수식만 사용한다. security static 검사에서 난수, 값별 출력 lookup/예외, 실제 입력 장치 API를 금지하고 동일 trace의 결정성도 검증한다. |
| 7 | PASS | signed displacement·normal·nodal mask·sand density KTX2 atlas가 manifest mode ID와 같은 좌표계를 사용한다. asset-runtime과 실제 WebGL2/Canvas2D renderer가 checksum 검증된 bytes를 소비한다. |
| 8 | PASS | `mandelbrot-plate.v1.yaml`에서 escape-time field, 최소 특징 필터, 두께 매핑, 질량·무게중심·강성 제약, 얇은 판 고유값 해석으로 이어진다. science tests가 생성물과 사양 hash를 다시 검증한다. |
| 9 | PASS | 물성장과 모래 마디선은 별도 자산이다. 화면·문서·provenance는 만델브로가 두께의 원인임을 설명하며 모래를 만델브로 실루엣이라고 주장하지 않는다. |
| 10 | PASS | 가상 `100`은 audio gain과 독립이다. DC blocker, band limiter, soft clip, RMS/peak 제한, exposure guard를 수식·실제 graph 양쪽에서 고정하며 offline sweep E2E가 peak/RMS ceiling을 검증한다. |
| 11 | PASS | 실제 마이크는 사용하지 않는다. 가상 microphone coupling만 데이터셋과 runtime에 존재하며 forbidden-runtime 검사가 `getUserMedia`·permission 경로를 차단한다. |
| 12 | PASS | dataset ID, 초기 상태, 고정 스텝, gesture trace가 결과를 완전히 결정한다. 단위·통합 검증이 다른 frame cadence, pause/resume, 반복 replay에서 같은 snapshot을 확인한다. |
| 13 | PASS | 렌더러는 snapshot read-only consumer다. `renderer-integrity.spec.ts`가 실제 프로덕션 dataset으로 WebGL2와 Canvas2D의 주파수·볼륨·측정 상태·regime 결과가 완전히 같음을 확인한다. |
| 14 | PASS | manifest는 plate spec, solver·옵션, mesh quality, convergence, 독립 참조, 파일 길이·SHA-256, coordinate system, coverage를 연결한다. dataset loader와 release validator가 모든 pin을 재검증한다. |
| 15 | PASS | diagnostics 패키지는 stable code, severity, evidence state, 사용자 문구, redacted 개발 근거를 분리한다. 손상 manifest, 잘못된 pin, texture upload, WebGL, AudioContext 실패 fixture가 fail-closed를 증명한다. |
| 16 | PASS | 다이얼은 `45..6000 Hz` ARIA slider이며 키보드·터치·포인터·휠이 같은 의미를 사용한다. 확정 출력만 별도 polite live region으로 알리고 pointer capture 손실도 종료한다. |
| 17 | PASS | reduced motion은 흔들림·펄스 품질만 줄이고 canonical 상태·숫자·문구를 유지한다. reduced-motion E2E와 실제 renderer golden을 함께 검증한다. |
| 18 | PASS | fixed-size delay/RMS/trace/frame buffers와 재사용 GPU·audio node를 사용한다. 1시간 가상 실행은 buffer identity를 확인하고, 브라우저 soak와 3회 hide/resume/pagehide E2E는 node·consumer·heap·teardown 상한을 검증한다. |

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
| D0 | PASS | 실제 dataset WebGL2 plate shader, Canvas2D data fallback, 반응형 인과 장면, oscilloscope·speaker·microphone·cable presenter |
| D1 | PASS | capability probe, asset loader, fixed-step loop, immutable snapshot fanout, lifecycle·오류 복구. 모든 consumer가 같은 snapshot 객체를 받고 DOM은 물리 재계산 없이 표시 cadence만 제한한다. |
| D2 | PASS | user gesture activation, modal oscillator bank, 안전 체인, peak/RMS offline audit, visibility fade/suspend, graph 생성 실패와 teardown |
| E0 | PASS | 극단값 `99.5012%`, `0..100` 전체 trace/replay, 전역 파라미터 보정, per-value branch 금지 검사 |
| E1 | PASS | decaying·critical·growing·saturated, burst·beating·reverse reverb, cable circulation, reduced-motion 9-state actual-renderer golden |
| F0 | PASS | integrity/capability diagnostics, WebGL2→Canvas fallback, Audio fail-closed, 키보드·터치·screen-reader semantics |
| F1 | PASS | TypeScript unit/web/integration, Python science, SSR, E2E, visual, offline audio, 장시간 resource/performance suite |
| G0 | PASS | dataset lock, clean-tree release provenance, security headers, audit, license notices, deterministic ZIP와 inventory/check |

## Critical 범위 보정

요청한 변경은 사양, generated config, runtime, coverage dataset에 함께 반영했다.

- critical loop-margin 반폭: `±0.025`
- 전체 critical 폭: `0.050`
- 포화 우선 판정: `feedbackEnvelope >= 0.92` 유지
- 모드별 잔향/loop 감쇠: `0.68 + |loopMargin| × 1.55` 유지
- 잔류 envelope만으로 critical을 넓히던 보조 판정은 사용하지 않음

따라서 잔향 시간을 줄이지 않고, 실제 loop gain이 임계점에 더 가까운 경우에만
`critical` 상태와 비팅 표현이 나타난다.

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

이 한계들은 미구현 항목을 문구로 덮은 것이 아니라, 검증된 구현이 주장할 수
있는 범위를 고정한다.
