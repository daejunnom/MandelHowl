# MandelHowl 물리 자산 파이프라인

## 목적과 재생성 계약

`specs/plate/mandelbrot-plate.v1.yaml`만 사람이 수정하는 canonical 물리
입력이다. `assets/generated/<sha256>/` 아래 파일은 모두
`tools/physics-baker`가 만든 불변 파생물이며 직접 수정하지 않는다.

개발용 생성:

```powershell
python tools/physics-baker/bake.py generate --output-root assets/generated
```

런타임 엔진이 `0..100`을 실제로 replay해 검증한 보고서를 포함하는 릴리스 생성:

```powershell
python tools/physics-baker/bake.py generate `
  --output-root assets/generated `
  --coverage-report path/to/runtime-coverage-report.json `
  --release
```

`--release`는 외부 보고서가 정확히 `0..100`을 한 번씩 포함하고 각 trace가
검증 상태이며 `perValueRuntimeExceptionTable: false`가 아니면 생성 자체를
거부한다. 보고서가 없는 개발 bake는 물리 모드에서 계산한 trajectory search
seed만 만들며 이를 도달성 증명이라고 표시하지 않는다.

## 단계

1. 제한된 안전 YAML parser가 canonical 사양을 로드하고 유한 JSON으로
   canonicalize한다.
2. 복소평면과 판 좌표를 선형 대응시켜 1024² escape-time 장을 계산한다.
   반복 상한은 256이며 무한 정밀도 프랙탈을 주장하지 않는다.
3. gaussian 근사, close/open, 12단계 양자화, 유한 폭 가공 bevel을 적용한다.
   bevel은 이상적인 불연속 단차가 사양의 두께 기울기 한계를 무한대로 만드는
   문제를 해결하는 제조 후처리다.
4. 두께 1.8–4.2 mm로 매핑한 뒤 질량, 질량중심, 최소 두께, 최대 기울기를
   실제 격자 적분으로 검사한다.
5. 중앙 hub에서 변위와 기울기가 0인 전역 trial basis로 가변 두께
   Kirchhoff–Love 굽힘 에너지와 질량을 적분한다. 자유 외곽은 자연 경계다.
6. `K q = ω² M q`를 Cholesky 변환과 대칭 Jacobi 방법으로 풀고,
   `qᵀMq=1`로 정규화한다. 가진점 또는 첫 비영점에서 부호를 고정한다.
7. coarse/medium/fine polar quadrature의 주파수 변화와 MAC을 비교한다.
   별도로 canonical 목표 요소 크기의 annular triangle mesh를 생성·검사하고,
   노드/요소 스트림 SHA-256 fingerprint를 남긴다.
8. 가진점·가상 마이크 결합, 방사 효율 근사, 45–6000 Hz 복소 응답,
   signed displacement, normal, nodal mask, sand density를 계산한다.
9. binary와 KTX2, provenance, 수렴·coverage 보고서, checksums를 만든 후
   manifest identity를 디렉터리명으로 사용한다.

## 수치해석의 정확한 범위

사용한 방법은 실제 가변 두께 얇은 판 고유값 수치해석이지만 shell FEM은 아니다.
전역 Rayleigh–Ritz basis가 canonical
`elementFamily: kirchhoff-love-thin-plate`의 solver adapter다. 중앙 고정 hub는
annular essential boundary로 표현한다. 공기 부가질량, 재료 비선형, 실제
스피커 구조, 개별 모래알 동역학은 포함하지 않는다.

독립 교차검증은 raster mode에 유한차분 Hessian을 적용한 Rayleigh quotient다.
공간 이산화가 독립적이므로 큰 오류와 좌표 불일치를 잡지만 두 번째 인증 솔버는
아니다. 실제 제작을 위한 인증·안전 해석으로 사용해서는 안 된다.

만델브로 반복식은 유한 해상도 두께장을 정의할 뿐 소리를 직접 만들지 않는다.
모래 밀도는 모드의 시간 평균 저속 영역 근사이며 만델브로 실루엣이라는 주장을
하지 않는다.

## 런타임 binary 계약

모든 수는 little-endian이다.

`modes.bin`:

- 16-byte header: ASCII `MHMODES1`, `u16 version=1`,
  `u16 headerBytes=16`, `u32 modeCount`.
- mode마다 96 bytes.
- `0..23`: NUL-padded UTF-8 mode ID.
- `24`: `u32 ordinal`, `28`: `u32 textureLayer`.
- `32..87`: 7개의 `f64`: natural Hz, angular rad/s, damping,
  actuator coupling, microphone coupling, radiation efficiency, phase.
- `88`: sign (`0` actuator-positive, `1` first-nonzero-positive);
  `89..95` reserved zero.

`response.bin`:

- 16-byte header: ASCII `MHRESPN1`, `u16 version=1`,
  `u16 headerBytes=16`, `u32 sampleCount`.
- sample마다 `f64 frequencyHz`, `f64 real`, `f64 imaginary`.

`science/solver-evidence.bin`은 런타임 자산이 아니라 테스트 증거다.
`MHEVID01`, version, basis count, mode count 뒤에 mass matrix와 모든
mass-normalized coefficient를 `f64` row-major로 둔다.

`mesh/fine-polar-mesh.mhmz`는 zlib 압축된 실제 fine triangle mesh다.
압축 해제 후 `MHMESH01`, version, node count, triangle count,
`componentCount=3` 헤더가 나오고 xyz `f32` 노드와 `u32` triangle index가
이어진다. 세 mesh level 전체의 품질 통계와 float64 fingerprint는
`mesh/mesh-evidence.json`에 있다.

## KTX2 subset

네 atlas는 [Khronos KTX 2.0 사양](https://github.khronos.org/KTX-Specification/ktxspec.v2.html)의
identifier와 DFD를 가진 유효한 2D array다.
1 mip, 1 face, `supercompressionScheme=0`, layer-contiguous 데이터,
`KTXorientation=ru`를 사용한다.

- signed displacement, nodal mask, sand density:
  `VK_FORMAT_R8_UNORM (9)`
- normal: `VK_FORMAT_R8G8_UNORM (16)`
- 128×128×48 layers

signed displacement는 `[-1,1] → [0,255]`로 명시적으로 양자화한다.
Basis/UASTC block compression을 했다고 주장하지 않는다. 각 atlas는 float64
모드에서 만들어진 canonical 128 px runtime LOD다.

## 해시와 검증

`checksums.json`은 manifest와 자기 자신을 제외한 모든 파일의 상대경로,
byte length, SHA-256을 담는다. manifest는 모든 descriptor digest를 가진 뒤
`datasetId`와 `contentAddressing.directoryName`을 뺀 canonical JSON을
SHA-256하여 두 값을 동시에 정한다. 따라서 순환 hash나 가변 `latest` 별칭이
없다.

브라우저 loader는 manifest에 직접 기술된 runtime 자산이 checksums와 정확히
양방향 일치하는지 확인한다. field, mesh, solver evidence 같은 추가 행도 안전한
상대경로·길이·SHA-256·정렬·중복을 검증하지만 초기 화면에서 fetch하지 않는다.
따라서 과학 provenance 전체가 dataset identity에 포함되면서 초기 로딩 비용은
늘지 않는다.

검증 명령은 manifest identity, 양방향 checksum inventory, binary header,
유한·오름차순 모드, KTX2 DFD/offset/layer, 제조성, 수렴성,
unit-modal-mass 직교성, coverage inventory를 모두 검사한다.

실패 시 CLI는 추측 문장 대신
`mandelhowl.baker-diagnostic.v1` JSON을 stderr로 출력한다. schema, 입력 누락,
solver, 제조성, 수렴성, dataset 무결성, I/O를 서로 다른 code로 구분하고
실제 exception type과 실행 command를 `confirmed` evidence로 남긴다.
