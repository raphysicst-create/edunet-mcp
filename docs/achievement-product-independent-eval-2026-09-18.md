# 성취수준 eval 독립 실행 — 2026-09-18

별도 세션과 git worktree에서 평가 결함을 수정하고 전체 검증을 재실행했다. **제품 eval 테스트 60/60, 전체 계약·회귀 289/289, 기존 golden 8/8, 공개 PDF/HWP smoke 2/2를 통과했다.** 실제 교사 질의 30개는 모두 후보 0건이었다. 승인된 실문서 gold가 0개이므로 정량 제품 품질은 `inconclusive`, `pass:false`다. 테스트 통과를 실문서 정확도 통과로 해석하지 않는다.

## 실행 범위와 대상

- 브랜치: `codex/achievement-product-eval-run`
- 시작 커밋: `fdabbe697aa943e378a139e34d70a2ed3c1effcd`
- 평가한 수정 소스의 커밋: `f694b31057a749c9c2c3c97462a1b97c14139f36`
- 채점기: `1.1.0`; Node `v24.18.0`, Windows
- 실행 시각: 2026-09-18 00:27:49–00:30:34 UTC, 09:27:49–09:30:34 KST

테스트는 시작 커밋의 worktree에 아래 수정 사항을 적용한 상태에서 실행했고, 검증한 수정 사항을 이후 `f694b31`로 커밋했다. discovery 수집·grade에 기록된 채점기 해시는 현재 커밋 파일과 일치한다. 구체적인 명령 인자, 종료 코드, 실행 시각, 소스·로그·원본 산출물 SHA-256은 [기계 판독 보고서](achievement-product-independent-eval-2026-09-18.json)에 보존했다.

원본 프로젝트의 스테이징된 배포 작업은 이 worktree에 포함하지 않았다. 상위 프로젝트의 `node_modules`를 재사용했으며 패키지를 새로 설치하지 않았다. 코드 작업공간은 분리했지만 의존성을 새로 설치한 완전한 독립 환경은 아니다. 과거 전체 테스트 수와 이번 수를 그대로 비교하지 않는다.

## 수정한 eval 결함

1. `run.completed !== false`를 `run.completed === true`로 바꿨다. 완료 선언이 없거나 `null`, 문자열, 숫자, 객체인 실행은 완결·합격으로 승격할 수 없다. 개별 지표는 진단용으로 남고 `collection_not_completed`를 기록한다.
2. gold가 검토하지 않은 추가 위치 좌표에 완전한 근거 점수를 주지 않는다. `{page:1}`만 검토했는데 `{page:1,row:999}` 또는 상세 block·문자 범위가 반환되면 추가 위치 검토가 필요하다. 이를 사실 오류로 단정하지 않고 `unverifiedLocationFields`와 `field_evidence_additional_location_review_needed`로 구분한다. gold에 기록한 위치가 충돌하는 경우는 근거 불일치다.
3. 최초 기준선의 git 제외 산출물 링크를 로컬 경로 표기로 바꿨다. GitHub에는 추적된 요약 JSON/Markdown만 연결한다.

1.0.0과 1.1.0의 근거 채점 의미가 달라 과거 결과를 재채점하거나 점수를 합산하지 않았다. 생산 검색·문서 파서 기능과 코퍼스 정답은 변경하지 않았다.

## 검증 결과

| 실행 | 결과 | 검증 범위 |
|---|---|---|
| TypeScript 검사·빌드 | exit 0 | 현재 worktree의 소스 |
| product eval 테스트 | 60/60 | 수집·CLI·채점, 신규 경계 회귀 포함 |
| 전체 계약·회귀 | 289/289 | 모든 `tests/*.test.mjs`, `evals/tests/*.test.mjs`; skip/todo 없음 |
| 기존 achievement golden | 8/8 | 합성/비교육 레이아웃 fixture; 사람 검수 실문서 정답 아님 |
| 공개 PDF/HWP smoke | 2/2 | 공식 첨부 다운로드·Worker·파서 연결 |
| 실제 discovery | 30/30 실행 | 질의 30개 모두 `not_found_in_official_index`, 후보 0건 |
| corpus audit | exit 0 | 승인 문서 0개, 승인 질의 0개, 준비 상태 `unmeasured` |
| review-packet | exit 0 | 비어 있는 사람 검토 양식 생성 |
| grade | exit 2 | 의도된 `inconclusive`, 품질 합격 아님 |

공개 문서 smoke는 자료 `2516662`의 PDF/HWP를 사용했다. PDF 113,952바이트와 HWP 343,040바이트를 `kordoc 4.14.0`이 파싱했다. 둘 다 `metadata_only`, 구조화 레코드 0개였다. 원문 추출 완료는 true였지만 PDF 응답에는 `hasMore:true`가 남아 있으며, 이 smoke가 모든 원문 응답 페이지를 읽은 검증은 아니다. `TABLE_PROFILE_UNMATCHED`, `NO_ACHIEVEMENT_RECORDS` 등 경고를 그대로 기록했다. 실제 성취수준 정답 문서로 승인하지 않았다.

교사 질의 30개는 중학교 과학·수학·국어 각각 5개, 고등학교 과학 5개, 기타 10개다. 첫 페이지 최대 20개 후보를 수집했으며 이번에는 모두 0건이었다. 이는 승인된 관련 문서 집합에 대한 recall 0이나 실제 자료 부재를 뜻하지 않는다. 초기 부모 세션의 대조 질의 결과와 이번 관측을 합산하지 않았다.

## 재현과 보존

실행한 명령은 TypeScript CLI의 `-p tsconfig.json --noEmit`과 build, Node `--test` product 테스트 3파일, `evals/contract.mjs --out ...`, `evals/achievement.mjs`, `scripts/verify-achievement-public.mjs`, product 실행기의 `discover`, `audit`, `review-packet`, `grade`다. 검색 명령만 기존 `.env`를 절대경로 `--env-file-if-exists`로 읽었다. 키 내용을 출력·복사·커밋하지 않았다. 정확한 실행 인자는 JSON의 `commands`에 있다.

원본 로그·실검색·검토 양식·채점 결과는 이 worktree의 `evals/results/independent-2026-09-18/`에 있고, 기존 golden 원본은 `evals/results/achievement-latest.json`이다. 이들은 git 제외 파일이므로 새 clone에서 링크로 열 수 없다. 추적된 JSON에는 원본 산출물 27개의 경로와 해시를 보존했다. 전체 원문, 인증키, 서명 ref는 보고서 커밋에 포함하지 않았다.

실문서 discovery recall, 레코드·필드 precision/recall, 실제 첨부 선택 정답률은 여전히 미측정이다. 클라이언트 12개는 수동 시나리오로 미실행이며 유료 모델 API 호출은 0회다. 운영 베타·원격 배포도 검증하지 않았다. 이 세션은 로컬 커밋까지만 수행했으며 원격 push·업로드·PR 생성은 하지 않았다.
