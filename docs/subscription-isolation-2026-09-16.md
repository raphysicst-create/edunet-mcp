# Terra 구독 환경 격리 재검사

2026-09-16. 사용자가 선택한 경로는 **gpt-5.6-terra Codex 구독**이다. API 평가와 분리한다. 이번 작업에서 실제 API 모델 호출 0건, 실제 구독 모델 호출 0건이며, API 크레딧 상태를 구독 평가의 차단 요인으로 사용하지 않는다.

## 확인된 차단 원인

설치된 CLI는 `0.154.0-alpha.6.2`다. 별도 HOME/USERPROFILE/CODEX_HOME, 빈 workspace, 개인 설정·키 환경변수 미상속, EDUNET 중립 MCP만 등록한 [기존 방식 재검사](../.scratch/subscription-terra-v3-preflight-initial.json)에서 기본 스킬·에이전트·권한 지침이 관측됐다. `read-only`의 환경 출력에는 `:root` 읽기 권한이 남는다. 파일 읽기 제한의 증거로 사용할 수 없다.

`app-server`의 로컬 생성 JSON Schema를 확인해 `environments: []`, `baseInstructions`, `dynamicTools`를 지원함을 확인했다. `subscription-surface-probe.mjs`는 다음 조건에서 **CLI가 실제 생성한 전송 요청**을 127.0.0.1 수신기로만 받는다.

- 새로운 임시 홈과 빈 작업공간, `--strict-config`, 인증 저장소 ephemeral. 사용자 인증은 읽거나 복사하지 않는다.
- 모델 식별자는 Terra 그대로 유지. 외부 모델 서버 대신 요청을 400으로 거절하는 로컬 provider만 사용하고 전달하지 않는다.
- 환경 접근을 빈 목록으로 설정한다. 실제 MCP tools/list에서 얻은 검색 스키마를 dynamic tool로 등록한다. 이 경로가 실제 구독 MCP 실행과 동일하다고 간주하지 않는다.
- shell, agent, 앱, 브라우저, 컴퓨터 사용, 이미지, sleep, goals, skill search 등 현재 CLI 기능 목록에 있는 비활성화 설정을 적용한다. 설정 의도와 관측 결과를 분리한다.
- 도구가 최상위 `tools`뿐 아니라 `input[].type=additional_tools`에도 들어갈 수 있으므로 두 위치와 중첩 namespace를 검사한다. `exec` 설명의 중첩 도구 선언도 별도로 기록한다.

[최종 관측](../.scratch/subscription-terra-v3-surface-final.json):

| 구분 | 관측 결과 |
|---|---|
| 모델에 노출된 직접 도구 | exec, wait, request_user_input |
| exec 안에 선언된 도구 | list_mcp_resource_templates, list_mcp_resources, read_mcp_resource, search_edunet, skills__list, skills__read |
| 검색 안내 이외 지침 | 기본 스킬 안내, 권한 안내 |
| fixture 접근 차단 | 미검증 |
| 실제 구독 서버의 도구·지침 | 미검증: 로컬 provider 관측은 구독 전송 증거가 아님 |
| 실제 구독 응답의 모델 버전 | 미확인: 모델을 호출하지 않음 |

따라서 `codex_usage_unverified`, `pass:false`를 유지한다. 설정으로 껐다는 사실이나 모델에게 사용하지 말라고 지시하는 것만으로 격리 완료를 선언하지 않는다. 구독 24회/90회 수집은 시작하지 않았다. 원래의 격리 차단 규칙에 따라 반복 모델 호출이나 API 우회를 하지 않는다.

공식 [설정 규격](https://learn.chatgpt.com/docs/config-file/config-reference)에는 도구·기능·스킬 설정이 설명되어 있으나, 현재 바이너리는 `tools.view_image`를 strict-config 오류로 거절했다. 실제 기능 목록에 있는 `features.view_image`로 바꾸어 검사했다. 공개 문서와 설치 버전의 지원 범위를 같다고 가정하지 않는다. 최초 실패와 후속 관측 파일은 모두 별도 보존했다.

## 변경·검증

- 새 로컬 요청 관측기와 `subscription.mjs --mode surface`를 추가했다. 일반 preflight는 유지하며, 임의 실행 모드나 기존 결과 파일은 검사 전에 거절한다.
- 검사 결과는 원본 요청 해시, 실행 파일 해시, 검사 코드·제품 스키마·공통 안내 해시, 실제 도구와 지침, 차단 원인을 보존한다. 실제 인증·API 키를 사용하지 않는다.
- TypeScript 타입 검사·빌드 통과. [계약 검사 88/88 통과](../.scratch/subscription-terra-v3-contract.json). 여기에 전체 30개 고정 응답 smoke, 도구 선언의 숨은 위치 검사, 안내 분리, 기존 기록 보존 회귀 검사가 포함된다. 모델 성능 점수가 아니다.
- 기존 `evals/results/`, 사람 검토 기록, 사용자 전역 설정은 변경하지 않았다. 사람 검토란을 자동으로 채우지 않았다.

```sh
node evals/subscription.mjs --mode preflight --codex-exe C:/path/to/codex.exe --out NEW/preflight.json
node evals/subscription.mjs --mode surface --codex-exe C:/path/to/codex.exe --out NEW/surface.json
```

프로젝트 밖 임시 폴더 생성이 샌드박스에 막히면 해당 로컬 검사에 대한 실행 권한이 필요하다. 현재 환경에서 검사 종료 코드 1은 격리 미완료를 뜻한다. API 할당량 실패가 아니다.

재개에는 검색 도구만 노출하고 파일 접근을 제한할 수 있는 **검증 가능한 구독 실행 표면**, 전체 적용 지침과 실제 구독 요청·응답 버전 증거가 필요하다. 이 조건을 확보하기 전에는 통제된 성능 평가를 완료했다고 보고할 수 없다. 별도 구독 사용성 관찰은 그와 다른 평가 범위이며, 릴리스 성적으로 합산할 수 없다.
