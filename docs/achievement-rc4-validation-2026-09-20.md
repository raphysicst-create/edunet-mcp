# 성취수준 RC4 수정 및 독립 평가 — 2026-09-20

## 고정 후보와 수정

- 제품 `1.1.0-rc.4`, profile `1.2.1`
- 소스 `74d14ccac8d7f557ae4fa7b65bf4e27a6d7b772d`
- 배포 `dpl_A2hAfTU7TcfPmtM1mofT1ZScwfxc`, READY
- [검증 MCP](https://edunet-oceo0joah-raphysicst.vercel.app/api/mcp), [배포 상세](https://vercel.com/raphysicst/edunet-mcp/A2hAfTU7TcfPmtM1mofT1ZScwfxc)
- sourceDigest `7b2b906fe08a4e169662b9a0e08a02457a273ba9678f3cbae6d833a97e2cccb6`
- 원격 manifestDigest `19b97e7edf0043bba32fcc43f945bce320729a5e813d77757b690e32b1f72ec2`

공식 게시판·안전한 다운로드·배포 동일성·코드 형식·표 병합·Worker 출력 범위 보완은 [RC2](achievement-rc2-validation-2026-09-20.md)와 [RC3](achievement-rc3-validation-2026-09-20.md)에 기록되어 있습니다. RC4는 RC3에서 새로 읽기에 도달한 한국사 HWP의 `성취기준별 성취수준 진술` 머리글 누락을 수정합니다. 이 정확한 문구와 parser의 2열 병합·명시적 성취기준 행 병합을 확인합니다. PDF는 실제 표 선 검증을 유지하며, 임의의 접미사·빈 셀·수준 순서로 관계를 추정하지 않습니다.

기존 프로젝트에서 `--prod --skip-domain`으로 만들었으며 공개 도메인으로 승격하지 않았습니다. 원격 manifest와 로컬의 모든 소스 파일 해시·sourceDigest·sourceCommit이 일치합니다. 로컬 제품 입력 경로는 clean, 원격 `gitClean:null`은 Git 상태 확인 불가입니다. 배포 보호는 유지합니다.

## 구현자 검사

| 검사 | 결과 |
|---|---|
| 타입 검사·제품 검사 | 232/232 PASS |
| 최종 계약 검사 | 295/295 PASS — 제품 232 + 기존 평가 검사 63 |
| 기존 합성 golden | 8/8 PASS |
| HWP 명시적 행 병합·PDF 표 선·미확인 머리글 거절 회귀 | 신규 3개 포함 PASS |
| 실제 과학 PDF 원격 연결 | `[9과05-01]` A–E 5개, 배포 digest 일치 |
| 실제 한국사 HWP 원격 연결 | `[10한사1-01-01]` A–E 5개·1페이지, 뒤 일반 검색 2개 |
| 실제 참조 만료·복구 | 만료 전 첨부 2개, 만료 후 `INVALID_REFERENCE`, 같은 MCP 클라이언트 연결에서 일반 검색 2개 |

첫 개발 검사에서 패키지 버전과 MCP 서버 버전 상수 불일치가 검출되어 함께 수정했습니다. 위 수치는 수정 후 전체 재실행 결과입니다. 최초 실패 로그와 최종 통과 로그를 별도로 보존했습니다. 새 검사도 기존 제한인 10MiB 다운로드·Worker 출력·메모리·시간 상한을 늘리지 않습니다.

구현자 증거는 `evals/results/remediation-development/`의 `check-rc4-final.log`, `contract-rc4.json`, `golden-rc4.json`, `rc4-smoke.log`, `rc4-history-smoke.json`, 로컬/원격 manifest와 `rc4-deployment-evidence.json`입니다. 이 검사는 독립 RC 건수에 합산하지 않습니다.

실제 발급 참조는 `09:08:05.621Z`에 생성되어 `09:23:05.621Z`에 만료됐습니다. 만료 전 `09:08:21.178Z`와 만료 후 `09:23:25.617Z`의 참조 SHA256·sourceDigest를 대조했습니다. 요약 증거는 `rc4-pre-expiry.json`, `rc4-expiry-recovery.json`이며 원시 참조는 공개 기록에 포함하지 않습니다. 구현자 보조 검사로서 독립 90건이나 Worker crash/timeout/cold start 검증에 합산하지 않습니다.

## 독립 평가의 수집기 변경과 해석

별도 작업 `성취수준 RC 독립 평가자 구현 및 평가`에서 같은 공식 원문 30종·90개 시나리오를 사용합니다. corpus SHA256은 `4602a056b74e8b4c1581efb4b2859e8be0c5180d53a06356f84d4eef4a3600aa`입니다. 이미 관측한 표본의 회귀 평가이며 새로운 블라인드 평가로 해석하지 않습니다.

RC3 종료 후 평가기 v3가 발견 첫 페이지만 수집한 결함을 확인했습니다. RC3의 후속 페이지 미수집 5건과 RC2의 10건은 확정 미발견이 아닙니다. 독립 평가자가 새 v4를 별도 디렉터리에 구현하고 검색 조건 유지·다음 페이지·잘못된/반복 페이지·상한·중간 실패를 검증했습니다. 정답·채점·인증 전송 규칙을 바꾸지 않았으며, 기존 결과를 소급 보충하거나 덮어쓰지 않았습니다.

RC4 전체 실행은 v4의 고정 조건으로 별도 수행합니다. 이전 실행과의 차이는 제품 수정과 평가기 수집 범위 변경이 함께 반영된 것이므로 전부 제품 개선 효과로 귀속하지 않습니다. 고정 정답의 결합 학년 허용값 누락으로 생긴 오탐도 자동 점수와 원문 감사 결과를 분리해 보고합니다.

## 독립 실행 최종 결과

별도 평가자가 v4 자체 검사 60/60을 통과한 뒤 `09:13:23Z`부터 `09:34:57Z`까지 전체 90건을 실행했습니다. `complete:true`, `protocolComplete:true`이며 원문/검색 부분 수집·예외는 모두 0건입니다.

| 항목 | 관측 결과 |
|---|---:|
| 목표 문서 발견·첨부 해결 | 각각 90/90 |
| 10MiB 이하 파일 다운로드·파싱·구조화 반환 | 각각 78/78 |
| 10MiB 초과 문서의 명시적 제한 처리 | 12/12 — 4개 문서를 각각 3회 질의 |
| 전체 시나리오의 구조화 반환 | 78/90 |
| 반환 레코드 | 318개, 서로 다른 문서 26종 |
| 고정 레코드 정밀도 | 291/318 (91.51%) |
| 진단용 핵심 필드 일치 | 1,272/1,272 — 코드·성취기준·수준·설명 |
| 관측 인용의 원문 존재 | 3,858/3,858 |
| 실행 전후 manifest·RPC 식별 | 일치, 280/280 RPC digest 일치 |

**고정 채점과 사후 원문 감사를 구분합니다.** 자동 불일치 및 critical 플래그 27회는 모두 `초등학교 1~2학년군` 등 원문에 실제 있는 결합 학년 표기를 사전 정답이 학교급/학년군으로 따로만 허용해 발생했습니다. 기타 필드 불일치는 0회입니다. 이를 제품의 학년 추론 오류나 확정 치명 결함 27건으로 해석하지 않습니다. 정답·채점기·score는 소급 수정하지 않았으며, 고정 Gate는 구조화 정밀도 FAIL, critical FAIL, 근거 존재 PASS를 그대로 보존합니다. 핵심 필드 100%는 이 Gate를 대체한 승인 점수가 아닙니다.

RC3와 RC4의 **첫 검색 응답** 발견은 모두 85/90입니다. v4에서 추가 검색 7회로 나머지 5건을 찾았습니다. 생태와 환경·진로와 직업 코드 질의는 3페이지, 인간과 철학의 세 질의는 2페이지에서 찾았습니다. 독립 평가자는 검색 97회의 조건·pageSize 유지, nextPage 순서, 목표 발견 후 중단을 감사했습니다. 따라서 85→90의 차이는 이번 평가의 후속 페이지 수집 효과입니다. 한국사 3건이 원문 부분 수집에서 구조화 반환으로 바뀐 것은 새 제품 후보에서 확인한 개선입니다.

정답 corpus·평가기·프로토콜의 고정 해시와 이전 RC2/RC3 산출물 불변을 확인했습니다. 최종 인증값 검사에서 알려진 인증값 노출은 0건입니다. 원본은 별도 평가 작업의 `outputs/runs/rc4-20260920-v4/`에 있는 `final-report.md`, `score.json`, `analysis.json`, `post-score-source-audit.json`, `request-sequence-audit.json`, `integrity-check.json`, `credential-audit.json`, `final-artifact-hashes.json`에 보존합니다. 구현자 저장소에는 핵심 수치와 이 원본의 해시를 `evals/results/remediation-development/independent-rc4-summary.json`으로 연결합니다.

## 운영 상태와 남은 검증

`09:38:14Z` 공개 도메인 조회에서도 `edunet-mcp.vercel.app`은 기존 `dpl_B75SY33uabZUFmRSUN7QhkddXCDK`를 가리켰습니다. RC4는 검증 배포입니다. 같은 시각대에 RC4의 `09:05:43Z` 이후 error 로그를 조회한 결과 0건이었습니다. 단일 조회 결과이며 장애 주입·지속 운영 안정성의 증명은 아닙니다. 증거는 `rc4-production-alias-evidence.json`, `rc4-runtime-error-logs.jsonl`, `rc4-runtime-error-query.log`입니다.

실제 모델 최종 답변 0/90, 사람의 원문·표 관계 검토 0/30, 통제된 원격 Worker 장애 주입·cold start, 미제공 최종 출시 Gate는 남아 있습니다. 스캔·자체 수준 라벨·페이지를 가로지르는 표 등 별도 표본 공백도 독립 평가의 `outputs/coverage-gaps.json`에 기록되어 있습니다. 고정 인자 도구 검사, 합성 검사, 구현자 만료·복구 검사로 이 항목을 완료 처리하지 않습니다. `releaseEligible:false`이며 이 문서는 출시 승인서가 아닙니다.

후속 출시 판정에는 정답집 학년 표기의 원문 감사에 대한 사람 판정, 표 관계 검토, 실제 모델 답변 및 격리 장애 검증, 최종 Gate 확정이 필요합니다. 그 후 검증한 동일 배포를 공개 도메인으로 승격해야 합니다. 현 단계에서 공개 도메인을 전환하지 않았으므로 운영 rollback은 필요하지 않으며, 향후 전환 문제가 생기면 보존한 기존 배포 ID로 도메인을 되돌릴 수 있습니다.
