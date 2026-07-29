# MandelHowl release provenance

릴리스는 clean 웹 source commit과 불변 physics dataset ID를 하나의 증거 레코드로
고정한다. 현재 dataset pin은 `release/dataset-lock.json`의 다음 값이다.

```text
dataset ID
sha256:d31d968f5812deae76626be450446e5d67cd9075515e36e3e57631204a3a8d98

manifest SHA-256
50e0df50dbd64b17324d62197bb53750a2bb9cd7bb69a9d918bb75e75ebc90ad
```

`npm run build`의 prebuild 단계는 원본 dataset을 `public/runtime/`에 stage하고
다음 `mandelhowl.release-provenance.v1` 레코드를 생성한다.

- 정확한 `webCommit`과 commit timestamp
- tracked source tree의 dirty 여부
- dataset ID, manifest·plate spec SHA-256
- solver 이름·버전·옵션·실행 환경 evidence
- package lock, license, third-party notices, complete transitive SPDX
  inventory, security headers digest
- Node 버전, build command, worker entrypoint

stage 과정은 manifest-relative 경로를 보존하며 원본과 staged 파일의 byte
length와 SHA-256을 다시 비교한다. `latest` 같은 가변 별칭은 릴리스 증거에
사용하지 않는다.

물리 baker는 Python 표준 라이브러리만 사용한다. KTX2 container는 공개 Khronos
사양을 구현하지만 Khronos 코드나 바이너리를 복사하지 않는다. 현재 실행이
containerized되지 않았다는 사실과 sentinel digest를 provenance에 그대로
기록하며, 이를 실제 container image 실행 증거로 해석하지 않는다.

## Gate

```bash
npm run physics:validate
npm run build
npm run release:verify -- --require-clean
npm run release:archive
npm run release:archive:check
```

`release:verify`는 dataset lock, staged manifest와 모든 runtime asset, source
input digest, security header, clean-tree provenance를 다시 검사한다.
`release:archive`는 고정 inventory 순서·mtime·권한으로 ZIP을 만들고,
`release:archive:check`가 같은 source에서 byte-identical artifact가 나오는지
확인한다. 배포할 commit은 이 검증에 사용한 commit과 같아야 한다.
