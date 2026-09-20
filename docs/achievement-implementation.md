# 성취수준 베타 구현 및 운영

## 2026-09-20 수정 후보 `1.1.0-rc.3`

RC3는 RC2 원격 평가에서 관측한 실패를 개발 원문으로 재현하여 보완합니다. 초등 학년군 묶음과 고등 공통과목의 제목 필터를 조정하고, 과목명 제목 검색의 총건수가 0이면 같은 학교급·페이지·크기·시간 한도 안에서 한 번만 제목 필터를 완화합니다. 완화 여부는 경고와 실제 목록 keyword로 알립니다. 괄호가 있는 교과 코드와 번호가 있는 공통과목 코드는 원문의 구두점을 보존합니다.

profile `1.2.0`과 PDF 선 복원은 성취기준 열 및 설명 열의 병합을 각각 확인합니다. A/B 또는 C/D 공동 설명은 실제 선으로 범위가 검증된 경우에만 동일 설명·원래 근거 위치를 사용합니다. 수준 라벨과 설명이 없는 기준만 추출된 항목은 검증된 성취수준 목록에서 제외하며, 수준을 확정할 수 없으면 원문 블록으로 제공합니다. 원문 기준 자체를 삭제하거나 만들어 채우지 않습니다.

다른 필터 없이 특정 코드만 읽는 요청은 서명된 Worker 작업에 그 범위를 전달하여 IPC 전에 해당 수준 레코드로 줄입니다. 온전한 수준 레코드가 있고 각각 20,000자 이하이면 사용하지 않는 전체 raw 블록을 IPC로 보내지 않습니다. 미발견·큰 레코드·일반 읽기는 raw fallback을 유지하며 10MiB 다운로드/Worker 출력 한도는 늘리지 않습니다. 문서의 결정적인 `WORKER_OUTPUT_TOO_LARGE` 거절은 다른 문서에 대한 전역 circuit을 열지 않게 구분하고, 실제 Worker crash/timeout/잘못된 IPC의 circuit은 유지합니다. 코드가 없는 큰 문서 읽기의 출력 제한은 여전히 적용됩니다.

RC2는 Vercel이 빌드 중 `vercel.json`에 추가하는 `name`/`version`을 소스에 명시했습니다. 빌드 manifest는 이 파일의 모든 설정을 키 정렬 JSON으로 해시하고 나머지 파일은 원본 바이트로 해시합니다. 설정 내용 변경은 계속 배포 불일치로 처리하며, 직렬화 형식 차이만 무시합니다. `fileHashEncodings` 필드에 이 규칙을 기록합니다.

공식 게시판 발견·상세·첨부 경로, 제한적 목록 POST, NCIC/게시판 다운로드 경로, 크기 초과 사전 안내를 추가했습니다. 배포 평가에는 원격 응답의 소스 digest와 빌드 manifest가 필요합니다. 아래 베타 버전 수치는 과거 기록입니다.

실제 과학 PDF에서 코드 셀이 여러 수준 행으로 잘리고 본문의 다른 교과 언급이 문맥으로 전파되는 결함이 확인됐습니다. profile `1.1.0`은 `성취기준별 성취수준`의 2열 병합 머리글을 지원합니다. PDF는 명시적인 선 좌표와 표 경계가 일치한 경우에만 성취기준 열의 세로 병합을 복원합니다. 빈 셀·수준 순서만으로 병합하지 않습니다. 불완전한 구조는 `PDF_TABLE_STRUCTURE_UNVERIFIED`로 기록하고 불확실한 코드-수준 관계는 반환하지 않습니다. 글꼴 때문에 heading으로 분류된 설명문이 교과 문맥을 변경하지 않도록 제한했습니다.

`pdfjs-dist@4.10.38`은 기존 kordoc의 전이 의존성을 같은 버전의 직접 의존성으로 고정했습니다. OCR·이미지 의미 해석은 활성화하지 않았습니다. 개발 진단에서 `[9과05-01]` A–E와 교과 `과학`을 확인했지만, 이 1개 진단은 전체 acceptance 평가가 아닙니다. 마지막 평가기는 제품 구현 대화를 공유하지 않은 별도 작업에서 구현·실행합니다.

합성 golden은 `npm run eval:achievement -- --out evals/results/NEW-RUN/golden.json`으로 새 출력 경로를 지정합니다. 기존 결과는 덮어쓰지 않습니다.

`1.1.0-beta.1`은 블루프린트의 탐색 → 첨부 선택 → 격리 Worker → 원문 근거 구조화 경로를 구현한다. 기존 검색은 기본 도구로 유지하며 새 기능은 opt-in이다. 공개 문서 표본과 합성 golden 테스트를 자동화했지만 실제 교육 문서에 대한 도메인 검토, 인증된 discovery recall, 소수 사용자 베타 운영을 통과한 정식 출시라고 주장하지 않는다.

## 실행과 기능 플래그

```powershell
npm ci
npm run check
npm run eval:contract
npm run eval:achievement
```

기존 계약 평가는 결과 파일을 덮어쓰지 않는다. 재실행할 때는 `npm run eval:contract -- --out evals/results/contract-achievement-new.json`처럼 사용하지 않은 출력 경로를 지정한다.

`.env.example`의 기존 API 키·등록 도메인에 더해 아래 값을 **로컬 `.env`에만** 설정한다. 이 저장소에는 실제 키나 `.env`가 없다.

```dotenv
EDUNET_REFERENCE_SECRET=<32바이트 이상의 무작위 비밀키>
EDUNET_ACHIEVEMENT_SEARCH_ENABLED=true
EDUNET_ACHIEVEMENT_PDF_READ_ENABLED=true
EDUNET_ACHIEVEMENT_HWP_READ_ENABLED=true
EDUNET_ACHIEVEMENT_HWPX_READ_ENABLED=false
EDUNET_ACHIEVEMENT_AUTO_ATTACHMENT_SELECTION_ENABLED=false
EDUNET_RESOURCE_READ_ENABLED=false
```

`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`로 키를 생성할 수 있다. 동일한 키를 유지하면 재시작·다중 프로세스 사이에서도 참조 검증이 가능하다. 키를 변경하면 기존 참조와 cursor가 무효화된다. 실제 값을 Git, 로그, MCP 출력에 넣지 않는다.

클라이언트의 도구 허용 목록에 새 도구를 추가한 후 MCP를 재시작한다. 저장소 `.codex/config.toml`의 실행 경로는 설치 경로에 맞춰야 한다. 새 읽기 Worker는 사용자가 별도로 연결하는 MCP가 아니다. `dist`, `config`, 런타임 의존성을 함께 설치한다. 로컬 stdio와 원격 Streamable HTTP를 지원하며, 원격 배포와 운영 검증은 [Vercel 배포 기록](vercel-deployment.md)을 참고한다.

## 도구 계약과 사용 흐름

| 도구 | 동작 |
|---|---|
| `search_edunet` | 기존 입력·출력 스키마, 안내, 페이지·오류 의미 유지. 첨부 조회·다운로드·파싱 0회 |
| `search_edunet_achievement` | 제한된 질의 변형, 공식 컬렉션 탐색, 상세·첨부 메타데이터 확인. `coverage`와 서명된 참조 반환 |
| `read_edunet_achievement` | `achievementRef`만으로 첨부 목록. 선택한 `attachmentRef`와 함께 호출하면 파일 하나 읽기·구조화 |
| `read_edunet_resource` | 추가 플래그로 활성화. 탐색 결과 `resourceRef`로 같은 첨부의 원문 블록을 읽으며 성취수준 레코드를 주장하지 않음 |

발견 입력은 `query`, `grade`, `subject`, `achievementStandardCode` 중 하나 이상이다. URL·로컬 경로·추가 필드는 거절한다. 검색 결과의 grade/subject/code hint는 메타데이터에서 확인한 힌트이며 문서 추출값이 아니다. 공식 인덱스 미발견과 검색 장애를 구분한다. 보조 registry는 확인된 공개 API 컬렉션·상세 경로만 포함하며 일반 웹 크롤러는 없다. [경로 근거와 제한](achievement-sources.md)을 참고한다.

읽기 필터는 `raw` 또는 `normalized`와 정확히 일치하는 레코드에 적용하며 요청값을 원문 필드에 채워 넣지 않는다. 수준 라벨은 A/B/C, 상/중/하, 서술형을 그대로 보존한다. 순서가 원문에서 명시되지 않으면 `ordinal`을 만들지 않는다. 병합 셀은 parser가 제공한 span만 사용하고 상속을 경고한다. 불명확한 페이지를 추정하지 않는다.

## 반환 한도와 이어 읽기

- 참조 만료: 15분. 내부 Worker handle: 최대 60초. 자료·첨부 소속을 메인과 Worker에서 매번 검증한다. 읽기 참조 재사용은 허용하며 Worker IPC는 프로세스당 한 번만 수신한다.
- 첨부 목록: 한 번에 최대 20개, `maxItems` 적용, 목록 항목 JSON 12,000자 예산. `pagination.cursor`로 목록을 이어 읽는다. 첨부를 선택할 때 목록 cursor는 제거한다.
- 파싱 응답: 기본 50개, 최대 100개. `maxChars`는 **records + rawBlocks의 직렬화 문자 예산**이며 기본 8,000, 최대 20,000이다. 출처·서명된 참조·경고 메타데이터는 별도로 제한된다. 총 MCP 프레임 크기 한도를 뜻하지 않는다.
- 레코드 전체 근거를 예산 안에서 보존한다. 요청 한도보다 큰 레코드는 한도를 높이도록 경고한다. 최대 20,000자 자체를 넘는 레코드는 제외 이유와 원문 블록을 반환한다.
- 긴 원문 블록은 문자 구간 `charStart`, `charEnd`를 보존하며 나눈다. UTF-16 문자 오프셋이며 surrogate pair를 중간에서 자르지 않는다.
- 읽기 cursor는 자료·첨부·필터·읽기 모드·파일 해시·parser/profile 버전·오프셋에 묶인다. 이어 읽기는 파일을 다시 검증·파싱하므로 파일이 바뀌면 기존 cursor를 거절한다. 원본과 추출 결과를 장기 캐시하지 않는다.
- `documentExtractionComplete`와 `responseTruncated`를 별도로 반환한다. 그림·그래프는 항상 `visualContentInterpreted:false`다.

## 지원 범위

| 형식 | 현재 지원 | 보수적 실패 |
|---|---|---|
| 텍스트 PDF | 페이지·표/문단의 명시된 코드·수준·설명, 행/열 표 | 인식하지 못한 표는 원문 블록 + `metadata_only` |
| HWP 5 | 문단·표·parser가 제공한 병합 span, 블록·표·행·열 근거 | 비밀번호/배포용/깨진 OLE 또는 한도 초과는 `parse_failed` |
| HWPX | 기본 꺼짐. 제한된 ZIP 구조와 명시적 표 머리글 profile만 실험적으로 허용 | 검증 안 된 profile은 `unsupported_format`, 원문 블록 보존 |
| 스캔 PDF | OCR 미지원 | `no_text` + `OCR_REQUIRED` |
| HTML/PPTX/DOCX/XLSX/미디어 | 현재 일반 읽기에서도 범위 밖 | `unsupported_format` 또는 첨부 목록만 제공 |

HWPX의 공개 템플릿은 파일 구조를 확인하는 smoke fixture다. 실제 교육 성취수준 문서에 대한 검증을 대신하지 않는다. 합성 golden의 품질 점수도 실제 자료 전체에 대한 정확도·recall 수치가 아니다. 다중 페이지 반복 머리글은 표 안에서 처리하지만 parser가 별개 표로 분리한 페이지의 암묵적 코드·셀을 추정 연결하지 않는다. 코드 없는 문서는 코드를 생성하지 않는다.

## 실행 경계와 보안

메인 MCP는 검색과 JSON 메타데이터만 처리한다. 별도 Node 자식 프로세스가 공개 EDUNET에서 직접 다운로드하고 `kordoc@4.14.0` parser를 실행한다. 파일 bytes/base64를 메인 IPC 요청에 싣지 않는다. 셸 실행·임시 파일·OCR 모델 다운로드·원문 영구 저장은 사용하지 않는다. 문서 내용은 지시문으로 실행하지 않는다.

- Worker 최대 2개, 전체 30초, Node heap 256MiB. Native 라이브러리까지 포함하는 OS 전체 RSS 제한은 아니므로 원격 플랫폼 배포 때 컨테이너 메모리 제한을 별도로 설정한다.
- 다운로드 10초, 10MiB, 전송/HTTP 압축해제 상한 각각 적용, 일시 장애 재시도 총 1회. DNS 검증 후 연결 주소를 고정하고 실제 소켓 주소를 비교한다. 모든 리디렉션의 HTTPS host/path/IP를 다시 검증한다.
- 확장자·메타데이터 MIME·HTTP MIME·magic bytes를 각각 비교한다. OLE/ZIP 내부 형식은 Worker에서 재검증한다.
- HWP/HWPX 내부 해제 상한: stream 32MiB, 합계 64MiB, 파일 500개. DTD/entity, 암호화, ZIP64/streaming descriptor 등 미검증 유형은 거절한다.
- parser 텍스트 4M 문자, 50,000블록, IPC 결과 3.5M 문자 상한. 큰 문서는 조용히 일부를 성공으로 반환하지 않는다.
- Worker 연속 실패 3회면 30초 circuit open. 검색은 별도이며 Worker timeout·crash·잘못된 응답에도 계속 호출 가능하다.

설치된 기존 kordoc OCR 전이 의존성에 대한 `npm audit` 결과는 4 high였다(`@huggingface/transformers`의 ONNX/sharp/adm-zip 경로). 이 기능에서는 OCR·이미지 변환을 비활성화했다. 정식 출시 전에 해당 의존성 업데이트와 재검증이 필요하다. 기능 구현 중 무관한 parser 메이저 업그레이드는 하지 않았다.

## 운영과 롤백

구조화 stderr 로그는 도구 상태·지연·Worker circuit open을 기록한다. 원문, query, 서명 토큰, 임시 다운로드 URL을 로그에 남기지 않는다. 운영 시스템에서 상태별 성공률과 지연 분포를 집계한다. 별도의 관측 SaaS나 remote 배포 설정은 추가하지 않았다.

읽기 장애 시 해당 `EDUNET_ACHIEVEMENT_*_READ_ENABLED=false`로 바꾸고 재시작하면 탐색과 기존 검색을 유지한다. 새 도구 전체는 `EDUNET_ACHIEVEMENT_SEARCH_ENABLED=false`로 끈다. parser profile은 `config/document-profiles`, 발견 경로는 `config/achievement-source-registry.json`을 독립적으로 Git revert할 수 있다. 실제 사용 중인 문서의 parser/profile 버전과 content hash를 보고 회귀를 재현한다.

## 검증 및 출시 게이트

2026-09-18 KST, Node `v24.18.0`, Windows에서 확인했다. 구현 통합 커밋은 `2418da2`이며 아래 결과는 출시 전 자동·연결 검증이다.

| 검증 | 결과 |
|---|---|
| `npm run check` | 타입 검사 통과, offline **118/118** |
| `npm run eval:contract -- --out evals/results/contract-achievement-final.json` | 기존 eval 포함 **181/181** |
| `npm run eval:achievement` | authored golden 및 공개 layout 표본 **8/8**, raw label fidelity·evidence 100%, unsupported inference 0% |
| `npm run verify:achievement:public` | 실제 공개 PDF/HWP **2/2** 다운로드·Worker·텍스트 파싱 통과. 성취수준 레코드 0개이므로 `metadata_only` |
| 인증된 기존 검색 live 및 실제 교육자료 품질 | API 키·교육 도메인 검토가 없어 미실행 |

Golden 점수의 상세 범위와 미측정 지표는 [측정 요약](achievement-golden-summary.json)을 참고한다. 완전한 expected/actual 비교는 실행 후 `evals/results/achievement-latest.json`에 생성된다. raw label fidelity 등 수치를 실제 교육자료 전체의 품질로 일반화하지 않는다.

기존 기준선은 [achievement-baseline.md](achievement-baseline.md), parser fixture 출처·라이선스는 [fixture README](../tests/fixtures/achievement/README.md)와 `tests/fixtures/achievement/public/`에 기록한다. 새로운 자동 검증은 서명/만료/소속, SSRF/리디렉션/DNS 재바인딩, 압축 한도, 파일 위장, parser fixture, evidence/raw label fidelity, 목록·본문 cursor, Worker 장애 격리와 검색 스키마 고정을 포함한다. 실제 자식 프로세스 종료·무응답·잘못된 IPC를 주입하면서 같은 MCP 연결의 검색이 정상인지 검사한다.

```powershell
# 공개 파일: 검색 인증키 없이 실제 MCP → 자식 Worker → EDUNET PDF/HWP
npm run verify:achievement:public
# API 키를 가진 환경: 기존 검색 live 5개 시나리오
npm run verify:live
```

인증 검색 live, 실제 교육 문서의 discovery recall/필드 정밀도, 교육 도메인 검토, 클라이언트 prompt eval, 운영 베타와 원격 배포는 이 체크아웃에서 완료하지 않은 출시 게이트다. 새 기능 기본 활성화는 이 검토 후 결정한다.
