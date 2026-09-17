# 성취수준 확장 기준선

- 기준 커밋: `587b3f9` (`v1.0.0-rc.1`)
- 구현 브랜치: `codex/achievement-blueprint`
- 기존 커밋을 `.scratch/baseline`에 복원하여 `npm run check`, `npm run eval:contract` 실행: **40/40**, **103/103** 통과.
- 기존 입력·출력 JSON Schema: `tests/fixtures/achievement/search-contract.json`에 고정. 현재 검색 스키마와 별도 회귀 테스트로 비교한다.
- 기준 offline 테스트 실행 시간: 약 8.3초. 실제 API 응답 지연 기준선은 아님.
- 이 체크아웃에 `.env`, `.vercel/project.json`, remote HTTP MCP 구현이 없다. 따라서 배포 URL·배포 커밋·live latency·환경변수 값은 확인하지 않았으며 추정하지 않는다. 과거 문서의 live 5/5는 이번 구현의 live 검증을 대신하지 않는다.
- 기존 `kordoc@4.14.0` 의존성은 유지한다. PDF/HWP/HWPX 파서는 Worker 프로세스만 로드한다. 메인 검색 경로는 parser 패키지 import와 파일 바이트 전달을 하지 않는다.

실제 API 회귀는 운영자가 기존 `EDUNET_API_KEY`, `EDUNET_DOMAIN`을 설정한 환경에서 `npm run verify:live`로 재현한다. 성취수준 공개 문서 검증 및 교육 도메인 검토와 별개의 게이트다.
