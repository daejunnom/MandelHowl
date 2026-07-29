# MandelHowl

MandelHowl은 하나의 `DRIVE FREQUENCY` 다이얼로 만델브로 물성판과 가상
스피커–마이크 피드백 루프를 구동하고, 그 결정적 상태를
`VOLUME 000..100`으로 읽는 인터랙티브 실험 장치다.

## 구현 상태

핸드오프 A0–G0과 완료 품질 기준 18개를 구현·자동 검증한다.

- `45..6000 Hz` 로그 다이얼, 포인터·터치·키보드·휠의 공통 회전 이력
- `1/240 s` 고정 스텝 모달 피드백, 측정/확정 상태, 단일 볼륨 매퍼
- 전역 수식만으로 안정 입력의 99.5%를 `0` 또는 `100`으로 보내면서
  상태 이력 trace로 모든 `1..99`를 재현하는 coverage 증거
- 만델브로 수치장→제조 가능한 가변 두께 판→고유모드→결합계수→마디선·모래
  텍스처로 이어지는 재현 가능한 오프라인 baker
- content-addressed manifest, 바이너리, Khronos KTX2 atlas, checksum,
  수렴성·독립 참조·provenance 보고서
- 같은 canonical snapshot과 mode dataset을 읽는 WebGL2/Canvas2D 장면,
  DOM 계기판, 안전한 Web Audio
- 해시·capability·오디오 실패의 구조화 진단, 접근성, reduced motion,
  challenge host 경계
- 단위·과학·통합·E2E·시각 회귀·오디오 안전·장시간 soak와 재현 가능한
  릴리스 검증
- React와 독립적인 browser-runtime/store 계약, Svelte 5 control의
  compile-only 수직 slice, Rust native modes/response validator와 Python
  oracle parity gate

프로덕션 데이터셋은 다음 ID로 고정한다.

```text
sha256:d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98
```

자산이 로드되는 동안이나 무결성 검증이 실패한 경우에만 명시적으로 표시된
분석적 fallback을 사용한다. 실패한 자산을 프로덕션 결과로 조용히 대체하지
않는다.

## 수치 표현의 한계

현재 baker는 가변 두께 Kirchhoff–Love 얇은 판의 결정적 Rayleigh–Ritz
고유값 해석을 사용한다. 이는 shell FEM이 아니며 그렇게 표기하지 않는다.
수렴성, 모드 MAC, 독립 유한차분 참조 오차는 데이터셋에 함께 기록하지만,
제작 공차·공기 하중·입자 상호작용까지 보증하는 공학 인증 결과는 아니다.
KTX2 atlas는 이식성을 위해 비압축 R8/RG8 payload를 사용한다. 화면의
마이크와 `VOLUME`은 가상 측정이며 실제 마이크 권한이나 기기 음량을 사용하지
않는다.

## 로컬 실행과 검증

```bash
npm install
npm run dev
```

전체 검증과 물리·릴리스 gate:

```bash
npm run verify
npm run physics:validate
npm run physics:validate:strict # policy-compatible CI에서 Rust 실행 필수
npm run release:verify -- --require-clean
npm run release:archive
npm run release:archive:check
```

과학·자산·안전의 표현 범위는 `docs/scientific-basis.md`,
`docs/asset-pipeline.md`, `docs/audio-safety.md`에 기록한다.
`MandelHowl_핸드오프.md`의 요구와 구현 증거의 최종 대응은
`docs/handoff-coverage.md`와 `docs/acceptance-matrix.md`에서 확인한다.
Svelte/Rust 기본 구현체 교체의 현재 경계와 남은 gate는
`docs/migration-seams.md`에 기록한다.
