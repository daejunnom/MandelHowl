# MandelHowl 예상 파일 구조

## 1. 구조 전제

이 구조는 다음 구현 방식을 기준으로 예측한다.

- 브라우저 실행부: TypeScript, Vite, Web Components 또는 경량 DOM view, WebGL2, Web Audio API
- 패키지 관리: pnpm workspace
- 오프라인 물리 자산 생성부: Python CLI와 외부 유한요소 솔버 어댑터
- 텍스처: 오프라인 모드 해석 결과를 KTX2 등 GPU 친화 포맷으로 패키징
- 테스트: Vitest, Playwright, Python 테스트, 데이터셋 검증 CLI
- 핵심 방침: 브라우저에서는 PDE를 풀지 않고 검증된 모달 데이터만 사용
- canonical ownership: 원본 사양과 계약을 수정하고 생성 자산은 다시 굽는 구조
- 핵심 입력: 회전 주파수 다이얼 하나
- 핵심 출력: 0~100 볼륨 하나

프로젝트 루트명은 `mandelhowl/`을 사용한다. 아래 주석은 각 파일이 단일 책임을 갖도록 구분한 예상 역할이다.

### 현재 구현 보정 (2026-07-30)

아래 트리는 초기 예상안이며 현재 저장소는 npm + Vinext host에서 Svelte 5를
primary, React 19를 standby로 실행한다. 다음 실제 경계를 추가했다.

- `packages/browser-runtime/`: UI 프레임워크와 독립적인 snapshot store,
  fanout, challenge/health host, UI port, generation lease와 N-version supervisor
- `packages/presentation-model/`: React와 Svelte가 공유하는 오실로스코프
  auto-range 표시 모델
- `apps/svelte-ui/`: 동일 store·CSS·ARIA 계약을 소비하는 production Svelte 5
  full scene과 mount adapter
- `apps/react-ui/`: 같은 계약을 독립 mount하는 React 19 standby full scene
- `specs/runtime/ui-nversion.v1.json`: primary/standby, failover와 view/session
  ownership의 canonical 정책
- `specs/physics/baker-algorithm.v1.json`: Python과 Rust가 함께 구현하는
  수치 순서·정밀도·허용오차의 versioned 단일 계약
- `tools/physics-baker-rs/`: field부터 solver·KTX2·mesh·packaging까지 독립
  구현한 Rust native 전체 generator/validator
- `tools/physics-baker/`: 같은 알고리즘 계약의 독립 Python stdlib
  generator/validator
- `tools/baker-supervisor/`: 두 candidate를 실행·비교하고 degraded,
  split-brain, last-known-good와 report-file attestation을 판정하는 broker
- 루트 `Cargo.toml`, `rust-toolchain.toml`: native baker workspace와 toolchain
  재현성 경계

과학 알고리즘은 UI 구현체 안으로 옮기지 않는다. Svelte와 React는 같은
canonical runtime을 읽는 presentation N-version이며 runtime·renderer/audio,
CSS, supervisor와 hosting bootstrap은 공통-mode다. Rust backend 승격은
Python과의 strict differential 합의 뒤에만 허용한다. 운영 경로는
platform/architecture별 관리된 단일 native executable을 사용하며 `cargo`는
개발 및 Linux CI 품질 gate에만 사용한다.

---

## 2. 전체 트리

```text
mandelhowl/
├─ .github/
│  ├─ ISSUE_TEMPLATE/
│  │  ├─ bug.yml                                  # 재현 trace, 데이터셋 ID, 진단 코드를 필수로 받는 버그 신고 양식
│  │  └─ physics-data.yml                         # 물리 자산의 수렴성·provenance 문제를 별도로 접수하는 신고 양식
│  └─ workflows/
│     ├─ ci-web.yml                               # TypeScript 검사, 단위 테스트, 웹 빌드를 수행하는 기본 CI
│     ├─ ci-physics-tools.yml                     # Python 도구의 정적 검사와 경량 fixture 해석을 검증하는 CI
│     ├─ validate-runtime-dataset.yml             # 배포 후보 데이터셋의 스키마·해시·도달성을 검사하는 CI
│     ├─ visual-regression.yml                    # 대표 공진 상태의 스크린샷 회귀를 검사하는 워크플로
│     └─ release-pages.yml                        # 정적 웹 산출물과 고정된 물리 데이터셋을 함께 배포하는 워크플로
│
├─ apps/
│  └─ web/
│     ├─ public/
│     │  ├─ icons/
│     │  │  ├─ icon-192.png                       # 설치형 웹 앱과 공유 카드에 사용할 소형 애플리케이션 아이콘
│     │  │  ├─ icon-512.png                       # 고해상도 런처와 설치 화면에 사용할 대형 아이콘
│     │  │  └─ maskable-512.png                   # 운영체제 마스킹 영역을 고려한 PWA 전용 아이콘
│     │  ├─ fallback/
│     │  │  ├─ plate-silhouette.svg               # WebGL 없이도 장치 관계를 보여주는 정적 판 실루엣
│     │  │  ├─ speaker.svg                        # Canvas fallback에서 재사용하는 스피커 벡터 자산
│     │  │  └─ microphone.svg                     # Canvas fallback에서 재사용하는 마이크 벡터 자산
│     │  ├─ manifest.webmanifest                  # 이름, 아이콘, 표시 모드를 정의하는 웹 앱 manifest
│     │  └─ robots.txt                            # 컨테스트 배포 환경의 검색 수집 정책을 명시하는 파일
│     │
│     ├─ src/
│     │  ├─ bootstrap/
│     │  │  ├─ create-app.ts                      # 모든 런타임 의존성을 조립해 AppController를 만드는 composition root
│     │  │  ├─ load-runtime-config.ts             # HTML의 안전한 설정과 기본 데이터셋 위치를 읽는 부트 설정 로더
│     │  │  ├─ register-lifecycle.ts              # visibilitychange, pagehide, 종료 시 오디오와 루프를 안전하게 정리하는 수명주기 등록기
│     │  │  └─ install-global-error-boundary.ts   # 처리되지 않은 오류를 구조화 진단으로 전환하는 최상위 오류 경계
│     │  │
│     │  ├─ application/
│     │  │  ├─ app-controller.ts                  # 입력, 시뮬레이션, 렌더링, 오디오를 한 방향 데이터 흐름으로 조율하는 애플리케이션 컨트롤러
│     │  │  ├─ app-command.ts                     # 다이얼 조작과 수명주기 사건을 애플리케이션 명령으로 정의하는 계약
│     │  │  ├─ app-event.ts                       # 로딩·진단·볼륨 확정 같은 애플리케이션 사건을 정의하는 계약
│     │  │  ├─ app-state.ts                       # 화면 준비 상태와 현재 데이터셋 ID를 보관하는 최소 애플리케이션 상태
│     │  │  ├─ simulation-clock.ts                # 실제 프레임과 독립된 고정 시간 스텝을 공급하는 시뮬레이션 시계
│     │  │  ├─ tick-loop.ts                       # 누적 시간, 최대 catch-up, 렌더 보간을 관리하는 메인 루프
│     │  │  ├─ snapshot-dispatcher.ts             # 하나의 runtime snapshot을 DOM, WebGL, 오디오 소비자에게 배포하는 fan-out 경계
│     │  │  └─ recovery-policy.ts                 # 일시 오류, 치명적 오류, fallback 전환을 구분하는 복구 정책
│     │  │
│     │  ├─ interaction/
│     │  │  ├─ dial-pointer-adapter.ts            # PointerEvent 좌표를 dial-engine의 회전 샘플로 바꾸는 DOM 어댑터
│     │  │  ├─ dial-keyboard-adapter.ts           # 키보드 입력을 동일한 회전 증분 명령으로 변환하는 접근성 어댑터
│     │  │  ├─ dial-wheel-adapter.ts              # 마우스 휠을 제한된 다이얼 회전으로 변환하고 페이지 스크롤 충돌을 제어하는 어댑터
│     │  │  ├─ dial-touch-adapter.ts              # 터치 포인터의 원호 회전을 다이얼 입력으로 전달하는 터치 전용 어댑터
│     │  │  ├─ pointer-capture-guard.ts            # 포인터 캡처 손실과 취소 시 gesture 세션을 누수 없이 종료하는 보호기
│     │  │  ├─ input-activation-gate.ts            # 첫 사용자 제스처를 오디오 활성화와 입력 시작에 한 번만 배분하는 게이트
│     │  │  └─ dial-aria-binding.ts                # 다이얼의 현재 주파수와 범위를 ARIA 속성으로 동기화하는 접근성 바인딩
│     │  │
│     │  ├─ presentation/
│     │  │  ├─ scene-presenter.ts                 # runtime snapshot을 장면 렌더 명령으로 변환하는 presenter
│     │  │  ├─ dial-presenter.ts                  # 다이얼 각도, Hz 표기, 공진 저항 표현을 view 모델로 만드는 presenter
│     │  │  ├─ volume-presenter.ts                # 확정 볼륨과 측정 중 상태를 숫자·바늘 표시용 모델로 변환하는 presenter
│     │  │  ├─ oscilloscope-presenter.ts          # 마이크 샘플을 화면 폭에 맞는 파형 버퍼로 축소하는 presenter
│     │  │  ├─ diagnostic-presenter.ts            # 구조화 진단을 사용자용 설명과 개발용 세부 정보로 분리하는 presenter
│     │  │  ├─ capability-presenter.ts            # WebGL, KTX2, 오디오 가용성을 기능 상태 문구로 변환하는 presenter
│     │  │  └─ challenge-target-presenter.ts      # 외부에서 주어진 목표 볼륨을 읽기 전용 기준선으로 표현하는 presenter
│     │  │
│     │  ├─ views/
│     │  │  ├─ app-shell.ts                       # 단일 입력·단일 출력 레이아웃과 상태 영역을 소유하는 최상위 Web Component
│     │  │  ├─ frequency-dial-view.ts             # 직접 회전 가능한 원형 노브와 Hz 눈금을 렌더링하는 view
│     │  │  ├─ volume-meter-view.ts               # 세 자리 숫자와 아날로그 바늘을 같은 값으로 표시하는 output view
│     │  │  ├─ oscilloscope-view.ts               # 현재 가상 마이크 파형을 보조 계측기로 그리는 Canvas view
│     │  │  ├─ loading-view.ts                    # shell과 물리 자산 로딩 단계를 과장 없이 표시하는 view
│     │  │  ├─ diagnostic-view.ts                 # 복구 가능한 오류와 치명적 오류를 다른 계층으로 보여주는 view
│     │  │  ├─ science-caption-view.ts            # 작품의 실제 물리 기반과 창작적 결합을 짧게 설명하는 캡션 view
│     │  │  └─ audio-state-view.ts                # 오디오 활성·정지 상태만 알려주고 별도 조절 입력은 만들지 않는 view
│     │  │
│     │  ├─ styles/
│     │  │  ├─ tokens.css                         # 크기, 간격, 글자, 광도, 상태 지속시간을 변수로 관리하는 디자인 토큰
│     │  │  ├─ reset.css                          # 브라우저 기본 차이를 제거하되 접근성 focus를 보존하는 최소 reset
│     │  │  ├─ layout.css                         # 스피커–판–마이크–다이얼–미터의 시선 흐름을 정의하는 반응형 배치
│     │  │  ├─ dial.css                           # 노브 재질, 눈금, 포인터, 회전 중 커서 상태를 정의하는 스타일
│     │  │  ├─ meter.css                          # 볼륨 숫자와 계기판 바늘의 공통 상태 표현을 정의하는 스타일
│     │  │  ├─ diagnostics.css                    # 경고와 치명 오류를 시각적으로 구분하는 진단 스타일
│     │  │  ├─ reduced-motion.css                 # 모션 감소 환경에서 흔들림·잔상·줌을 줄이는 대체 스타일
│     │  │  └─ high-contrast.css                  # 색 대비 요구가 높은 환경에서 선·문자·마디 패턴을 강화하는 스타일
│     │  │
│     │  ├─ main.ts                               # 브라우저 부팅을 시작하고 bootstrap composition root만 호출하는 진입점
│     │  └─ vite-env.d.ts                         # Vite 환경 타입만 선언하고 프로젝트 도메인 타입은 포함하지 않는 파일
│     │
│     ├─ index.html                               # CSP 친화적 루트 마크업과 접근 가능한 앱 mount 지점을 제공하는 HTML
│     ├─ package.json                             # 웹 앱 전용 빌드·개발 스크립트와 내부 패키지 의존성을 선언하는 manifest
│     ├─ tsconfig.json                            # DOM·WebGL 대상 TypeScript 설정을 루트 공통 설정에서 확장하는 파일
│     └─ vite.config.ts                           # 자산 manifest 주입, worker 번들, 정적 경로를 구성하는 Vite 설정
│
├─ packages/
│  ├─ contracts/
│  │  ├─ src/
│  │  │  ├─ plate-spec.ts                         # 유한 해상도 만델브로 물성판 사양의 TypeScript 타입을 정의하는 계약
│  │  │  ├─ resonance-manifest.ts                 # 런타임 데이터셋 파일·해시·좌표계의 manifest 타입을 정의하는 계약
│  │  │  ├─ mode-record.ts                        # 모드별 주파수, 감쇠, 결합계수, 텍스처 참조를 정의하는 계약
│  │  │  ├─ feedback-spec.ts                      # 지연, 이득, 게이트, 클리퍼, 리미터 파라미터를 정의하는 계약
│  │  │  ├─ runtime-snapshot.ts                   # 렌더러와 오디오가 읽는 불변 snapshot 구조를 정의하는 계약
│  │  │  ├─ diagnostic-record.ts                  # confirmed·needs_evidence·inconclusive 진단 구조를 정의하는 계약
│  │  │  ├─ gesture-trace.ts                      # 재현 가능한 다이얼 입력 샘플 포맷을 정의하는 계약
│  │  │  ├─ coverage-report.ts                    # 0~100 도달성 결과와 증명 trace를 표현하는 계약
│  │  │  ├─ runtime-config.ts                     # 배포 시 선택 가능한 데이터셋과 안전 옵션을 정의하는 계약
│  │  │  └─ index.ts                              # 외부에 공개할 계약만 명시적으로 재수출하는 패키지 표면
│  │  ├─ schemas/
│  │  │  ├─ plate-spec.schema.json                # Python 생성기와 TypeScript가 함께 검증하는 판 사양 JSON Schema
│  │  │  ├─ resonance-manifest.schema.json        # 배포 데이터셋 manifest의 필수 필드와 버전을 고정하는 JSON Schema
│  │  │  ├─ feedback-spec.schema.json             # 전역 피드백 설정의 범위와 단위를 검증하는 JSON Schema
│  │  │  ├─ gesture-trace.schema.json             # 테스트·재현용 입력 trace의 단조 시간과 값 범위를 검증하는 JSON Schema
│  │  │  └─ coverage-report.schema.json           # 도달성 보고서가 모든 출력값과 증거를 포함하는지 검증하는 JSON Schema
│  │  ├─ test/
│  │  │  ├─ schema-fixtures.test.ts               # 정상·비정상 fixture가 계약대로 통과·거부되는지 검사하는 테스트
│  │  │  └─ version-compatibility.test.ts         # 데이터 버전 업그레이드와 명시적 비호환 처리를 검사하는 테스트
│  │  ├─ package.json                             # 계약 패키지의 생성·검증 스크립트를 선언하는 manifest
│  │  └─ tsconfig.json                            # DOM 없이 직렬화 계약만 컴파일하도록 제한하는 TypeScript 설정
│  │
│  ├─ dial-engine/
│  │  ├─ src/
│  │  │  ├─ dial-state.ts                         # 누적 각도, 각속도, 주파수, gesture 상태를 소유하는 순수 도메인 상태
│  │  │  ├─ dial-command.ts                       # pointer sample과 키 회전을 엔진 명령으로 정의하는 타입
│  │  │  ├─ unwrap-angle.ts                       # -π/π 경계를 넘는 포인터 각도를 연속 회전량으로 풀어내는 함수
│  │  │  ├─ radial-dead-zone.ts                   # 중심 근처 불안정한 포인터 좌표를 회전 계산에서 제외하는 판정기
│  │  │  ├─ angular-velocity.ts                   # 시간 간격이 불규칙한 샘플에서 안정적인 각속도를 추정하는 계산기
│  │  │  ├─ frequency-scale.ts                    # 누적 회전각을 제한된 로그 주파수 범위로 매핑하는 함수
│  │  │  ├─ end-stop.ts                           # 주파수 범위 끝에서 물리적인 저항과 overscroll 복원을 계산하는 함수
│  │  │  ├─ inertia.ts                            # 포인터 해제 뒤 제한된 관성 회전을 적분하는 순수 함수
│  │  │  ├─ resonance-haptics.ts                  # 실제 진동 상태를 다이얼 시각 떨림·저항 신호로 변환하는 모델
│  │  │  ├─ gesture-recorder.ts                   # 입력 샘플을 결정적 trace로 기록하는 개발·테스트용 기록기
│  │  │  ├─ dial-engine.ts                        # 명령을 받아 단일 dial state 전이를 수행하는 도메인 엔진
│  │  │  └─ index.ts                              # DOM 독립 다이얼 API만 외부에 노출하는 패키지 표면
│  │  ├─ test/
│  │  │  ├─ unwrap-angle.test.ts                  # 0도 경계 반복 통과와 역회전의 연속성을 검증하는 테스트
│  │  │  ├─ angular-velocity.test.ts              # 느린·빠른·불규칙 샘플의 속도 추정 오차를 검증하는 테스트
│  │  │  ├─ frequency-scale.test.ts               # 로그 스케일의 단조성, 끝단, 왕복 일관성을 검증하는 테스트
│  │  │  └─ trace-replay.test.ts                  # 기록한 gesture trace가 같은 다이얼 상태를 재현하는지 검증하는 테스트
│  │  ├─ package.json                             # 순수 다이얼 엔진의 테스트와 빌드 의존성만 선언하는 manifest
│  │  └─ tsconfig.json                            # DOM 타입을 금지해 입력 어댑터와 도메인 계산의 경계를 지키는 설정
│  │
│  ├─ resonance-engine/
│  │  ├─ src/
│  │  │  ├─ resonance-state.ts                    # 모드별 진폭·속도·위상과 피드백 포락선을 소유하는 canonical 상태
│  │  │  ├─ resonance-command.ts                  # 주파수 갱신, 시간 진행, 리셋을 엔진 명령으로 표현하는 타입
│  │  │  ├─ active-mode-selector.ts               # 현재 주파수와 잔향을 기준으로 계산할 모드 집합을 제한하는 선택기
│  │  │  ├─ modal-integrator.ts                   # 모드별 감쇠 2차 동역학을 고정 스텝으로 적분하는 계산기
│  │  │  ├─ drive-signal.ts                       # 다이얼 주파수와 sweep 속도에서 가진 파형을 생성하는 모델
│  │  │  ├─ virtual-microphone.ts                 # 모드 응답과 측정점 결합계수에서 가상 마이크 신호를 합산하는 모델
│  │  │  ├─ feedback-delay.ts                     # 폐루프 전달 지연을 결정적 순환 버퍼로 구현하는 모듈
│  │  │  ├─ feedback-filter.ts                    # 피드백 경로의 대역 제한과 위상 응답을 계산하는 필터
│  │  │  ├─ noise-gate.ts                         # 감쇠 영역의 미세 신호를 노이즈 플로어 아래로 수렴시키는 게이트
│  │  │  ├─ soft-clipper.ts                       # 증폭기 비선형 포화를 연속 함수로 적용하는 소프트 클리퍼
│  │  │  ├─ virtual-limiter.ts                    # 가상 자기진동을 100 상태의 유한 상한으로 제한하는 리미터
│  │  │  ├─ envelope-follower.ts                  # 피드백 성장·감쇠를 안정적으로 측정하는 포락선 팔로워
│  │  │  ├─ rms-window.ts                         # 최근 측정 구간의 RMS를 할당 없이 갱신하는 이동 창
│  │  │  ├─ volume-mapper.ts                      # 가상 음압 범위를 0~100 정수로 변환하는 유일한 출력 매퍼
│  │  │  ├─ regime-classifier.ts                  # decaying·critical·growing·saturated 상태를 분류하는 판정기
│  │  │  ├─ settling-detector.ts                  # 결과가 확정 가능한 시간 안정성을 판정하는 감지기
│  │  │  ├─ snapshot-builder.ts                   # 내부 상태를 읽기 전용 runtime snapshot으로 압축하는 빌더
│  │  │  ├─ resonance-engine.ts                   # 모든 모달·피드백 구성요소의 순서를 소유하는 코어 엔진
│  │  │  └─ index.ts                              # 상태 생성, step, snapshot API만 공개하는 패키지 표면
│  │  ├─ test/
│  │  │  ├─ modal-decay.test.ts                   # 피드백이 없을 때 에너지가 감쇠하는지 검증하는 테스트
│  │  │  ├─ feedback-growth.test.ts               # 임계 루프 이득 위에서 진폭이 리미터까지 성장하는지 검증하는 테스트
│  │  │  ├─ critical-burst.test.ts                # 임계 경계에서 중간 RMS가 생성되는지 검증하는 테스트
│  │  │  ├─ frame-rate-independence.test.ts       # 서로 다른 렌더 프레임 패턴에서 같은 시뮬레이션 결과를 검증하는 테스트
│  │  │  ├─ deterministic-replay.test.ts          # 동일 데이터와 trace가 바이트 수준 동일 snapshot을 만드는지 검증하는 테스트
│  │  │  └─ limiter-safety.test.ts                # 어떤 입력에서도 가상 상태가 정의된 상한과 유한값을 넘지 않는지 검사하는 테스트
│  │  ├─ package.json                             # 수치 코어에 필요한 최소 의존성과 벤치마크 스크립트를 선언하는 manifest
│  │  └─ tsconfig.json                            # 브라우저 전용 API를 배제하는 수치 엔진 TypeScript 설정
│  │
│  ├─ asset-runtime/
│  │  ├─ src/
│  │  │  ├─ dataset-locator.ts                    # 런타임 설정에서 고정된 manifest URL을 안전하게 결정하는 위치 해석기
│  │  │  ├─ manifest-loader.ts                    # manifest를 가져오고 스키마·버전을 검증하는 로더
│  │  │  ├─ checksum-verifier.ts                  # 바이너리와 텍스처의 해시를 사용 전 검증하는 무결성 검사기
│  │  │  ├─ mode-binary-decoder.ts                # 압축 모달 바이너리를 typed array view로 해석하는 디코더
│  │  │  ├─ response-binary-decoder.ts            # 주파수 응답 데이터를 런타임 조회 구조로 변환하는 디코더
│  │  │  ├─ texture-atlas-loader.ts               # 필요한 모드 atlas를 우선순위에 따라 지연 로드하는 로더
│  │  │  ├─ ktx2-capability.ts                    # 브라우저의 지원 GPU 압축 포맷을 판정하는 capability probe
│  │  │  ├─ dataset-cache.ts                      # 검증된 자산만 세션 캐시에 보관하고 버전 충돌을 방지하는 캐시
│  │  │  ├─ dataset-repository.ts                 # 앱에 완성된 불변 ResonanceDataset을 제공하는 저장소 경계
│  │  │  └─ index.ts                              # 로딩·검증·캐시 API만 노출하는 패키지 표면
│  │  ├─ test/
│  │  │  ├─ invalid-hash.test.ts                  # 변조된 자산이 엔진에 전달되지 않는지 검증하는 테스트
│  │  │  ├─ incompatible-version.test.ts          # 지원하지 않는 manifest 버전의 명시적 거부를 검증하는 테스트
│  │  │  └─ partial-load-recovery.test.ts         # 일부 atlas 실패 시 재시도·fallback 정책을 검증하는 테스트
│  │  ├─ package.json                             # fetch와 바이너리 디코딩 경계의 의존성만 선언하는 manifest
│  │  └─ tsconfig.json                            # Web API를 허용하되 DOM view 의존성을 금지하는 설정
│  │
│  ├─ render-engine/
│  │  ├─ src/
│  │  │  ├─ renderer.ts                           # 렌더 패스 순서, 프레임 리소스, 품질 단계를 소유하는 WebGL2 렌더러
│  │  │  ├─ render-context.ts                     # WebGL 객체와 공용 버퍼를 명시적으로 보관하는 렌더 컨텍스트
│  │  │  ├─ scene-layout.ts                       # 스피커·판·마이크·케이블의 고정 공간 배치를 정의하는 장면 구성
│  │  │  ├─ camera-controller.ts                  # 반응형 화면비에 맞춰 과도한 줌 없이 카메라를 조정하는 컨트롤러
│  │  │  ├─ frame-resources.ts                    # 프레임버퍼와 임시 텍스처의 생성·재사용·해제를 책임지는 관리자
│  │  │  ├─ quality-policy.ts                     # GPU 시간과 capability에 따라 표현 품질만 단계적으로 낮추는 정책
│  │  │  ├─ snapshot-interpolator.ts              # 고정 스텝 snapshot 사이를 렌더 프레임용으로 보간하는 모듈
│  │  │  ├─ passes/
│  │  │  │  ├─ speaker-pass.ts                    # 가상 가진 진폭에 따라 스피커 콘의 변위를 그리는 렌더 패스
│  │  │  │  ├─ plate-pass.ts                      # 계산된 모드 텍스처로 금속판 표면 변위를 표현하는 렌더 패스
│  │  │  │  ├─ sand-pass.ts                       # 마디선 밀도와 잔류 시간을 이용해 Chladni 모래를 그리는 렌더 패스
│  │  │  │  ├─ microphone-pass.ts                 # 측정점과 음압 링을 표현하는 마이크 렌더 패스
│  │  │  │  ├─ cable-signal-pass.ts               # 폐루프 케이블을 따라 이동하는 신호 펄스를 그리는 렌더 패스
│  │  │  │  ├─ fractal-cutaway-pass.ts            # 판 뒷면 만델브로 물성 분포를 짧은 단면 효과로 드러내는 렌더 패스
│  │  │  │  ├─ glow-pass.ts                       # 포화 상태의 국소 발광만 처리하고 전체 플래시를 피하는 후처리 패스
│  │  │  │  └─ composite-pass.ts                  # 모든 패스를 색공간에 맞게 최종 화면으로 합성하는 패스
│  │  │  ├─ shaders/
│  │  │  │  ├─ plate.vert.glsl                    # 모드별 signed displacement를 합산해 판 정점을 변위시키는 정점 셰이더
│  │  │  │  ├─ plate.frag.glsl                    # 금속 재질과 계산된 normal map을 결합하는 판 조각 셰이더
│  │  │  │  ├─ sand.vert.glsl                     # 모래 밀도 atlas에서 입자 또는 점 sprite 위치를 결정하는 셰이더
│  │  │  │  ├─ sand.frag.glsl                     # 입자 크기와 광량을 조절해 마디선을 읽기 쉽게 만드는 셰이더
│  │  │  │  ├─ cable.vert.glsl                    # 케이블 중심선을 따라 신호 위치를 계산하는 정점 셰이더
│  │  │  │  ├─ cable.frag.glsl                    # 피드백 성장 상태에 맞춰 신호 펄스의 국소 발광을 그리는 셰이더
│  │  │  │  ├─ cutaway.frag.glsl                  # 만델브로 물성장을 과학 도식처럼 표시하는 단면 조각 셰이더
│  │  │  │  └─ composite.frag.glsl                # 선형 색공간의 장면을 화면 출력으로 변환하는 최종 셰이더
│  │  │  ├─ fallback/
│  │  │  │  ├─ canvas-renderer.ts                 # WebGL이 없을 때 같은 snapshot을 2D 도식으로 표현하는 fallback 렌더러
│  │  │  │  ├─ plate-contour.ts                   # 모드 마디선을 Canvas path로 단순화해 그리는 보조 모듈
│  │  │  │  └─ waveform-painter.ts                # fallback 계측기의 파형을 그리는 경량 painter
│  │  │  └─ index.ts                              # 렌더러 생성, resize, render, dispose API만 공개하는 패키지 표면
│  │  ├─ test/
│  │  │  ├─ resource-disposal.test.ts             # 컨텍스트 재생성·종료 뒤 GPU 리소스 참조가 남지 않는지 검사하는 테스트
│  │  │  ├─ quality-invariance.test.ts            # 품질 단계가 핵심 수치 snapshot을 변경하지 않는지 검사하는 테스트
│  │  │  └─ shader-contract.test.ts               # 셰이더 uniform 이름과 TypeScript 바인딩의 일치를 검사하는 테스트
│  │  ├─ package.json                             # WebGL 렌더 계층의 빌드와 shader import 설정을 선언하는 manifest
│  │  └─ tsconfig.json                            # WebGL 타입과 shader 모듈 선언을 포함하는 TypeScript 설정
│  │
│  ├─ audio-engine/
│  │  ├─ src/
│  │  │  ├─ audio-engine.ts                       # runtime snapshot을 안전한 Web Audio graph 파라미터로 적용하는 오디오 엔진
│  │  │  ├─ context-lifecycle.ts                  # AudioContext 생성·resume·suspend·close를 사용자 제스처와 연결하는 관리자
│  │  │  ├─ modal-oscillator-bank.ts              # 활성 모드의 주파수·가중치를 제한된 oscillator bank로 합성하는 모듈
│  │  │  ├─ spectral-shaper.ts                    # 판 재질과 모드 결합을 들을 수 있는 음색으로 변환하는 필터 계층
│  │  │  ├─ virtual-envelope.ts                   # 가상 피드백 포락선을 실제 오디오 게인 곡선으로 안전하게 변환하는 모듈
│  │  │  ├─ dc-blocker.ts                         # 합성 신호의 직류 성분을 제거하는 보호 필터
│  │  │  ├─ band-limiter.ts                       # 불필요한 초저역·고역 에너지를 제한하는 대역 안전 필터
│  │  │  ├─ soft-clipper-node.ts                  # 갑작스러운 피크를 연속적으로 완화하는 오디오 노드 래퍼
│  │  │  ├─ rms-limiter.ts                        # 지속 에너지 상한을 지키는 RMS 기반 제한기
│  │  │  ├─ peak-limiter.ts                       # AudioDestination 직전의 절대 피크 상한을 지키는 제한기
│  │  │  ├─ fade-policy.ts                        # 시작, 탭 숨김, 오류, 종료의 안전한 fade 시간을 정의하는 정책
│  │  │  ├─ audio-safety-audit.ts                 # graph 연결과 최대 파라미터가 안전 규칙을 우회하지 않는지 검사하는 진단기
│  │  │  └─ index.ts                              # activate, applySnapshot, suspend, dispose API만 공개하는 패키지 표면
│  │  ├─ worklets/
│  │  │  ├─ rms-limiter.worklet.ts                # 오디오 스레드에서 할당 없이 RMS 제한을 수행하는 AudioWorklet
│  │  │  └─ meter-tap.worklet.ts                  # 디버그용 피크·RMS 측정값만 전달하는 AudioWorklet
│  │  ├─ test/
│  │  │  ├─ gain-ceiling.test.ts                  # 모든 가상 볼륨에서 실제 게인 상한을 지키는지 검사하는 테스트
│  │  │  ├─ lifecycle.test.ts                     # 반복 활성·중지 뒤 오디오 노드가 누적되지 않는지 검사하는 테스트
│  │  │  └─ invalid-snapshot.test.ts              # NaN·무한대 snapshot이 오디오 파라미터에 전달되지 않는지 검사하는 테스트
│  │  ├─ package.json                             # Web Audio와 worklet 빌드 경계를 선언하는 manifest
│  │  └─ tsconfig.json                            # AudioWorklet과 메인 스레드 타입을 분리해 컴파일하는 설정
│  │
│  ├─ diagnostics/
│  │  ├─ src/
│  │  │  ├─ diagnostic-code.ts                    # 데이터·GPU·오디오·입력 실패 코드를 안정적인 문자열로 정의하는 목록
│  │  │  ├─ diagnostic-builder.ts                 # 원인, 증거, 심각도, 사용자 메시지를 구조화하는 빌더
│  │  │  ├─ capability-probe.ts                   # WebGL2, 압축 텍스처, AudioWorklet 지원을 독립적으로 검사하는 probe
│  │  │  ├─ evidence-state.ts                     # confirmed·needs_evidence·inconclusive 판정만 제공하는 상태 정의
│  │  │  ├─ performance-sampler.ts                # 프레임 시간과 메모리 대리 지표를 제한된 버퍼에 기록하는 샘플러
│  │  │  ├─ report-serializer.ts                  # 개인 정보 없이 개발자가 재현할 수 있는 진단 보고서를 직렬화하는 모듈
│  │  │  └─ index.ts                              # 진단 생성과 직렬화 API만 노출하는 패키지 표면
│  │  ├─ test/
│  │  │  ├─ evidence-classification.test.ts       # 증거 부족을 원인 확정으로 오인하지 않는지 검사하는 테스트
│  │  │  └─ redaction.test.ts                     # URL query와 환경 정보에서 불필요한 개인 데이터를 제거하는 테스트
│  │  ├─ package.json                             # 진단 패키지의 무의존성 또는 최소 의존성을 선언하는 manifest
│  │  └─ tsconfig.json                            # 브라우저와 Node 양쪽에서 쓸 수 있는 공통 컴파일 설정
│  │
│  └─ test-fixtures/
│     ├─ src/
│     │  ├─ synthetic-dataset.ts                  # 빠른 단위 테스트용 합성 공진 모드 데이터셋을 생성하는 fixture
│     │  ├─ stable-zero-trace.ts                   # 확실히 감쇠 상태로 수렴하는 다이얼 입력 trace
│     │  ├─ stable-hundred-trace.ts                # 확실히 포화 상태로 수렴하는 다이얼 입력 trace
│     │  ├─ critical-mid-trace.ts                  # 임계 버스트로 중간 출력이 나오는 입력 trace
│     │  └─ invalid-manifests.ts                   # 버전·해시·좌표계 오류 사례를 제공하는 fixture 모음
│     ├─ package.json                             # 여러 테스트 계층이 공유하는 fixture 패키지 manifest
│     └─ tsconfig.json                            # 프로덕션 번들에 포함되지 않는 테스트 전용 TypeScript 설정
│
├─ tools/
│  ├─ physics-baker/
│  │  ├─ src/mandelhowl_baker/
│  │  │  ├─ __init__.py                           # 오프라인 물리 자산 생성 패키지의 공개 버전만 정의하는 초기화 파일
│  │  │  ├─ cli.py                                # generate, solve, postprocess, package, validate 명령을 제공하는 CLI 진입점
│  │  │  ├─ config.py                             # YAML·JSON 사양을 단위가 명시된 내부 설정으로 변환하는 로더
│  │  │  ├─ diagnostics.py                        # 솔버·메시·자산 오류를 구조화 코드와 증거로 기록하는 진단 모듈
│  │  │  ├─ units.py                              # 길이·질량·주파수 단위를 명시적으로 변환하고 혼용을 막는 단위 모듈
│  │  │  │
│  │  │  ├─ field/
│  │  │  │  ├─ mandelbrot_escape.py               # 판 좌표에서 escape-time 수치장을 계산하는 순수 생성기
│  │  │  │  ├─ mandelbrot_distance.py             # 경계 근처 연속성을 높이는 distance estimate 수치장을 계산하는 생성기
│  │  │  │  ├─ coordinate_map.py                  # 물리 판 좌표와 복소평면 영역 사이의 변환을 정의하는 모듈
│  │  │  │  ├─ feature_filter.py                  # 최소 제조 특징 크기보다 작은 프랙탈 구조를 정리하는 필터
│  │  │  │  ├─ thickness_map.py                   # 정규화 수치장을 뒷면 두께 분포로 변환하는 매퍼
│  │  │  │  ├─ mass_map.py                        # 정규화 수치장을 부착 질량 또는 면밀도 분포로 변환하는 매퍼
│  │  │  │  └─ field_validation.py                # 최소 두께, 총질량, 무게중심, 기울기 제한을 검증하는 모듈
│  │  │  │
│  │  │  ├─ geometry/
│  │  │  │  ├─ plate_domain.py                    # 원형 전면, 중심 허브, 자유 외곽을 물리 도메인으로 정의하는 모듈
│  │  │  │  ├─ backside_profile.py                # 물성장을 실제 뒷면 높이 또는 shell 속성으로 변환하는 모듈
│  │  │  │  ├─ actuator_location.py               # 가진점이 유효 판 영역에 있는지 계산하고 좌표를 고정하는 모듈
│  │  │  │  ├─ microphone_location.py             # 가상 측정점과 방향을 물리 좌표계에 배치하는 모듈
│  │  │  │  └─ manufacturing_constraints.py       # 최소 벽 두께와 가공 한계를 형상에 적용하는 제약 모듈
│  │  │  │
│  │  │  ├─ mesh/
│  │  │  │  ├─ mesh_builder.py                    # 판 형상과 물성장에 맞는 shell·plate 메시를 생성하는 모듈
│  │  │  │  ├─ refinement_policy.py               # 프랙탈 경계와 높은 물성 기울기 부근의 국소 세분화 규칙
│  │  │  │  ├─ mesh_quality.py                    # 종횡비, 뒤집힘, 최소 크기, 연결성을 검사하는 품질 검증기
│  │  │  │  ├─ mesh_export.py                     # 솔버별 입력 포맷으로 메시와 물성 태그를 내보내는 모듈
│  │  │  │  └─ mesh_fingerprint.py                # 노드·요소·태그를 정규화해 재현 가능한 메시 해시를 만드는 모듈
│  │  │  │
│  │  │  ├─ solver/
│  │  │  │  ├─ solver_protocol.py                 # 특정 솔버에 묶이지 않은 고유값 해석 어댑터 인터페이스
│  │  │  │  ├─ calculix_adapter.py                # 기본 외부 유한요소 솔버 입력 생성·실행·결과 파싱 어댑터
│  │  │  │  ├─ reference_adapter.py               # 작은 참조 메시를 독립 방식으로 교차검증하는 보조 어댑터
│  │  │  │  ├─ boundary_conditions.py             # 중앙 고정과 자유 외곽 조건을 솔버 중립 표현으로 만드는 모듈
│  │  │  │  ├─ material_assignment.py             # 위치별 두께·질량·재료 값을 요소 속성으로 배치하는 모듈
│  │  │  │  ├─ eigen_request.py                   # 모드 수, 주파수 범위, 허용오차를 솔버 요청으로 만드는 모듈
│  │  │  │  ├─ eigen_result.py                    # 솔버 출력을 정규화된 고유주파수·고유벡터 구조로 변환하는 모듈
│  │  │  │  ├─ mode_normalization.py              # 질량 정규화와 모드 부호 기준을 적용하는 모듈
│  │  │  │  └─ convergence_study.py               # 메시 수준별 주파수·모드 유사도를 비교하는 수렴성 분석기
│  │  │  │
│  │  │  ├─ postprocess/
│  │  │  │  ├─ actuator_coupling.py               # 가진점에서 각 모드가 얼마나 자극되는지 결합계수를 계산하는 모듈
│  │  │  │  ├─ microphone_coupling.py             # 측정점에서 각 모드가 얼마나 관측되는지 결합계수를 계산하는 모듈
│  │  │  │  ├─ transfer_response.py               # 감쇠와 결합계수에서 복소 주파수 응답을 생성하는 모듈
│  │  │  │  ├─ nodal_mask.py                      # signed displacement에서 마디선 후보를 추출하는 모듈
│  │  │  │  ├─ sand_density.py                    # 시간 평균 표면 속도와 입자 크기에서 모래 집결 밀도를 계산하는 모듈
│  │  │  │  ├─ displacement_texture.py            # 모드 변위장을 정밀도 보존 텍스처로 래스터화하는 모듈
│  │  │  │  ├─ normal_texture.py                  # 변위 기울기에서 표면 normal map을 생성하는 모듈
│  │  │  │  ├─ texture_alignment.py               # 모든 모드 텍스처의 원점·축·UV를 동일하게 맞추는 검증기
│  │  │  │  └─ mode_preview.py                    # 생성 전 검토용 정적 모드 그림을 만드는 개발 보조 모듈
│  │  │  │
│  │  │  ├─ calibration/
│  │  │  │  ├─ feedback_model.py                  # TypeScript 엔진과 동일한 차원 없는 피드백 모델을 오프라인에서 실행하는 모듈
│  │  │  │  ├─ parameter_space.py                 # 전역 이득·감쇠·지연·리미터 후보 범위를 정의하는 모듈
│  │  │  │  ├─ static_sweep.py                    # 충분히 감쇠한 초기 상태의 주파수별 0·100 분포를 측정하는 도구
│  │  │  │  ├─ trajectory_search.py               # 방향·속도·정지 시간을 바꿔 중간값 도달 trace를 탐색하는 도구
│  │  │  │  ├─ coverage_analyzer.py               # 0~100 모든 정수의 도달 여부와 중복 trace를 분석하는 도구
│  │  │  │  ├─ distribution_score.py              # 극단값 비율과 중간값 희귀성을 하나의 보정 점수로 계산하는 도구
│  │  │  │  └─ calibration_report.py              # 선택된 전역 파라미터와 근거를 사람이 읽는 보고서로 출력하는 모듈
│  │  │  │
│  │  │  ├─ packaging/
│  │  │  │  ├─ mode_binary_writer.py              # 모드 수치 배열을 버전된 압축 바이너리로 직렬화하는 writer
│  │  │  │  ├─ response_binary_writer.py          # 복소 응답 표를 런타임 조회에 적합한 바이너리로 쓰는 writer
│  │  │  │  ├─ ktx2_encoder.py                    # 변위·노멀·모래 atlas를 GPU 압축 텍스처로 변환하는 adapter
│  │  │  │  ├─ manifest_builder.py                # 파일 위치, 단위, 해시, 호환 버전을 manifest로 조립하는 빌더
│  │  │  │  ├─ provenance_builder.py              # 솔버·메시·사양·환경 정보를 provenance 문서로 만드는 빌더
│  │  │  │  ├─ checksum_writer.py                 # 배포 파일의 콘텐츠 해시 목록을 생성하는 모듈
│  │  │  │  └─ content_addressed_store.py          # 데이터셋 해시를 디렉터리 이름으로 사용하는 저장소 writer
│  │  │  │
│  │  │  └─ validation/
│  │  │     ├─ schema_validation.py               # 모든 입력·출력 JSON을 공유 Schema로 검증하는 모듈
│  │  │     ├─ physical_validation.py             # 질량, 두께, 주파수, 유한값, 직교성을 검사하는 물리 검증기
│  │  │     ├─ texture_validation.py              # 해상도, 채널, UV, mode ID 일치를 검사하는 텍스처 검증기
│  │  │     ├─ dataset_validation.py              # manifest가 참조한 전체 자산과 해시를 통합 검사하는 검증기
│  │  │     └─ determinism_validation.py          # 같은 사양에서 생성된 핵심 수치 해시가 재현되는지 검사하는 검증기
│  │  │
│  │  ├─ tests/
│  │  │  ├─ test_mandelbrot_field.py              # 알려진 좌표의 escape-time과 좌표 변환을 검사하는 테스트
│  │  │  ├─ test_feature_filter.py                # 최소 특징 크기 필터가 총질량과 연결성을 깨지 않는지 검사하는 테스트
│  │  │  ├─ test_mesh_quality.py                  # 고의로 손상된 메시를 품질 검증기가 탐지하는지 검사하는 테스트
│  │  │  ├─ test_mode_normalization.py            # 질량 정규화와 부호 기준의 일관성을 검사하는 테스트
│  │  │  ├─ test_texture_alignment.py             # 변위·모래·노멀 텍스처의 픽셀 좌표 정렬을 검사하는 테스트
│  │  │  └─ test_dataset_packaging.py             # 완성 데이터셋이 공유 계약과 해시 검증을 통과하는지 검사하는 테스트
│  │  ├─ pyproject.toml                           # Python 의존성, CLI entry point, 테스트·정적 검사 설정을 선언하는 파일
│  │  ├─ uv.lock                                  # 오프라인 생성 환경의 Python 패키지 버전을 재현 가능하게 고정하는 lockfile
│  │  └─ README.md                                # 물리 자산 생성 명령과 외부 솔버 요구사항만 설명하는 도구 문서
│  │
│  ├─ dataset-inspector/
│  │  ├─ src/
│  │  │  ├─ main.ts                               # 로컬 데이터셋을 읽어 모드와 응답을 검사하는 개발 도구 진입점
│  │  │  ├─ mode-browser.ts                       # 고유주파수 순서대로 모드 텍스처와 결합계수를 탐색하는 화면
│  │  │  ├─ response-plot.ts                      # 복소 응답 크기와 위상을 주파수에 따라 그리는 검사 도구
│  │  │  ├─ coverage-browser.ts                   # 각 볼륨값의 증명 trace를 재생하고 비교하는 검사 도구
│  │  │  └─ provenance-panel.ts                   # 데이터셋 사양·솔버·수렴 정보를 읽기 전용으로 표시하는 패널
│  │  ├─ index.html                               # 개발용 inspector mount 지점을 제공하는 HTML
│  │  ├─ package.json                             # 배포 앱과 분리된 내부 검사 도구 의존성을 선언하는 manifest
│  │  ├─ tsconfig.json                            # inspector 전용 TypeScript 설정
│  │  └─ vite.config.ts                           # 로컬 파일·개발 서버에서 데이터셋을 읽는 Vite 설정
│  │
│  ├─ schema-codegen/
│  │  ├─ src/
│  │  │  ├─ generate-types.mjs                    # JSON Schema에서 반복되는 TypeScript 타입 생성을 자동화하는 스크립트
│  │  │  ├─ generate-validators.mjs               # 런타임에 사용할 경량 검증 함수를 생성하는 스크립트
│  │  │  └─ check-drift.mjs                       # Schema와 생성 타입이 어긋났는지 CI에서 검사하는 스크립트
│  │  └─ package.json                             # 코드 생성 도구의 Node 의존성과 실행 명령을 선언하는 manifest
│  │
│  └─ release-packager/
│     ├─ src/
│     │  ├─ stage-runtime-assets.mjs               # 선택한 content-addressed 데이터셋을 웹 dist에 복사하는 스크립트
│     │  ├─ verify-release.mjs                     # HTML, manifest, 자산 해시, 라이선스를 배포 전 통합 검사하는 스크립트
│     │  ├─ build-provenance.mjs                   # 웹 commit과 물리 데이터셋 ID를 하나의 release provenance로 묶는 스크립트
│     │  └─ write-security-headers.mjs             # 정적 호스팅용 CSP와 보안 헤더 파일을 생성하는 스크립트
│     └─ package.json                              # 릴리스 패키징 도구의 의존성과 명령을 선언하는 manifest
│
├─ specs/
│  ├─ plate/
│  │  ├─ mandelbrot-plate.v1.yaml                 # 판 치수, 재료, 고정 조건, 만델브로 물성 매핑의 canonical 사양
│  │  ├─ manufacturing-limits.v1.yaml             # 최소 특징 크기, 최소 두께, 총질량 범위를 정의하는 제조 제약 사양
│  │  └─ solver-request.v1.yaml                   # 모드 수, 주파수 범위, 수렴 수준을 정의하는 해석 요청 사양
│  ├─ runtime/
│  │  ├─ feedback.v1.yaml                         # 피드백 지연, 이득, 게이트, 클리퍼, 리미터의 canonical 설정
│  │  ├─ dial.v1.yaml                             # 다이얼 회전 범위, 로그 주파수 매핑, 관성 한계를 정의하는 설정
│  │  ├─ volume-map.v1.yaml                       # 가상 RMS와 0~100 출력 간의 단일 매핑 규칙을 정의하는 설정
│  │  └─ audio-safety.v1.yaml                     # 실제 Web Audio RMS·피크·대역 상한을 정의하는 안전 설정
│  ├─ visual/
│  │  ├─ scene.v1.yaml                            # 스피커·판·마이크·케이블의 공간 배치와 카메라 기준을 정의하는 사양
│  │  ├─ quality-tiers.v1.yaml                    # 렌더 품질 단계별 텍스처·후처리·입자 예산을 정의하는 사양
│  │  └─ motion-safety.v1.yaml                    # 플래시, 흔들림, 감소된 모션의 상한을 정의하는 사양
│  └─ challenge/
│     ├─ host-contract.v1.json                    # 외부 컨테스트 페이지가 목표값과 결과를 주고받는 최소 계약
│     └─ sample-targets.v1.json                   # 로컬 E2E에서 사용할 대표 목표 볼륨 목록
│
├─ assets/
│  ├─ source/
│  │  ├─ scene/
│  │  │  ├─ mandelhowl-scene.blend                # 스피커·판·마이크·케이블의 원본 3D 장면 파일
│  │  │  ├─ speaker-source.glb                    # 스피커 메시의 교환용 원본 export
│  │  │  ├─ microphone-source.glb                 # 마이크 메시의 교환용 원본 export
│  │  │  └─ cable-paths.json                      # 케이블 중심선과 신호 흐름 방향의 원본 경로 데이터
│  │  ├─ materials/
│  │  │  ├─ brushed-metal-source.png              # 금속판 재질 제작을 위한 원본 고해상도 표면 자료
│  │  │  ├─ speaker-cone-source.png               # 스피커 콘 재질 제작을 위한 원본 표면 자료
│  │  │  └─ sand-grain-source.png                 # 모래 점 sprite 제작을 위한 원본 입자 자료
│  │  └─ audio/
│  │     ├─ mechanical-click.wav                  # 다이얼 물리 클릭을 표현하는 짧은 원본 효과음
│  │     ├─ limiter-tick.wav                      # 가상 리미터 작동을 알리는 절제된 원본 효과음
│  │     └─ room-impulse.wav                      # 안전한 가상 공간감을 위한 원본 임펄스 응답
│  ├─ generated/
│  │  └─ .gitkeep                                 # content-addressed 데이터셋이 생성될 위치를 저장소에 유지하는 표식
│  └─ fixtures/
│     ├─ tiny-dataset/                            # CI와 단위 테스트에 사용하는 소형 합성 데이터셋 디렉터리
│     └─ corrupted-dataset/                       # 해시·텍스처 누락 오류를 검증하는 손상 fixture 디렉터리
│
├─ tests/
│  ├─ integration/
│  │  ├─ dial-to-volume.test.ts                   # 다이얼 trace가 앱 조율 계층을 거쳐 예상 볼륨으로 이어지는 통합 테스트
│  │  ├─ dataset-to-render.test.ts                # 실제 dataset snapshot이 올바른 모드 텍스처를 선택하는지 검사하는 통합 테스트
│  │  ├─ dataset-to-audio.test.ts                 # 실제 dataset snapshot이 안전한 오디오 파라미터로 변환되는지 검사하는 통합 테스트
│  │  └─ error-recovery.test.ts                   # 자산·GPU·오디오 실패가 지정된 fallback으로 전환되는지 검사하는 통합 테스트
│  ├─ e2e/
│  │  ├─ one-input-one-output.spec.ts             # 화면에 필수 조절 입력이 다이얼 하나뿐인지 검사하는 브라우저 테스트
│  │  ├─ direct-dial-rotation.spec.ts              # 마우스 원호 드래그가 연속 회전과 주파수 변화를 만드는지 검사하는 테스트
│  │  ├─ target-volume.spec.ts                    # 제공된 목표값에 도달했을 때 host contract가 결과를 보고하는지 검사하는 테스트
│  │  ├─ keyboard-dial.spec.ts                    # 키보드가 동일한 다이얼 의미를 제공하는지 검사하는 접근성 테스트
│  │  ├─ reduced-motion.spec.ts                   # 감소된 모션에서도 상태와 출력이 읽히는지 검사하는 테스트
│  │  ├─ webgl-fallback.spec.ts                   # WebGL 차단 환경에서 Canvas fallback이 동작하는지 검사하는 테스트
│  │  └─ audio-activation.spec.ts                 # 사용자 제스처 전후의 AudioContext 상태를 검사하는 테스트
│  ├─ science/
│  │  ├─ modal-orthogonality.test.py              # 배포 모드가 질량 기준 직교성 허용오차를 지키는지 검사하는 테스트
│  │  ├─ convergence-report.test.py               # 데이터셋에 필수 메시 수렴 증거가 있는지 검사하는 테스트
│  │  ├─ response-consistency.test.py             # 결합계수와 response table이 서로 모순되지 않는지 검사하는 테스트
│  │  ├─ texture-mode-match.test.py               # 각 텍스처의 마디선이 대응 모드 변위와 일치하는지 검사하는 테스트
│  │  └─ reachability.test.py                     # 0~100 각 값의 증명 trace가 실제 엔진에서 재현되는지 검사하는 테스트
│  ├─ visual/
│  │  ├─ snapshots.ts                             # 감쇠·임계·성장·포화 대표 snapshot을 한곳에서 정의하는 파일
│  │  ├─ plate-visual.spec.ts                     # 모드별 판·모래 표현의 시각 회귀를 검사하는 테스트
│  │  ├─ device-layout.spec.ts                    # 다양한 화면비에서 장치 인과관계가 유지되는지 검사하는 테스트
│  │  └─ diagnostic-layout.spec.ts                # 오류 화면이 핵심 안전 정보와 복구 상태를 가리지 않는지 검사하는 테스트
│  ├─ performance/
│  │  ├─ long-session.spec.ts                     # 장시간 회전과 포화 반복에서 메모리·노드가 누적되지 않는지 검사하는 테스트
│  │  ├─ frame-budget.spec.ts                     # 대표 장면의 프레임 시간과 quality tier 전환을 검사하는 테스트
│  │  └─ asset-load-budget.spec.ts                # 초기 shell과 지연 atlas 로딩이 예산 파일을 지키는지 검사하는 테스트
│  └─ fixtures/
│     ├─ traces/
│     │  ├─ volume-000.json                       # 완전 감쇠 출력을 재현하는 공식 gesture trace
│     │  ├─ volume-050.json                       # 임계 비팅으로 중간값 50을 재현하는 공식 gesture trace
│     │  └─ volume-100.json                       # 리미터 포화 출력을 재현하는 공식 gesture trace
│     └─ browsers/
│        └─ no-webgl.json                         # capability fallback 테스트용 브라우저 환경 fixture
│
├─ docs/
│  ├─ handoff.md                                  # 프로젝트 목표와 과학·UX·아키텍처 계약을 담는 정식 핸드오프
│  ├─ file-structure.md                           # 이 트리와 책임 경계를 유지하는 정식 파일 구조 문서
│  ├─ scientific-basis.md                         # 확립된 물리와 창작적 결합을 구분해 설명하는 과학 근거 문서
│  ├─ plate-model.md                              # 판 물성, 경계조건, 단위, 제조 가능한 해상도를 설명하는 모델 문서
│  ├─ feedback-model.md                           # 감쇠·성장·포화·임계 버스트의 계산 규칙을 설명하는 문서
│  ├─ interaction-contract.md                     # 단일 다이얼 입력과 단일 볼륨 출력의 UX 계약 문서
│  ├─ asset-pipeline.md                           # 사양에서 모드·텍스처·manifest까지 생성되는 흐름을 설명하는 문서
│  ├─ diagnostics.md                              # 진단 코드와 증거 상태를 해석하는 문서
│  ├─ audio-safety.md                             # 가상 볼륨과 실제 청취 레벨 분리 및 안전 체인을 설명하는 문서
│  └─ release-provenance.md                       # 웹 commit과 물리 dataset을 연결하는 배포 provenance 규칙 문서
│
├─ scripts/
│  ├─ generate-contracts.mjs                      # JSON Schema 기반 타입과 validator를 한 번에 생성하는 루트 스크립트
│  ├─ validate-all.mjs                            # 웹, 계약, 데이터셋, 문서 drift 검사를 순서대로 실행하는 통합 검증 스크립트
│  ├─ build-web.mjs                               # 선택된 dataset ID를 고정하고 웹 배포물을 만드는 스크립트
│  ├─ run-e2e.mjs                                 # 정적 서버 시작과 Playwright 종료를 안전하게 조율하는 스크립트
│  ├─ stage-dataset.mjs                           # content-addressed dataset을 로컬 개발 경로에 연결하는 스크립트
│  └─ clean-generated.mjs                         # 파생 산출물만 삭제하고 canonical 사양과 원본 자산은 보존하는 정리 스크립트
│
├─ docker/
│  ├─ physics-baker.Dockerfile                    # 외부 유한요소 솔버와 Python 도구 환경을 digest로 고정하는 이미지 정의
│  ├─ physics-baker-entrypoint.sh                  # 컨테이너 내부 단위·경로·권한을 검증한 뒤 CLI를 실행하는 진입 스크립트
│  └─ README.md                                   # 동일 데이터셋 재생성을 위한 컨테이너 사용법만 설명하는 문서
│
├─ .editorconfig                                  # 언어별 들여쓰기와 줄 끝을 통일하는 편집기 설정
├─ .gitattributes                                 # 바이너리 자산, 텍스트 정규화, 대형 원본의 Git 처리 규칙
├─ .gitignore                                     # dist, 캐시, 생성 dataset, 솔버 임시 파일을 제외하는 규칙
├─ .npmrc                                         # workspace 설치 정책과 lockfile 엄격성을 설정하는 pnpm 구성
├─ .python-version                                # 물리 도구가 사용하는 Python 실행 계열을 고정하는 파일
├─ .tool-versions                                 # Node·Python·외부 도구 버전의 로컬 개발 기준을 모으는 파일
├─ eslint.config.mjs                              # 패키지 경계, 순환 의존성, DOM 금지 규칙을 포함하는 ESLint 설정
├─ package.json                                   # 루트 명령과 workspace 개발 의존성을 선언하는 manifest
├─ pnpm-lock.yaml                                 # 웹·도구 Node 의존성을 재현 가능하게 고정하는 lockfile
├─ pnpm-workspace.yaml                            # apps, packages, Node 기반 tools의 workspace 범위를 선언하는 파일
├─ playwright.config.ts                           # E2E 브라우저, 로컬 서버, 스크린샷 정책을 정의하는 설정
├─ tsconfig.base.json                             # 엄격한 타입 검사와 공통 module 정책을 정의하는 TypeScript 기반 설정
├─ vitest.workspace.ts                           # 패키지별 단위·통합 테스트 프로젝트를 묶는 Vitest 설정
├─ LICENSE                                        # 프로젝트 소스의 사용 조건을 명시하는 라이선스
├─ THIRD_PARTY_NOTICES.md                         # 솔버, 압축기, 원본 자산의 제3자 고지를 모으는 문서
├─ SECURITY.md                                    # 취약점 신고 경로와 권한·오디오 안전 범위를 설명하는 문서
├─ CONTRIBUTING.md                                # 사양 변경, 생성 자산 재생성, 검증 요구사항을 설명하는 기여 지침
└─ README.md                                      # 작품 개요와 최소 실행 명령만 제공하고 상세 설계 문서로 연결하는 입구 문서
```

---

## 3. 핵심 의존성 방향

```text
packages/contracts
      ↑
      ├─ packages/dial-engine
      ├─ packages/resonance-engine
      ├─ packages/asset-runtime
      ├─ packages/render-engine
      ├─ packages/audio-engine
      └─ packages/diagnostics
                     ↑
                  apps/web
```

오프라인 파이프라인은 TypeScript 내부 구현을 직접 import하지 않는다.
`packages/contracts/schemas/`의 JSON Schema, versioned 바이너리 포맷과
`specs/physics/baker-algorithm.v1.json`을 통해 연결한다.

```text
specs/*
  ├─ tools/physics-baker-rs ─┐
  └─ tools/physics-baker ────┤
                             ↓
                 tools/baker-supervisor
                             ↓
assets/generated/<dataset-hash>/
  ↓
packages/asset-runtime
  ↓
packages/resonance-engine
  ↓
render-engine + audio-engine + DOM views
```

---

## 4. canonical ownership 규칙

| 데이터 | 유일한 수정 위치 | 파생 위치 |
|---|---|---|
| 판 치수·재료·만델브로 매핑 | `specs/plate/` | 메시, 모드, 텍스처, manifest |
| 피드백 이득·지연·리미터 | `specs/runtime/feedback.v1.yaml` | 런타임 설정, coverage report |
| 다이얼 범위·주파수 매핑 | `specs/runtime/dial.v1.yaml` | dial engine 초기 상태 |
| 가상 RMS→볼륨 변환 | `specs/runtime/volume-map.v1.yaml` | volume mapper 상수 |
| 실제 청취 안전 상한 | `specs/runtime/audio-safety.v1.yaml` | audio graph 파라미터 |
| UI N-version 선택·ownership | `specs/runtime/ui-nversion.v1.json` | generated digest, supervisor와 release provenance |
| Baker 수치 알고리즘 | `specs/physics/baker-algorithm.v1.json` | Python/Rust generator, semantic comparator |
| Baker 선택·승격 정책 | `specs/physics/baker-nversion.v1.json` | broker, attestation, release verifier |
| 직렬화 구조 | `packages/contracts/schemas/` | TypeScript 타입, Python validator |
| 생성된 모드·텍스처 | 수정 금지 | 사양 또는 baker 변경 후 재생성 |
| 화면 레이아웃 기준 | `specs/visual/scene.v1.yaml` | renderer와 CSS view model |

동일한 상수를 여러 패키지에 복사하지 않는다. 런타임 성능을 위해 생성 코드에 상수를 굽는 경우에도 원본 spec hash를 포함하고 drift 검사를 둔다.

---

## 5. 런타임 데이터 흐름

```text
PointerEvent / KeyboardEvent
        ↓
Svelte primary / React standby
        ↓
generation-scoped input lease
        ↓
packages/browser-runtime/dial-input
        ↓
packages/dial-engine
        ↓
frequency + sweep history
        ↓
packages/resonance-engine
        ↓
RuntimeSnapshot
   ┌────┼───────────┐
   ↓    ↓           ↓
UI port  WebGL    Web Audio
Svelte/React      safe sound
```

볼륨 계산은 `resonance-engine/volume-mapper.ts` 한 곳만 소유한다. DOM, 렌더러, 오디오 엔진은 표시·재생을 위해 snapshot을 읽을 뿐 값을 다시 계산하지 않는다.
UI failover는 view만 detach하고 같은 runtime snapshot sequence를 유지한다.

---

## 6. 오프라인 데이터 흐름

```text
mandelbrot-plate.v1.yaml + baker-algorithm.v1.json
        ├──────────────────────┐
        ↓                      ↓
Rust native generator     Python stdlib generator
        ↓                      ↓
독립 candidate dataset   독립 candidate dataset
        └──────────┬───────────┘
                   ↓
        semantic differential broker
                   ↓
   dual-verified / degraded / split-brain
                   ↓
      explicit promotion + report attestation
                   ↓
        content-addressed runtime dataset
```

각 backend 내부의 동일한 알고리즘 단계는 다음과 같다.

```text
만델브로 수치장 생성
        ↓
두께·질량·제조 제약 적용
        ↓
메시 생성 및 품질 검증
        ↓
고유값 해석
        ↓
수렴성·교차검증
        ↓
결합계수·응답·마디선 계산
        ↓
변위·노멀·모래 텍스처 생성
        ↓
피드백 보정과 0~100 도달성 검증
        ↓
content-addressed runtime dataset
```

생성 단계 중 어느 하나가 실패하면 불완전한 dataset을 배포 경로에 쓰지 않는다. 임시 디렉터리에서 전부 검증한 뒤 원자적으로 최종 디렉터리로 이동한다.
Rust가 실행 표면 문제로 unavailable이면 Python candidate로 degraded 운영할 수
있지만 승격·release는 금지한다. 과학적 불일치나 거부는 split-brain이며 검증된
last-known-good pin을 유지한다.

---

## 7. 파일 분리 판단 기준

- 입력 좌표 처리와 다이얼 물리는 분리한다.
- 다이얼 물리와 공진 물리는 분리한다.
- 공진 계산과 화면 연출은 분리한다.
- 가상 볼륨과 실제 청취 게인은 분리한다.
- 데이터셋 로딩과 데이터셋 사용은 분리한다.
- 솔버 실행과 결과 후처리는 분리한다.
- 수치 결과와 텍스처 인코딩은 분리한다.
- 진단 생성과 사용자 문구 변환은 분리한다.
- 생성 자산과 원본 사양은 분리한다.
- 테스트 fixture와 프로덕션 dataset은 분리한다.

파일이 여러 상태의 canonical owner가 되거나, 서로 다른 이유로 변경되는 로직을 함께 포함하면 더 분리한다. 반대로 단순 pass-through 파일을 늘리기 위한 분리는 피한다.

---

## 8. 생성물 저장 정책

- 원본 3D 장면과 소형 배포용 데이터셋만 저장소 정책에 따라 추적한다.
- 대형 솔버 중간 결과와 임시 메시 파일은 추적하지 않는다.
- 배포 데이터셋 디렉터리 이름은 content hash로 결정한다.
- `latest` 같은 가변 별칭은 개발 편의에만 사용하고 release manifest에는 고정 hash를 기록한다.
- dataset 내부 파일을 수동 교체하지 않는다.
- 웹 commit과 dataset hash의 조합을 release provenance에 기록한다.
- 동일 사양 재생성 결과가 플랫폼 특성으로 미세하게 달라질 수 있는 텍스처는 허용오차 기반 검증과 도구 버전 digest를 함께 기록한다.

---

## 9. 구조상 금지 사항

- `apps/web` 안에 유한요소 계산 코드를 넣지 않는다.
- 렌더 셰이더에서 최종 볼륨을 계산하지 않는다.
- 오디오 노드의 실제 게인을 가상 볼륨 0~100과 직접 1:1로 연결하지 않는다.
- 특정 정수 볼륨을 만들기 위한 주파수별 예외 분기를 넣지 않는다.
- 실제 마이크 권한을 요구하는 코드를 핵심 흐름에 넣지 않는다.
- 생성된 JSON, 바이너리, 텍스처를 사람이 직접 수정하는 운영을 허용하지 않는다.
- `utils.ts`, `common.ts`, `helpers.ts`에 서로 무관한 로직을 모으지 않는다.
- DOM event 객체를 resonance engine까지 전달하지 않는다.
- WebGL 객체를 app state나 domain state에 저장하지 않는다.
- 오류를 `console.error`만 남기고 사용자·진단 계층에 전달하지 않는 경로를 만들지 않는다.
- test fixture를 프로덕션 fallback으로 재사용하지 않는다.
