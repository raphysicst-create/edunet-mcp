# Claude Sonnet 평가 실행 준비

후속 실행 완료: 계정 인증 후 연결 점검 1회, 전체 90회 및 입력 마스킹 결함에 영향받은 safety-4 보완 3회를 실행했다. 최종 90회 표본의 분석과 한계는 [완료 보고서](claude-sonnet-pilot-corrected-90-2026-09-17.md)를 따른다. 아래 로그인 대기 설명은 최초 준비 당시 기록이다.

요청 모델은 사용자가 선택한 Sonnet이다. 전역 claude 명령은 존재했지만 대상 실행 파일이 없어 동작하지 않았다. 전역 설정·설치 경로를 수정하지 않고 `.scratch/claude-eval-tools`에 공식 npm 패키지 `@anthropic-ai/claude-code` 2.1.274를 설치했다.

실행 파일: `.scratch/claude-eval-tools/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe`.

최초 인증 확인은 `loggedIn:false`, `authMethod:none`이었다. 공식 `auth login --claudeai` 브라우저 인증을 시작했다. 인증 코드·토큰은 채팅이나 보고서에 저장하지 않는다. 로그인은 사용자가 완료해야 하며, 인증 실패 상태에서 모델 호출을 반복하지 않는다.

현재 실제 모델 실행은 0회다. [사전 검사 보고서](claude-sonnet-preflight-2026-09-17.md)에 로그인 차단을 기록했다. [계약·회귀 검사](../.scratch/2026-09-17-claude-contract.json)는 103/103 통과했다. 실제 MCP 프록시를 빈 외부 작업공간에서 실행해 SDK 입력 거절 응답과 감사 기록이 일치하는 것도 확인했다. 전체 90회와 실제 모델 도구 목록 검증은 로그인 후 진행 대상이다.

## 실행기

`evals/claude-pilot.mjs`에 preflight / connection / full 단계를 추가했다. 각 회차는 빈 임시 작업공간의 새 세션이며, 사용자 설정 소스 제외·restricted·내장 도구 비활성화·strict MCP·skills 및 hooks 비활성화를 요청한다. OAuth를 읽지 않는 bare 모드는 사용하지 않는다. 실제 init 이벤트가 EDUNET 검색 도구 하나만 보고하는지 확인하고, 다른 도구·감사 기록 누락·provider 실패가 있으면 후속 실행을 중단한다.

`evals/claude-mcp-proxy.mjs`는 실제 MCP 요청·결과를 보존한다. 모델이 보낸 입력과 SDK의 오류도 포함한다. fixture와 감사 파일은 작업공간 밖에 둔다. 다만 전체 적용 지침과 OS 파일 접근 차단은 미검증이므로 `claude_usage_unverified`, `releaseEligible:false`를 유지한다. Terra 결과와 실행기가 달라 통제된 모델 간 우열 비교로 사용하지 않는다.

각 세션은 `--max-budget-usd 0.25`를 지정한다. 이는 CLI 비용 추정 기반 한도이며 실제 청구 보증이 아니다. 결제·추가 사용 활성화·크레딧 구매를 하지 않는다. 구독 인증 및 사용 가능한 크레딧 상태에서만 연결을 점검한다.

```powershell
$claudeExe = '.scratch/claude-eval-tools/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe'
& $claudeExe auth login --claudeai
node evals/claude-pilot.mjs --allow-unverified true --mode connection --model sonnet --claude-exe $claudeExe --out NEW/connection.json --review NEW/connection-review.json --artifacts NEW/connection-events
# 연결 점검의 실제 도구 목록·모델·오류를 확인한 후 full로 30×3회 수집한다.
node evals/claude-pilot.mjs --allow-unverified true --mode full --model sonnet --claude-exe $claudeExe --out NEW/full.json --review NEW/full-review.json --artifacts NEW/full-events
node evals/claude-pilot-report.mjs --report NEW/full.json --out NEW/report.md
```

모든 산출물 경로는 새 경로여야 한다. 사람 검토는 모델로 대신 채우지 않는다. preflight와 connection은 성능 평가 90회에 포함하지 않는다.

공식 참고: [CLI 옵션](https://code.claude.com/docs/en/cli-reference), [자동 실행](https://code.claude.com/docs/en/headless), [계정 인증](https://code.claude.com/docs/en/authentication).

이전 답변에서 검색 요약만 근거로 별도 월간 SDK 크레딧 차감을 단정했으나 최신 공식 본문에서는 그 문구를 확인하지 못했다. 계정별 실제 과금·사용 한도는 로그인 후 확인하며 무료 실행을 보장하지 않는다.
