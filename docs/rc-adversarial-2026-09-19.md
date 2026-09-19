# RC 추가 공격 테스트 — 2026-09-19

## 범위

`ac0fa0f`의 현재 작업 트리(`1.1.0-beta.1`)를 대상으로, 기존 `1.0.0-rc.1` 검색 계약과 이후 추가된 원격 HTTP·성취수준 읽기 경계를 공격했다. 기존 RC 기록은 [2026-09-18 보고서](rc-adversarial-2026-09-18.md)에 있다. 기능·공개 도구 스키마·의존성·버전·보관 RC 산출물은 변경하지 않았다.

모든 공격은 로컬 HTTP 서버, 주입한 upstream 응답, 합성 ZIP/Worker/참조와 고정 seed 입력으로 실행했다. 실제 EDUNET이나 배포 서버에 공격 트래픽을 보내지 않았다.

## 실패 재현과 수정

| 경계 | 수정 전 재현 | 수정 |
| --- | --- | --- |
| HTTP timeout·취소 | 즉시 준비되는 0-byte stream이 microtask를 독점해 제한 시간과 취소 타이머를 막음. 격리 자식 프로세스를 외부에서 종료해야 함 | 일정한 읽기 횟수마다 event loop에 실행 기회를 주고 빈 chunk는 저장하지 않음 |
| 잘못된 body chunk | `Uint16Array([0x1234,0xabcd])`가 성공 응답 `[52,205,0,0]`으로 변조됨 | `Uint8Array` 이외 chunk를 `INVALID_RESPONSE`로 거부 |
| XML 문자 참조 | `&#0;`·surrogate 숫자 참조가 XML parser에서 삭제되어 정상 제목으로 수용됨 | 실제 숫자 참조를 파싱 전에 검증. 주석·CDATA 리터럴은 별도로 보존 |
| 필드 별칭 | 우선 필드가 있으면 모순된 대체 ID·카테고리와 중복 대체 필드를 무시함 | 모든 단일 필드 별칭의 중복·충돌을 검사 |
| 출처 URL | `https://<b>evil</b>.test/`와 공백이 섞인 값을 정리해 다른 유효 URL로 만들어 반환함 | 출처 식별자에서 마크업·공백을 제거하지 않고 검사하며 모호한 링크는 `null` |
| 원격 JSON 바이트 | 잘못된 UTF-8을 대체문자로 바꿔 도구 호출까지 전달함. stream·Vercel Buffer 모두 HTTP 200 | 크기 검사 후 엄격히 decode하고 HTTP 400 / JSON-RPC `-32700` 반환 |
| 원격 Origin | absolute-form 요청 대상과 Origin을 같은 외부 도메인으로 설정하면 Host와 달라도 HTTP 200 | Host에서 구한 origin을 기준으로 검사하고 서로 다른 요청 대상 거부 |
| 원격 초기화 취소 | 미완료 factory를 기다리는 연결이 끊겨도 invocation이 대기함. 프로토콜 분류 중 취소 뒤에도 새 factory 실행 | factory 대기를 취소와 경쟁시키고, 늦게 반환된 서버 정리 및 실행 직전 취소 검사 |
| HWPX 경로 별칭 | ZIP Unicode path extra `0x7075`로 `payload.bin`을 XML 섹션 이름으로 변경해 DTD 검사를 우회하거나 검사한 섹션 덮어쓰기 | local/central entry의 extra-field 프레이밍과 Unicode 별칭 일치 검사 |
| 첨부 목록 pagination | 목록 삽입·삭제·재정렬 뒤 예전 cursor 사용 시 조용히 누락·중복 | cursor를 첨부 목록의 순서·표시·다운로드 메타데이터 해시에 결합 |
| Worker 취소 분류 | 사전 취소가 Worker busy/circuit-open 뒤에서 검사되어 잘못된 오류 반환 | admission 검사 전에 `ABORTED` 판정 |
| 잘못된 참조 반복 호출 | 잘못된 attachmentRef/cursor 68개가 거부 전에 metadata 조회 68회 실행 | 서명·resource scope를 외부 조회 전에 검증하여 호출 0회 |

## 공격 회귀 테스트

- `tests/rc2-http-faults.test.mjs`: chunk fuzz 80회, 반복 성공·실패·취소 100회, malformed chunk 9종, 잘못된 제한값 31종, 재시도 가능 HTTP 상태와 예산 0/1/2, Retry-After, 무한 empty-stream timeout·취소.
- `tests/rc2-response-fuzz.test.mjs`: 금지된 숫자 참조 608개, 필드 별칭 fuzz 180회, URL 변형 33개, 정상 문자 참조·주석·CDATA 보존.
- `tests/rc2-client-fuzz.test.mjs`: 페이지·페이지 크기·전체 건수 경계 400조합, 카테고리·구조 입력 오류 114개, malformed upstream 13종, query parameter 주입 5종. client/category/schema에서 추가 수정할 결함은 발견하지 못했다.
- `tests/rc2-remote-adversarial.test.mjs`: 잘못된 UTF-8, absolute-form origin 우회, legacy/modern factory 대기 중 취소, microtask 깊이 0~7 취소 경쟁, 프롬프트 공격을 포함한 연속 요청 12개와 upstream 시도 수 24회 검증.
- `tests/rc2-achievement-adversarial.test.mjs`: 악성 Unicode ZIP 별칭·섹션 덮어쓰기, 정상 UTF-8/일치 별칭, 첨부 목록 변경, 잘못된 참조 68개, busy/circuit-open 취소 우선순위.

반복 호출 테스트는 요청마다 최대 2회 내부 재시도와 오류 후 중단 안내를 확인하며, 뒤따르는 정당한 사용자 요청은 계속 처리한다. 기존 실제 MCP in-memory 취소·동시 호출·합성 모델 trace 판정 테스트도 함께 실행한다.

## 검증 한계와 호환성

이 검증은 실제 모델을 사용한 신규 프롬프트 공격 평가가 아니다. 모델이 중단 안내를 항상 따르는지는 인증하지 않는다. 잘못된 typed chunk 테스트는 주입 경계 검사이며 정상 native fetch에서 같은 타입이 발생한다고 주장하지 않는다. Origin 재현은 raw HTTP absolute-form 요청으로 확인했으며 브라우저에서의 악용 가능성을 별도로 입증하지 않았다.

새 목록 해시가 없는 기존 첨부 목록 cursor는 `INVALID_REFERENCE`가 된다. 배포 후 진행 중인 첨부 목록은 첫 페이지부터 다시 조회해야 한다. 원문 읽기 cursor와 공개 입력 스키마는 그대로다. 이번 작업에서는 배포를 수행하지 않았다.

## 최종 검사

- 신규 공격 테스트는 **27개**다. 공개 검색 계약과 저장된 실제 API 응답 fixture를 포함한 기존 테스트도 유지했다.
- 타입 검사와 빌드 통과.
- `node --test evals/tests/*.test.mjs`: **63/63 통과**, 실패·취소·skip 0.
- 첫 `npm run check`의 기본 병렬 실행: **203개 중 201 통과, 1 실패, 1 timeout 취소**. 독립 fault-worker의 시작이 2초 제한을 넘어서 예상한 crash 대신 `WORKER_TIMEOUT`이 반환됐고, Vercel 묶음 검사가 120초 제한을 초과했다. timeout 이후에도 남아 있던 해당 bundle test 자식 프로세스만 확인 후 종료했다. 이 실행을 성공으로 기록하지 않는다.
- 제한 시간·assertion·제품 코드를 바꾸지 않은 `node --test --test-concurrency=2 tests/*.test.mjs` 재검사: **202/203 통과**, Worker 장애 격리도 통과했다. Vercel 묶음 검사만 다시 120초 timeout이 발생했고, 종료되지 않은 해당 자식 프로세스를 정리했다. 신규 공격 테스트 **27/27 통과**, 나머지 기존 검사도 통과했다.
- 배포 묶음의 실제 assertion 실패와 소요 시간 문제를 구분하기 위해, 원본 테스트를 수정하지 않고 제한 시간만 360초로 확장한 임시 복사본을 별도 실행했다. **94.8초에 1/1 통과**했고 임시 복사본은 삭제했다. 이 진단 실행은 통과 수에 중복 계산하지 않는다.
- `node --test tests/vercel-bundle.test.mjs`: 원본 **120초 제한 그대로 55.0초에 1/1 통과**. 프로젝트 밖의 격리 묶음에서 PDF/HWP/HWPX 파싱·PDFium 초기화·실제 Worker fork 및 비밀 파일 제외를 검증했다.
- 최종적으로 **분리 실행 기준 제품 203/203, 평가기 63/63**의 각 assertion을 통과했다. 전체 병렬 실행의 시간 민감성은 위 실패 기록대로 남아 있으며, 기존 제한 시간이나 테스트 assertion을 완화하지 않았다.
- `git diff --check` 통과. 기본 `npm run check`가 전부 통과했다고 주장하지 않는다.

## 요청 항목별 완료 감사

현재 소스·테스트 본문·실행 로그를 다시 대조했다. 수정한 6개 소스의 마지막 변경보다 `dist` 빌드와 최종 검사 로그가 뒤에 있으며, 검사 후 제품 코드 변경은 없다.

| 요청 | 확인한 불변식·실패 조건 | 검증 근거 |
| --- | --- | --- |
| fuzz / property-based | 고정 seed 재현, 바이트·문자 순서 보존, 크기 상한, 정규화 멱등성, 페이지 전진·재조합 | `rc-response-fuzz`, `rc-client-fuzz`, `rc-http-faults`, `rc-achievement-adversarial`, `rc2-*` 테스트 통과 |
| malformed upstream | XML/JSON/인코딩·숫자 엔티티·중복 필드·잘못된 chunk·Worker IPC를 정상 빈 결과로 오인하지 않음 | 응답·HTTP·client·achievement 공격 테스트 통과 |
| timeout / rate-limit | 본문 읽기·무한 empty stream·Retry-After 대기에도 제한 시간·취소 적용, 재시도 0/1/2 상한 | `rc-http-faults`, `rc2-http-faults`, 원격 반복 요청 테스트 통과 |
| prompt-induced repeated calls | 공격 문자열을 결과 데이터에 유지하고 안내와 분리, 내부 호출 증폭 차단, 반복·terminal 이후 재호출 trace 검출 | `rc-mcp-adversarial` 및 `rc2-remote-adversarial` 통과. 실제 모델의 후속 행동 평가는 별도이며 실행하지 않음 |
| pagination edge case | 1~50페이지와 pageSize 경계, total 미제공·모순·빈 페이지, 원문 cursor 전진, 변경된 첨부 목록 거부 | client 페이지 400조합·기존 원문 재조합·첨부 목록 변경 테스트 통과 |
| unsafe URL | 공백·마크업으로 출처 생성 금지, scheme·credential·private IP·redirect·DNS peer 검증, Origin 우회 거부 | response·safe-download·achievement·remote 공격 테스트 통과 |
| category normalization | 전체 선택 우선, 중복·순서 정규화, 입력 불변성·멱등성, 잘못된 코드 거부, query 경계 보존 | `rc-client-fuzz`, `rc2-client-fuzz` 통과. 관련 제품 코드 변경 없음 |
| cancellation | fetch/body/backoff/discovery/read/Worker/remote 초기화에서 취소 전파·정리, 후속 정상 요청 복구 | MCP 취소·반복 취소·busy/circuit·legacy/modern factory·microtask 경쟁 테스트 통과 |
| 버그만 수정 | 모든 제품 변경을 위 실패 재현과 연결. 기능·공개 스키마·의존성·버전 유지 | 제품 diff 6파일, 공개 RC 스키마 보존 테스트 통과, manifest/lockfile/schema/guidance diff 없음 |

위 감사는 기본 병렬 실행의 시간 제한 실패나 실제 모델 평가 미실행을 성공으로 바꾸지 않는다. 요청한 RC 제품 경계의 공격·수정·회귀 검증과 그 제한을 함께 완료 기록으로 남긴다.
