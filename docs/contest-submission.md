# MandelHowl — 컨테스트 출품 설명

이 문서는 출품 폼, 프로젝트 소개 페이지, 발표 자료에 바로 옮겨 쓸 수 있는 한국어·영어 설명을 모아 둔다. 과학적 표현은 `docs/scientific-basis.md`와 구현된 런타임 계약의 범위를 벗어나지 않는다.

## 기본 정보

- **작품명:** MandelHowl
- **부제:** One Dial. One Result. Almost Always Wrong.
- **장르:** 의도적으로 최악인 볼륨 조절 UI / 인터랙티브 음향 실험
- **라이브 데모:** https://daejunnom.github.io/MandelHowl/
- **소스 코드:** https://github.com/daejunnom/MandelHowl
- **추천 키워드:** Chladni patterns, acoustic feedback, resonance, Mandelbrot set, nonlinear dynamics, scientific UI, worst volume control

## 한국어 출품 문구

### 한 문장 소개

주파수 다이얼 하나로 만델브로 물성판의 공진과 음향 피드백을 튜닝해, 거의 항상 0이나 100만 나오는 볼륨을 맞추는 과학적으로 개연성 있는 최악의 UI입니다.

### 짧은 소개

MandelHowl은 볼륨 슬라이더를 주파수 실험 장치로 바꾼 인터랙티브 작품입니다. 사용자는 단 하나의 다이얼을 돌려 만델브로 집합으로 두께가 부호화된 Chladni 진동판을 가진합니다. 공진하지 않으면 피드백이 감쇠해 `VOLUME 000`이 되고, 공진이 붙으면 리미터까지 성장해 `VOLUME 100`이 됩니다. 원하는 중간값은 두 상태 사이의 매우 좁은 임계 경계에서만 나타납니다. 난수는 사용하지 않습니다.

### 전체 소개

보통의 볼륨 조절기는 원하는 숫자를 직접 선택하게 해 줍니다. MandelHowl은 그 당연한 관계를 의도적으로 망가뜨립니다.

사용자가 조작할 수 있는 것은 `DRIVE FREQUENCY` 다이얼 하나뿐입니다. 다이얼은 가상 스피커를 구동하고, 스피커는 얇은 금속판을 진동시킵니다. 판의 두께는 만델브로 집합의 escape-time 값을 제조 가능한 범위로 변환해 공간적으로 달라지도록 설계했습니다. 이 물성 분포가 판의 고유진동수와 모드 형상을 바꾸며, 판 위의 모래는 각 모드의 마디 구조를 Chladni 무늬처럼 드러냅니다.

판의 응답은 가상 마이크를 거쳐 다시 스피커로 되먹임됩니다. 루프 이득이 임계값보다 작으면 진동은 사라져 볼륨 0으로 수렴합니다. 임계값을 넘고 위상이 맞으면 피드백이 성장해 안전한 가상 리미터에 붙으며 볼륨 100으로 수렴합니다. 1부터 99까지의 값은 침묵과 하울링 사이의 좁은 임계 영역에서만 얻을 수 있습니다.

그래서 조작은 직관적이지만 제어는 끔찍합니다. 다이얼을 조금 돌렸을 뿐인데 0이 100으로 튀고, 목표값 바로 옆에 도달한 뒤 성급히 되돌리면 남아 있던 진동과 관성 때문에 다시 극단값으로 밀려날 수 있습니다. 사용자는 `조작 → 공진 관찰 → 측정 → 근접 실패 → 재시도`의 짧은 피드백 루프에 들어갑니다. 이 반복 감각이 MandelHowl의 Dopamine-Driven Design 요소입니다.

결과는 무작위가 아닙니다. 주파수, 접근 방향, 회전 속도, 다이얼 관성, 남아 있는 모달 에너지와 피드백 상태가 같은 고정 시간 스텝 모델을 결정합니다. 정적 입력의 대부분은 0 또는 100으로 양극화되며, 검증된 조작 이력으로 모든 중간 정수값을 재현할 수 있도록 설계했습니다.

MandelHowl은 실제 마이크 권한이나 운영체제 볼륨을 사용하지 않습니다. 화면의 `VOLUME`은 작품 내부의 정규화된 가상 측정값이며, 들리는 Web Audio 모니터는 별도의 제한·필터·노출 보호 체인을 거칩니다.

### 체험 방법

1. 원형 `DRIVE FREQUENCY` 다이얼을 마우스나 터치로 직접 잡고 돌립니다.
2. 스피커, 판, 모래, 마이크, 오실로스코프가 어떻게 반응하는지 관찰합니다.
3. 손을 놓고 측정이 안정될 때까지 기다립니다.
4. 목표값이 있다면 정확히 같은 `VOLUME 000..100`이 나올 때까지 다시 튜닝합니다.
5. 빠르게 훑기보다 접근 방향, 속도, 잔향을 이용하는 편이 낫습니다. 물론 여전히 형편없는 볼륨 조절기입니다.

### 심사 포인트

- **한눈에 읽히는 인과관계:** 주파수 다이얼 → 스피커 → 진동판과 모래 → 마이크 → 피드백 → 볼륨
- **실제 학문의 창작적 결합:** 복소동역학, 박판 진동, Chladni 현상, 음향 피드백, 비선형 제한
- **하나의 입력과 하나의 출력:** 기능적 입력은 주파수 다이얼 하나, 결과는 가상 볼륨 하나
- **극단값의 개연성:** 비공진은 감쇠하고 공진은 포화하므로 대부분 0 또는 100
- **무작위 없는 불쾌함:** 결과가 어려운 이유는 난수가 아니라 상태 이력과 임계 동역학
- **과학적 정직성:** 만델브로 무늬를 모래에 그대로 복사하지 않고, 물성 분포가 실제 모드 계산을 바꾸도록 구성
- **안전과 개인정보:** 실제 마이크를 쓰지 않으며, 가상 볼륨과 청취 게인을 분리

## English submission copy

### One-line pitch

MandelHowl is a scientifically plausible worst-volume-control UI: tune one frequency dial to drive a Mandelbrot-encoded Chladni plate, then try to catch a virtual volume that almost always collapses to 0 or 100.

### Short description

MandelHowl replaces a volume slider with a closed-loop acoustics experiment. One dial drives a virtual speaker and a thin plate whose thickness field is encoded from Mandelbrot escape-time data. Off resonance, the loop decays to `VOLUME 000`; on resonance, feedback grows into a limiter and settles at `VOLUME 100`. Intermediate values exist only near the narrow critical boundary between silence and howl. There is no randomness.

### Full description

A normal volume control lets you choose a number directly. MandelHowl deliberately destroys that relationship.

The only functional input is a `DRIVE FREQUENCY` dial. It excites a virtual loudspeaker, which drives a thin metal plate. The plate does not merely display a Mandelbrot image: Mandelbrot escape-time values are converted into a bounded, manufacturable thickness field. That material distribution changes the plate's modal frequencies and shapes. Sand on the surface then reveals the nodal structure of those modes as Chladni-like patterns.

A virtual microphone returns the plate response to the speaker. Below the loop-gain threshold, vibration decays toward silence and the result becomes `VOLUME 000`. Above the threshold, phase-aligned feedback grows until a virtual limiter captures it at `VOLUME 100`. Values from 1 to 99 appear only inside the narrow critical region between those two attractors.

The control is immediately understandable but intentionally awful to master. A tiny turn can jump from silence to full feedback. A near miss invites one more adjustment, yet inertia and residual modal energy can push the next attempt back to an extreme. This creates a rapid loop of action, visible response, measurement, near miss, and retry—the project's Dopamine-Driven Design layer.

The behavior is deterministic. Frequency, approach direction, rotation speed, dial inertia, residual modal energy, and feedback history evolve through the same fixed-step model. Most static settings polarize to 0 or 100, while validated gesture histories can reproduce every intermediate integer.

The displayed `VOLUME` is a normalized virtual measurement, not operating-system volume or calibrated sound-pressure level. MandelHowl never requests microphone access, and its optional audible Web Audio monitor is independently filtered, limited, and exposure-controlled.

### How to play

1. Grab and rotate the `DRIVE FREQUENCY` dial with a mouse or touch input.
2. Watch the loudspeaker, plate, sand, microphone, and oscilloscope respond.
3. Release the dial and let the measurement settle.
4. If a target is shown, repeat until the virtual volume matches it exactly.
5. Approach direction, sweep speed, inertia, and residual vibration matter. Brute-force scanning is possible in theory and miserable in practice.

## 과학적 표현 경계

출품 설명에서는 다음 구분을 유지합니다.

- 만델브로 집합은 음향 방정식이 아니라 **판의 두께 분포를 생성하는 기하학적 입력**입니다.
- 모래 무늬는 만델브로 실루엣이 아니라 **계산된 판 모드의 마디 구조**입니다.
- 화면의 스피커–판–마이크 루프는 확립된 공진·피드백 개념을 결합한 **가상 예술 장치**입니다.
- `VOLUME 000..100`은 정규화된 작품 내부 값이며 dB SPL, 청력 수준, 기기 볼륨이 아닙니다.
- 오프라인 수치해석은 수렴성과 독립 검증 자료를 포함하지만, 실제 제작 공차·공기 하중·입자 상호작용까지 인증하는 공학 시험은 아닙니다.

## 사용하지 않을 표현

- “만델브로 공식이 직접 소리를 만든다.”
- “모래가 만델브로 집합 모양으로 배열된다.”
- “실제 마이크 입력을 분석한다.”
- “화면의 100이 실제 음압이나 운영체제 볼륨 100을 의미한다.”
- “실물 제작 시 화면과 완전히 동일한 소리가 보장된다.”
