# 성취수준 발견 경로와 지원 범위

`search_edunet_achievement`는 기존 `search_edunet`을 변경하지 않고 공식 검색 API를 조합합니다. 원래 질의와 성취수준·성취기준·평가기준 변형을 최대 5개 사용하며, 검증된 평가자료(`evl_data`)·교육과정(`crclm`) 컬렉션도 최대 2회 조회합니다. 전체 발견 예산은 10초이고, 상세 메타데이터 조회는 중복 제거 후 상위 20건, 동시 4건으로 제한합니다. 첨부 파일 다운로드와 파서는 이 경로에서 실행하지 않습니다.

공식 검색 API의 컬렉션 코드는 [공식 안내](https://www.edunet.net/apiApply/semantic/489)와 저장소의 [v4.5 조사 기록](api-findings.md)에 근거합니다. 검색 결과에 제공된 공식 상세 URL에만 상세 어댑터를 적용합니다. 자료 ID와 URL의 ID가 다르거나 경로를 검증하지 못한 경우 출처를 유지하고 `detail_path_unverified` 경고를 반환합니다.

| 공식 상세 페이지 | 메타데이터 API | 검증 |
|---|---|---|
| `/clssStdDt/view/{menuId}/{id}` | `/main/clssStdDt/getClssStdDtInfo/{id}` | 2026-09-17 UTC, 자료 `2516662`, 제목과 첨부 4건 확인 |
| `/contsMvGllry/view/{menuId}/{id}` | `/main/conts/getContsData?contsId={id}&prgrmId=0` | 2026-09-17 UTC, 자료 `34345`, 제목과 첨부 8건 확인 |

위 두 API는 공개 사이트가 사용하는 비로그인 상세 API입니다. 재확인한 공식 자료는 [평가자료](https://www.edunet.net/clssStdDt/view/150/2516662?sbjtClsf=77433&srvcClsf=59599)와 [주제별 학습자료](https://www.edunet.net/contsMvGllry/view/154/34345)입니다. 이 표본 확인은 두 자료가 성취수준 golden 문서라는 뜻이 아닙니다. 초기 9건 조사 범위는 [접근성 기록](link-access-data.json)을 참조하세요.

메타데이터의 `fileUrl`을 신뢰하거나 다운로드하지 않습니다. 확인된 `fileRscId`로 `/main/fileRsc/downloadFile/{id}` 주소만 생성합니다. 읽기 단계에서 Worker가 이 공개 API의 임시 URL을 받아 허용 호스트·경로·연결 주소·크기를 다시 검사합니다. 서명된 임시 URL을 참조 토큰, 출력 또는 로그에 저장하지 않습니다. 파일명·명시 확장자가 다르면 형식을 `unknown`으로 표시하며, 명시 MIME이 없으면 확장자로 MIME을 만들어 채우지 않습니다.

후보 점수는 실제 제목·검색 발췌·상세 메타데이터·첨부 파일명의 성취 관련 표현, 코드 형태, 공식 평가자료 분류를 사용합니다. 요청한 학년·과목·수준을 그대로 후보의 힌트로 복사하지 않고 메타데이터에 존재하는 경우에만 채웁니다. `readCapability=possible`은 PDF/HWP 첨부를 찾았다는 뜻이며 실제 성취수준을 추출했다는 뜻이 아닙니다. HWPX는 초기 검증 단계에서 지원을 약속하지 않습니다.

검색 0건은 `not_found_in_official_index`로 반환합니다. API 장애는 `search_unavailable`, 일부 질의·메타데이터 실패는 `partial`입니다. `coverage`에 실제 시도한 질의와 registry 경로를 남깁니다. 페이지는 각 질의의 동일한 공식 API 페이지를 합친 범위이며 전역 정렬 커서는 아닙니다. 합친 후보가 요청 개수를 넘으면 응답 제한 경고를 반환합니다.

`config/achievement-source-registry.json`의 버전과 검증일을 관리합니다. 마지막 검증에서 90일이 지났거나 검증일이 유효하지 않으면 `registry_stale` 경고를 반환합니다. 기존 검증 경로 외에는 구성 파일에 추가하는 것만으로 활성화되지 않습니다. 새 공식 어댑터와 테스트가 필요합니다. 확인하지 않은 목록 API, HTML 크롤러 또는 일반 검색엔진을 보조 경로로 가정하지 않습니다.
