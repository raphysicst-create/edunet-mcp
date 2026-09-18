# Vercel 원격 MCP 배포

`api/mcp.mjs`는 로컬 stdio와 같은 `createServer`를 Streamable HTTP로 제공합니다. 연결 경로는 `/api/mcp`입니다. 각 요청에 별도 MCP 서버를 만들고 세션을 저장하지 않아 서버리스 인스턴스 사이의 세션 고정이 필요하지 않습니다. JSON 응답을 사용하며 GET/SSE 구독은 제공하지 않습니다. 기존 2025 MCP 클라이언트와 SDK v2의 최신 요청을 지원합니다.

## 빌드와 배포

```sh
npm ci
npm run check
npm run build:vercel
```

빌드는 `.vercel/output`에 Vercel Build Output API 결과를 만듭니다. Node.js 24 함수에 `api/mcp.mjs`, 컴파일된 `dist`, Worker, 설정 파일과 추적한 런타임 의존성을 넣습니다. OCR을 사용하지 않는 이 서버의 배포에는 ONNX/Transformers/Sharp OCR 모듈을 포함하지 않습니다. PDF 텍스트 파싱에 필요한 PDF.js/PDFium 파일은 포함합니다. `.env`, `.codex`, Git 기록, 평가 결과는 배포 파일에 넣지 않습니다.

기존 Vercel 프로젝트의 Git 연결이 이 저장소와 배포 브랜치를 가리키면 `vercel.json`의 빌드 명령이 자동 적용됩니다. CLI를 사용하는 경우 먼저 **기존** 프로젝트에 `vercel link`한 뒤 배포합니다. 새 프로젝트를 만들어 기존 도메인을 대체하지 않습니다.

```sh
npx vercel@59.23.1 link
npx vercel@59.23.1 deploy --prod
```

## Vercel 환경변수

Vercel 프로젝트의 Production 환경에 다음 값을 설정합니다. 로컬 `.env`는 업로드되지 않습니다.

| 이름 | 값 |
|---|---|
| `EDUNET_API_KEY` | 기존 에듀넷 API 키 유지 |
| `EDUNET_DOMAIN` | 키에 등록된 도메인 유지 |
| `EDUNET_REFERENCE_SECRET` | 32바이트 이상의 무작위 비밀값. 인스턴스와 배포 사이에 유지 |
| `EDUNET_ACHIEVEMENT_SEARCH_ENABLED` | `true` |
| `EDUNET_ACHIEVEMENT_PDF_READ_ENABLED` | `true` |
| `EDUNET_ACHIEVEMENT_HWP_READ_ENABLED` | `true` |
| `EDUNET_ACHIEVEMENT_HWPX_READ_ENABLED` | `false` |
| `EDUNET_ACHIEVEMENT_AUTO_ATTACHMENT_SELECTION_ENABLED` | `false` |
| `EDUNET_RESOURCE_READ_ENABLED` | `false` |

환경변수 변경 후 새 배포에 적용됐는지 확인합니다. 공개 원격 서버는 서버에 설정된 에듀넷 인증정보로 읽기 전용 요청을 처리합니다. API 키와 서명 비밀값을 클라이언트에 전달하지 않습니다. 파일 읽기는 기존 Worker의 다운로드·크기·시간 제한을 유지합니다. 외부 Origin을 포함한 브라우저 요청은 기본적으로 같은 출처만 허용하며, 일반 MCP 클라이언트의 Origin 없는 요청은 허용합니다.

## 배포 후 실제 검증

```sh
npm run verify:remote -- https://edunet-mcp.vercel.app/api/mcp --read
```

패키지와 원격 서버 버전 일치, 도구 3개, 실제 `광합성` 검색, 과학 성취수준 후보 탐색, 첨부 목록, 선택한 PDF/HWP 한 개의 텍스트 읽기를 확인합니다. `metadata_only`는 파일 텍스트를 읽었으나 성취수준 레코드를 확정하지 못했다는 의미입니다. 후보 검색의 `partial` 경고와 원문 읽기의 경고는 그대로 기록하며 도메인 정확도 검증을 대신하지 않습니다.

## 운영 배포 검증 기록 — 2026-09-18 KST

- 기존 `raphysicst/edunet-mcp` 프로젝트에 CLI로 운영 배포했습니다. Git 저장소는 Vercel 프로젝트에 연결돼 있지 않으므로 GitHub push만으로 자동 재배포되지 않습니다.
- 코드 커밋: `74a4d19e55de611b5435a27697d2749099409a75`. 구현 `54656d5`, 참조 시간 오류 수정 `fafe151`을 포함합니다.
- 배포 ID: `dpl_B75SY33uabZUFmRSUN7QhkddXCDK`, 상태 `READY`, production alias `https://edunet-mcp.vercel.app`.
- [배포 상세](https://vercel.com/raphysicst/edunet-mcp/B75SY33uabZUFmRSUN7QhkddXCDK), [MCP 주소](https://edunet-mcp.vercel.app/api/mcp).
- Vercel Linux 빌드: 28초, 함수 818개 파일 / 67.14 MiB. 런타임 Node.js 24.
- 로컬 타입 검사 및 전체 테스트 **176/176** 통과. 독립 임시 디렉터리의 배포 파일만으로 API import, PDF/HWP/HWPX 파싱, PDFium WASM, Worker IPC 검증을 포함합니다.
- 원격 초기화 버전 `1.1.0-beta.1`, 도구 `search_edunet`, `search_edunet_achievement`, `read_edunet_achievement` 확인.
- 원격 `광합성` 검색: 전체 111건 중 2건 반환.
- 과학 성취수준 탐색: 후보 3건, 첫 후보 첨부 4개. 미검증 상세 경로에 대한 `detail_path_unverified` 경고로 상태는 `partial`입니다.
- 실제 PDF와 HWP 각각 다운로드·Worker·원문 블록 10개 반환 성공. 두 자료 모두 `metadata_only`, 구조화 레코드 0개로 반환했습니다. 성취수준 필드 정확도나 전체 문서 추출 완료를 주장하지 않습니다.
- 해당 배포의 최근 15분 `error` 로그 조회 결과 0건. 별도 로그 Drains나 지속 모니터링 설정은 이번 작업에서 변경하지 않았습니다.

API 키와 등록 도메인은 기존 Vercel 값을 유지했습니다. 새 서명 비밀값은 Vercel Secret으로 생성·저장했고 소스나 Git에 넣지 않았습니다. 검색·PDF·HWP만 활성화했으며 HWPX·자동 첨부 선택·일반 문서 읽기는 기본 비활성 상태를 유지합니다.
