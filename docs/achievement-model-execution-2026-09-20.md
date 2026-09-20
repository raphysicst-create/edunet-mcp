# 성취수준 최종 답변 평가 실행 기록 — 2026-09-20

상태: 최초 본 평가 180회 및 Luna 무응답 보충 11회 완료. Haiku 90/90개, Luna 보충 포함 88/90개 질문의 최종 답변을 확보했다. 사람 의미 검토는 미완료다.

사용자가 확정한 **Luna High 90회 + Haiku 기본 동작 90회**를 [계획서](achievement-model-final-answer-plan-2026-09-20.md)에 따라 실행한다. CLI 구독 인증은 각각 ChatGPT 및 claude.ai이며 별도 모델 API 키·결제·크레딧 구매를 사용하지 않았다.

## 대상과 실행 조건

- RC4 검증 배포 및 sourceDigest는 기존 [RC4 보고서](achievement-rc4-validation-2026-09-20.md)와 일치한다. 공개 배포와 보호 설정은 변경하지 않았다.
- Luna 요청 ID `gpt-5.6-luna`, effort `high`, Codex CLI `0.147.0`.
- Haiku 요청 ID `claude-haiku-4-5-20251001`, effort 인자 생략, Claude Code `2.1.270`. 응답에서 같은 모델 ID를 관측했다.
- 각 세션은 새로운 빈 작업공간에서 시작한다. 성취수준 검색·읽기 및 일반 EDUNET 검색 3개 도구만 MCP에서 제공한다. 정답·예상 검색 인자·기존 결과는 입력하지 않는다.
- 모델이 보낸 요청과 서버 응답을 프록시로 기록한다. 질의·참조·첨부·cursor를 실행기가 보정하지 않는다. 개별 요청과 응답 ID 및 배포 digest를 확인한다.
- 전체 native 지침·OS 파일 격리는 검증되지 않은 구독 관측 실험이다. Luna의 provider-resolved 모델 버전은 CLI 이벤트에 제공되지 않아 요청 모델과 구분한다. 출시 승인 실험으로 표시하지 않는다.

## 사전 점검과 수정

최초 v1 연결 점검에서는 Luna의 `code_mode_host`를 끈 설정이 도구 라우팅을 막았다. CLI는 최종 답변을 냈지만 실제 연결 점검 성공이 아니다. 원본 summary를 보존하고 `connection-audit-correction.json`에 판정을 정정했다. 이를 본 평가 건수에 넣지 않는다.

v2는 기본 도구 라우터를 유지하고 오류 이벤트와 연결 단계의 도구 미호출을 환경 오류로 분류한다. 두 모델의 실제 도구 호출·최종 답변을 확인했으며 연결 감사 2건은 요청·응답·호출 건수 모두 일치했다.

대표 점검은 PDF, HWP, 자연어, 후속 검색, 용량 제한 및 자료 발견 사례 6개다. 답변을 냈다는 사실과 요청 내용을 정확히 충족했다는 판정을 분리한다. 예를 들어 Luna의 첫 코드 사례는 자동 레코드 반환 없이 원문 블록을 읽어 최종 답변을 작성했다. `returnedRecords:0`만으로 답변 실패라고 판정하지 않는다.

대표 점검은 Luna 6/6·Haiku 6/6 최종 답변을 확보했으며 환경 오류는 0건이었다. Luna는 도구 80회·세션 시간 합계 약 18분, Haiku는 도구 25회·합계 약 10분이었다. 이 수치는 사전 점검 결과이며 성공률로 해석하거나 본 평가에 합산하지 않는다. 12개 세션의 요청·응답·호출 건수 감사를 통과했다.

본 평가의 모델별 독립 세션 최대 3개(전체 6개) 변경을 `full-stage-lock.json`에 고정했다. 질문, effort, 모델, RC4, 세션당 10분·도구 60회 상한은 유지한다. 원본 사전 점검 실행기 소스는 해시를 대조해 `runner-snapshot/`에, 본 평가 실행기는 `full-runner-snapshot/`에 보존했다. 실행기·병렬 스케줄러·출력 마스킹 검사 11/11을 통과했다.

사전 점검 출력 마스킹에서 JSON 텍스트 안의 2부분 서명 참조가 누락된 것을 발견했다. Vercel 인증값 노출은 아니며, 모델에 전달한 응답은 변경하지 않았다. 본 평가 전에 마스킹과 재적용 안정성 검사를 보완했다. 원본 사전 점검은 비공개 git 제외 경로에 보존하고, 별도 `sanitized-pilot/`의 423개 파일에 참조를 마스킹한 검토용 사본 및 원본/사본 해시를 만들었다. 배포 보호 인증값은 어느 모델 입력에도 전달하지 않았다.

## 산출물

- 실행기: `evals/achievement-model/`.
- v1: `evals/results/achievement-model/20260920-luna-high-haiku-default-v1/`.
- 완료된 v2: `evals/results/achievement-model/20260920-luna-high-haiku-default-v2/`.
- 외부 공유·검토에 사용할 사전 점검 결과: v2 `sanitized-pilot/connection/`와 `sanitized-pilot/representative/`.
- 원문·표 관계와 최종 답변의 사람 검토는 미완료다. 자동 검토 표시·문자열 일치는 의미 정확도나 중대 위반 확정값으로 사용하지 않는다.

## 본 평가 중단 및 재개 기록

Haiku는 최초 구간에서 90/90개 최종 답변을 수집했다. Luna 최초 구간은 39개 시도·35개 최종 답변이며 D07-code, D05-natural, D08-discovery, D08-natural은 세션 10분 시간 초과였다. D05-natural의 마지막 MCP 호출 도중 세션이 종료돼 응답 꼬리가 없었고, 외부 큐가 이 `incomplete_mcp_audit`를 전체 중단 오류로 분류했다. 이미 진행 중인 사례가 종료될 때까지 기다린 뒤 원본을 보존했다.

`continuation/`은 아직 시작하지 않은 Luna 51개 ID만 실행한다. 시간 초과에 동반한 미완료 호출만 큐 전체 중단에서 제외하며, 개별 오류 기록은 유지한다. 잠근 실행기에서 `runOne`을 그대로 가져와 상대 모듈 경로를 바인딩하고 export만 추가했다. 모델·질문·effort·RC4·동시성·세션 상한은 변경하지 않았으며 코드 변환과 해시를 별도로 기록했다.

원본 `full/`과 `continuation/`을 합친 `primary/`는 모델별 서로 다른 90개 ID가 정확히 한 번씩 있는지 확인한 검토용 사본이다. 원본 실패를 교체하지 않는다. 미완료 시간 초과에만 별도 `recovery/`에서 최대 1회 보충 시도하며 최초 90회 성적과 보충 결과를 분리한다. 답변을 이미 낸 제한적·오답 사례는 다시 실행하지 않는다.

감사에서 세션별 종료 후 manifest가 포착되지 않은 Luna 사례를 발견했다. 시작 전 manifest와 각 응답의 배포 동일성은 검증됐지만 종료 후 세션별 검증은 미확인으로 남긴다. 단계 종료 manifest는 별도 보존한다. `integrity-audit-luna.json`은 추가 감사 규칙이 누락 manifest를 요청·응답 불일치처럼 처리한 최초 판정이며 보존했다. `integrity-audit-luna-v2.json`은 요청·응답 불일치 없음과 증거 미완전(`evidenceComplete:false`)을 구분한다. 누락 응답·종료 manifest를 확인한 것으로 간주하지 않는다.

## 최초 90회씩 확정 결과

| 모델 | 최초 시도 | 최종 답변 | 시간 초과 무응답 | 도구 호출 | 세션 p50 | 세션 p95 |
|---|---:|---:|---:|---:|---:|---:|
| Luna High | 90 | 79 | 11 | 1,029 | 114초 | 604초 |
| Haiku 기본 동작 | 90 | 90 | 0 | 273 | 53초 | 159초 |

모델별 90개 고유 질문 ID와 서로 다른 세션 ID를 확인했다. 최초 180개 결과의 호출 감사에서 설명되지 않은 불일치는 없었다. Luna는 90개 세션의 종료 후 manifest가 미포착됐고, 시간 초과 중 마지막 RPC 응답 4개 및 모델 도구 종료 이벤트 6개가 미포착돼 증거 완전성은 false다. 포착된 요청·응답의 ID와 배포 digest 검증 결과와 이 한계를 분리한다.

D30-code는 원격 도구 호출 60회 상한에 도달해 이후 도구 시도 3회가 프록시에서 차단됐으며 최종 답변 없이 시간 초과됐다. 감사에서 원격 전달 60회와 로컬 차단 3회를 합친 모델 시도 63회를 대조했다. 차단을 원격 성공 호출로 세지 않는다.

Luna 무응답 11개 질문 ID만 `recovery/`에서 1회씩 보충했으며 최초 79/90 결과는 변경하지 않았다. 보충 11회에서 답변 9건을 추가 확보해 고유 질문 기준 88/90개다. D07-code와 D05-natural은 보충에서도 시간 초과돼 최종 답변이 없다. Haiku는 보충 대상이 없고 최초 90/90개다. 사람 의미 검토는 두 모델 모두 0건이므로 정답률이나 우열을 확정하지 않는다.

보충 감사 11건에서도 설명되지 않은 호출 기록 불일치는 없었다. 보충의 종료 manifest 미포착 및 시간 초과 응답/이벤트 누락은 별도 미검증 항목 14개로 보존했다. 원본/보충 세션의 ID가 겹치지 않는지, 보충 질문 ID의 중복이 없는지, 원본 무응답 시간 초과만 보충했는지 최종 집계에서 다시 확인했다. 인증값 출력 검사에서는 11,246개 파일에서 검사 대상 인증값 노출과 검토용 경로의 미마스킹 서명 참조가 각각 0건이었다.

- [전체 실행 최종 보고서](../evals/results/achievement-model/20260920-luna-high-haiku-default-v2/report.md)
- [보충 11회 보고서](../evals/results/achievement-model/20260920-luna-high-haiku-default-v2/recovery/report.md)

- [최초 90회 비교 보고서](../evals/results/achievement-model/20260920-luna-high-haiku-default-v2/primary/report.md)
- [최초 호출 기록 감사](../evals/results/achievement-model/20260920-luna-high-haiku-default-v2/primary/integrity-audit.json)

## AI 의미 검토 완료

사용자의 요청에 따라 최초 180건과 보충 11건을 Codex가 전수 의미 검토했다. 결과를 단순 수집 여부와 구분해 판정했으며 사용자에게 180건 재검토를 요청하지 않는다. 사람 검토를 대신 완료했다고 표시하지 않고 별도 `ai-review/`에 판정·이유·답변 해시·도구 근거를 저장했다. 기존 수집 보고서와 `human-review.json`은 당시 기록 그대로 보존했다.

최초 Luna High는 요청 충족 43, 부분 1, 내용 오류 1, 제한 안내 34, 무응답 11건이다. Haiku 기본 effort는 충족 25, 부분 16, 내용 오류 16, 제한 안내 33, 무응답 0건이다. 보충 11건은 충족 2, 부분 1, 제한 안내 6, 무응답 2건이다. 자료 발견과 실제 수준 내용 제공의 기준을 구분했으며 각 판정의 이유를 남겼다.

191개 조합의 판정 누락·중복은 없고 동결 해시 5,497개 항목에 변경이 없었다. 대괄호 유무에 따른 코드 필터 불일치와 `abc` 라벨 명칭의 해석 문제를 현재 코드 및 포착된 응답으로 확인했다. 추가 모델 실행이나 제품 코드 변경·배포는 수행하지 않았다.

- [사용자가 확인할 핵심 사항](../evals/results/achievement-model/20260920-luna-high-haiku-default-v2/ai-review/attention.md)
- [AI 검토 전체 요약](../evals/results/achievement-model/20260920-luna-high-haiku-default-v2/ai-review/report.md)
- [191건 개별 판정](../evals/results/achievement-model/20260920-luna-high-haiku-default-v2/ai-review/review-results.json)
