# RC 공격 테스트 — 2026-09-18

## 범위

현재 작업 트리 `1.1.0-beta.1`을 대상으로 기존 `1.0.0-rc.1` 검색 입출력 계약을 보존하며 검증했다. 보관된 RC ZIP과 해시, 버전, 의존성, 공개 도구 스키마는 변경하지 않았다. 기능 추가 없이 실패 테스트로 재현한 결함만 수정했다.

실제 외부 서비스를 공격하지 않고 주입 가능한 HTTP·DNS·HTTPS·Worker 응답과 실제 MCP in-memory 연결로 오류를 재현했다. 시작 시 기존 제품 테스트는 118/118 통과했다.

## 재현 및 수정

| 경계 | 수정 전 재현 | 수정 |
| --- | --- | --- |
| HTTP 취소 | fetch가 취소를 무시하고 늦게 Response를 반환하거나 microtask 사이 취소가 도착하면 body.cancel 호출 0회 | 폐기된 Response를 취소 경쟁 처리와 함께 정리 |
| HTTP Promise | fetch가 동기 취소 후 reject하면 처리되지 않은 거부로 프로세스 종료, 원본 오류가 stderr로 노출 | 사전 취소 여부와 무관하게 Promise 결과를 관찰 |
| Rate limit | 308/400자리 숫자 Retry-After가 overflow하여 전체 deadline 전에 추가 호출 | 정상 숫자 지연값은 전체 시간 예산을 소모하도록 처리 |
| 잘못된 XML 목록 | dataList의 오류 텍스트·JSON 문자열을 검색 0건으로 처리 | 비공백 텍스트를 INVALID_RESPONSE로 거부 |
| 중복 XML 필드 | 중복 responseType·totalCount·dataList·출처 필드의 앞쪽 값만 사용 | 단일 값 필드의 중복을 거부 |
| 모순된 전체 건수 | totalCount=0인데 자료가 있어도 수용하여 0건·자동 재검색 안내와 실제 자료가 충돌 | 알려진 전체 건수보다 많은 data 항목을 INVALID_RESPONSE로 거부 |
| XML 문자 | NUL 등 금지 제어 문자가 리터럴·HTML 숫자 엔티티 경로로 유출 | 디코딩 전후 금지 문자 검사 |
| 검색 출처 URL | 슬래시가 빠진 URL·역슬래시·공백이 URL 파서에서 보정되어 출처로 통과 | 모호한 URL을 null로 반환, 정상 HTTP(S) 출처는 보존 |
| 발견·읽기 취소 | 사용자의 취소를 search_unavailable/source_unavailable/worker_unavailable로 반환하거나 의존성 완료를 기다림 | 취소를 ABORTED로 전파하고 MCP의 자동 재호출 중단 안내 보존 |
| 원문 페이지 | 위치 정보가 20,000자보다 크면 최대 예산에서도 같은 cursor가 계속 발급 | 불가능한 블록은 명시적 경고와 함께 건너뛰고, 현재 maxChars만 부족하면 예산 상향 안내 |
| Worker 검증 | downloadStatus가 blocked/failed인데 verified_extraction을 수용 | 다운로드 완료 근거 없는 검증 성공을 WORKER_INVALID_RESPONSE로 거부 |
| 다운로드 URL | 원 URL과 redirect의 공백·역슬래시가 URL 객체 변환에서 사라져 검사 우회 | 보정되기 전 원문 URL도 검사 |
| DNS/소켓 | IPv6의 dotted IPv4 tail에서 서로 다른 주소를 동일하게 비교 | 전체 128비트 주소를 정규화하여 승인 DNS와 실제 peer 비교 |
| Worker IPC | 동기 send 예외 시 작업 timer/listener가 남고 원본 예외 전파 | 공통 종료 경로로 정리하고 WORKER_CONNECTION_FAILED로 반환 |

## 공격 테스트 구성

- `tests/rc-response-fuzz.test.mjs`: malformed XML/JSON/바이트, 중복 필드, 엔티티, 깊은 중첩, unsafe URL, 안전 정수 건수, Unicode 발췌와 순서 보존.
- `tests/rc-client-fuzz.test.mjs`: 카테고리 정규화의 멱등성·입력 불변성, 1/2/49/50페이지와 pageSize 경계, 건수 미제공, 응답 개수 상한, 잘못된 입력의 upstream 호출 0회.
- `tests/rc-http-faults.test.mjs`: 고정 seed 바이트 chunk fuzz 160회, 읽기 중 취소 fuzz 48회, Retry-After, 부분 전송 실패, deadline, late response, strict unhandled-rejection subprocess.
- `tests/rc-achievement-adversarial.test.mjs`: 원문 Unicode 페이지 재조합 40회, private/special IPv4 1,536개, DNS peer 불일치, 악성 redirect, malformed metadata/IPC, 20회 반복 Worker 취소와 admission 복구.
- `tests/rc-discovery-cancellation.test.mjs`: 사전 취소, 검색·메타데이터 대기 중 취소, 세 성취수준 MCP 핸들러의 ABORTED 분류.
- `tests/rc-mcp-adversarial.test.mjs`: 프롬프트 공격 문자열 7종, 24개 동시 호출, 세션 복구, 실제 MCP 취소 전달, 카테고리 표기만 바꾼 중복 호출·terminal 오류 후 반복 호출 trace 검출.

고정 seed 속성 검사는 별도 라이브러리 추가 없이 실행된다. 프롬프트 공격 검사는 신뢰 경계와 합성 호출 trace의 회귀 검사이며, 실제 모델이 항상 중단 안내를 따름을 인증하는 검사는 아니다. 서버는 뒤따르는 정당한 사용자 요청을 계속 허용한다.

생성된 속성·fuzz 입력은 정상 XML 180건, malformed XML/JSON 150건, 잘못된 바이트 150건, 카테고리 120건, 페이지 경계 220건, 모순 건수 80건, HTTP chunk 160건, 읽기 취소 48건, 원문 페이지 40건으로 총 1,148개다. 각 시나리오의 내부 재호출·여러 페이지 확인 및 IPv4 1,536개는 이 합계와 별도다.

## 검증 제한

이 환경에는 `.env`와 `EDUNET_API_KEY`/`EDUNET_DOMAIN`이 없어 새로운 live EDUNET 호출은 실행하지 않았다. 저장된 2026-09-16 실제 응답 fixture의 파싱 회귀 검사는 포함했다. 실제 클라이언트 모델을 사용한 새로운 프롬프트 공격 평가는 수행하지 않았다.

## 최종 검사

- `npm run check`: 타입 검사·빌드 성공, 제품 테스트 **166/166 통과**. 기존 118개에 신규 공격 회귀 테스트 48개를 추가했다. 실패·취소·skip 0개.
- 공개 검색 스키마와 보관 RC 계약의 일치 검사, 저장된 실제 API 응답 fixture 검사 통과.
- `node --test evals/tests/*.test.mjs`: 평가기 테스트 **63/63 통과**. 반복 호출·terminal 오류 후 재시도·pagination 전이·카테고리 정규화·증거 보존 판정을 포함한다.
- 합계 **229/229 통과**, `git diff --check` 통과. 기능·의존성·버전 변경 없음.
