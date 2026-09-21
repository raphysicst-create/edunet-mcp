# 원격 MCP 모니터링

GitHub Actions의 `Remote MCP health monitor` workflow가 6시간마다 `https://edunet-mcp.vercel.app/api/mcp`를 확인한다. 별도 서버나 데이터 저장소는 사용하지 않는다.

검사는 실제 Streamable HTTP MCP client로 다음 순서대로 수행한다.

1. 원격 endpoint에 연결하고 `initialize` handshake를 완료한다.
2. `tools/list`에서 항상 제공되어야 하는 `search_edunet`을 확인한다. 기능 플래그에 따라 추가되는 성취수준 도구는 필수 목록에 넣지 않는다.
3. `search_edunet({ query: "광합성", pageSize: 1 })`을 한 번 호출하고 EDUNET live 응답의 핵심 필드를 확인한다. 원문이나 첨부파일은 읽지 않는다.

각 시도는 전체 30초로 제한된다. 실패하면 2초 간격으로 두 번 재시도하며, 세 번 모두 실패해야 장애로 판정한다.

로컬 수동 실행:

```bash
npm run health:remote
```

다른 주소는 `npm run health:remote -- https://example.test/api/mcp`처럼 전달할 수 있다. Bearer 배포를 검사할 때만 `MCP_ACCESS_TOKEN` 환경변수를 사용한다. 현재 공개 endpoint 검사에는 EDUNET API key나 GitHub secret이 필요하지 않다.

GitHub에서는 Actions 탭의 `Remote MCP health monitor`에서 `Run workflow`로 수동 실행할 수 있다. 예약 실행은 `0 */6 * * *`(UTC 기준 6시간 간격)이다.

세 번 실패하면 `[monitor] edunet-mcp remote health check failed` 제목의 열린 Issue를 찾는다. 없으면 만들고, 있으면 새 실패 보고서를 comment로 추가한다. 다음 실행이 성공하면 복구 시간과 Actions 실행 링크를 comment로 남기고 해당 Issue를 닫는다. 정상 상태에서는 Issue나 comment를 만들지 않는다.
