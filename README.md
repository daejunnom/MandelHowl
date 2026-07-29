# MandelHowl

MandelHowl은 하나의 `DRIVE FREQUENCY` 다이얼로 Chladni 판과 가상
스피커–마이크 피드백 루프를 가진하고, 그 상태를 `VOLUME 000..100`으로
읽는 결정적 인터랙티브 실험 장치다.

## 현재 구현

- 버전된 판·런타임 사양과 TypeScript/JSON Schema 계약
- 연속 회전, 로그 주파수 매핑, 관성, 끝단 저항을 갖춘 순수 다이얼 엔진
- 고정 시간 스텝 모달·피드백 엔진과 단일 볼륨 매퍼
- 동일 snapshot을 읽는 장면, Canvas 판 표현, 계기판, 안전한 Web Audio
- 포인터·키보드·휠 입력, 감소된 모션, 고대비 접근성
- 결정성·감쇠·포화·유한값 단위 테스트와 서버 렌더링 테스트

현재 웹 버전은 전체 상호작용 경계를 검증하기 위한
`prototype-analytical-plate-v1` 모달 fixture를 사용한다. 이는 FEM 결과라고
주장하지 않으며, 화면에도 `FEM BAKE PENDING` 상태를 표시한다. 실제 제작
가능한 판의 메시·고유모드·수렴성·텍스처 데이터셋은 핸드오프의 B/C 단계에서
같은 dataset 계약 뒤에 연결해야 한다.

## 로컬 실행

```bash
npm install
npm run dev
```

검증:

```bash
npm test
npm run lint
```

상세 설계 기준은 `MandelHowl_핸드오프.md`와
`MandelHowl_파일_구조.md`를 따른다. 현재 구현과 완료 조건의 대응 상태는
`docs/handoff-coverage.md`에 기록한다.
