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
5. C1 cubic-Hermite 방사 유한요소와 정규화 실수 Fourier 원주 함수를
   결합해 가변 두께 Kirchhoff–Love 질량·강성 행렬을 조립한다. 중앙 hub의
   변위·방사 기울기 DOF는 제거하고 자유 외곽은 자연 경계로 둔다.
6. `K q = ω² M q`를 Cholesky 변환과 대칭 Jacobi 방법으로 풀고,
   `qᵀMq=1`로 정규화한다. 가진점 또는 첫 비영점에서 부호를 고정한다.
7. coarse/medium/fine의 `(방사 요소, 최대 Fourier 차수, 원주 적분점)`을
   `(3,7,64) → (4,8,80) → (5,9,96)`으로 세분하고, 공통 물리 격자에서
   질량 가중 MAC과 주파수 변화를 비교한다. 별도로 canonical 목표 요소
   크기의 annular triangle mesh를 생성·품질 검사하고 노드/요소 스트림
   SHA-256 fingerprint를 남긴다.
8. 가진점·가상 마이크 결합, 방사 효율 근사, 45–6000 Hz 복소 응답,
   signed displacement, normal, nodal mask, sand density를 계산한다.
   같은 두께장에서 `y=0` 직경을 64점으로 샘플해 manifest의
   `plate.materialSectionProfile`도 만든다. UI의 뒤쪽 단면은 이 검증된
   UNORM8 값을 표시하며 브라우저에서 만델브로장을 다시 계산하지 않는다.
9. binary와 KTX2, provenance, 수렴·coverage 보고서, checksums를 만든 후
   manifest identity를 디렉터리명으로 사용한다.

이 단계의 렌더 기저는 48개 모드다. signed displacement, normal, nodal mask,
sand density의 같은 ordinal layer가 같은 물리 모드를 나타낸다. 런타임은 이
기저를 다시 계산하지 않고 WebGL2 top 4, Canvas2D top 2로 혼합한다. 자세한
선택·잔류 규칙은 `docs/adr-runtime-rendering-and-migration.md`에 있다.

## 수치해석의 정확한 범위

사용한 방법은 실제 가변 두께 얇은 판의 C1 finite-strip 유한요소
고유값 해석이다. 방사 방향 cubic-Hermite 요소의 국소 지지성과 C1 연속성,
원주 방향 정규화 Fourier 함수가 canonical
`elementFamily: kirchhoff-love-thin-plate` 요청을 구현한다. 중앙 고정 hub는
annular essential boundary로 표현한다. 공기 부가질량, 재료 비선형, 실제
스피커 구조, 개별 모래알 동역학은 포함하지 않는다.

surface triangle archive는 제조·좌표·품질 provenance를 제공하지만 고유값
문제에는 별도의 C1 finite-strip analysis mesh가 사용된다. algorithm,
convergence report와 generation report는 이 구분을 명시하며
`finiteElementAssemblyUsed`, analysis-mesh coupling, strict 10.3/B1
conformance를 함께 검증한다.

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

내부 해석은 binary64를 유지한다. 직렬화 경계에서만 주파수는 `2^-20 Hz`,
세 coupling은 `2^-27` 격자에 ties-to-even으로 양자화하고 `-0`을 `+0`으로
정규화한다. 각속도는 양자화된 주파수와 IEEE-754 `TAU`의 곱이다. 이 계약은
허용오차 안의 Python/Rust 차이가 coverage identity를 갈라놓지 않게 하며,
양쪽 `modes.bin`의 byte identity를 release 전제조건으로 만든다.

`response.bin`:

- 16-byte header: ASCII `MHRESPN1`, `u16 version=1`,
  `u16 headerBytes=16`, `u32 sampleCount`.
- sample마다 `f64 frequencyHz`, `f64 real`, `f64 imaginary`.

브라우저 loader는 `response.bin`을 해시 검증하고 위 형식으로 디코딩한다.
v1 값은 모든 모드의 `g_i*m_i*r_i` 전달응답을 합산한 뒤 bake된 표본 중
최대 복소 크기로 한 번 정규화한 전역 응답 곡선이다. 현재 baker는
45–6000 Hz를 512개 로그 간격으로 표본화한다. resonance runtime dataset은
이 표를 보존하며 표시·진단 소비자를 위해 복소 실수부와 허수부를 로그
주파수 축에서 결정적으로 보간한다.

이 aggregate 표에는 모드별 행이 없으므로 각 모드의 포획·잔향 에너지를
대신할 수 없다. 해당 용도에는 mode별 복소 응답과 연속 구간 오차 한계를
명시하는 `response-v2` 계약, runtime calibration 및 `0..100` coverage의
재생성이 필요하다.

`science/solver-evidence.bin`은 런타임 자산이 아니라 테스트 증거다.
`MHEVID01`, version, basis count, mode count 뒤에 mass matrix와 모든
mass-normalized coefficient를 `f64` row-major로 둔다.

`mesh/fine-polar-mesh.mhmz`는 zlib 압축된 실제 fine triangle mesh다.
압축 해제 후 `MHMESH01`, version, node count, triangle count,
`componentCount=3` 헤더가 나오고 xyz `f32` 노드와 `u32` triangle index가
이어진다. 세 mesh level 전체의 품질 통계와 float64 fingerprint는
`mesh/mesh-evidence.json`에 있다.

## KTX2 subset

현재 release의 48개 shard는
[Khronos KTX 2.0 사양](https://github.khronos.org/KTX-Specification/ktxspec.v2.html)의
identifier와 DFD를 가진 유효한 2D array다. 각 파일은 1 mip, 1 face,
4 layer, `supercompressionScheme=3` ZLIB,
`KTXorientation=ru`를 사용한다. 압축 stream은 두 baker가 동일하게 만드는
`fixed-Huffman-or-stored` DEFLATE subset으로 제한되고, 브라우저는 선언
길이·block range·Adler-32까지 검증한다.

- signed displacement, nodal mask, sand density:
  `VK_FORMAT_R8_UNORM (9)`
- normal: `VK_FORMAT_R8G8_UNORM (16)`
- versioned r2: 128×128×4 layers/shard, 종류별 12 shard(총 48 파일)
- compatibility-only legacy: 128×128×48 layers의 종류별 scheme-0 파일

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

WebGL shader는 dataset texture와 별도의 canonical
`webgl-shader-allowlist.v1.json`에 program ID, compile constant,
vertex/fragment source SHA-256을 고정한다. 두 shader는 renderer bundle에
embedded되며 URL에서 가져오지 않는다. program 생성 직전에 동기 SHA-256
검사를 통과한 source만 `gl.shaderSource`에 전달한다. security static gate와
release verifier는 renderer template을 독립적으로 다시 조립해 같은 digest를
확인한다.

실패 시 CLI는 추측 문장 대신
`mandelhowl.baker-diagnostic.v1` JSON을 stderr로 출력한다. schema, 입력 누락,
solver, 제조성, 수렴성, dataset 무결성, I/O를 서로 다른 code로 구분하고
실제 exception type과 실행 command를 `confirmed` evidence로 남긴다.

## 브라우저 로딩·캐시 단계

브라우저에서 자산을 사용할 때도 content identity와 전체 dataset 승격을
구분한다.

1. `manifest.json`은 `no-cache` 요청으로 재검증한다.
2. schema, canonical manifest SHA-256, 고정 release dataset ID, runtime
   호환성을 먼저 확인한다.
3. `modes.bin`, `response.bin`, checksum inventory와 과학 evidence를 검증해
   canonical modal dataset을 구성한다. versioned texture request는 이
   `ready` 경계까지 0건이다.
4. texture descriptor마다 SHA-256이 들어간 immutable URL과 검증 전용
   `loadBytes` capability만 renderer에 넘긴다. raw `fetch` surface는
   renderer에 노출하지 않는다.
5. renderer는 현재 top-K 또는 포획 전 8% 대역의 최근접 mode에 필요한
   shard만 요청한다. loader는 byte length→SHA-256→KTX2
   channel/dimension/layer/orientation 순서로 fail-closed 검증한다.
6. content-addressed `/runtime/*`에는 1년 immutable cache policy를 적용하고,
   decoded cache는 dataset identity를 key로 하는 bounded LRU다.
7. 앱은 loader가 core를 검증하고 visible renderer가 현재 필요한 shard를
   모두 설치한 경우에만 `VERIFIED`를 표시한다. 그 사이는 검증된 modal
   metadata 기반 analytical fallback을 명시한 `STREAMING` 상태다.

compatibility-only eager 경로의 진행 observer가 받은 bytes를 변경해도
loader의 검증 입력이 바뀌지 않도록 이벤트에는 격리된 copy를 제공한다.
반대로 검증된 shard를 renderer에 넘길 때 KTX2 decoder는 원본
`Uint8Array`의 payload `subarray` view를 사용해 대형 픽셀 buffer를 다시
복사하지 않는다.

앱은 loader에 lifecycle `AbortSignal`을 전달한다. component dispose 시
진행 중인 manifest와 atlas 요청을 중단하며, 중단된 검증은 실패 진단이나
`VERIFIED` 승격으로 전환되지 않는다.

versioned r2의 각 texture kind는 전역 mode 순서대로 4 layer씩 12개 KTX2
shard를 가진다. loader의 core/evidence `ready` 경로는 texture를 전혀
요청하지 않는다. renderer가 현재 top-K 또는 포획 전 8% 대역의 최근접 mode를
요청할 때에만 해당 shard의 immutable content URL을 fetch하고 byte length,
SHA-256, KTX2 header·orientation·channel·dimension을 검증한다. WebGL은
종류별 최대 5개 decoded shard, Canvas는 sand 최대 3개만 보유하고 LRU로
퇴거한다. 대역 밖 sweep은 texture fetch를 만들지 않는다.

legacy 앱은 검증된 sand atlas 이벤트를 renderer의 GPU prewarm에 사용한다.
production mode ID를 그대로 유지하므로 prototype snapshot을 layer ordinal로
잘못 매핑하지 않으며, 최종 source는 같은 dataset의 resident sand upload를
재사용한다. 두 경로 모두 안전한 전체 승격 원칙을 유지한다. loader의
`ready` 결과와 허용된 renderer source 설치 전에는 runtime dataset이나 화면의
`VERIFIED` 상태를 변경하지 않는다.
