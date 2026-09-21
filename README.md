# edunet-mcp

**에듀넷 교육자료 검색과 성취수준 원문 읽기를 제공하는 MCP 서버입니다.** 로컬 stdio와 Vercel 원격 Streamable HTTP를 지원합니다. 기존 `search_edunet`은 제목, 최대 500자 발췌, 출처 링크와 페이지 정보만 제공하며 원문·첨부를 읽지 않습니다. 성취수준 베타를 켜면 후보 탐색, 첨부 선택, PDF/HWP 구조화, 필드별 원문 근거를 별도 도구로 제공합니다.

현재 버전은 **`v1.1.0-beta.1`**입니다. 새 기능은 기본 비활성화이며, 기존 검색 계약을 유지합니다. [성취수준 설정·지원 범위·검증](docs/achievement-implementation.md), [기존 RC 기록](docs/release-v1.0.0-rc.1.md)을 참고하세요.

## 설치

Node.js **22.12 이상**과 이 프로젝트 소스 폴더가 필요합니다. 현재는 소스에서 설치·빌드하는 방식이며 npm 공개 배포 패키지는 아닙니다. 프로젝트 폴더에서 실행합니다.

```sh
npm ci
npm run build
```

`.env.example`을 `.env`로 복사합니다. 이미 `.env`가 있다면 덮어쓰지 말고 기존 값을 확인하세요.

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

## 인증과 환경변수

[에듀넷 검색 API 안내](https://www.edunet.net/apiApply/semantic/489)에서 이용 신청·키 발급 안내를 확인하고 발급받은 키와 등록 도메인을 로컬 `.env`에 입력합니다.

```dotenv
EDUNET_API_KEY=발급받은_API_키
EDUNET_DOMAIN=API에_등록한_도메인
```

| 환경변수 | 의미 |
|---|---|
| `EDUNET_API_KEY` | 에듀넷 검색 API 인증키. 필수 |
| `EDUNET_DOMAIN` | API 신청 시 등록한 도메인 값. 필수. API 서버 주소가 아니며 등록한 값을 그대로 사용 |

MCP 자체에는 OpenAI·Anthropic API 키가 필요하지 않습니다. 대화 클라이언트의 로그인·이용 권한은 별도입니다. 에듀넷 키를 대화나 공유 파일에 붙여 넣지 말고 `.env`에 보관하세요.

## 클라이언트 연결

아래 `C:/absolute/path/edunet-mcp`를 **실제 설치 폴더의 절대 경로**로 바꾸세요. macOS/Linux는 `/absolute/path/edunet-mcp` 형태를 사용합니다. `node`를 찾지 못하면 실행 파일의 절대 경로를 지정합니다.

### Codex

사용자 설정 `~/.codex/config.toml`에 다음 항목을 추가합니다. 기존 `edunet` 항목이 있으면 수정하세요. 프로젝트에만 연결하려면 신뢰한 프로젝트의 `.codex/config.toml`을 사용할 수 있습니다. [공식 MCP 설정 안내](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.edunet]
command = "node"
args = ["--env-file=C:/absolute/path/edunet-mcp/.env", "C:/absolute/path/edunet-mcp/dist/index.js"]
```

새 세션을 열고 MCP 도구 목록에서 `search_edunet`을 확인합니다.

### Claude Code

연결할 프로젝트 폴더에서 실행합니다. 기본 등록 범위는 해당 프로젝트의 로컬 설정입니다. [공식 MCP 연결 안내](https://code.claude.com/docs/en/mcp)

```sh
claude mcp add --transport stdio edunet -- node "--env-file=C:/absolute/path/edunet-mcp/.env" "C:/absolute/path/edunet-mcp/dist/index.js"
```

Claude Code에서 `/mcp`로 연결 상태를 확인합니다.

### Claude Desktop 및 JSON 설정을 쓰는 로컬 클라이언트

클라이언트의 로컬 MCP 설정 파일에 아래 서버를 추가합니다. 기존 `mcpServers`가 있으면 그 안에 `edunet`만 병합합니다. 설정 파일 위치는 해당 클라이언트의 안내를 따릅니다.

```json
{
  "mcpServers": {
    "edunet": {
      "command": "node",
      "args": [
        "--env-file=C:/absolute/path/edunet-mcp/.env",
        "C:/absolute/path/edunet-mcp/dist/index.js"
      ]
    }
  }
}
```

저장 후 클라이언트를 다시 시작합니다. MCP 실행 명령에는 `npm start` 대신 위와 같이 `node`를 사용하세요. stdout은 MCP 통신 전용이며 서버 로그는 stderr로 나갑니다.

### ChatGPT 웹

Vercel 배포 후 `https://<배포 도메인>/api/mcp`를 원격 MCP 주소로 등록합니다. 공개 배포(`MCP_AUTH_MODE=public`)에서는 인증 방식을 **없음 / No authentication**으로 선택합니다. 앱별 계정·조직 설정에 따라 사용자 정의 MCP 등록 권한이 필요합니다. 로컬 stdio 실행 명령을 웹에 직접 등록할 수는 없습니다.

### Vercel 원격 배포

Vercel 프로젝트에 이 저장소를 연결합니다. `vercel.json`이 빌드 명령(`npm run build`), 정적 출력(`public`), 서울 리전, 함수 최대 실행 시간(60초)을 설정합니다. `/api/mcp`는 요청마다 독립 서버를 생성하므로 Redis나 세션 저장소가 필요하지 않습니다.

배포 환경변수:

| 이름 | 설정 |
|---|---|
| `EDUNET_API_KEY` | 발급받은 키. Vercel Secret으로 저장 |
| `EDUNET_DOMAIN` | API에 등록한 도메인 값 |
| `MCP_AUTH_MODE` | 공개 배포는 `public`. 기본은 Bearer 인증 |
| `MCP_ACCESS_TOKEN` | Bearer 모드에서 32자 이상 비밀값. 공개 모드에서는 불필요 |
| `MCP_ALLOWED_ORIGINS` | 브라우저 직접 요청에 허용할 Origin, 쉼표 구분. 일반 서버 간 MCP 통신에는 불필요 |

공개 모드는 누구나 서버 소유자의 에듀넷 검색 할당량을 사용할 수 있습니다. API 키 자체는 응답에 포함하지 않습니다. 각 사용자에게 자신의 API 키를 받는 서비스는 아닙니다. Bearer 모드는 사용자 지정 Authorization 헤더를 지원하는 클라이언트용이며 OAuth 로그인은 구현하지 않습니다. 인증 설정이 없으면 원격 경로는 503으로 닫힙니다.

MCP 주소를 브라우저에서 열어 GET 405 응답을 받는 것은 정상입니다. MCP 클라이언트가 POST로 초기화·도구 목록·도구 호출을 수행합니다. 루트 주소는 서버 안내 페이지입니다.

CLI 배포: `npx vercel link` → 환경변수 설정 → `npx vercel deploy --prod`.
GitHub 자동 배포는 Vercel 계정에 GitHub 로그인 연결과 저장소 접근 권한이 있어야 합니다.

검증: `npm run check`. 실제 배포 검증: `node --env-file=.env scripts/verify-remote.mjs https://<배포 도메인>/api/mcp`.

## 대표 사용 예시

연결 후 대화창에서 요청합니다. 결과 유무는 에듀넷 데이터에 따라 달라집니다.

1. “에듀넷에서 중2 과학 광합성 수업자료를 5개 찾아줘. 제목과 발췌, 제공된 출처 링크를 보여줘.”
2. “광합성 관련 **평가자료**만 5개 찾아줘.”
3. “물의 상태 변화를 설명하는 **사진·영상** 자료를 찾아줘.”
4. “환경 보호 자료를 **제목에서만**, **최근 등록순**으로 찾아줘.”
5. “방금 검색한 조건과 페이지 크기를 유지해서 **다음 페이지**를 보여줘. 다음 페이지가 확인될 때만 검색해줘.”

## 주요 카테고리

자료 유형을 지정하지 않으면 전체 검색을 사용합니다. 직접 입력할 때는 코드 배열을 사용합니다(예: `categories: ["evl_data"]`).

| 코드 | 의미·용도 |
|---|---|
| `total` 또는 생략 | 전체 검색 |
| `lsn_design` | 수업설계 |
| `tpc_lrng` | 주제학습 |
| `evl_data` | 평가자료 |
| `ednwkst` | 주제별 학습자료 |
| `edntpd` | 주제별 사진·영상 |
| `asset` | 글꼴·이미지·음악·PPT 등 제작 소재 |
| `edunanum` | 선생님들의 나눔공간 |
| `crclm` | 교육과정 |
| `ednaisw` | AI·SW교육 |

사진·영상 학습자료는 `edntpd`, 제작용 소재는 `asset`입니다. 전체 18개 코드와 API 계약은 [API 조사 기록](docs/api-findings.md)에 있습니다.

## 입력 범위

| 입력 | 기본값·제한 |
|---|---|
| `query` | 필수, 공백 제거 후 1~300자 |
| `categories` | 생략·빈 배열은 전체. 최대 20개 코드, `total` 포함 시 전체로 정규화 |
| `sort` | `relevance`(정확도순), `latest`(등록순). 기본 `relevance` |
| `searchType` | `title_summary`(제목+요약), `title`(제목). 기본 `title_summary` |
| `page` | 1~50, 기본 1 |
| `pageSize` | 1~20, 기본 10 |

## 성취수준 베타

`.env`에 32바이트 이상 `EDUNET_REFERENCE_SECRET`을 설정하고 `EDUNET_ACHIEVEMENT_SEARCH_ENABLED`, `EDUNET_ACHIEVEMENT_PDF_READ_ENABLED`, `EDUNET_ACHIEVEMENT_HWP_READ_ENABLED`를 `true`로 설정한 뒤 MCP를 재시작하세요. HWPX와 자동 첨부 선택은 별도 플래그이며 기본값은 `false`입니다. 실제 교육 문서 검토 후 활성화해야 합니다.

1. `search_edunet_achievement`에 과목·학년·코드·검색어를 전달합니다.
2. 후보 `achievementRef`로 `read_edunet_achievement`를 호출해 첨부 목록을 확인합니다.
3. 선택한 `attachmentRef`를 함께 보내 원문을 읽습니다. 필드마다 원문 문구와 가능한 문서 위치가 붙습니다.
4. `pagination.hasMore`가 참이면 같은 첨부·필터와 `cursor`로 이어 읽습니다.

검색 인덱스에서 찾지 못한 결과는 자료 부재를 뜻하지 않습니다. 원문에 없는 코드나 설명을 만들지 않고, A/B/C·상/중/하를 서로 환산하지 않습니다. OCR은 제공하지 않습니다. 파서는 별도 자식 프로세스에서 실행되며 Worker 장애가 기존 검색을 중단시키지 않습니다. 일반 첨부 텍스트 읽기 `read_edunet_resource`는 추가 플래그로 활성화하는 보조 기능입니다.

## 알려진 제한사항과 오류 대응

- 기존 `search_edunet`은 검색 메타데이터와 최대 500자 발췌만 제공합니다. 새 원문 읽기는 성취수준 베타 도구에서만 수행합니다. 학습지는 생성하지 않습니다.
- 학년·과목 전용 필터는 없습니다. 검색어에 포함할 수 있지만 수업 적합성은 교사가 확인해야 합니다.
- 출처는 API가 반환한 안전한 HTTP(S) URL만 그대로 제공합니다. URL이 없거나 안전하지 않으면 `null`로 반환하고 “출처 URL 미제공”을 안내합니다. 링크를 생성하거나 메인 페이지로 대체하지 않습니다. 현재 접근성·로그인 필요 여부는 확인하지 않습니다.
- 전체 건수가 없으면 전체 건수와 다음 페이지 존재 여부는 `null`입니다. 0건 결과와 API 장애는 구분됩니다.
- 요청별 제한 시간은 본문 읽기를 포함해 15초, 재시도를 포함한 전체 제한은 45초입니다. 일시적 네트워크 오류·시간 초과와 HTTP 429·502·503·504는 최대 2회 재시도합니다.
- 최종 답변과 도구 선택은 클라이언트 모델이 결정합니다. 모델별 조건 누락·오류 후 재호출 등 행동 차이가 있으며 서버 검증 통과가 답변의 정확성을 보증하지는 않습니다.

| 오류 | 사용자가 확인할 것 |
|---|---|
| `CONFIGURATION` / `AUTHENTICATION` | 로컬 `.env`의 키·등록 도메인 확인. 키를 대화에 보내지 않기 |
| `INVALID_INPUT` | 안내에 따라 검색어·코드·페이지 범위 수정 |
| `NETWORK` / `TIMEOUT` / `UPSTREAM_HTTP` / `RATE_LIMITED` | 연결·에듀넷 장애·호출 제한 가능성. 자동 반복을 멈추고 잠시 후 다시 요청 |
| `INVALID_RESPONSE` / `RESPONSE_TOO_LARGE` | 응답 형식·크기 문제. 발생 시각과 오류 코드 기록 |
| `ABORTED` / `INTERNAL` | 취소 여부 확인. 반복되면 키를 제외한 재현 조건과 오류 코드 기록 |

## 검증 상태

**MCP 검증** — 2026-09-17 RC 기준:

- offline **40/40 PASS**
- live EDUNET **5/5 PASS**
- typecheck **PASS**

재현 명령과 보안·오류 점검 근거는 [MCP 검증 기록](docs/mcp-validation.md)에 있습니다. `npm run check`는 타입 검사와 오프라인 MCP 테스트를 실행합니다. 실제 에듀넷 확인은 키가 필요한 `npm run verify:live`로 분리합니다.

**별도 참고: 클라이언트 호환성 관측** — Terra 평가 수행, Sonnet 평가 수행, 모델별 행동 차이 존재. 점수는 MCP 합격점이나 RC 통과 조건으로 사용하지 않습니다. [호환성 관측 요약](docs/client-compatibility.md)과 [평가 실행 안내](evals/README.md)를 참고하세요.
