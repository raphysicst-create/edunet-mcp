# 성취수준 제품 평가

실제 검색 30개와 대조 질의의 첫 관측은 [2026-09-18 기준선 보고서](../../docs/achievement-product-baseline-2026-09-18.md)에 보존했다.

실제 문서의 발견·첨부 선택·구조화 정확도를 기존 계약 테스트와 분리해 측정한다. `corpus.json`은 **교사 질의 30개와 빈 문서 목록**으로 시작한다. 모든 질의는 `pending`이며, 빈 `relevantDocumentIds`는 정답 문서가 없다는 판정이 아니다. 실제 성취수준 문서를 수집하거나 사람이 검토한 결과를 포함하지 않는다.

목표는 사람이 승인한 실제 양성 문서 20~50개(권장 30개)와 별도의 음성 대조 문서다. 양성 문서는 수준 라벨과 설명이 있으며, 서로 다른 원본 파일 해시로 최소 표본 수를 센다. 질의 분포는 중학교 과학 5, 수학 5, 국어 5, 고등학교 과학 5, 기타 10개다. **질의 30개는 문서 30개가 아니다.** 문서도 이 분포를 출발점으로 확보하되, 교육과정·PDF/HWP·표 방향·병합 셀·코드 유무·라벨 체계·여러 첨부 등 실패할 만한 조건을 함께 기록한다.

## 실행

프로젝트 루트에서 실행한다. 기존 결과를 덮어쓰지 않으므로 매번 새 출력 경로를 사용한다. `audit`, `grade`, `review-packet`은 네트워크·모델 호출이 없다. `discover`와 `collect`는 실제 EDUNET API를 호출하며 기존 `.env` 또는 프로세스 환경의 EDUNET 설정을 사용한다. 모델 API를 호출하지 않는다.

```sh
# 코퍼스 준비 상태. 초기 상태는 unmeasured이며 성능 합격이 아니다.
npm run eval:achievement:product -- --mode audit

# 30개 질의의 첫 페이지 후보와 탐색 범위를 수집한다.
npm run eval:achievement:product -- --mode discover --out evals/results/NEW-discovery.json

# 연결 점검만 필요할 때. 부분 실행은 완결 평가가 아니다.
npm run eval:achievement:product -- --mode discover --limit 1 --out evals/results/NEW-discovery-smoke.json

# 사람이 볼 빈 판정 양식과 관측 결과를 새 JSON에 보관한다.
npm run eval:achievement:product -- --mode review-packet --run evals/results/NEW-discovery.json --out evals/results/NEW-review.json

# 문서·gold·질의 관련성 검토를 마친 코퍼스로 다시 수집한다.
npm run eval:achievement:product -- --mode collect --out evals/results/NEW-run.json
npm run eval:achievement:product -- --mode grade --run evals/results/NEW-run.json --out evals/results/NEW-grade.json
```

모든 모드에 `--corpus path/to/corpus.json`을 사용할 수 있다. 기본 코퍼스 대신 작업용 코퍼스를 쓰려면 프로젝트의 `.scratch/` 안에 둔다. 질의는 첫 페이지 최대 20개 후보를 수집하고 기본 `k=10`으로 채점한다. `--k 20`은 grade의 평가 절단값을 바꾼다. 이것은 공식 인덱스 전체의 recall이 아니라 **승인된 질의·정답 집합에 대한 recall@k**다.

`collect`는 검색과 문서 읽기를 함께 기록한다. 먼저 자동 첨부 선택 결과를 관측하고, 이후 코퍼스에 지정한 첨부를 별도로 읽어 추출 정확도를 측정한다. 자동 선택 실패와 파서 실패를 섞지 않기 위해서다. `pending` 문서도 원문 검토를 돕도록 수집할 수 있으나 채점용 gold가 되지 않는다. 첨부 ID가 없는 문서는 선택 목록 또는 자동 선택 결과만 관측한다. 읽기 페이지 한도는 기본 20회이고 `--max-pages 100`까지 지정할 수 있다. 한도에 도달했으면 전체 읽기를 완료했다고 해석하지 않는다.

평가 세션은 검색·PDF·HWP·자동 첨부 선택을 켜고 일반 리소스 읽기와 HWPX를 끈다. 프로젝트 운영 설정을 수정하지 않는다. `--hwpx true`는 별도 실험이며 기본 프로필 결과와 구분한다. 실행 파일의 `evaluationProfile`, 코드·설정 해시, 코퍼스 해시, Node 환경과 제한을 보존한다.

## 원문과 gold 승인

1. 평가 대상 검색 결과 외의 독립적인 공식 목록·원문 탐색으로 문서를 확보한다. 발견된 후보만 정답 목록으로 삼으면 검색이 놓친 문서를 분모에 넣을 수 없어 recall을 검증할 수 없다. 후보 탐색 기록과 독립 출처 목록을 검토 노트에 남긴다.
2. 실제 resource ID·제목·출처 URL과 attachment ID·파일명·형식을 기록한다. URL이나 ID를 추측하지 않는다. 한 첨부를 하나의 document로 취급한다. 같은 첨부의 이름만 바꿔 표본 수를 늘리지 않는다.
3. 원문 **전체**를 사람이 검토한다. 실제 바이트의 SHA-256, 원문 수준 라벨, 코드, 설명과 필드별 근거를 작성한다. 파서 출력은 비교 대상이며 gold의 원본이 아니다. LLM이 작성한 초안만으로 `approved` 처리하지 않는다.
4. 필드가 실제로 없는 경우에만 `null`로 기록한다. 아직 확인하지 않은 필드는 문서 전체를 `pending`으로 남긴다. 원문의 `상/중/하`, `A/B/C`, 서술형 라벨과 순서를 임의로 변환하지 않는다.
5. 질의별 관련 문서 집합을 따로 검토한다. 질의의 `approved`는 `relevantDocumentIds`가 완성됐다는 뜻이며, 해당 ID는 승인된 문서를 가리켜야 한다. 검색에서 나온 모든 문서를 자동으로 관련 있다고 표시하지 않는다.
6. gold를 변경하면 코퍼스 해시가 바뀐다. **코퍼스를 편집하기 전에** `review-packet`을 만들거나 실행 당시 코퍼스 사본을 보존한다. `pending collect → 독립 원문 검토 → 코퍼스 승인·고정 → 새 collect → grade` 순서로 진행한다. 승인 전 실행은 검토용 관측이며 승인 후 gold로 소급 채점하지 않는다. 과거 출력의 해시를 수동으로 고쳐 재사용하지 않는다.

승인 문서의 계약은 다음과 같다. 아래 대괄호 문자열은 **설명용 자리표시자**이고 실제 자료나 정답이 아니다. 그대로 코퍼스에 넣으면 승인 요건을 충족하지 못한다.

```json
{
  "id": "[코퍼스 내부 고유 ID]",
  "resource": { "id": "[실제 resource ID]", "title": "[원문 제목]", "sourceUrl": "[실제 공식 출처 URL]" },
  "attachment": { "id": "[실제 attachment ID]", "fileName": "[실제 파일명]", "format": "pdf" },
  "contentHash": "sha256:[원문 바이트의 64자리 소문자 hex]",
  "review": { "status": "approved", "reviewer": "[검토자]", "reviewedAt": "[ISO 8601 시각]", "scope": "full_document" },
  "records": [
    {
      "id": "[문서 안의 고유 gold ID]",
      "grade": null,
      "subject": null,
      "domain": null,
      "achievementStandardCode": null,
      "achievementStandardText": null,
      "achievementLevel": "[원문 수준 라벨]",
      "description": "[원문 수준 설명]",
      "evidence": {
        "achievementLevel": [{ "quote": "[원문 수준 라벨]", "location": { "page": 1, "table": 1, "row": 2, "column": 1 } }],
        "description": [{ "quote": "[원문 수준 설명]", "location": { "page": 1, "table": 1, "row": 2, "column": 2 } }]
      }
    }
  ],
  "selection": { "expectedAction": "select", "acceptableAttachmentIds": ["[실제 attachment ID]"] }
}
```

모든 non-null 필드에는 해당 필드의 `quote`와 근거 위치가 필요하다. `page`, `paragraph`, `block`, `table`, `row`, `column`은 1부터, `charStart`/`charEnd`는 UTF-16 기준 0부터 시작한다. 문서에서 확인할 수 있는 위치만 사용하고, 없는 페이지 번호를 채우지 않는다. `anchor`도 사용할 수 있다. 인용은 필드 값을 실제로 뒷받침해야 하며 다른 문구의 위치를 복사하지 않는다. 파서 출력과 gold의 파일 해시가 다르면 다른 판본일 수 있으므로 채점 가능한 동일 문서로 간주하지 않는다.

원문에 성취기준만 있으면 확인한 필드가 최소 하나 있는 성취기준 레코드도 gold에 넣을 수 있다. `achievementLevel`이 있으면 원문 `description`도 있어야 한다. 성취기준만 있는 문서는 최소 양성 문서 수나 수준 레코드 수에 포함되지 않는다. 전체 `records` 지표와 별도 `levelRecords` 지표를 함께 확인한다.

자동 선택 정답은 실제 첨부 목록을 보고 작성한다. 서로 대체 가능한 첨부가 있으면 허용 ID를 모두 적는다. 메타데이터만으로 안전하게 고를 수 없는 경우 `expectedAction: "abstain"`, `acceptableAttachmentIds: []`로 기록한다. 이때도 추출 평가용 `attachment.id`는 사람이 별도로 결정한다.

**음성 문서**는 전체 원문에 성취수준이 없음을 사람이 확인한 자료다. 성취기준만 있는 문서라면 해당 gold 레코드를 남기며, 구조화 대상 레코드가 전혀 없을 때만 `records: []`로 승인한다. 양성 문서와 분리해 오탐을 확인한다. 다운로드 성공·텍스트 추출 성공·현재 파서의 0건만으로 음성 gold를 만들지 않는다. 기존 공개 PDF/HWP smoke 문서는 실제 성취수준 자료로 검증되기 전까지 양성 표본 수에 넣지 않는다.

원본 PDF/HWP와 전체 파서 응답은 git 제외된 `.scratch/` 또는 `evals/results/`에 보관한다. 원문 전체를 저장소에 커밋하지 않는다. 공유하는 gold에는 검증에 필요한 최소 인용과 출처를 남긴다. 서명 ref와 인증키를 코퍼스에 넣지 않는다.

## 판정 읽기

| 관측 | 확인할 것 |
|---|---|
| 발견 recall@k | 승인된 관련 문서 중 상위 k개에서 발견한 수. 검색 범위 coverage와 구분한다. |
| 첨부 선택 정확도 | 자동 선택 또는 보류가 사람이 정한 허용 행동과 일치하는지. 추출용 수동 첨부 지정과 분리한다. |
| 레코드 precision / recall | 문서 전체 gold에 대한 오탐과 누락. 음성 문서의 잘못된 레코드도 오탐이다. |
| 필드 정확도·라벨 보존 | 코드·설명·라벨의 원문 값과 누락·추가를 확인한다. 임의 등급 변환을 정답으로 세지 않는다. |
| 근거 정확도 | 해당 파일의 인용과 위치가 gold를 뒷받침하는지. 단순 evidence 객체 존재 여부가 아니다. |
| 완전성 | 승인·표본 수·실행 누락·원문 해시·파싱 완료·응답 페이지 소진 상태를 함께 본다. |

레코드 일치는 7개 필드를 모두 비교한다. 설명과 성취기준 문장은 공백 차이만 무시하며, 다른 필드와 원문 라벨은 정확히 일치해야 한다. 정확히 일치하는 레코드가 TP, 추가·불일치 예측이 FP, 누락·불일치 gold가 FN이다. precision은 `TP/(TP+FP)`, recall은 `TP/(TP+FN)`이며 중복 예측도 오탐으로 센다. 필드 지표도 같은 방식으로 각각 계산한다. `levelRecords`는 라벨과 설명을 가진 레코드만 대상으로 하며 일치 여부는 여전히 7개 필드 전체로 판단한다.

라벨 보존은 정확한 원문 라벨 수를 예측 또는 gold에 라벨이 있는 비교 항목 수로 나눈다. 근거 일치는 값·원문 인용·위치·sourceHash가 모두 맞는 필드 수를 예측 또는 gold에 값이 있는 필드 수로 나눈다. **누락된 gold와 추가된 예측도 분모에 들어가므로**, 맞게 찾은 일부 항목만으로 100%를 얻지 못한다. 근거는 사람이 적은 인용문·위치와 비교하며, 인용 위치가 다르지만 내용상 타당한 경우에도 자동으로 동의어·등가 위치로 추정하지 않는다. 해당 실패는 사람이 검토한다.

발견 recall은 상위 k개에서 발견한 관련 resource 수를 승인된 관련 resource 수로 나눈다. 같은 자료의 여러 첨부가 정답이어도 resource 단위로 중복 제거한다. 첨부 선택 정확도는 맞게 선택하거나 보류한 문서 수를 전체 승인 문서 수로 나눈다. 별도 selectionCoverage는 선택이 기대된 자료에서 실제 선택한 비율이며 정답 선택 비율과 다르다.

현재 scorer의 **초기 평가 목표값(교육 품질 인증·릴리스 승인 아님)**은 발견 recall@k 80%, 레코드 precision 95%·recall 90%, 원문 라벨 보존 100%, 근거 일치 100%, 첨부 선택 정확도 95%다. 수준 라벨·설명이 있는 레코드만의 precision/recall도 같은 목표로 별도 확인한다. 사람이 승인한 음성 질의가 있으면 검색 결과가 비어 있는 비율 100%를 확인한다. 이 값은 사용자나 교육 도메인 검토자가 승인한 품질 기준이 아니라 초기 실험용 목표이며, 바꾸면 변경 이유와 scorer 버전을 함께 기록한다.

분모가 없는 지표는 미측정이며 100%가 아니다. 표본 부족, 미검토, 부분 실행과 읽기 실패가 남으면 제품 정확도가 증명된 것으로 해석하지 않는다. `audit` 또는 `collect`의 정상 종료는 평가 준비/수집 성공일 뿐이다. grade의 `status`, `complete`, `pass`와 각 지표의 분자·분모를 함께 확인한다. 실험상 `--min-documents`를 줄인 결과는 20~50개 실문서 검증을 대체하지 않는다. 현재 evaluator 통과도 원격 배포나 운영 베타 승인을 의미하지 않는다.

grade 종료 코드는 `0=pass`, `1=fail`, `2=inconclusive`다. 입력 오류·실행 오류도 1로 종료하므로 보고서 생성 여부와 오류 메시지를 확인한다. `audit`의 exit 0은 코퍼스 구조를 읽고 점검했다는 뜻이며 문서가 0개인 초기 상태에서도 정상이다.

## 클라이언트 전체 흐름

`client-cases.json`의 12개 케이스는 **수동 실행·검토용 설계**다. 실제 ChatGPT/Claude 실행기나 성적이 아니다. 원문 기반 케이스와 명시적 합성 실패/공격 케이스를 구분해 실행하고, 모델·버전·도구 목록·프롬프트·도구 인자/응답·최종 답변·실행 시각·사람 판정을 기록한다. 사전 조건을 충족하지 못한 케이스는 통과가 아니라 미실행이다.

각 케이스의 rubric을 전부 확인하고 `criticalFailures`가 하나라도 발생하면 실패로 남긴다. 일반 검색과 성취수준 도구 선택, 첨부 선택, 원문 라벨·근거, 부분 응답·파싱 실패·OCR·HWPX 안내, 음성 자료·검색 미발견, 문서 속 악성 지시를 다룬다. 제품의 문서 지표와 모델 행동 성적은 따로 보고하며 모델을 실행하지 않은 상태에서는 클라이언트 평가 성공을 주장하지 않는다.
