# 에듀넷 출처 링크·첨부 리소스 접근 조사

조사일: 2026-09-16  
범위: 수업설계(`lsn_design`)·평가자료(`evl_data`)·주제별 학습자료(`ednwkst`) 각 3건, 총 9건  
인증 상태: 에듀넷 로그인 쿠키 없이 수행

## 결론

표본 9건의 검색 API 출처 URL은 모두 HTTP 200을 반환했고, 사이트가 배포한 JavaScript에서 확인한 공개 상세 API도 9건 모두 HTTP 200과 `success: true`를 반환했다. 모든 표본에서 검색 API의 파일명·확장자 목록과 상세 API의 `fileList`가 확인됐다. 로그인 화면으로 전환된 사례는 없었다.

각 표본에서 상세 API의 첫 번째 파일 리소스 하나를 골라 공개 다운로드 API로 URL을 받은 뒤, 해당 파일의 처음 32바이트만 `Range` 요청했다. 사이트 JavaScript가 사용하는 공개 CDN 변환 경로에서는 9건 중 8건이 HTTP 206과 실제 파일 바이트를 반환했다. 나머지 1건인 과거 MP4는 CDN 변환 경로에서 HTTP 403이었지만, 같은 비로그인 다운로드 API가 발급한 임시 URL에서는 HTTP 206과 MP4 바이트가 확인됐다. HWP 표본은 OLE compound signature, JPG는 JPEG signature, MP4는 ISO BMFF signature가 확인됐다. 평가자료 한 건에서는 PDF도 별도로 1,024바이트를 받아 `%PDF-1.4`를 확인했다.

따라서 **비로그인 첨부파일 읽기 확장은 기술적으로 진행 가능**하다. 문서 표본 6건은 모두 공개 CDN 경로에서도 성공했다. 다만 이번 조사는 전체 파일을 내려받아 파싱하거나 파일 내용의 무결성을 검증한 것이 아니다. 또한 `ednwkst`의 `fileList`는 교사용 문서 첨부라기보다 페이지를 구성하는 JPG·MP4·PDF 콘텐츠 자산이다. 문서 읽기와 미디어 콘텐츠 처리를 같은 기능으로 취급하면 안 되며, 과거 VOD는 CDN 경로별 호환 처리가 필요하다.

## 조사 방법과 판정 기준

1. 검색 Open API에서 카테고리별 서로 다른 결과 3건과 API가 제공한 `conts_link`, `file_nm`, `file_extn`을 수집했다.
2. 각 `conts_link`를 쿠키 없이 GET하고 상태 코드·리디렉션·정적 HTML을 확인했다.
3. 에듀넷이 배포한 [수업·평가 상세 코드](https://www.edunet.net/assets/ClssStdDtView.js), [주제별 자료 상세 코드](https://www.edunet.net/assets/ContsMvGllryView.js), [콘텐츠 서비스 코드](https://www.edunet.net/assets/ContsService.js), [공통 번들](https://www.edunet.net/assets/index.js)에서 실제 상세·다운로드 호출을 확인했다.
4. 같은 경로로 공개 상세 API를 호출해 제목·본문 길이·파일 리소스 수를 확인했다.
5. 표본별 첫 파일 리소스에 대해 공개 다운로드 API와 사이트 코드의 CDN 변환 규칙을 적용하고, 32바이트 범위 요청으로 실제 파일 응답을 확인했다. CDN 변환이 실패한 MP4는 API가 발급한 임시 URL도 같은 범위로 확인했다. 짧은 유효기간의 서명 URL은 결과 파일에 저장하지 않았다.

상세 페이지의 최초 HTML은 9건 모두 제목이 `에듀넷`이고 정적 가시 텍스트가 3자뿐인 SPA 셸이었다. 이 결과만으로 본문 부재나 로그인 차단으로 판정하면 잘못이다. 브라우저에서 JavaScript가 실행된 평가자료 1건은 제목, 분류, 첨부 4건, 2쪽 HWP 미리보기가 로그인 없이 실제 표시됐다. 나머지 8건은 브라우저 UI를 하나씩 육안 확인하지 않았지만, 페이지가 사용하는 공개 상세 API에서 해당 자료의 제목과 파일 목록이 정상 반환됐다.

검색 결과와 상세 API의 콘텐츠 ID는 9건 모두 일치했다. 제목 세 건에는 띄어쓰기 차이가 있어 공백을 정규화한 뒤 일치로 판정했다.

## 9건 결과

| 분류 | 자료 | 비로그인 상세 데이터 | 파일 목록 | 대표 파일 부분 다운로드 |
|---|---|---|---:|---|
| 수업설계 | [수업 만들기(우리 동네 땅따먹기 게임)](https://www.edunet.net/clssStdDt/view/149/2065756?sbjtClsf=89434&srvcClsf=59602&contents_openapi=search) | 200, 제목 일치, 별도 본문 0자 | HWP 3 | 206, 32/98,816바이트, HWP signature |
| 수업설계 | [수업 만들기(우리 동네 표지판 만들기)](https://www.edunet.net/clssStdDt/view/149/2065778?sbjtClsf=89434&srvcClsf=59602&contents_openapi=search) | 200, 제목 일치, 별도 본문 0자 | HWP 3 | 206, 32/11,264바이트, HWP signature |
| 수업설계 | [[수업 지도안] 일이 일어난 차례를 생각하며 말하기](https://www.edunet.net/clssStdDt/view/149/2074372?sbjtClsf=89432&srvcClsf=59602&contents_openapi=search) | 200, 제목 일치, 별도 본문 0자 | HWP 3, PPTX 1 | 206, 32/95,232바이트, HWP signature |
| 평가자료 | [광합성 산물의 저장과 이용](https://www.edunet.net/clssStdDt/view/150/2516662?sbjtClsf=77433&srvcClsf=59599&contents_openapi=search) | 200, 제목 일치, 본문 30자; 브라우저 미리보기 확인 | HWP 2, PDF 2 | HWP 206, 32/343,040바이트; PDF도 1,024/113,952바이트 확인 |
| 평가자료 | [광합성](https://www.edunet.net/clssStdDt/view/150/2516656?sbjtClsf=77433&srvcClsf=59599&contents_openapi=search) | 200, 제목 일치, 본문 25자 | HWP 2, PDF 2 | 206, 32/342,528바이트, HWP signature |
| 평가자료 | [식물의 호흡과 광합성](https://www.edunet.net/clssStdDt/view/150/2516660?sbjtClsf=77433&srvcClsf=59599&contents_openapi=search) | 200, 제목 일치, 본문 19자 | HWP 2, PDF 2 | 206, 32/680,448바이트, HWP signature |
| 주제별 학습자료 | [식물은 광합성으로 만든 녹말을 어떤 방식으로 저장할까?](https://www.edunet.net/contsMvGllry/view/154/11704?contents_openapi=search) | 200, 제목 일치, 본문 2,564자 | JPG 자산 7 | 206, 32/96,445바이트, JPEG signature |
| 주제별 학습자료 | [물속에 사는 작은 생물을 만나다(1)](https://www.edunet.net/contsMvGllry/view/154/34345?contents_openapi=search) | 200, 제목 일치, 본문 2,874자 | MP4 5, JPG 3 | 공개 CDN 403; 비로그인 API 임시 URL은 206, 32/3,251,718바이트, MP4 signature |
| 주제별 학습자료 | [바다의 선물, 갯벌에 대해 알아보아요](https://www.edunet.net/contsMvGllry/view/154/2048924?contents_openapi=search) | 200, 제목 일치, 본문 3,312자 | JPG 12, MP4 1, PDF 1 | 206, 32/39,495바이트, JPEG signature |

수업설계 3건의 상세 API 본문 길이가 0인 것은 접근 실패가 아니다. 제목과 파일 목록이 반환되고 대표 HWP 바이트도 내려왔다. 이 표본들은 실제 수업 내용이 첨부 문서에 들어 있는 형태다.

주제별 학습자료에서 `광합성` 검색으로 나온 두 번째·세 번째 결과는 제목만 보면 직접 관련성이 낮다. 이는 링크 접근성 실패가 아니라 검색 관련성 문제이며, 검색 유용성 eval에서 별도로 다뤄야 한다.

## 확장 판단

첨부파일 읽기를 다음 확장으로 선택할 근거가 충분하다. 우선순위는 평가자료의 PDF, 수업설계·평가자료의 HWP, 수업설계의 PPTX 순서가 적절하다. PDF는 표본에서 실제 PDF signature까지 확인됐고 추출 도구가 안정적이다. HWP는 수업설계와 평가자료의 핵심 형식이지만 OLE 기반 HWP와 향후 HWPX를 구분해 변환기를 격리해야 한다. PPTX는 이번 표본에 1건뿐이므로 추가 표본을 확보한 뒤 지원 범위를 정하는 편이 안전하다.

원격 MCP 여부는 이번 링크 조사만으로 결정할 수 없다. 공개 상세·다운로드 경로가 기술적으로 접근 가능하다는 사실은 확인했지만, 운영자 키의 재배포 조건·호출량 제한·캐시 허용 범위는 별도의 이용 조건 확인이 필요하다.

세부 파일명, 확장자, 리소스 ID, 상태 코드와 부분 바이트 증거는 `docs/link-access-data.json`에 정리했다. 재현용 스크립트는 `scripts/check-link-access.mjs`이며 인증키·등록 도메인·서명 URL을 출력 결과에 보존하지 않는다.
