# MandelHowl 핸드오프 구현 감사

감사 기준일: 2026-07-29  
감사 범위: `MandelHowl_핸드오프.md`, `MandelHowl_파일_구조.md`, 현재
git-tracked 소스

## 결론

핸드오프의 방향과 핵심 경계는 현재 코드에 적절히 반영되어 있지만, 핸드오프의
모든 완료 조건이 구현된 상태는 아니다. 현재 결과물은 다이얼부터 결정적
프로토타입 공진, 동일 snapshot 기반 화면·Canvas·오디오까지 연결된 **A 단계와
D 단계의 첫 수직 슬라이스**다.

특히 다음 네 묶음은 제작 완료 전에 반드시 이어져야 한다.

1. 실제 만델브로 물성장을 사용하는 FEM 생성·수렴성·provenance 파이프라인
2. 해시 검증 manifest, 모달 바이너리, KTX2 atlas를 읽는 런타임 자산 계층
3. 모든 `1..99`의 재현 가능한 입력 trace와 0/100 분포를 증명하는 도달성 도구
4. capability 진단, WebGL/Canvas 품질 계층, 오디오 상한·장시간·시각 회귀 검증

## 즉시 해결해야 할 canonical drift

계약 파일은 존재하지만 앱이 이를 생성물로 읽지 않고 상수를 수동 복제해, 현재
canonical 사양과 실행 코드 사이에 다음 불일치가 있다.

| 항목 | canonical 사양 | 현재 프로토타입 런타임 |
|---|---|---|
| 주파수 범위 | `45..6000 Hz` (`dial.v1.yaml`, plate spec) | `52..1250 Hz` (dial engine, fixture, UI) |
| 공진 고정 스텝 | `1/240 s` | `1/120 s` |
| 최대 catch-up | `0.1 s` | `0.25 s` |
| 볼륨 매핑 | RMS `0.003..0.62`, logarithmic dB | RMS `0.018..0.86`, smoothstep |

또한 prototype dataset은 각 모드의 `radialOrder`와 `angularOrder`를 갖지만,
Canvas painter는 아직 active-mode 인덱스에서 별도 차수를 재계산한다. 이는
핸드오프 13.1의 canonical ownership과 “동일 modal state를 시각화가 읽는다”는
요구를 충족하지 못한다.

따라서 다음 구현의 최우선 순위는 `spec → 생성된 runtime config → 엔진` 경로와
drift 검사를 만드는 것이다. 이번 critical 반폭 `0.025`는 사양과 코드에 함께
반영했지만, 자동 생성·검증이 생기기 전까지는 수동 이중 관리라는 한계가 남는다.

## 그 밖의 주요 계약 이탈

| 우선순위 | 요구 | 현재 확인된 이탈 |
|---|---|---|
| P0 | 측정 중 `MEASURING`, 마지막 확정값 보존 | `getResonanceSnapshot()`과 UI가 측정 중에도 순간 볼륨 숫자를 계속 노출한다. canonical `RuntimeSnapshot`의 measuring/settled union은 실제 앱에서 사용되지 않는다. |
| P0 | 명시적인 오디오 안전 체인과 상한 증명 | 현재 그래프는 oscillator→low-pass→compressor→gain이다. DC blocker, high-pass band limiter, soft clipper, 독립 RMS/peak limiter, exposure guard와 피크·RMS 자동 검증은 없다. 낮은 최대 gain은 유효한 1차 방어지만 완료 증거는 아니다. |
| P0 | 확인 가능한 진단·fallback | 진단 타입은 있으나 manifest/KTX2/WebGL2/Audio capability probe, 진단 builder, 사용자/개발자용 presenter와 복구 정책이 연결되지 않았다. |
| P1 | 한 프레임의 단일 snapshot | Canvas와 오디오는 매 animation frame, DOM은 약 32ms마다 갱신된다. 같은 코어 상태에서 파생되지만 핸드오프의 “같은 프레임” 계약은 엄격히 보장하지 않는다. |
| P1 | 모든 입력 어댑터의 같은 회전 이력 의미 | 키보드·휠 nudge는 현재 sweep와 approach direction을 0으로 만들어 포인터 회전과 이력 의미가 다를 수 있다. `lostpointercapture` 정리 경로도 없다. |
| P1 | 스크린 리더에 안정된 확정값 알림 | 빠르게 변하는 전체 볼륨 영역이 `aria-live`여서 과도한 알림이 생길 수 있다. measuring/settled 계약을 구현한 뒤 확정값만 알리는 검증이 필요하다. |
| P1 | 숨김 전 실제 fade-out | gain ramp를 예약한 직후 AudioContext를 suspend하므로 ramp가 진행된다는 보장이 없다. 즉시 음소거는 되지만 지정된 fade lifecycle과 다르다. |
| P1 | 시각 계측과 데이터 정합 | 오실로스코프·위상 강조가 없고 Canvas는 실제 모드 텍스처를 읽지 않는다. 스피커·케이블의 일부 움직임도 주파수/신호 대신 포락선 또는 상시 CSS animation에 의존한다. |

## 완료 품질 기준 감사

상태 표기:

- **구현**: 현재 소스에서 요구의 핵심 동작과 경계가 확인됨
- **부분**: 계약 또는 프로토타입 동작은 있으나 완료 증거가 부족함
- **미구현**: 제작용 자산, 파이프라인 또는 검증 증거가 없음

| # | 핸드오프 완료 기준 | 상태 | 현재 근거와 남은 일 |
|---:|---|---|---|
| 1 | 첫 화면의 인과관계가 즉시 읽힘 | 부분 | `app/mandelhowl-scene.tsx`가 스피커→판→마이크→피드백→볼륨을 한 장면에 배치한다. 고정 snapshot 시각 회귀와 사용자 검증은 없다. |
| 2 | 개념적 입력은 회전 다이얼 하나 | 구현 | `app/mandelhowl-lab.tsx`의 포인터·키보드·휠은 모두 `packages/dial-engine`의 같은 명령 경계로 들어간다. 오디오 활성화는 다이얼 사용의 부수 효과다. |
| 3 | 핵심 출력은 0..100 정수 하나 | 구현 | `packages/resonance-engine/src/resonance-engine.ts`의 단일 볼륨 매퍼와 장면의 `VOLUME` 표시가 같은 snapshot을 사용한다. |
| 4 | 대부분의 안정 입력이 0 또는 100 | 부분 | 강한 모드의 100과 비공진의 0 단위 테스트는 있다. 균일 주파수 표본에서 90% 이상인지 측정한 분포 보고서는 없다. |
| 5 | 모든 1..99가 재현 가능한 이력으로 도달 | 미구현 | trajectory search, 공식 gesture trace, 도달성 보고서와 재생 검증이 없다. |
| 6 | 핵심 출력에 난수·정수별 lookup 없음 | 구현 | 공진 코어는 고정 스텝·전역 수식으로 동작하고 `Math.random()`이나 정수별 예외가 없다. Canvas의 입자 배치는 입력으로부터 결정적으로 계산된다. |
| 7 | Chladni 무늬가 오프라인 해석 텍스처와 연결 | 미구현 | `packages/render-engine/src/plate-painter.ts`는 분석적 프로토타입 패턴이다. FEM 모드 텍스처와 KTX2 atlas가 없다. |
| 8 | 만델브로가 실제 판 물성에 반영 | 부분 | `specs/plate/mandelbrot-plate.v1.yaml`과 계약은 물성 매핑을 정의한다. 그 사양으로 생성한 메시·고유모드가 런타임에 연결되지는 않았다. |
| 9 | 모래 무늬를 만델브로 실루엣으로 오인시키지 않음 | 부분 | `README.md`, dataset provenance, 화면 footer는 프로토타입임을 밝힌다. 다만 장면의 `Mandelbrot-encoded` 설명은 실제 물성 dataset 연결 전에는 가까운 위치에 prototype 한정을 함께 두어야 안전하다. |
| 10 | 가상 100과 기기 최대 음량을 분리 | 구현 | `packages/audio-engine/src/safe-audio-engine.ts`는 가상 볼륨 숫자를 받지 않고 포락선만 받아 출력 gain을 `0.045`로 독립 제한한다. |
| 11 | 실제 마이크 권한 없이 재현 | 구현 | 실제 입력 장치 API를 사용하지 않으며 `specs/runtime/audio-safety.v1.yaml`도 마이크 권한을 금지한다. |
| 12 | 동일 데이터셋·입력 trace의 결정성 | 부분 | 공진 동일 입력 단위 테스트는 통과한다. 기록 가능한 gesture trace 포맷, 프레임률 교차 검증, 공식 replay fixture가 없고 키보드·휠의 이력 의미도 포인터와 완전히 같지 않다. |
| 13 | 렌더 품질/fallback이 볼륨을 바꾸지 않음 | 부분 | 현재 Canvas painter는 공진 엔진의 snapshot을 읽기만 하므로 계산 경계는 분리됐다. WebGL2 품질 계층과 fallback 전환 검증은 없다. |
| 14 | dataset에 사양·솔버·메시·수렴성·해시 provenance 포함 | 미구현 | TypeScript·JSON Schema 계약만 있다. 실제 content-addressed 제작 dataset과 generation report는 없다. |
| 15 | 오류를 진단 코드와 근거로 보고 | 부분 | `packages/contracts/src/diagnostic-record.ts` 계약은 있으나 capability probe, 진단 생성기, 사용자/개발자 presenter가 런타임에 연결되지 않았다. |
| 16 | 키보드·터치·스크린 리더가 같은 다이얼 의미 사용 | 부분 | Pointer Events, 키보드, ARIA slider가 같은 엔진을 사용한다. 키보드·휠은 회전 이력 일부를 만들지 않으며, 스크린 리더·터치·포인터 캡처 손실의 브라우저 E2E 증거도 없다. |
| 17 | 감소된 모션에서도 상태·출력 이해 가능 | 부분 | CSS와 Canvas가 `prefers-reduced-motion`을 반영하고 숫자·상태 문구는 유지된다. 대표 상태 시각 회귀는 없다. |
| 18 | 장시간 실행 시 메모리·오디오 노드가 누적되지 않음 | 부분 | 오디오 노드는 한 번 구성되고 숨김·pagehide·unmount에서 suspend/dispose된다. 장시간 soak와 노드 수 회귀 테스트는 없다. |

요약하면 완료 기준 18개 중 **구현 5개, 부분 10개, 미구현 3개**다.
부분 항목에는 과학 자산과 검증 증거처럼 출시를 막는 요구가 포함되므로, 개수만으로
완성도를 해석하면 안 된다.

## 권장 구현 단계 대비 상태

| 단계 | 상태 | 판단 |
|---|---|---|
| A0 계약 고정 | 부분 | plate, manifest, runtime snapshot 계약과 사양은 있다. 계약 생성·schema 검증 자동화가 없고 실행 상수와 drift가 있다. |
| A1 다이얼 엔진 | 부분 | unwrap, 이상치/중심 dead zone, 속도, 로그 매핑, 관성, 끝단, 키보드·휠은 있다. 키보드·휠의 sweep 이력, lost-pointer-capture 정리, 공식 gesture trace와 replay 검증은 없다. |
| A2 데이터 없는 공진 코어 | 부분 | 결정적 fixture, 모드 에너지·위상, 마이크 합산, 성장·critical·감쇠·포화, 측정창은 있다. 핸드오프 사양의 명시적 지연선·필터·게이트·소프트 클리퍼·리미터 모델과 일치하지 않고 고정 스텝·볼륨 매핑도 canonical spec과 다르다. |
| B0 판 사양·물성장 | 부분 | canonical YAML/Schema만 있으며 생성·제조 가능성 검증 코드가 없다. |
| B1 메시·솔버 | 미구현 | 메시 생성, 솔버 어댑터, 고유값 해석·파싱이 없다. |
| B2 수렴성·provenance | 미구현 | 메시 수준 비교, 독립 참조 해석, generation report가 없다. |
| C0 모드 후처리 | 미구현 | 제작 FEM 모드의 결합계수·마디선·normal map 생성이 없다. |
| C1 자산 패키징 | 미구현 | 모달 바이너리, KTX2 atlas, checksum manifest가 없다. |
| D0 WebGL 장면 | 부분 | 인과관계 장면과 결정적 Canvas 판은 있다. WebGL2 렌더 패스·셰이더·품질 단계는 없다. |
| D1 앱 조율 | 부분 | 다이얼→고정 tick→공진 snapshot→DOM/Canvas/audio 흐름은 있다. DOM의 별도 32ms 갱신 때문에 같은 프레임 계약은 엄격히 충족하지 않으며 자산 로더, capability probe, 복구 정책도 없다. |
| D2 안전한 오디오 | 부분 | 사용자 제스처, 낮은 gain, 압축기, 숨김 suspend가 있다. canonical 안전 체인의 DC blocker, band limiter, soft clipper, 독립 RMS/peak limiter, 노출 guard, 상한 검증과 오류 진단은 없다. |
| E0 극단값·도달성 | 미구현 | 0/100 예시 테스트만 있고 분포·1..99 trajectory 증명이 없다. |
| E1 DDD 연출 | 부분 | 상태별 판·신호·계기 연출과 잔향 시각 흔적은 있다. 검증된 모드 데이터와 버스트 연출은 아직 프로토타입이다. |
| F0 진단·fallback·접근성 | 부분 | Canvas, ARIA, reduced motion은 있다. 무결성·WebGL2·KTX2·오디오 진단과 구조화 presenter는 없다. |
| F1 통합 검증 | 부분 | 공진 단위 테스트 7개와 SSR smoke test 2개가 있다. 물리, 프레임률/탭 재개, 입력 E2E, 오디오 상한, 시각 회귀, 장시간 성능, challenge harness 테스트는 없다. |
| G0 배포 패키징 | 부분 | 웹 빌드와 비공개 Sites 배포는 가능하다. dataset 버전 고정, release provenance, 제3자 고지, 명시적 보안 헤더 검증은 없다. |

## 이번 critical 범위 보정

`specs/runtime/feedback.v1.yaml`의 canonical 값과 프로토타입 공진 코어를 함께
조정했다.

- critical loop-margin 반폭: `0.075` → `0.025`
- 전체 critical 폭: `0.150` → `0.050`으로 약 66.7% 축소
- 잔류 포락선이 `0.08..0.76`이라는 이유만으로 critical로 분류하던 보조 조건 제거
- 모드별 release와 loop 감쇠식 `0.68 + |loopMargin| × 1.55`는 변경하지 않음
- 포화 우선 판정 `feedbackEnvelope >= 0.92`도 유지

따라서 기존 잔향의 시간 감각을 인위적으로 짧게 만들지 않고, 루프 이득이 실제
임계점에 가까운 경우에만 `critical` 동역학과 상태 표시가 유지된다.

## 다음 제작 게이트

다음 순서는 B0→B1→B2→C0→C1을 하나의 재현 가능한 물리 자산 파이프라인으로
완성한 뒤, E0 도달성 보정과 F/G 검증·배포 증거를 붙이는 것이다. 이 과정에서
현재의 `prototype-analytical-plate-v1`은 런타임 경계를 유지한 채 content-addressed
FEM dataset으로 교체해야 한다.
