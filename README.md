# MandelHowl

[**라이브 데모**](https://daejunnom.github.io/MandelHowl/) · [**컨테스트 출품 설명 전체본**](docs/contest-submission.md)

> 주파수 다이얼 하나로 만델브로 물성판의 공진과 음향 피드백을 튜닝해,
> 거의 항상 0이나 100으로 끝나는 볼륨을 맞추는 과학적으로 개연성 있는
> 최악의 UI.

MandelHowl은 하나의 `DRIVE FREQUENCY` 다이얼로 만델브로 물성판과 가상
스피커–마이크 피드백 루프를 구동하고, 그 결정적 상태를
`VOLUME 000..100`으로 읽는 인터랙티브 실험 장치다.

## 체험 방법

1. 원형 `DRIVE FREQUENCY` 다이얼을 마우스나 터치로 직접 잡고 돌린다.
2. 스피커, 진동판과 모래, 마이크, 오실로스코프의 반응을 관찰한다.
3. 손을 놓고 측정이 안정될 때까지 기다린다.
4. 목표값이 있다면 정확히 같은 `VOLUME 000..100`이 나올 때까지 다시 튜닝한다.

키보드와 마우스 휠도 같은 다이얼 이력을 통해 동작한다. 접근 방향, 회전 속도,
관성, 남아 있는 진동 에너지가 결과에 영향을 주므로 단순히 눈금을 훑는 것만으로는
중간값을 안정적으로 얻기 어렵다.

## 왜 최악의 볼륨 UI인가

보통의 볼륨 조절기는 원하는 값을 직접 선택하게 해 준다. MandelHowl은 대신
주파수를 조절하게 한다. 공진하지 않으면 피드백이 감쇠해 `VOLUME 000`으로
수렴하고, 공진이 붙으면 리미터까지 성장해 `VOLUME 100`으로 수렴한다.
`001..099`는 침묵과 하울링 사이의 좁은 임계 경계에서만 나타난다.

작은 회전 하나가 0을 100으로 바꾸고, 근접 실패 직후의 성급한 재시도는 다이얼
관성과 잔류 모달 에너지 때문에 다시 극단값으로 밀려날 수 있다. 이
`조작 → 시각·음향 반응 → 측정 → 근접 실패 → 재시도`의 짧은 루프가
MandelHowl의 Dopamine-Driven Design 요소다. 난수는 사용하지 않는다.

## 과학적으로 무엇이 실제 기반인가

만델브로 집합은 소리를 직접 만드는 공식으로 취급하지 않는다. escape-time
수치장을 제조 가능한 범위의 판 두께 분포로 변환하고, 그 물성 분포가 얇은 판의
고유진동수와 모드 형상을 바꾸도록 구성한다. 판 위의 모래는 만델브로 그림을
복사하는 것이 아니라 계산된 모드의 마디 구조를 Chladni 무늬처럼 보여 준다.

가상 마이크가 판의 응답을 다시 스피커로 보내는 폐루프에서는 루프 이득과 위상에
따라 진동이 감쇠하거나 성장·포화한다. 화면의 `VOLUME`은 이 상태를 정규화한
작품 내부 측정값이며, 실제 음압·운영체제 볼륨·기기 음량이 아니다. 실제 마이크
권한도 사용하지 않고, 들리는 Web Audio 모니터는 별도의 안전 제한을 거친다.

과학적 표현 범위와 수치적 한계는 [과학적 기반 문서](docs/scientific-basis.md),
오디오 안전 경계는 [오디오 안전 문서](docs/audio-safety.md)에 기록한다.

## 구현 상태

핸드오프 A0–G0과 완료 품질 기준 18개를 구현·자동 검증한다.

- `45..6000 Hz` 로그 다이얼, 포인터·터치·키보드·휠의 공통 회전 이력
- `1/240 s` 고정 스텝 모달 피드백, 측정/확정 상태, 단일 볼륨 매퍼
- 전역 수식만으로 검증된 균일 정적 입력의 100%를 `0` 또는 `100`으로 보내면서
  상태 이력 trace로 모든 `1..99`를 재현하는 coverage 증거
- 만델브로 수치장→제조 가능한 가변 두께 판→고유모드→결합계수→마디선·모래
  텍스처로 이어지는 재현 가능한 오프라인 baker
- content-addressed manifest, 바이너리, Khronos KTX2 atlas, checksum,
  수렴성·독립 참조·provenance 보고서
- embedded-only WebGL shader allowlist와 vertex/fragment source SHA-256
- 같은 canonical snapshot과 mode dataset을 읽는 WebGL2 판·스피커·마이크·
  방향성 케이블 장면, Canvas/CSS 전체 장치 fallback, DOM 계기판과 안전한
  Web Audio
- 대역·잔류 기준으로 최대 12개 모드만 완전 적분하는 고정 용량 active set,
  in-place RAF state와 재사용 snapshot/audio/render typed buffer
- WebGL2 top-4 GPU texture residency·결정적 eviction, Canvas2D top-2 합성,
  정확한 6단계 one-way 렌더 품질 저하
- 해시·capability·오디오 실패의 구조화 진단, 접근성, reduced motion,
  challenge host 경계
- 단위·과학·통합·E2E·시각 회귀·오디오 안전·장시간 soak와 재현 가능한
  릴리스 검증
- 같은 browser session을 유지하는 Svelte 5 primary/React 19 standby
  full-scene presentation, one-way availability failover와 generation-scoped input
- 동일한 versioned 알고리즘 계약을 독립 구현한 Rust native/Python stdlib 전체
  baker, semantic differential broker와 machine-readable release attestation

프로덕션 데이터셋의 유일한 사람이 편집 가능한 pin은
`specs/runtime/dataset-release.v1.yaml`이며,
`release/dataset-lock.json`과 TypeScript projection은 생성물이다. 고정된
dataset은 `kirchhoff-love-c1-finite-strip-r2` 계약으로 격리된 Linux/amd64
OCI 안에서 Rust와 Python이 각각 생성한 뒤, 전체 candidate inventory와
decoded texture pixel 비교가 일치한 경우에만 Rust candidate를 승격한다.
canonical YAML과 생성된 TypeScript projection이 정확한 ID·manifest·modal
model hash를 소유한다. release lock은 ID·source directory·manifest hash를
투영하고, committed `release/attestations/<dataset-id>/` bundle의 Rust
candidate가 modal model hash까지 기계적으로 결속한다.

자산이 로드되는 동안이나 무결성 검증이 실패한 경우에만 명시적으로 표시된
분석적 fallback을 사용한다. 실패한 자산을 프로덕션 결과로 조용히 대체하지
않는다.

## 수치 표현의 한계

현재 두 baker는 가변 두께 Kirchhoff–Love 판을 C1 cubic-Hermite 방사
유한요소와 정규화 Fourier 원주 기저로 이산화한 결정적 finite-strip
고유값 해석을 독립 구현한다. 중앙 hub의 변위·방사 기울기 DOF는 제거하고
자유 외곽은 자연 경계로 남긴다. 수렴성, 물리 격자 질량 MAC, 독립
유한차분 참조 오차는 데이터셋에 함께 기록하지만,
제작 공차·공기 하중·입자 상호작용까지 보증하는 공학 인증 결과는 아니다.
현재 알고리즘 revision의 KTX2 atlas는 R8/RG8 array를 표준 ZLIB
supercompression scheme 3으로 저장하며, 재현 가능한
`fixed-Huffman-or-stored` DEFLATE 프로필만 허용한다. 브라우저 decoder는
선언 길이로 경계가 고정된 동기 inflater와 Adler-32 검증을 사용하고 dynamic
Huffman을 거부한다. 비압축 scheme 0은 과거 dataset을 명시적으로 읽는
호환 경로에만 남아 있고 현재 release pin에는 허용하지 않는다. 화면의
마이크와 `VOLUME`은 가상 측정이며 실제 마이크 권한이나 기기 음량을
사용하지 않는다.

## 로컬 실행과 검증

```bash
npm install
npm run dev
```

전체 검증과 물리·릴리스 gate:

```bash
npm run verify
npm run handoff:check # 503개 규범 의무별 exact acceptance case의 빠른 검사
npm run physics:validate
npm run physics:validate:strict # 관리된 Linux native 환경에서만 사용
npm run baker:nversion:generate -- --strict --report-file <report.json>
npm run baker:container:release -- --output-dir <fresh-name> --stage-release-evidence
npm run release:verify -- --require-clean # source·asset 검증
npm run release:verify:attested # committed OCI evidence를 쓰는 strict gate
npm run handoff:verify -- \
  --report <handoff-report.json> # 전체 구현·브라우저·물리·릴리스·archive gate
npm run release:archive
npm run release:archive:check
```

`mandelhowl.release-provenance.v4`는 검토한 핸드오프 원문, 실제 파일 구조
기준과 `specs/acceptance/handoff-verification.v1.json`의 digest까지 release에
결속한다. Linux CI는 Rust fmt·clippy·unit·strict dual validation을 담당한다.
Windows의 `handoff:verify`는 로컬 Rust PE를 생성·실행하지 않고
`release/dataset-lock.json`에서 계산한
`release/attestations/<dataset-id-hex>/`의 promotion-time OCI bundle을
fail-closed로 검증하며, 기본적으로 clean tree와 deterministic archive
재검사까지 수행한다.

과학·자산·안전의 표현 범위는 `docs/scientific-basis.md`,
`docs/asset-pipeline.md`, `docs/audio-safety.md`에 기록한다.
`MandelHowl_핸드오프.md`의 요구와 구현 증거의 최종 대응은
`docs/handoff-coverage.md`와 `docs/acceptance-matrix.md`에서 확인한다.
Svelte/React N-version은 하나의 canonical browser session 위에서
presentation availability를 보호한다. 두 view가 공유하는 runtime, dataset,
renderer/audio, dial-input mapping, presentation model, CSS, supervisor와
route/hosting bootstrap은 의도적인 계약 경계이며 별도의 미완료 UI 알고리즘으로
분류하지 않는다. 이 범위와 Rust backend 경계는 `docs/migration-seams.md`에
기록한다.
