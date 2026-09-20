# 성취수준 최종 답변 수집

고정 RC4 원격 MCP를 실제 구독 CLI의 Luna High 및 Haiku 기본 동작으로 평가한다. 모델은 질문·공통 지침·실제 MCP 도구만 받으며 정답이나 사전 지정 검색 인자를 받지 않는다. 30개 원문 × discovery/code/natural = 모델별 90개 새 세션이다.

```powershell
node --test evals/achievement-model/runner.test.mjs
node evals/achievement-model/run.mjs --stage prepare --out evals/results/achievement-model/NEW_RUN
node evals/achievement-model/run.mjs --stage connection --out evals/results/achievement-model/NEW_RUN
node evals/achievement-model/run.mjs --stage representative --out evals/results/achievement-model/NEW_RUN
node evals/achievement-model/freeze-full.mjs --out evals/results/achievement-model/NEW_RUN
node evals/achievement-model/run.mjs --stage full --out evals/results/achievement-model/NEW_RUN
node evals/achievement-model/audit.mjs --out evals/results/achievement-model/NEW_RUN --stage full
node evals/achievement-model/report.mjs --out evals/results/achievement-model/NEW_RUN --stage full
```

`prepare`의 CLI 경로와 독립 corpus/RC 잠금 경로는 `common.mjs`의 이 Windows 작업공간 경로를 사용한다. Vercel 접근은 기존 CLI 인증으로 프로젝트의 기존 automation secret을 읽어 지정된 RC4 endpoint에만 헤더로 보낸다. 인증값은 디스크 산출물이나 모델 프로세스 환경·입력에 전달하지 않는다. 전역 설정·배포 보호·공개 배포는 변경하지 않는다.

단계별 디렉터리는 새 경로여야 한다. 원본 trace·답변·실패를 덮어쓰지 않는다. 연결 1회와 대표 6회는 본 평가에 포함하지 않는다. 본 평가는 고정 질문마다 한 번씩 진행하며 재시도·수정 실행은 별도로 기록해야 한다.

2026-09-20 실행에서 시간 초과 중 미완료 RPC가 전체 큐를 중단시킨 후에는 `continue.mjs --out RUN`으로 시작하지 않은 ID만 이어서 수집했다. 이 도구는 잠긴 세션 실행 함수를 그대로 사용하며 시간 초과에 동반한 미완료 감사 기록만 외부 큐의 중단 조건에서 제외한다. 원본 결과의 오류는 유지한다. 모든 최초 시도가 끝난 뒤 `compose-primary.mjs --out RUN`이 모델별 90개 고유 ID를 확인하고 원본 구간들을 `primary/`에 복사한다. `audit.mjs`와 `report.mjs`는 `--stage primary`로 실행한다.

`recover.mjs --out RUN`은 `primary/`의 무응답 시간 초과에만 최대 한 번 새 세션을 허용한다. 보충 결과는 `recovery/`에 분리하며 `--stage recovery`로 별도 감사·보고한다. 완료된 답변은 내용에 관계없이 다시 실행하지 않는다. `audit.mjs`의 pass는 설명되지 않은 호출 기록 불일치가 없다는 뜻이다. 종료 후 manifest 또는 시간 초과 응답이 빠지면 별도 `incompleteEvidence`와 `evidenceComplete:false`를 남기므로 완전한 증거 검증 통과로 해석하지 않는다.

본 평가의 동시성은 모델별 최대 3개(전체 6개)다. `freeze-full.mjs`가 사전 점검 완료와 원본 실행기 스냅샷을 확인하고 별도 실행 조건을 잠근다. 한 세션의 시간 초과·최종 답변 누락은 미완료로 남기고 나머지 시나리오를 계속 수집한다. 제공자·연결·배포 동일성 등의 환경 오류는 해당 모델의 새 작업 시작을 중단하며 이미 실행 중인 결과는 보존한다.

`proxy.mjs`는 모델이 선택한 MCP 요청을 그대로 전달한다. 도구 오류도 결과로 보존하고, 읽지 않은 페이지를 자동 수집하지 않는다. 세션당 도구 60회·10분 상한을 적용한다. endpoint redirect·배포 digest 불일치는 수집을 중단한다. 각 요청은 먼저 기록하므로 프로세스 중단 때도 시작한 호출은 남는다.

`report.mjs`는 최종 답변 수집 수, 시간·호출 수 및 검토용 진단만 계산한다. 원문 정답의 설명과 문자 그대로 일치하는지는 진단 정보이며 의미 정확도·유용성 성공률이 아니다. 사람 검토 칸은 비워 두고 모델 판정으로 대신 채우지 않는다. 전체 원문/표 관계 및 최종 답변의 사람 검토, 모델 환경 격리 검증과 별도 출시 Gate가 남으므로 `releaseEligible:false`를 유지한다.

구독 CLI의 전체 시스템 지침·OS 파일 접근 격리를 증명하지 못한 관측 실행이다. Haiku 실제 응답 모델 ID와 Luna 요청 모델·High 설정 증거를 따로 보존하고, Luna의 provider-resolved 버전이 제공되지 않으면 미확인으로 기록한다. Haiku 기본 동작과 Luna High의 차이를 동일 effort 비교로 해석하지 않는다.

2026-09-20 최초 v1 연결 점검은 Luna의 code-mode host를 비활성화해 MCP 실행이 불가능했다. 원본을 보존하고 `connection-audit-correction.json`에 연결 실패를 정정했다. v2는 기본 도구 라우터를 유지하며 CLI 오류 이벤트와 도구 호출 없는 연결 점검을 환경 오류로 처리한다. 이 초기 실행을 본 평가에 합산하지 않는다.
