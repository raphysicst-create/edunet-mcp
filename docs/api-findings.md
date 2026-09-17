# 에듀넷 검색 Open API 조사

조사일: 2026-09-16  
상태: 공식 v4.5 문서와 인증된 실제 검색·로컬 MCP 호출 확인 완료. 상세페이지·대표 첨부 접근성은 9건 표본으로 추가 조사 완료(아래 후속 조사 참조).

## 확인한 공식 자료

- 에듀넷의 현재 [검색 API 안내 페이지](https://www.edunet.net/apiApply/semantic/489)는 검색 API가 외부 사이트의 UI에 맞게 검색 결과를 재구성할 수 있도록 결과를 제공한다고 설명한다. 이 페이지의 다운로드 버튼이 제공한 공식 문서는 `에듀넷 통합검색 스크립트, Open API 소개 및 설치 안내_v4.5.hwp`이다.
- 문서 표지의 기준 시점은 `2026. 2`이며 `svc_version=4.5`를 현재 검색 엔진 버전으로 명시한다. 문서가 가리키는 설치 영상 주소는 [에듀넷 검색 Open API 설치영상](https://www.edunet.net/apiApply/srchApi/490)이다.
- API 요청 경로는 [https://api.edunet.net/search/searchApi/search](https://api.edunet.net/search/searchApi/search)이다. 이 링크만 호출하면 필수 인자가 없어 정상 검색이 되지 않는다.

아래 계약은 이 공식 문서에서 전사했다. 이후 사용자의 승인을 받아 등록된 키·도메인으로 실제 API와 로컬 MCP 호출을 확인했다. 코드의 통합 상태는 `live_verified`이며, 이는 검색 연결 검증을 뜻하고 첨부파일 접근성이나 검색 품질 평가를 뜻하지 않는다.

## 실제 호출 확인

2026-09-16 `광합성`을 `pageSize=3`으로 검색했다. 직접 API 응답은 HTTP 200, `Content-Type: application/xml;charset=UTF-8`이고 최초 저장한 원시 본문 3,175바이트를 UTF-8로 정상 해석했다. 제목·카테고리·내용·API 제공 상세 링크가 있는 자료 3건을 받았다. 전체 건수는 111건이며 **매뉴얼과 달리 `search/totalCount`에 있었다.** 최초 파서는 매뉴얼의 위치만 읽어 누락했으며, 실제 응답 조사 후 두 위치를 모두 지원하도록 수정하고 재검증했다.

실제 Node 자식 프로세스의 stdio MCP 연결, 도구 목록 조회, `search_edunet` 호출도 확인했다.

| 조건 | 반환 자료 수 | 전체 건수 / 다음 페이지 존재 여부 |
|---|---:|---|
| 전체, 1페이지 | 3 | 111 / `true` |
| 전체, 2페이지 | 3 | 111 / `true` |
| 수업설계, 1페이지 | 0 | 0 / `false` |
| 평가자료, 1페이지 | 3 | 5 / `true` |
| 주제별 학습자료, 1페이지 | 3 | 41 / `true` |

이는 조사 시점의 한 검색어에 대한 관측값이다. 0건을 해당 카테고리의 모든 자료가 없다는 뜻으로 해석하지 않는다. 향후 API가 전체 건수를 제공하지 않는 경우에는 전체 건수와 다음 페이지 존재 여부를 `null`로 표시한다.

인증키와 등록 도메인을 제거한 실제 응답은 `tests/fixtures/edunet-search-live.xml`, 수집 시각·조건·헤더는 같은 이름의 `.json`에 저장했다. `scripts/verify-live.mjs`는 직접 API와 실제 MCP 프로세스를 검사하며 `npm run verify:live`로 명시적으로 실행한다. 기본 `npm test`는 네트워크 없이 고정 fixture를 사용한다. Evals는 별도 작업이다.

## 요청 계약

HTTP GET 요청이며 공식 문서의 변수는 다음과 같다.

| 변수 | 필수 여부와 값 | 확인한 의미 |
|---|---|---|
| `kwd` | 필수 문자열 | 검색어. UTF-8 URL 인코딩 필요 |
| `collection` | 필수 문자열, 여러 값은 쉼표로 구분 | 검색 대상 카테고리 |
| `sort` | `r` 기본값, `d` | `r` 정확도순, `d` 등록순 |
| `searchType` | `all` 기본값, `title` | `all` 제목+요약, `title` 제목 |
| `pageNum` | 기본 1, 최대 50 | 결과 페이지 번호 |
| `pageSize` | 기본 10, 최대 100 | 페이지당 결과 수. 이 MCP는 계획에 따라 최대 20으로 더 작게 제한 |
| `sno` | 필수 문자열 | 신청 후 받은 인증키 |
| `svc_version` | 필수 문자열 `4.5` | 검색 엔진 버전 |
| `svc_domain` | 필수 문자열 | 신청 기관 홈페이지의 도메인 정보 |

공식 문서의 예시는 다음과 같은 형태다. `sno`와 도메인 값은 문서에서도 마스킹되어 있으며 실제 값으로 대체하지 않았다.

```text
https://api.edunet.net/search/searchApi/search?kwd=%ED%8A%B9%EC%A7%95&collection=lsn_design,evl_data,cre_sys&sort=r&searchType=all&pageNum=1&pageSize=10&sno=******&svc_version=4.5&svc_domain=*******
```

### collection 코드

| 코드 | 공식 문서의 이름 |
|---|---|
| `total` | 전체 |
| `lsn_design` | 수업설계 |
| `tpc_lrng` | 주제학습 |
| `evl_data` | 평가자료 |
| `ednwkst` | 주제별 학습자료 |
| `edntpd` | 주제별 사진·영상 자료 |
| `edunanum` | 선생님들의 나눔공간 |
| `webrlstccont_inc` | 웹 실감형콘텐츠 |
| `asset` | 글꼴·이미지·음악·PPT |
| `ednstdyschl` | 연구학교 |
| `ednstdyconfr` | 연구대회 |
| `crclm` | 교육과정 |
| `ednaisw` | AI·SW교육 |
| `ncs` | 직업계고 교육과정 |
| `cre_sys` | 고교학점제 |
| `sel` | 사회정서교육 |
| `archive` | 아카이브 |
| `qst_cntr` | 질문 중심 수업 |

문서는 `collection`을 쉼표 구분 목록으로 정의하고 복수 코드 예시를 제공한다. `total`과 개별 코드를 함께 보내는 경우의 우선순위는 설명하지 않는다. MCP에서는 전체 검색을 `total` 하나로 보내는 편이 모호하지 않다.

## 응답 계약

공식 문서가 설명하는 XML 계층은 다음과 같다.

```text
search
├─ conditions
│  ├─ kwd, collection, searchType
│  ├─ searchOrder 또는 sort
│  ├─ pageNum, pageSize
│  └─ responseType, responseTime
└─ totalResults
   ├─ totalCount
   └─ dataList
      └─ data (0개 이상)
```

`responseType`은 문서상 `success` 또는 `error`이다. 오류일 때의 추가 노드, HTTP 상태, 인증 오류 식별 방법은 문서에 없다. 구현은 `success`가 아닌 값과 알 수 없는 구조를 정상적인 빈 결과로 바꾸지 않고 `INVALID_RESPONSE`로 처리한다.

공식 필드 표의 `data` 필드는 다음과 같다.

| 필드 | 공식 설명 | MCP 사용 |
|---|---|---|
| `category_nm` | 카테고리 명 | `category` |
| `depth1`, `depth2` | 카테고리 뎁스 | 현재 미사용 |
| `contents_id` | 콘텐츠 ID | `id` |
| `ttl` | 제목 | `title` |
| `cn` | 본문1 | 최대 500자의 `content` |
| `sbj_clsf_nm_path`, `sbj_clsf_id_path` | 교과분류 이름·ID 경로 | 현재 미사용 |
| `srvc_clsf_nm_path`, `srvc_clsf_id_path` | 서비스분류 이름·ID 경로 | 현재 미사용 |
| `conts_link` | 콘텐츠 상세페이지 URL | 검증된 HTTP(S) 값만 `url` |
| `file_nm` | 첨부파일 명, `:` 구분 | 현재 미사용 |
| `file_extn` | 문서에는 “첨부파일 링크정보, `:` 구분”이라고 기재 | 의미 불일치로 현재 미사용 |
| `thmb_img_path` | 본문 썸네일 데이터 | 현재 미사용 |
| `reg_dt` | 등록일 `yyyymmdd24hhmmss` | 현재 미사용 |

### 공식 문서 내부의 불일치

문서의 필드 표와 바로 뒤 샘플 XML 사이에 다음 차이가 있다.

- 표의 `category_nm` 대신 샘플은 `ctgry_nm`을 쓴다.
- 표의 `contents_id` 대신 샘플은 `conts_id`를 쓴다.
- 조건 표는 `searchOrder`를 설명하지만 샘플은 요청 변수와 같은 `sort`를 쓴다.
- `totalCount`를 제공한다고 설명하지만 샘플 XML에는 `totalCount`가 없다.
- `file_extn`의 설명은 링크정보라고 되어 있으나 샘플 값은 `hwp`이다.

응답 어댑터는 ID와 카테고리에 한해 표 이름과 샘플 이름을 모두 받아들인다. `totalCount`가 없으면 결과 수를 추정하지 않고 `null`로 둔다. 첨부파일 URL은 `file_extn`으로 만들지 않는다.

### 실제 응답과 문서의 차이

실제 저장한 응답은 `search/totalResults/dataList/data` 구조와 `conts_id`·`ctgry_nm` 필드를 사용한다. 전체 건수는 `search/totalResults/totalCount`가 아니라 `search/totalCount`에 있다. 파서는 두 위치를 모두 읽고 둘 다 있으면서 값이 다르면 오류로 처리한다. 실제 깊이 필드는 `depth_1st`·`depth_2nd`이며 현재 MCP 출력에는 사용하지 않는다. 이 차이를 정제한 실제 응답 fixture와 회귀 테스트로 고정했다.

## 인코딩과 링크

- 공식 샘플의 XML 선언은 `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`이다.
- 문서는 검색어를 UTF-8로 URL 인코딩하라고 명시한다.
- 실제 정상 응답의 `Content-Type: application/xml;charset=UTF-8`과 UTF-8 원시 바이트를 확인했다. 구현은 BOM, HTTP charset, XML 선언을 검사해 UTF-8 또는 EUC-KR로 엄격하게 디코딩하고, 서로 충돌하거나 잘못된 바이트가 있으면 실패한다. EUC-KR 지원은 운영 응답이 EUC-KR이라는 확인이 아니라 방어적 호환 처리다.
- 상세 링크는 응답의 `conts_link`만 사용한다. 공식 샘플은 `https://www.edunet.net/clssStdDt/view/149/20416?...` 형태를 보여 주지만, 이를 일반화해 URL을 조합하지 않는다.
- 문서 샘플의 특정 상세 링크가 지금도 존재하는지, 비로그인 접근이 되는지, 첨부파일이 있는지와 내려받을 수 있는지는 확인하지 못했다.

## 아직 확인하지 못한 항목

후속 출처 조사는 [출처 링크·첨부 리소스 접근 보고서](link-access-report.md)에 기록했다. 세 카테고리에서 각 3건을 조사해 모두 비로그인 상세 데이터와 파일 목록을 확인했다. 대표 파일은 공개 CDN에서 8건 부분 바이트 요청 성공, 과거 영상 1건은 CDN 403이었으나 공개 API가 발급한 임시 URL로 부분 바이트 요청에 성공했다. 브라우저 렌더링은 평가자료 1건을 확인했다. 조사 시점의 표본 결과이며 MCP에 첨부 읽기 기능을 추가한 것은 아니다.

현재 환경의 `EDUNET_API_KEY`와 등록 도메인으로 정상 검색과 0건 응답을 확인했다. 다음 항목은 여전히 별도로 확인해야 한다.

- 이번에 확인한 범위 밖의 카테고리·검색 조건에서 나타나는 XML 필드 변형
- 잘못된 `sno`, 등록 도메인 불일치, 호출 제한 초과, 서버 오류의 상태 코드와 XML 구조
- API 호출량 한도, 이용 조건, 운영자 키로 공개 원격 MCP를 제공할 수 있는지
- 아래 9건 표본을 제외한 자료와 카테고리의 비로그인 접근성
- 자료에 첨부파일이 없는 경우와 로그인 때문에 접근할 수 없는 경우의 구분
- 조사 표본 밖에서 `file_nm`·`file_extn`의 값 표현과 다운로드 경로가 동일한지 여부
- 검색 결과의 강조 태그, CDATA, 누락 필드가 실제로 나타나는 방식

`tests/fixtures/edunet-search-live.xml`만 정제한 실제 응답이며, 나머지 테스트 코드 안의 XML은 공식 계약을 바탕으로 만든 합성 입력이다. 실제 검색 관측과 합성 오류 검증을 구분한다.
