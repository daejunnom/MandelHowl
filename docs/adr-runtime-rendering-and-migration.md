# ADR: 사전 계산 모드 렌더링과 구현체 이전 게이트

- 상태: Accepted
- 결정일: 2026-07-30
- 적용 범위: 중앙 금속판·모래 렌더링, 런타임 자산 로딩, UI와 오프라인
  baker의 향후 구현체 선택

## 배경

프로덕션 데이터셋에는 48개 모드의 signed displacement, normal, nodal mask,
sand density가 128×128×48 KTX2 array로 미리 계산되어 있다. 브라우저는 이
기저를 사용해야 하며 PDE, 메시 해석 또는 입자 동역학을 다시 풀지 않는다.

기존 렌더 경로는 이 자산을 검증하고 업로드했지만, 매 프레임 에너지가 가장 큰
모드 하나만 선택했다. 그 결과 다음 문제가 있었다.

- 이전 모드의 에너지가 남아 있으면 새로 포획한 모드가 즉시 보이지 않았다.
- 여러 모드의 비팅과 잔향이 하나의 모래 layer로 축약됐다.
- WebGL 판이 네 정점 quad여서 signed displacement가 실제 판 정점에
  반영되지 않았다.
- 연속 sand density가 실제 모래알보다 색칠된 면처럼 보였다.

이 문제는 사전 계산 자산의 부재가 아니라 마지막 런타임 합성 경로의 누락이다.

## 결정

### 1. canonical snapshot과 모드 선택

`RuntimeSnapshot.activeModeId`는 현재 구동이 포획한 모드의 식별자다. 잔류
에너지가 가장 큰 모드와 독립적이며, 포획 임계값을 넘는 모드가 없으면
`null`이다. 렌더러는 공진을 다시 판정하지 않고 이 값과 같은 snapshot의 모드별
에너지·진폭·위상을 읽는다.

렌더러별 고정 용량은 다음과 같다.

| 경로 | 합성 모드 수 | 적용 |
|---|---:|---|
| WebGL2 | top 4 | sand, nodal, normal, signed displacement |
| Canvas2D | top 2 | sand density |

선택은 잔류 시각 가중치가 큰 순서이며 동률은 dataset 모드 순서로 해소한다.
현재 포획 모드는 top-K 밖에 있더라도 마지막 slot에 포함한다. sand 가중치는
선택된 모드 안에서 정규화하고, WebGL 변위 계수는 물리 snapshot을 보존하는
`amplitudeNormalized × cos(phaseRad)`를 사용한다.

기존 `dominantModeId` 계산은 분석적 fallback과 보조 표시를 위해 남아 있지만,
검증된 atlas의 WebGL2·Canvas2D 합성 경로를 제한하지 않는다.

### 2. 다음 paint와 결정적 잔류

포획 identity는 공진 엔진에서 같은 fixed step에 계산되고 snapshot으로
전달된다. 렌더러는 다음 paint에서 새 포획 모드에 시각 가중치 하한 `0.085`를
적용한다. 이는 모래 패턴의 attack을 보이게 하는 표현 계층의 bias이며 물리
에너지나 볼륨을 수정하지 않는다. 실제 판 변위는 계속 canonical 모달 진폭과
위상만 사용한다.

시각 가중치는 attack `35 ms`, release `580 ms`의 지수 응답으로 전이한다.
한 번의 시각 적분 간격은 최대 `100 ms`로 제한한다. 입력 snapshot과 시뮬레이션
시간이 같으면 선택, 잔류, 출력 가중치도 같으며 `Math.random()`이나 벽시계를
사용하지 않는다. 고정 typed buffer와 snapshot writer를 재사용해 48개 모드
객체 graph를 렌더 프레임마다 새로 만들지 않는다.

renderer와 audio는 매 animation frame에 같은 writer lease를 동기적으로
소비하고 이를 보관하지 않는다. React, challenge, diagnostics는 같은 canonical
state와 sequence에서 만든 owned immutable snapshot을 최대 24 Hz로 받는다.
dataset 교체와 visibility reset에는 두 lane을 강제로 함께 발행한다. differential
unit test가 lease와 immutable projection의 필드 값을 비교한다.

이는 전체 런타임을 allocation-free라고 주장하는 결정이 아니다.
`advanceMandelHowlRuntime`의 immutable wrapper와 dial 갱신에는 작은 객체가
남아 있다. 이번 변경은 48-mode bulk projection과 renderer/audio 보조 frame
객체를 매 RAF 생성하던 비용을 제거하고, 장시간 누적이 없음을 soak로 검증하는
범위다.

### 3. 원형 금속판과 모래 표현

WebGL2 판은 품질 단계별 polar tessellation을 사용한다.

| 품질 | 방사 분할 | 각 분할 |
|---|---:|---:|
| high | 32 | 96 |
| balanced | 24 | 72 |
| reduced | 16 | 48 |

정점 셰이더는 선택된 최대 네 displacement layer를 샘플링해 원형 메시의
방사 변형과 투영 높이에 반영한다. fragment 셰이더는 같은 모드 집합의 normal,
nodal, sand layer를 혼합한다.

모래알은 별도 입자 물리를 주장하지 않는다. WebGL2는 화면 좌표의 고정 hash,
Canvas2D는 `(x, y, layer)` 정수 hash로 density의 alpha를 결정한다. 따라서
시간에 따라 무작위로 반짝이지 않으며 같은 입력·해상도에서는 같은 grain
패턴을 만든다. density가 0인 상태에 항상 남던 모래 가시성 하한은 제거하고,
전체 모래 가시성은 모달 presence에 연결한다.

### 4. content-hash 캐시와 검증 진행 단계

로더의 승격 순서는 다음과 같다.

1. `manifest.json`은 `no-cache`로 재검증하고 schema, dataset identity,
   release pin, runtime 호환성을 확인한다.
2. `modes.bin` → `response.bin` → `sand-density.ktx2`를 우선 요청한다.
3. 자산 URL에는 descriptor SHA-256을 query key로 포함하고 `force-cache`를
   사용한다. 생성 데이터셋은 content-addressed이고 `/runtime/*`에는
   immutable cache header가 적용된다.
4. 각 자산의 byte length와 SHA-256이 통과하면
   `mandelhowl.asset-progress.v1` 이벤트를 보낸다. 이 이벤트는 항상
   `datasetReady: false`이며 observer 오류는 검증 결과에 영향을 주지 않는다.
5. 나머지 atlas와 보고서를 병렬로 가져와 같은 검증을 수행한 뒤 checksum
   양방향 inventory, evidence, binary header, mode/texture 교차 일치를
   검사한다.
6. 모든 검사가 끝난 뒤에만 dataset을 `ready`로 반환하고 앱이
   `VERIFIED` 상태로 승격한다.

진행 이벤트는 검증된 개별 자산을 사용할 수 있는 경계다. 현재 프로덕션 앱은
검증된 sand atlas가 도착하면 canonical dataset·mode identity를 유지한 채
renderer에 먼저 decode/upload하여 GPU를 예열한다. prototype mode ID와
production mode ID를 배열 위치로 대응시키지 않으므로 로딩 중 잘못된 무늬를
표시하지 않는다. 최종 source는 같은 dataset의 resident sand texture를
재사용하고 나머지 atlas만 추가한다.

이 예열은 dataset 승격이 아니다. 전체 loader 결과가 `ready`이고 full source의
renderer 상태까지 확인되기 전에는 runtime dataset과 화면의 `datasetStatus`를
바꾸지 않는다. 실패하거나 component가 dispose되면 예열 texture를 제거하고
pending manifest/asset fetch를 abort하며 labelled prototype에 남는다.

현재 고정된 KTX2 v1은 종류별 48 layer가 하나의 monolithic 파일이므로, 한
모드나 주파수 구간만 독립적으로 fetch·hash 검증·evict할 수 없다. 현재의
progressive 경계는 core binary → 전체 sand atlas prewarm → 나머지 atlas
병렬 검증이다. 진정한 per-mode/range lazy residency는 chunk descriptor와
개별 checksum을 가진 atlas-v2 및 새 content hash가 필요하며, 기존 고정
dataset을 조용히 재해석하지 않는다.

KTX2 decoder는 검증된 `Uint8Array`를 직접 받고 payload를 `subarray` view로
노출한다. 렌더러 경로에서는 atlas 전체를 한 번 더 복사하지 않는다. 단, 진행
observer에는 검증 입력을 변경하지 못하도록 격리된 byte copy를 제공한다.

## `response.bin` 재통합 보류

`response.bin`은 manifest pin, byte length, SHA-256, binary format을
검증하고 `ResonanceDataset.response`로 디코딩한다. 런타임 모달 dataset도
이 aggregate complex table을 보존하며, endpoint clamp와 로그 주파수축
실수부·허수부 보간을 제공한다. science 검증은 512개 전 표본을 baker의
합산 전달함수와 다시 비교한다.

다만 `response-v1`은 모든 모드를 합산해 전역 peak로 정규화한 하나의 곡선이며
모드별 행이 아니다. 따라서 공진 적분기의 포획·에너지 가중치에는 사용할 수
없고, 그 경로는 계속 모드 주파수·감쇠·결합계수에서 analytical response를
계산한다.

이번 렌더 수정에 `response.bin` 사용을 함께 넣지 않는다. 응답 함수를 바꾸면
critical 폭, 0/100 극단 비율, 1..99 전체 도달 trace가 함께 달라질 수 있기
때문이다. 재통합은 다음을 모두 통과하는 별도 변경으로 진행한다.

- 45..6000 Hz sweep에서 complex table 보간과 현재 analytical 응답의
  differential report
- 모든 공식 gesture trace의 volume, regime, active mode 비교
- `0..100` coverage 독립 replay
- 필요 시 전역 calibration 재생성과 새 dataset/content hash 발행
- 기존 dataset을 조용히 재해석하지 않는 schema 또는 runtime 호환 버전 변경

## UI·baker 구현체 이전 게이트

프레임워크나 언어 변경은 현재 렌더 hot path의 정확성 수정과 분리한다.

### React에서 Svelte 5

현재 React/Vinext 프로덕션 entry를 즉시 교체하지 않는다. 다만
snapshot fanout, challenge host, health hook은 React 앱에서
`packages/browser-runtime`으로 이동했고, Svelte-readable
`RuntimeSnapshotStore`와 `MandelHowlBrowserRuntimePort`를 공개한다.
`apps/svelte-prototype`의 Svelte 5 수직 slice는 같은 TypeScript 엔진,
presentation model, CSS와 ARIA 계약을 사용하며 `svelte-check`를 통과해야
한다. 이 slice는 아직 compile-only다. production orchestration adapter와
pointer gesture, mount smoke가 추가되기 전에는 runnable migration으로
승격하지 않는다.

동일 기기·동일 production build에서 다음 중 하나 이상을 만족할 때만 전체
entry 이전 후보로 승인한다.

- 초기 client JavaScript transfer 또는 parse 대상 20% 이상 감소
- 다이얼 조작 구간 UI commit CPU 30% 이상 감소
- dial input에서 다음 plate paint까지 p95 15% 이상 감소

그와 동시에 snapshot 결정성, WebGL2/Canvas2D 픽셀 전환, 접근성, 오디오
안전, 60/30 FPS 예산에 회귀가 없어야 한다. 측정 기준과 raw 결과를 저장하지
않은 체감 비교는 이전 근거로 사용하지 않는다.

### Python baker에서 Rust native

Python baker는 브라우저 UI hot path가 아니라 오프라인 생성 도구다. 장기
후보는 Cython이나 런타임 WASM이 아니라 Rust native baker다. 루트 Cargo
workspace와 `tools/physics-baker-rs`가 `modes-v1`·`response-v1` 독립
validator를 제공하며 pinned dataset 검증에서 Python oracle 뒤에 실행된다.
native `generate`는 아직 fail-closed다. Rust 구현은 Python을 독립 oracle로
유지하면서 field, 질량, 고유주파수, mode sign, texture와 coverage의
differential 검증을 통과해야 한다. provenance에는 Rust toolchain과 binary
digest를 기록한다.

로컬 application-control 정책이 새 Rust executable을 막는 경우 기본
`physics:validate`는 skip을 명시하고, `physics:validate:strict`는 실패한다.
따라서 native parity의 release 증거는 policy-compatible CI에서 strict
command로 남긴다. compile/clippy 성공을 native 실행 성공으로 대체하지 않는다.

backend provenance가 다르면 전체 dataset content hash도 달라지는 것이
정상이다. 따라서 cross-backend gate는 scientific payload의 semantic digest와
수치·pixel parity를 비교하고, full dataset hash 결정성은 backend별 반복
실행으로 검증한다.

런타임 Rust/WASM은 현재 도입하지 않는다. representative trace에서
시뮬레이션 step이 `2 ms p95`를 넘거나 시뮬레이션이 메인 스레드 CPU의
`20%`를 넘을 때에만 별도 spike를 승인한다. JS↔WASM 복사 비용을 포함해
측정하며, 두 기준 아래에서는 기존 TypeScript fixed-step 엔진을 유지한다.

## 검증 증거

2026-07-30 worktree에서 render-engine·asset-runtime·runtime snapshot
focused unit, 두 snapshot fanout lane의 web unit, renderer integrity와
resource soak를 통과했다.

temporal fixture E2E는 WebGL2와 Canvas2D 각각 baseline 뒤 정확한 다음
animation frame, 50 ms, 250 ms snapshot을 순서대로 그린다. 새
`activeModeId`가 다음 paint에 반영되고, 같은 현재 snapshot을 새 renderer에
단독 적용한 결과와 transition renderer의 framebuffer가 달라 이전 모드
잔류가 존재함을 확인한다. 별도의 실제 다이얼 E2E는 브라우저 합성 결과를
screenshot hash로 비교해 실제 입력 뒤 근접 paint, 50 ms, 250 ms의 가시
변화를 확인한다.

## 의도적으로 미구현인 항목

- `response-v1` aggregate를 모드별 공진 적분에 사용하는 것
- 검증 진행 이벤트만으로 부분 dataset을 `VERIFIED`로 승격하는 것
- monolithic atlas-v1에서 per-mode/range lazy fetch·eviction을 주장하는 것
- immutable runtime-state wrapper까지 포함한 완전한 zero-allocation 전환
- 48개 중 inactive mode를 건너뛰는 적분 active-set/culling
- runtime frame-pressure를 입력으로 한 자동 `60→30 FPS` 전환과
  핸드오프 15.3의 전체 단계적 품질 저하. 현재는 startup hardware tier,
  reduced-motion, forced-colors만 적용한다.
- Svelte 5 전체 UI entry 이전. browser-runtime store/port 계약과 compile-only
  control slice는 구현했지만 production adapter, pointer gesture,
  route/fixture/hosting shell은 아직 React다.
- Rust native 전체 generator와 Rust/WASM 런타임. Cargo workspace와 binary
  validator는 구현했지만 Python generator를 대체하지 않는다.

이 항목은 누락을 완료로 표시하지 않고 위 검증 게이트가 충족될 때 별도
변경으로 추적한다.
