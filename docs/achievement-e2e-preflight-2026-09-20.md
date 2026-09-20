# 성취수준 공개 배포 전 E2E 사전 검증 — 2026-09-20

**현재 판정: 공개 승인 불가(NO-GO). 전체 계획 완료나 30개 문서·90개 시나리오 평가 결과가 아니다.**

사용자가 제공한 계획서에 따라 실제 Remote MCP부터 검사했다. 독립 원문 확인과 원격 실행에서 발견 경로의 공백을 확인했다. 검색이 원문에 도달하지 못했으므로 추출 정밀도 ≥98%, evidence 원문 존재율 100%, 치명적 오류 0건을 입증하지 못했다. 미측정을 성공이나 0% 오류로 바꾸지 않는다.

첨부 계획서는 12절 코드 기준의 `실제 실패에서 추가`에서 끝났다. 이후 최종 Gate 문구는 제공되지 않았으므로 임의로 보완하지 않았다. 기존 `v1.0.0-rc.1`은 검색 전용 과거 기록이며 이번 성취수준·Remote 범위의 RC로 재사용하지 않는다.

## 1. 고정 기준과 배포 식별

- 소스: `df5efee6b5eccced210cdad04064e5ab51893e86`, 시작 시 작업 트리 clean.
- 패키지: `1.1.0-beta.1`. 이번 작업에서 제품 버전·태그·제품 기능·배포를 변경하지 않았다.
- 환경: Windows, Node `v24.18.0`.
- 제품 소스·설정·의존성 등 42개 파일의 SHA256: [baseline.json](../evals/results/e2e-20260920/baseline.json).
- 원격: <https://edunet-mcp.vercel.app/api/mcp>, 초기화 버전 `1.1.0-beta.1`, 도구 3개 확인.
- Vercel CLI `inspect`가 반환한 운영 배포: `dpl_B75SY33uabZUFmRSUN7QhkddXCDK`, READY, 2026-09-18 생성. [당시 배포 기록](vercel-deployment.md)의 ID와 일치하며, 그 기록의 소스는 `74a4d19e55de611b5435a27697d2749099409a75`다. CLI 응답에서 빌드 SHA 자체를 얻지는 못했다. 현재 소스와 같은 RC의 원격 평가로 계산하지 않는다.
- Vercel 연결 앱은 팀 권한 403을 반환했으며 기존 CLI 인증으로 읽기 전용 확인했다. 인증·권한은 변경하지 않았다.

## 2. 새로 실행한 코드 검사

| 검사 | 결과 |
|---|---|
| `npm run check` | typecheck PASS, 제품 테스트 **203/203 PASS**, skip/cancel/fail 0 |
| Vercel bundle test | 위 203개에 포함, 원래 120초 제한에서 약 50.2초에 PASS |
| `node --test evals/tests/*.test.mjs` | **63/63 PASS**, skip/cancel/fail 0 |
| 신규 수집기 | 실제 Remote 실행, `node --check`, 기존 결과 파일 덮어쓰기 거절 확인 |

203개에는 기존 security/adversarial/Worker 장애 격리 테스트가 포함된다. 이 로컬 결과를 운영 장애주입·cold start 검증으로 대체하지 않는다. 위 전체 검사는 제품 변경이 없는 고정 소스에서 실행했으며, 이후 추가한 것은 진단 수집기와 검증 문서다.

## 3. MCP 출력과 분리한 공식 자료 확인

브라우저에서 EDUNET 메뉴 `교육정책 → 교육과정 → 성취수준(평가기준)`을 따라 [2022 성취수준 게시판](https://www.edunet.net/cmnBoard/list/57)을 확인했다. 사이트의 공개 자바스크립트에 명시된 목록·상세 API를 읽기 전용으로 조회했다. 이 조회는 정답 자료 수집용이며 제품의 발견 성공으로 계산하지 않는다.

독립 메타데이터 인벤토리:

- 게시물 75개: 초등학교 5, 중학교 18, 고등학교 52.
- 첨부 150개: PDF 75, HWP 74, HWPX 1.
- 메타데이터상 10MiB 이하 첨부 71개. 정상 텍스트 문서 수나 파싱 성공 수는 아니다.
- **75개 모두 `/cmnBoard/view/57/{id}` 경로로, 현재 상세 어댑터가 인식한 수는 0개.**
- 제품은 현재 `/clssStdDt/view/...`, `/contsMvGllry/view/...`만 인식한다. 실제 성취수준 게시판의 메타데이터 어댑터·발견 경로가 없다.

[official-catalog.json](../evals/results/e2e-20260920/official-catalog.json)과 [catalog-coverage.json](../evals/results/e2e-20260920/catalog-coverage.json)에 기록했다. 이는 **75개 원문 검토나 30개 acceptance corpus가 아니다.** 다른 교육과정 게시판까지 조사해 초등학교 표본을 보완해야 한다.

## 4. 독립 원문 Ground Truth 1개 / 시나리오 3개

공식 자료: [(중)2022 개정 교육과정에 따른 성취수준(과학)](https://www.edunet.net/cmnBoard/view/57/602681).

- PDF 첨부 ID `3063775`, 파일명 `(중)2022 개정 교육과정에 따른 성취수준(과학).pdf`.
- 실제 다운로드 4,428,117바이트, SHA256 `1c23626fc131a2c6acf473362f673cb2cac28504bdfc58b8075832574d2c0264`.
- 공식 다운로드 API가 반환한 저장 경로는 `/KEDNCM/NCIC/tchboard/10055/ADE72C5D-280B-CB1A-8F73-EC90189C9218.pdf`. 현재 다운로드 검증기는 이 경로를 `DOWNLOAD_BLOCKED`로 거절한다. 크기 제한과는 별도 공백이다.
- PDF 총 112쪽. PDF 28쪽 / 인쇄 24쪽의 `(5) 힘의 작용` 표에서 `[9과05-01]`, 성취기준 원문, A–E 수준 설명을 확인했다.
- MCP/Kordoc 출력을 사용하지 않고 원본을 직접 다운로드하여 pypdf 텍스트와 Poppler 렌더링을 대조했다. 사람 검토 완료는 아니다. 학년을 중2라고 추정하지 않았다.
- Ground Truth를 저장한 다음 Remote 실행을 시작했다. [science-ground-truth.json](../evals/results/e2e-20260920/science-ground-truth.json), [실행 결과](../evals/results/e2e-20260920/science-remote-probe.json).

| 사용자 시나리오 | 원격 발견 결과 | 후속 단계 |
|---|---|---|
| 중학교 과학 성취수준 자료 찾아줘 | 후보 0건 | 첨부·다운로드·파싱·추출 미도달 |
| `[9과05-01]`의 성취수준을 알려줘 | 후보 0건 | 동일 |
| 중학교 과학에서 힘의 평형과 관련된 성취수준을 찾아줘 | 후보 0건 | 동일 |

정확한 자료명으로 수행한 일반 검색과 성취수준 검색도 0건이었다. 이는 **시험한 질의에서 미발견**이라는 증거이며 공식 검색 인덱스 전체에 자료가 없다는 증명은 아니다. 인덱스 부재가 확정되지 않았으므로 계획의 Discovery Success Rate 분모 제외를 적용하지 않았다. 모델이 자연어를 도구 인자로 바꾸거나 최종 답변을 작성한 실험은 아니며, 도구 인자는 수집기에 사전 고정했다.

## 5. 추가 원격 동작 관측

- 기존 `verify:remote --read`: initialize·3개 tools·일반 검색·후보·첨부 목록은 확인했으나, 첫 선택 PDF가 `source_unavailable / DOWNLOAD_TOO_LARGE`를 반환하여 **실패(exit 1)**. 이를 성공으로 바꾸거나 원문 오추출로 분류하지 않았다.
- 국어·수학·과학·사회·영어·정보·음악의 7개 탐색을 별도로 기록했다. 일반 평가지·다른 교과의 제목도 후보에 포함되므로 후보 개수는 적합한 성취수준 자료 발견 수가 아니다. [discovery.json](../evals/results/e2e-20260920/discovery.json).
- 알려진 소규모 대조 자료 `광합성 산물의 저장과 이용`의 전체 제목 검색은 0건이었으나, 검색어를 `광합성`으로 줄인 새로운 검사에서 공식 자료 `2516662`를 발견했다.
- 이 자료의 학생용 PDF/HWP 각각 실제 Remote 검색 → 첨부 목록 → 다운로드 → Worker → 파싱을 실행했다. 둘 다 `metadata_only`, 구조화 레코드 0개였다. PDF는 cursor로 2개 응답을 이어 읽고 종료, HWP는 1개 응답으로 종료했다. 이 결과는 성취수준 추출 정확도 통과가 아니다.
- 잘못된 참조는 MCP 오류를 반환했고, 그 다음 일반 `광합성` 검색은 2개 결과를 반환했다. 실제 만료 참조·Worker crash·timeout·circuit breaker를 운영 서버에 주입한 검사는 아니다.
- 코드 질문 반복도 후보 0건이었다. 광범위한 반복 안정성이나 cold start 검증을 뜻하지 않는다.
- [대조 실행](../evals/results/e2e-20260920/remote-controls-short-query.json), [첫 대조 실행](../evals/results/e2e-20260920/remote-controls.json).

## 6. 독립 Evals 및 사람 검토

개발 대화 이력을 전달하지 않은 별도 평가 에이전트에 질문, 사전 Ground Truth, 실제 출력, 공식 원문/렌더링, rubric만 제공했다. 제품 소스나 이전 평가 결론을 읽지 않도록 제한했다. 별도 모델 평가 API나 사용자 소유 새 작업은 만들지 않았다.

[independent-eval.json](../evals/results/e2e-20260920/independent-eval.json): 3개 모두 **FAIL / D**. 원문과 사전 정답의 코드·A–E 설명·인쇄 쪽수는 일치. 검색 실패 표현은 관측 범위에서 보수적이며, 추출·evidence·C(최종 AI 답변)는 미평가. 전체 인덱스 부재는 확정하지 않았다.

표의 성취기준 셀이 5개 수준 행에 걸친 병합 구조이므로 계획서에 따라 **HUMAN_REVIEW_REQUIRED**로 승격했다. 사람이 입력해야 하는 `CONFIRMED_PASS` 등의 최종 판정은 대신 작성하지 않았다. 정답의 표 관계를 확인하는 사람 검토와 발견 실패 자체의 관측은 구분한다.

## 7. Acceptance 지표와 잔여 작업

| 지표/단계 | 현재 값 또는 상태 |
|---|---|
| 정식 RC 고정 및 원격 동일 소스 증명 | 미완료. 현재 소스 해시만 보존, 운영은 다른 배포 |
| 30개 문서 / 약 90개 시나리오 | 미완료. 독립 원문 정답 1개, 진단 시나리오 3개 |
| 이 진단의 기대 문서 발견 | 0/3. 전체 EDUNET 발견률로 일반화 불가 |
| Attachment Resolution Success | 정답 시나리오 미도달; 미측정 |
| 정상 PDF/HWP Parse Success | acceptance corpus 미측정; 별도 대조 2개 파일 텍스트 읽기 관측 |
| Structured Extraction Precision | `null` — 미측정 |
| Evidence Accuracy / 원문 존재율 | `null` — 미측정 |
| Unsupported Inference Rate | `null` — 미측정 |
| 치명적 오류 0건 Gate | 입증 안 됨. 구조화 결과를 평가할 표본 없음 |
| 독립 Evals | 진단 3건 완료, 전체 corpus 미완료 |
| 사람 최종 검토 | 미완료 |
| 새 RC 전체 재검증 / production-like 장애 검증 | 미실행 |

우선 해결해야 하는 범위는 실제 성취수준 게시판 발견·상세 메타데이터·첨부 경로다. 현재 허용 목록을 광범위하게 풀거나 참조를 임의 발급해 Remote 경로를 우회하지 않았다. 이 지원 확장은 기존 RC의 새 기능 금지 원칙과 구분해 새 후보에서 구현·검증해야 한다. 원문 기반 평가 없이 parser 규칙이나 수준 라벨을 바꾸지 않았다.

지원 경로가 준비되면 새 RC를 고정·배포하고, 독립 Ground Truth 30개 및 난이도/학교급/교과 분포를 완성한 뒤 전체 90개 시나리오를 처음부터 실행해야 한다. 이번 진단 실행을 그 90개에 합산하지 않는다. 스캔·지원하지 않는 형식·복잡한 병합·다학년·자체 라벨 등의 정답과 예상 실패도 별도로 필요하다.

## 8. 재현과 결과 보존

추가한 [Remote 진단 수집기](../evals/achievement-remote-probe.mjs)는 제품 함수를 직접 호출하지 않고 Streamable HTTP MCP로만 실행한다. 사전 정답 해시, 도구 목록, 모든 도구 인자·응답, 지연시간을 저장하며 서명 참조는 SHA256 식별자로 치환한다. 현재 수집기는 진단용이며 자동 의미 채점이나 출시 승인을 수행하지 않는다.

```powershell
node evals/achievement-remote-probe.mjs --corpus evals/results/e2e-20260920/science-ground-truth.json --endpoint https://edunet-mcp.vercel.app/api/mcp --out evals/results/NEW-RUN/science-remote-probe.json
```

실행 완료의 exit 0은 출시 통과가 아니다. 항상 `releaseEligible:false`를 보존한다. 기존 출력 경로는 네트워크 호출 전에 거절한다. 원문 파일·렌더링·전체 정답 설명·원시 결과는 Git 제외된 `evals/results/e2e-20260920/`에만 보존했다. 원문 재배포 허용을 확인하지 않았으므로 공개 fixture에 포함하지 않았다. 사람 검토 및 전체 검증을 마치기 전 공개 배포 승인으로 사용하지 않는다.
