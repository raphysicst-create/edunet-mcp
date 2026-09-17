# MCP 검증 기록

검증일: 2026-09-17 · 대상: `v1.0.0-rc.1` · 환경: Windows, Node.js 24.18.0, npm 11.16.0.

## MCP 검증

| 항목 | 명령 | 결과 |
|---|---|---|
| offline | `npm test` (`npm run check` 안에서 실행) | **40/40 PASS**, 실패·skip·todo 0 |
| live EDUNET | `npm run verify:live` | **5/5 PASS** |
| typecheck | `npm run typecheck` (`npm run check` 안에서 실행) | **PASS** |

`npm run check`는 타입 검사 → 빌드 → 오프라인 MCP 테스트 순서다. API 키나 모델 호출 없이 실행한다. live 검증은 로컬 `.env`의 에듀넷 키·등록 도메인을 사용하며 별도로 실행한다.

## live 확인 범위

실제 Node stdio MCP 프로세스의 초기화·도구 목록 확인 후 다음을 검사했다.

| 항목 | 관측 |
|---|---|
| 일반 검색 | 광합성 1페이지 2건 / 전체 111건 |
| 카테고리 검색 | 과학, 평가자료(`evl_data`) 2건 |
| 0건 검색 | 존재하지 않는 검증 검색어, 전체 0건·다음 페이지 없음 |
| 페이지 처리 | 1·2페이지 각각 2건, 자료 ID 목록 차이 확인 |
| 잘못된 입력 | `page=51`을 `INVALID_INPUT`으로 거부 |

최초 샌드박스 실행은 네트워크 접근 제한으로 1/5(입력 거부만 통과)였다. 외부 연결을 허용한 재실행에서 5/5를 확인했다. 환경 제한 실패를 0건 검색이나 EDUNET 장애로 판정하지 않았다. 위 건수는 검증 시점의 관측값이며 고정된 서비스 데이터가 아니다.

## 최종 보안·오류 sanity check

| 점검 | 결과와 근거 |
|---|---|
| API 키가 로그·응답에 노출되는가 | **PASS — 검사한 경로에서 미노출.** `logger.test.mjs`에서 원문·URL 인코딩·구조화 필드 마스킹, `client.test.mjs`·`response.test.mjs`에서 upstream의 키 반사·검색 조건·발췌 잘림 전 마스킹 확인. live 스크립트가 정상 응답과 stderr의 실제 키 미포함 확인 |
| 내부 stack trace가 사용자에게 나오는가 | **PASS — 미노출.** `publicError`는 미지의 예외를 `INTERNAL`로 변환. `http.test.mjs`·`search-guidance.test.mjs`·`server.test.mjs`에서 원문 예외, 내부 파일 위치, stack 필드 미포함 확인 |
| 잘못된 입력이 서버를 종료시키는가 | **PASS — 세션 유지.** SDK가 범위·타입·알 수 없는 필드를 거부하고 backend를 호출하지 않음. 같은 세션의 수정된 검색 성공 및 실제 stdio 프로세스의 후속 호출·도구 목록 조회 확인 |
| EDUNET 장애가 구분 가능한가 | **PASS.** HTTP 인증·호출 제한·서버 오류, 네트워크·시간 초과, 잘못된 응답·크기 초과를 고정 오류 코드와 한국어 안내로 구분. `http.test.mjs`와 `search-guidance.test.mjs`로 합성 장애를 검증하며 live 서비스에 장애를 주입하지 않음 |
| 출처 URL을 임의 생성하는가 | **PASS — 생성하지 않음.** `response.test.mjs`·`client.test.mjs`·`search-guidance.test.mjs`에서 API 제공 링크 보존, 누락·위험 스킴·인증정보 포함 링크의 `null` 처리, 대체 링크 없음 확인. API 요청 endpoint 구성과 자료 출처 URL은 별개 |

이번 점검에서 제품 동작의 추가 수정이 필요한 결함은 발견하지 않았다. 기존 테스트에 stack trace 미포함·오류 후 프로세스 생존·패키지 버전과 MCP handshake 버전 일치 검사를 보강했다. 검증 범위는 서버이며, 최종 답변을 작성하는 모델의 행동이나 모든 외부 링크의 접근성을 보증하지 않는다.

## 별도 개발용 회귀 검사

`npm run eval:contract -- --out .scratch/rc-contract.json`: **103/103 PASS**. MCP 테스트와 평가 실행기 테스트를 함께 실행한 결과이며 40개 MCP 테스트를 포함한다. 40+103으로 합산하지 않는다. 실제 모델 실행·호환성 성적과는 무관하다.

Terra·Sonnet 평가 수행과 모델별 행동 차이는 [클라이언트 호환성 관측](client-compatibility.md)에만 기록한다. 모델 점수를 MCP 합격점으로 사용하지 않는다.
