# kordoc 설치

2026-09-16: [공식 kordoc](https://github.com/chrisryugj/kordoc)의 npm 배포 버전 `4.14.0`을 이 프로젝트의 의존성으로 설치했다. `package.json`과 `package-lock.json`에 버전을 고정했다.

```powershell
npm.cmd ci
node node_modules/kordoc/dist/cli.js --version
node node_modules/kordoc/dist/cli.js '자료.hwp' -o '.scratch/자료.md'
```

프로젝트 `.codex/config.toml`에 `kordoc` stdio MCP를 등록했다. 기존 `edunet` 등록은 유지했다. 등록은 [Codex 공식 MCP 설정](https://developers.openai.com/codex/mcp)을 따른다. 현재 대화에 도구가 나타나지 않으면 MCP 연결을 재시작하고 이 프로젝트에서 새 대화를 시작한다. 설정의 절대 경로는 프로젝트를 이동할 때 갱신해야 한다.

## 확인한 범위

- CLI 버전: 4.14.0.
- MCP 초기화 및 도구 목록: 17개 도구 응답.
- MCP `parse_document`: 패키지에 포함된 HWPX 서식의 한글 및 설치 확인용 합성 PDF의 알려진 텍스트 추출 성공.
- ONNX 런타임 로딩과 sharp의 작은 PNG 생성 성공.
- 기존 프로젝트 TypeScript 타입 검사 통과.

설치 시 npm이 일부 선택 의존성의 설치 스크립트를 보류했지만, 위에서 확인한 실행 경로는 정상 동작했다. OCR 모델 다운로드와 실제 OCR 추론, 실제 에듀넷 HWP/PDF의 추출 품질은 아직 확인하지 않았다. 설치 확인은 eval 통과를 의미하지 않으며 기존 evals는 수정하거나 실행하지 않았다.

현재 kordoc은 별도 MCP로 로컬 문서 경로를 받아 처리한다. `search_edunet`에서 첨부파일을 자동 다운로드하고 kordoc에 전달하는 기능은 아직 연결하지 않았다.
