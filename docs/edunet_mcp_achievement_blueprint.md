# EDUNET MCP 성취수준 확장 블루프린트

> 상태: 구현 전 설계안
>
> 최우선 목표: **성취기준·성취수준 자료를 찾고, PDF/HWP/HWPX 원문을 읽고, 근거 위치를 보존한 구조화 결과로 반환한다.**
>
> 원칙: 기존 `search_edunet`의 안정성과 계약은 유지한다. 일반 문서 읽기(`read_edunet_resource`)는 성취수준 기능을 보조하는 후순위 기능으로 둔다.

## 0. 결정 요약

이번 확장의 제품 중심을 다음과 같이 바꾼다.

```text
기존 중심
  search_edunet → 검색 결과·발췌·출처 링크

새 중심
  성취수준 자료 탐색
      → 원문 문서 선택
      → PDF/HWP/HWPX 읽기
      → 학년·과목·성취기준 코드·성취수준·설명 문구 구조화
      → 각 값의 원문 구간·출처·문서 위치 반환
```

### 우선순위

| 순위 | 기능 | 정책 |
|---|---|---|
| P0 | 기존 `search_edunet` | 입력·출력 의미와 안정성 유지. 성취수준 파서와 결합하지 않음 |
| P0 | 성취수준 자료 탐색 | 공식 API 검색결과에 직접 노출되지 않는 경우까지 고려한 별도 흐름 |
| P0 | 성취수준 원문 읽기·구조화 | PDF/HWP 우선, HWPX는 검증 후 활성화 |
| P0 | 출처·원문 구간 추적 | 추출값마다 문서 위치와 원문 문구를 보존 |
| P0 | 장애 격리 | 문서 다운로드·파서·Worker 장애가 검색 MCP를 중단시키지 않음 |
| P1 | `read_edunet_resource` | 일반 문서의 텍스트 읽기. 성취수준 구조화의 대체물이 아님 |
| P2 | OCR | 초기 범위에서 제외. 스캔 문서는 정직하게 미지원 처리 |

### 한 문장 제품 정의

> **한국 교육자료에서 성취수준을 찾아, 문서 원형을 보존한 채 AI가 인용하고 비교할 수 있는 데이터로 돌려주는 신뢰 가능한 EDUNET MCP.**

---

## 1. 범위와 비범위

### 이번 확장에 포함하는 것

- 성취기준·성취수준·평가기준·교과별 성취수준 자료 탐색
- 학년, 학년군, 과목, 영역, 성취기준 코드 추출
- 성취수준 라벨 추출: `A/B/C`, `상/중/하`, `매우 우수/우수/...` 등
- 문서가 사용한 라벨을 그대로 보존하고, 임의로 A/B/C로 환산하지 않음
- 수준별 설명 문구 및 표의 행·열 관계 추출
- PDF, HWP, 검증된 HWPX 읽기
- 원문 문구, 페이지·문단·표·행·열 위치, 자료·첨부 식별자 추적
- 공식 API 검색결과에 문서가 노출되지 않을 때의 보조 발견 경로
- 검색, 문서 상세조회, 첨부 선택, 파싱의 단계별 실패 상태
- 기존 검색과 문서 읽기 Worker의 실행·장애 분리

### 초기 범위에서 제외하는 것

- OCR 및 이미지 속 글자 판독
- 이미지·그래프·도형의 의미 해석
- 영상, PPTX, DOCX, XLSX 파싱
- 임의 URL 또는 사용자의 로컬 파일을 받는 범용 파서
- 로그인 우회, 비공개 자료 접근, robots·접근정책 우회
- 검색할 때마다 모든 문서를 미리 다운로드하는 선파싱
- AI가 설명 문구를 근거 없이 보정하거나 다른 등급으로 번역하는 기능
- 성취수준 자료를 자동으로 요약·평가·수업안으로 변환하는 별도 MCP 도구

OCR은 기술적으로 가능하더라도 별도 제품 범위로 다룬다. 초기에는 스캔 PDF를 읽은 것처럼 가장하지 않고 `NO_TEXT_LAYER` 또는 `OCR_REQUIRED`로 반환한다.

---

## 2. 목표 사용자 흐름

### 2.1 기존 검색만 요청한 경우

> “중학교 과학 성취수준 자료를 찾아줘.”

기존 도구의 동작을 깨지 않는다.

```text
search_edunet
  → 제목·발췌·출처·페이지 정보
  → AI가 검색 결과를 정리
```

이 경우 문서 다운로드와 파싱을 하지 않는다. 기존 응답의 `originalRead=false`, `attachmentsRead=false` 의미도 유지한다.

### 2.2 성취수준을 실제로 확인하려는 경우

> “중1 과학의 성취기준별 상·중·하 설명을 실제 문서에서 추출해줘.”

```text
search_edunet_achievement
  → 성취수준 후보와 achievementRef
  → 상세정보·첨부 목록 확인
  → 지원 파일 선택
  → read_edunet_achievement
  → 구조화 레코드 + 원문 근거 + 위치 + 경고
```

AI가 처음부터 “찾아서 실제 내용을 비교해줘”라고 요청받으면 위 단계를 같은 작업 안에서 연속 호출한다.

### 2.3 검색 결과에 성취수준 문서가 없는 경우

공식 API 검색이 0건이라고 해서 “EDUNET에 성취수준 자료가 없다”고 단정하지 않는다.

```text
1. 공식 검색 API의 성취 관련 질의어 변형
2. 검색 결과의 상세 페이지·첨부 목록 확인
3. 검증된 EDUNET 자료 유형·컬렉션 경로 탐색
4. 발견된 문서의 제목·첨부·본문에서 성취 관련성 확인
5. 그래도 확인하지 못하면 검색 범위를 명시한 not_found 반환
```

반환 문구는 다음을 구분해야 한다.

- `not_found_in_official_index`: 공식 검색 인덱스에서 찾지 못함
- `candidate_found_attachment_unknown`: 자료는 찾았지만 적절한 첨부를 판별하지 못함
- `document_found_not_parsed`: 문서는 찾았지만 형식·파서가 지원하지 않음
- `verified_extraction`: 원문에서 성취수준 레코드를 확인함

`not_found`를 곧바로 “자료가 없음”으로 번역하지 않는다.

---

## 3. 외부 MCP 도구 구성

외부 도구는 네 개까지 정의할 수 있지만, 출시 순서는 엄격히 나눈다.

### 3.1 `search_edunet` — 기존 계약 유지

기존 검색 도구는 성취수준 파서와 독립적으로 운영한다.

- 기존 입력 필드 유지
- 기존 결과의 제목·발췌·출처·페이지·pagination 의미 유지
- 검색 호출 중 첨부 다운로드·파싱을 하지 않음
- 파서 의존성을 검색 Function의 시작 경로에 넣지 않음
- 기존 검색 회귀 테스트를 출시 게이트로 유지

검색 결과에 성취수준 전용 참조를 선택적으로 추가할 수는 있지만, 참조 발행 실패가 검색 결과 자체를 실패시키면 안 된다.

```typescript
type SearchResultExtension = {
  achievementCapability?:
    | "possible"      // 검색 결과만으로 후보 가능성을 표시
    | "unsupported"   // 자료 유형·첨부 형식이 현재 범위 밖
    | "unknown";      // 추가 조회 없이는 판단하지 않음
  achievementRef?: string | null;
};
```

`possible`은 실제 문서 검증이나 파싱 성공을 의미하지 않는다.

### 3.2 `search_edunet_achievement` — 성취수준 전용 발견 도구

성취수준 관련 질의를 기존 검색 API에 그대로 한 번 보내는 얇은 래퍼가 아니다. 검색 누락 가능성을 고려한 발견 오케스트레이터다.

#### 입력

```typescript
type SearchAchievementInput = {
  query?: string;
  grade?: string;
  subject?: string;
  achievementStandardCode?: string;
  levelLabel?: string;
  resourceType?: "achievement_standard" | "achievement_level" | "assessment_criteria" | "unknown";
  page?: number;
  pageSize?: number;
};
```

`query`, `grade`, `subject`, `achievementStandardCode` 중 하나 이상은 있어야 한다. URL, 로컬 파일 경로, 임의 검색 엔드포인트는 입력받지 않는다.

#### 발견 단계

1. 원래 질의와 학년·과목·코드 조합을 검색한다.
2. `성취수준`, `성취기준`, `평가기준`, `성취기준 코드`, `교과별 성취수준` 등 제한된 질의어 변형을 시도한다.
3. 결과의 상세정보와 첨부 목록을 확인한다.
4. EDUNET 공식 자료 유형·컬렉션을 가리키는 검증된 source registry가 있으면 후보 경로로 사용한다.
5. 제목·본문 발췌·첨부 파일명·문서 메타데이터를 이용해 성취수준 후보 점수를 계산한다.
6. 후보를 `achievementRef`로 봉인해 다음 읽기 도구에 전달한다.

모든 보조 경로는 EDUNET의 허용된 호스트와 공식 공개 경로 안에서만 동작한다. 임의 웹 크롤러나 일반 검색엔진을 v1의 숨은 의존성으로 넣지 않는다.

#### 출력

```typescript
type AchievementSearchResponse = {
  kind: "edunet_achievement_search";
  status:
    | "ok"
    | "partial"
    | "not_found_in_official_index"
    | "search_unavailable";
  results: AchievementCandidate[];
  pagination?: {
    page: number;
    pageSize: number;
    hasNext: boolean;
    nextPage?: number;
  };
  coverage: {
    officialApiQueried: boolean;
    queryVariantsTried: string[];
    attachmentMetadataChecked: boolean;
    registryPathsChecked: string[];
    limitation?: string;
  };
  warnings: Warning[];
};

type AchievementCandidate = {
  achievementRef: string;
  resourceRef: string;
  title: string;
  snippet?: string;
  sourceUrl?: string;
  sourceType?: string;
  gradeHint?: string;
  subjectHint?: string;
  codeHint?: string;
  levelLabelHint?: string;
  candidateReason: string[];
  readCapability: "possible" | "unsupported" | "unknown";
};
```

### 3.3 `read_edunet_achievement` — 원문 읽기·성취수준 구조화 도구

이 도구는 일반 텍스트 미리보기 도구가 아니다. 문서에서 성취수준 레코드를 추출하고, 각 필드에 근거를 붙이는 도메인 도구다.

#### 입력

```typescript
type ReadAchievementInput = {
  achievementRef: string;
  attachmentRef?: string;
  grade?: string;
  subject?: string;
  achievementStandardCode?: string;
  levelLabel?: string;
  cursor?: string;
  maxItems?: number;
  maxChars?: number;
};
```

동작은 두 단계다.

| 호출 | 동작 |
|---|---|
| `achievementRef`만 | 자료 상세정보, 첨부 목록, 지원 여부, 선택 근거 반환. 애매한 첨부는 파싱하지 않음 |
| `achievementRef` + `attachmentRef` | 소속 검증 후 파일 1개 다운로드·파싱·구조화 |

지원 파일이 하나뿐이고 파일명·MIME·자료 메타데이터가 모두 명확한 경우 자동 선택을 허용할 수 있다. 여러 파일이 있거나 학생용·교사용·해설용이 섞여 있으면 자동 선택하지 않고 `attachment_selection_required`를 반환한다.

#### 출력

```typescript
type ReadAchievementResponse = {
  kind: "edunet_achievement_read";
  status:
    | "attachment_selection_required"
    | "metadata_only"
    | "verified_extraction"
    | "no_text"
    | "unsupported_format"
    | "parse_failed"
    | "worker_unavailable"
    | "source_unavailable";
  source: SourceProvenance;
  attachment?: AttachmentProvenance;
  documentProfile?: DocumentProfile;
  records: AchievementRecord[];
  rawBlocks?: RawBlock[];
  pagination?: {
    cursor?: string;
    hasMore: boolean;
  };
  warnings: Warning[];
};
```

실패 상태에서도 `source`, 자료 제목, 원문 링크, 검색 발췌, 실패 이유를 반환한다. 실패했다고 빈 배열만 반환하지 않는다.

### 3.4 `read_edunet_resource` — 일반 문서 읽기, 보조 기능

기존 설계의 일반 문서 읽기는 유지하되 우선순위를 내린다.

- 성취수준 문서에는 `read_edunet_achievement`를 먼저 사용한다.
- 이 도구는 HTML·텍스트·일반 PDF/HWP 미리보기와 출처 반환을 담당한다.
- 성취수준의 학년·코드·단계·설명 문구를 구조화했다고 주장하지 않는다.
- 문서가 성취수준 후보로 보이면 전용 도구 사용을 권고하는 메타데이터를 반환할 수 있다.
- `url`, `file_path`, 셸 명령은 여전히 입력받지 않는다.

---

## 4. 성취수준 데이터 모델

핵심은 “값을 정규화하되 원문을 잃지 않는 것”이다. 모든 정규화 필드는 원문 필드와 함께 반환한다.

### 4.1 출처와 첨부

```typescript
type SourceProvenance = {
  resourceRef: string;
  achievementRef?: string;
  title?: string;
  sourceUrl?: string;
  sourceSystem: "edunet";
  retrievedAt: string;
  contentHash?: string;
  searchEvidence?: EvidenceSpan[];
};

type AttachmentProvenance = {
  attachmentRef: string;
  fileName: string;
  declaredMimeType?: string;
  detectedMimeType?: string;
  byteSize?: number;
  format: "pdf" | "hwp" | "hwpx" | "unknown";
  parserName?: string;
  parserVersion?: string;
  downloadStatus: "downloaded" | "blocked" | "failed";
};
```

### 4.2 구조화 레코드

```typescript
type AchievementRecord = {
  id: string;
  grade?: FieldValue;
  subject?: FieldValue;
  domain?: FieldValue;
  achievementStandardCode?: FieldValue;
  achievementStandardText?: FieldValue;
  achievementLevel?: AchievementLevelValue;
  description?: FieldValue;
  evidence: EvidenceSpan[];
  extraction: {
    method: "table" | "paragraph" | "heading_context" | "mixed";
    confidence: "high" | "medium" | "low";
    parserWarnings?: string[];
  };
};

type FieldValue = {
  raw: string;
  normalized?: string;
  evidence: EvidenceSpan[];
};

type AchievementLevelValue = {
  rawLabel: string;
  labelSystem?:
    | "abc"
    | "상중하"
    | "descriptive"
    | "numeric"
    | "document_defined"
    | "unknown";
  normalizedLabel?: string;
  ordinal?: number;
  evidence: EvidenceSpan[];
};
```

### 4.3 라벨 보존 규칙

다음 규칙은 출시 게이트다.

1. `rawLabel`은 문서의 표현을 그대로 보존한다.
2. `A`, `B`, `C`를 `상`, `중`, `하`로 자동 변환하지 않는다.
3. `상`, `중`, `하`의 순서를 알고 있어도 다른 문서의 체계에 투영하지 않는다.
4. `매우 우수`, `우수`, `보통`, `미흡` 같은 서술형 라벨은 원문 그대로 둔다.
5. 문서가 수준 순서를 명시한 경우에만 `ordinal`을 채운다.
6. `normalizedLabel`은 검색·필터용 보조값이며 원문을 대체하지 않는다.
7. 라벨이 표 머리글과 행에 분산되어 있으면 두 위치를 모두 근거로 기록한다.

### 4.4 문서 위치와 원문 구간

```typescript
type EvidenceSpan = {
  quote: string;
  location: {
    page?: number;
    paragraph?: number;
    block?: number;
    table?: number;
    row?: number;
    column?: number;
    charStart?: number;
    charEnd?: number;
    anchor?: string;
  };
  sourceHash?: string;
};
```

위치 정보가 없는 파서에서 페이지를 추정해 채우지 않는다. 페이지를 제공하지 못하면 문단·블록·표 위치만 반환하고 `locationPrecision` 경고를 남긴다.

---

## 5. 문서 발견 전략

공식 API 검색 결과에 성취수준 자료가 바로 노출되지 않을 수 있다는 점을 제품의 정상 상태로 취급한다.

### 5.1 검색 계층

```text
계층 1: 기존 공식 검색 API
  - 사용자가 입력한 질의
  - 성취 관련 제한 질의어 변형

계층 2: 공식 검색 결과의 상세·첨부 확인
  - 제목·본문·파일명·자료 유형 확인
  - 실제 성취수준 문서 여부 판정

계층 3: 검증된 EDUNET 자료 유형·컬렉션 registry
  - 알려진 공식 목록·상세 경로
  - 버전과 확인 시점을 기록

계층 4: 문서 본문·첨부의 제한적 후보 판정
  - 다운로드 가능한 지원 형식만
  - 파싱은 사용자가 읽기를 요청한 뒤 수행
```

계층 3의 registry는 숨은 크롤링 규칙이 아니다. 운영자가 실제로 확인한 공식 경로, 자료 유형, 필요한 식별자, 마지막 검증 시점을 버전 관리하는 작은 구성 파일이다.

```typescript
type AchievementSourceRegistryEntry = {
  sourceType: string;
  officialHost: string;
  pathPattern: string;
  discoveryMethod: "api" | "official_listing" | "known_detail";
  checkedAt: string;
  enabled: boolean;
};
```

registry가 오래되거나 경로가 바뀌면 결과를 숨기지 않고 `registry_stale` 경고를 반환한다.

### 5.2 검색 누락을 다루는 응답 원칙

- 공식 API 0건: `not_found_in_official_index`
- 보조 경로에서 자료 발견: `partial` 또는 `ok`와 발견 경로 기록
- 자료는 찾았으나 첨부가 없음: `candidate_found_no_attachment`
- 첨부는 있으나 문서가 성취수준인지 확인 불가: `candidate_unverified`
- 원문 파싱까지 성공: `verified_extraction`

검색 범위와 시도한 질의어를 `coverage`에 넣어 AI가 검색 실패를 과장하지 않게 한다.

---

## 6. PDF/HWP/HWPX 파싱 설계

파싱 결과는 바로 의미 레코드로 만들지 않는다. 먼저 문서 레이아웃을 보존한 중간 표현을 만든 뒤 구조화한다.

### 6.1 공통 파이프라인

```text
허용된 첨부 확인
  ↓
안전한 다운로드·바이트 검사
  ↓
실제 MIME·파일 형식 판별
  ↓
형식별 parser
  ↓
레이아웃 보존 중간 표현
  ↓
표·문단·머리글 정규화
  ↓
성취수준 문서 profile 적용
  ↓
필드·레코드 추출
  ↓
원문 근거·위치 연결
  ↓
검증·경고·제한된 반환
```

### 6.2 형식별 정책

| 형식 | 초기 정책 | 실패 시 응답 |
|---|---|---|
| 텍스트 PDF | 우선 지원. 페이지·표·문단 위치 보존 시도 | 텍스트 레이어 없음이면 `no_text` |
| HWP | 우선 지원. 표와 문단을 중간 표현으로 변환 | 변환·구조 해석 실패 시 `parse_failed` |
| HWPX | 샘플 문서로 검증한 parser만 활성화 | 검증 전에는 `unsupported_format` |
| 스캔 PDF | OCR 제외 | `OCR_REQUIRED` 경고와 원문 링크 |
| 이미지·영상 | 파싱하지 않음 | `unsupported_format` |

실제 parser 선택은 저장소의 런타임과 라이선스에 맞춘다. 이 문서는 특정 라이브러리나 변환기를 강제하지 않는다. 중요한 것은 parser가 교체되어도 중간 표현과 출력 계약이 유지되는 것이다.

### 6.3 문서 포맷 차이 대응

성취수준 문서마다 다음 차이가 생길 수 있다.

- 학년과 학년군이 제목·표 머리글·본문에 각각 표시됨
- 과목명이 약칭·정식명·복수 과목 형태로 섞임
- 성취기준 코드와 설명이 같은 셀에 함께 있음
- 성취수준이 열로 배치되거나 행으로 배치됨
- 표가 여러 페이지에 걸쳐 반복 머리글을 가짐
- 셀 병합으로 과목·코드가 여러 행에 암묵적으로 적용됨
- 설명 문구가 여러 문단 또는 여러 셀로 끊김
- 문서가 `A/B/C`가 아닌 사용자 정의 서술형 수준을 사용함
- 페이지 머리글·바닥글이 실제 설명에 섞임
- HWP의 글상자·각주·텍스트 상자에 내용이 들어 있음

따라서 parser는 “열 번호 1은 코드, 열 번호 2는 상” 같은 단일 규칙에 의존하지 않는다. 다음 profile 단계를 사용한다.

1. 문서 제목·머리글에서 학년·과목 후보를 추출한다.
2. 표의 셀 내용과 머리글 패턴으로 코드·수준 열을 식별한다.
3. 병합 셀의 적용 범위를 복원하되, 확정할 수 없으면 낮은 confidence로 둔다.
4. 표 밖의 설명과 표 안의 설명을 구분한다.
5. 동일 레코드의 모든 근거 구간을 연결한다.
6. 규칙으로 확정할 수 없는 값은 `null`과 경고로 남긴다.

### 6.4 문서 profile

문서별 예외를 코드에 하드코딩하지 않고 버전 관리 가능한 profile로 둔다.

```typescript
type DocumentProfile = {
  profileId: string;
  profileVersion: string;
  matchedBy: string[];
  headerPatterns: string[];
  codePatterns: string[];
  levelPatterns: string[];
  tableOrientation: "levels_in_columns" | "levels_in_rows" | "unknown";
  knownLimitations: string[];
};
```

profile이 잘못 선택될 위험이 있으므로, profile 이름만으로 confidence를 높이지 않는다. 실제 원문 근거와 구조 검증 결과를 함께 사용한다.

---

## 7. 구조화 규칙과 검증

### 7.1 성취기준 코드

- 코드 후보는 문서의 코드 패턴과 표 위치를 함께 본다.
- `2022 개정`, 과목, 영역 정보만으로 코드를 만들어내지 않는다.
- 코드가 잘려 있거나 OCR이 필요한 경우 추정하지 않고 raw 문구만 남긴다.
- 정규화된 코드가 있더라도 `raw`를 항상 반환한다.

### 7.2 학년·과목

- 문서 제목, 표 머리글, 본문 문맥에서 후보를 수집한다.
- 문서 전체에 공통으로 적용되는 값과 특정 표에만 적용되는 값을 구분한다.
- `중학교 1학년`과 `중1`은 검색용으로만 연결하고 원문은 그대로 보존한다.
- 여러 학년·과목이 한 파일에 있으면 레코드별 컨텍스트를 분리한다.

### 7.3 설명 문구

- 줄바꿈·셀 경계는 읽기 좋은 `normalized` 값을 만들 수 있지만 `raw`를 잃지 않는다.
- 문서의 문장을 요약하거나 맞춤법을 고쳐서 원문으로 저장하지 않는다.
- 설명이 여러 구간이면 하나의 값에 여러 `evidence`를 연결한다.
- 표 머리글만 있고 설명 셀이 비어 있으면 설명을 만들지 않는다.

### 7.4 레코드 검증

각 레코드는 다음을 통과해야 한다.

- 최소 하나의 원문 근거가 있음
- `achievementLevel.rawLabel`이 실제 추출 구간에 존재함
- 코드가 채워졌다면 코드 근거가 있음
- 병합 셀 상속으로 채운 값은 상속 경고가 있음
- 페이지·행·열 위치가 parser가 제공한 정보와 일치함
- 원문에 없는 라벨·설명·코드를 생성하지 않음

검증에 실패한 레코드는 버리지 말고 `records`에서 제외한 이유를 `warnings`에 기록한다. 필요하면 `rawBlocks`로 원문 블록을 반환한다.

---

## 8. 출처·원문 추적과 정직한 응답

성취수준 기능의 품질은 파싱 성공률만으로 평가하지 않는다. 사용자가 “이 값이 문서 어디에 있나?”를 확인할 수 있어야 한다.

### 반드시 반환할 메타데이터

| 항목 | 의미 |
|---|---|
| 자료 ID·첨부 ID | 어떤 EDUNET 자료를 읽었는지 |
| 제목·원문 링크 | 사람이 원문을 확인할 경로 |
| 파일명·감지 형식 | HWP/PDF/HWPX 구분 |
| 콘텐츠 해시 | 같은 파일인지 이어 읽기에서 확인 |
| parser 버전·profile 버전 | 결과 재현성 |
| 실제 읽은 범위 | 페이지·문단·표·행·열 |
| raw quote | 필드의 근거가 된 원문 |
| 반환 제한 | `maxItems`, `maxChars`, cursor 상태 |
| 시각 자료 미해석 여부 | 그림·도표의 의미를 읽지 않았음을 표시 |
| 경고·실패 상태 | 모델이 빈칸을 추정하지 않게 함 |

`truncated`는 두 종류로 분리한다.

- `documentExtractionComplete`: 문서 전체 추출이 끝났는가
- `responseTruncated`: 이번 응답이 제한 때문에 잘렸는가

문서 전체를 파싱했지만 8,000자만 반환한 경우와, 문서 자체가 일부만 추출된 경우를 혼동하지 않는다.

### 예시 응답

```json
{
  "status": "verified_extraction",
  "source": {
    "resourceRef": "edunet_res_abc",
    "title": "중학교 과학 성취수준 자료",
    "sourceSystem": "edunet",
    "retrievedAt": "2026-09-17T00:00:00Z",
    "contentHash": "sha256:..."
  },
  "records": [
    {
      "id": "record-001",
      "grade": {
        "raw": "중학교 1학년",
        "normalized": "중1",
        "evidence": [{
          "quote": "중학교 1학년 과학",
          "location": {"page": 2, "block": 3}
        }]
      },
      "subject": {
        "raw": "과학",
        "evidence": [{
          "quote": "과학",
          "location": {"page": 2, "table": 1, "column": 1}
        }]
      },
      "achievementStandardCode": {
        "raw": "[9과01-01]",
        "evidence": [{
          "quote": "[9과01-01]",
          "location": {"page": 3, "table": 2, "row": 4, "column": 1}
        }]
      },
      "achievementLevel": {
        "rawLabel": "상",
        "labelSystem": "상중하",
        "evidence": [{
          "quote": "상",
          "location": {"page": 3, "table": 2, "row": 4, "column": 3}
        }]
      },
      "description": {
        "raw": "...문서 원문 설명...",
        "evidence": [{
          "quote": "...문서 원문 설명...",
          "location": {"page": 3, "table": 2, "row": 4, "column": 3}
        }]
      },
      "evidence": [],
      "extraction": {
        "method": "table",
        "confidence": "high"
      }
    }
  ],
  "warnings": []
}
```

예시의 설명 문구는 실제 문서를 읽은 결과가 아니므로 구현 테스트 fixture의 예시로만 사용한다.

---

## 9. 검색 코어와 문서 파서의 장애 격리

### 9.1 권장 구조

```text
사용자 / AI 클라이언트
          │
          ▼
     EDUNET MCP 공개 엔드포인트
          │
          ├── search_edunet
          │       └── 기존 검색 코어 → EDUNET 검색 API
          │
          ├── search_edunet_achievement
          │       └── 검색 오케스트레이터 → 후보·첨부 메타데이터
          │
          ├── read_edunet_achievement
          │       └── 짧은 JSON handle → 문서 읽기 Worker
          │                                  ├─ 안전한 다운로드
          │                                  ├─ PDF/HWP/HWPX parser
          │                                  └─ 구조화·근거 연결
          │
          └── read_edunet_resource
                  └── 일반 문서 읽기 경로
```

Worker는 사용자가 별도로 연결하는 두 번째 MCP가 아니다. 외부에는 하나의 MCP 주소만 보이고, 내부에서만 별도 실행 경계를 둔다.

### 9.2 물리적 분리 기준

같은 프로젝트 안에서 별도 Function으로 실행해도 다음이 충족되면 1차 구현으로 허용한다.

- 검색 코드가 parser 패키지를 import하지 않음
- 검색 요청의 프로세스·메모리 경로에서 파일 바이트를 처리하지 않음
- Worker timeout이 검색 요청 timeout으로 전파되지 않음
- Worker 오류를 검색 응답 상태로 덮어쓰지 않음
- 검색 회귀 테스트가 Worker 없이 실행되고 통과함

이 기준을 만족하지 못하면 `worker/`를 별도 배포 단위로 분리한다. 경로만 `/mcp`와 `/parse`로 나누는 것으로 격리를 증명하지 않는다.

### 9.3 장애 동작

| 장애 | `search_edunet` | 성취수준 검색 | 성취수준 읽기 |
|---|---|---|---|
| Worker 다운 | 정상 | 후보·메타데이터 반환 | `worker_unavailable` + 원문 링크 |
| parser timeout | 정상 | 후보 반환 | `parse_failed` + 범위·경고 |
| 잘못된 파일 | 정상 | 후보 반환 | `unsupported_format` 또는 `parse_failed` |
| 첨부 API 오류 | 정상 | `partial` | `source_unavailable` |
| 검색 API 오류 | 기존 계약의 오류 상태 | `search_unavailable` | 읽기 요청도 출처 확인 불가 |
| 응답 크기 초과 | 정상 | 페이지 축소·경고 | cursor·`responseTruncated` |

파서가 죽어도 검색 프로세스가 재시작되거나 circuit breaker에 걸리지 않는 것이 목표다. 반대로 플랫폼 전체 장애까지 “검색은 절대 중단되지 않는다”고 보장하지는 않는다.

### 9.4 circuit breaker와 시간 예산

초기 제안값이며 실제 플랫폼 한도에 맞춰 측정 후 조정한다.

| 항목 | 초기 제안 |
|---|---:|
| 검색 요청 추가 파싱 | 0초, 금지 |
| 성취 후보 조회 | 10초 내 |
| 파일 1개 다운로드 상한 | 10 MiB |
| 파일 다운로드 timeout | 10초 |
| Worker 전체 예산 | 30초 |
| 기본 레코드 수 | 50개 |
| 기본 반환 문자 수 | 8,000자 |
| 최대 반환 문자 수 | 20,000자 |
| 일시적 다운로드 재시도 | 1회 |
| parser timeout 재시도 | 하지 않음 |
| circuit breaker open | 연속 실패율·시간으로 운영 측정 후 설정 |

파일을 MCP 요청 본문에 base64로 전달하지 않는다. 서버 간에는 서명된 짧은 수명의 handle과 필요한 식별자만 전달하고, Worker가 허용된 EDUNET에서 직접 다운로드한다.

---

## 10. 보안·안전 규칙

문서 파싱은 외부 콘텐츠를 다루므로 검색보다 위험면이 넓다.

### 다운로드

- 서버가 발행한 `resourceRef`·`achievementRef`·`attachmentRef`만 허용
- 임의 URL·로컬 경로·파일 시스템 명령을 입력으로 받지 않음
- 허용 호스트·경로 목록을 검증
- 리디렉션마다 목적지 호스트와 실제 연결 주소 검증
- DNS rebinding·사설 IP·loopback·metadata endpoint 차단
- 응답 바이트 상한과 압축 해제 후 상한을 별도로 적용
- 확장자, 선언 MIME, magic bytes가 충돌하면 보수적으로 중단
- HTML 오류 페이지를 HWP/PDF로 오인하지 않음

### 파서

- parser를 검색 Function에서 직접 실행하지 않음
- CPU·메모리·파일 수·압축 해제 크기 제한
- 임시 파일은 짧은 수명으로 삭제
- 원본 파일을 장기 저장하지 않음. 저장이 필요하면 암호화·보존기간·삭제정책을 별도로 정의
- 문서 안의 지시문은 데이터로만 취급하고 실행하지 않음
- 원문에 포함된 프롬프트 인젝션 문구를 모델 지시로 승격하지 않음

### 참조 보안

- opaque 또는 서명된 self-contained reference 사용
- 자료와 첨부의 소속을 매 호출 검증
- 만료·재생 방지·범위 제한 적용
- 서버 메모리 `Map`에만 참조를 저장하지 않음
- 로그에 원문 전체·토큰·민감한 query를 남기지 않음

---

## 11. 코드 구조 제안

기존 검색 구현을 전면 재구성하지 않고, 성취수준 기능을 옆에 추가한다.

```text
src/
  server.ts                         # 도구 등록. parser 직접 실행 금지
  schema.ts                         # 기존 검색 스키마 유지
  search/
    client.ts                       # 기존 검색 API client
    response.ts                     # 기존 결과 정규화
    contracts.ts                    # 기존 계약·오류
  achievement/
    search-contracts.ts             # 전용 탐색 입력·출력
    search-orchestrator.ts          # 질의 변형·후보 합치기
    source-registry.ts              # 검증된 공식 경로
    references.ts                   # achievementRef 발행·검증
    read-contracts.ts               # 구조화 결과 계약
    gateway.ts                      # Worker 호출·timeout·circuit breaker
  resource/
    read-contracts.ts               # 일반 문서 읽기 보조 도구

worker/
  entry.ts                          # 서비스 인증·요청 검증
  resolver.ts                       # 상세정보·첨부 목록
  safe-download.ts                  # host·redirect·size·MIME 검증
  format-detect.ts                  # magic bytes·실제 형식
  parsers/
    pdf.ts
    hwp.ts
    hwpx.ts
  intermediate/
    blocks.ts                       # 문단·표·페이지 중간 표현
    tables.ts                       # 병합 셀·반복 머리글
  achievement/
    profile.ts
    extract.ts
    normalize.ts
    validate.ts
    evidence.ts
  limits.ts
  errors.ts

config/
  achievement-source-registry.json
  document-profiles/

tests/
  search-regression.*
  achievement-contract.*
  achievement-discovery.*
  reference-scope.*
  safe-download.*
  parser-fixtures.*
  evidence-location.*
  failure-isolation.*
  response-limits.*

evals/
  achievement-golden.jsonl
  achievement-golden-results/
  run-achievement-eval.*
```

새 parser를 추가하기 위해 SDK 메이저 업그레이드, 프레임워크 교체, 전체 모노레포 정리는 함께 하지 않는다.

---

## 12. 테스트와 eval

### 12.1 기존 검색 회귀 게이트

기존 `search_edunet` 테스트를 새 기능의 전제조건으로 둔다.

- 기존 offline/live 평가를 동일한 명령으로 재실행
- 결과 schema, 0건, pagination, 오류 상태, 출처 링크 확인
- 검색만 요청했을 때 첨부 다운로드·parser 호출이 0회인지 확인
- 성취수준 Worker를 중단한 상태에서도 검색 회귀가 통과하는지 확인
- 기존에 기록된 offline 40/40, live 5/5 등 수치는 새 기능의 성공을 의미하지 않으므로 별도 achievement eval을 추가

### 12.2 parser fixture matrix

최소 fixture 세트를 실제 공개 문서에서 비식별·재배포 가능 범위로 준비한다.

| fixture | 검증 내용 |
|---|---|
| 텍스트 PDF의 행 기반 표 | 기본 레코드·페이지·행·열 |
| 텍스트 PDF의 열 기반 표 | A/B/C 또는 상·중·하 열 매핑 |
| 단순 HWP 표 | 코드·수준·설명 추출 |
| 병합 셀이 있는 HWP | 학년·과목·코드 상속과 경고 |
| 여러 페이지 표 | 반복 머리글 제거·행 연결 |
| HWPX 표 | 활성화 전 parser 검증 |
| 수준 라벨 A/B/C | 원문 라벨 fidelity |
| 수준 라벨 상/중/하 | 임의 환산 금지 |
| 서술형 수준 | `document_defined` 또는 `descriptive` 보존 |
| 코드 없는 문서 | 코드 생성 금지 |
| 그림·그래프 포함 | 텍스트와 시각 자료 미해석 구분 |
| 스캔 PDF | `NO_TEXT`/`OCR_REQUIRED` |
| 깨진 파일·HTML 위장 파일 | 안전한 실패 |

### 12.3 정량 eval 지표

초기 목표값은 측정 후 조정할 수 있지만, 출시 전에 모두 수치화한다.

| 지표 | 의미 | 초기 출시 기준 제안 |
|---|---|---:|
| candidate recall@k | 성취수준 관련 후보를 상위 k개에 포함하는 비율 | golden set 기준 측정·하락 금지 |
| verified document rate | 후보 중 실제 문서가 확인되는 비율 | 자료 유형별 기준선 확보 |
| field precision/recall/F1 | 학년·과목·코드·설명 추출 품질 | 필드별 분리 보고 |
| code exact accuracy | 코드 원문과 정규화 코드 일치율 | 98% 이상 목표 |
| level raw-label fidelity | 문서 라벨을 원형 그대로 보존하는 비율 | 100% 목표 |
| evidence attachment rate | 채워진 필드에 근거가 붙은 비율 | 100% 목표 |
| unsupported inference rate | 원문에 없는 값을 생성한 비율 | 0% 목표 |
| format parse success | PDF/HWP/HWPX별 성공률 | 형식별 별도 기준선 |
| p95 latency | 발견·읽기 단계별 지연 | timeout 예산 내 |
| search availability under worker faults | Worker 장애 중 검색 성공률 | 기존 baseline 유지 |

성취수준은 잘 읽었지만 라벨을 다른 체계로 바꿔버린 결과를 성공으로 세지 않는다. `level raw-label fidelity`와 `unsupported inference rate`는 별도 하드 게이트다.

### 12.4 fault injection

다음 상황을 자동화한다.

- Worker 연결 거부
- Worker 응답 지연·timeout
- parser 프로세스 종료
- 큰 파일·압축폭탄·잘못된 MIME
- 첨부 API 404/403/500
- 빈 텍스트·부분 추출
- malformed structured response
- circuit breaker open 상태

각 경우에 `search_edunet` 응답이 정상인지 확인한다.

### 12.5 품질 검토 방식

자동 점수만으로 출시하지 않는다.

- 교육 도메인 검토자가 golden fixture의 레코드·근거 위치를 확인
- 모델이 결과를 보고 성취수준을 잘못 환산하지 않는지 프롬프트 eval 수행
- “공식 API에서 못 찾음”과 “자료 없음”을 구분하는지 확인
- 원문과 구조화 결과를 나란히 비교하는 내부 검토 화면 또는 JSON diff 사용

---

## 13. 구현·출시 단계

### Phase 0 — 현재 상태 고정

- 배포 중인 remote MCP의 검색 URL·커밋·환경 변수를 기록
- 기존 검색 회귀 테스트와 latency baseline 저장
- 검색 Function dependency graph에서 parser가 없는지 확인
- 기존 `search_edunet` 계약을 snapshot으로 고정

완료 기준: 새 브랜치가 없어도 현재 검색 동작을 재현할 수 있다.

### Phase 1 — 성취수준 발견만 추가

- `search_edunet_achievement` 계약과 후보 ref 추가
- 공식 API 질의어 변형과 coverage 상태 구현
- 첨부 목록·파일명·자료 유형 확인
- parser 호출 없이 후보를 반환
- source registry를 작게 시작하고 각 경로에 검증일 기록

완료 기준: 공식 API 검색 누락 시도와 `not_found_in_official_index` 상태가 테스트로 고정된다.

### Phase 2 — Worker와 텍스트 PDF 구조화

- 서명된 reference와 자료·첨부 소속 검증
- 안전한 다운로드·MIME·크기·timeout
- 텍스트 PDF 중간 표현
- 표 기반 성취수준 추출
- evidence span과 `rawLabel` 보존

완료 기준: PDF golden fixture에서 코드·라벨·설명·위치를 재현한다.

### Phase 3 — HWP 구조화

- HWP 문단·표 추출
- 병합 셀·반복 머리글 처리
- 문서 profile과 낮은 confidence 경로
- 파서 장애 주입 후 검색 정상성 확인

완료 기준: HWP fixture와 실제 공개 샘플에서 원문 근거가 연결된다.

### Phase 4 — HWPX 검증·제한적 활성화

- 실제 HWPX 샘플을 fixture로 추가
- 표·글상자·스타일 차이 확인
- 지원 범위가 명확한 profile부터 feature flag로 활성화
- 미지원 문서는 조용히 빈 결과를 반환하지 않고 상태·경고 반환

완료 기준: 검증된 HWPX 유형에서만 `verified_extraction`을 허용한다.

### Phase 5 — 제한된 베타

- 내부 사용자 또는 소수의 실제 질의로 운영
- achievement discovery recall, parse success, evidence coverage 수집
- 결과를 원문과 대조해 profile 보정
- 일반 `read_edunet_resource`는 성취수준 작업의 보조 경로로만 노출

### Phase 6 — 정식 출시

다음 조건을 모두 만족할 때 기본 활성화한다.

- 기존 `search_edunet` 회귀 게이트 통과
- Worker 장애 중 검색 정상
- 수준 라벨 원형 보존 100%
- 원문에 없는 값 생성 0%
- 모든 구조화 필드에 근거 또는 명시적 누락 사유 존재
- PDF/HWP/HWPX별 지원·미지원 범위가 문서화됨
- 검색 누락과 파싱 실패가 서로 다른 상태로 반환됨
- 운영 로그·지표·rollback 절차 준비

### Phase 7 — 일반 문서 읽기 확장

성취수준 기능이 안정화된 뒤에만 `read_edunet_resource`의 형식과 범위를 넓힌다. 일반 문서 읽기 때문에 성취수준 Worker의 품질·지연·안정성 목표를 희석하지 않는다.

---

## 14. 운영 관측과 롤백

### 기록할 지표

- 도구별 호출 수와 성공률
- 검색 API·첨부 API·Worker별 latency
- `verified_extraction`, `parse_failed`, `no_text`, `unsupported_format` 비율
- 파일 형식별 파싱 성공률
- 필드별 evidence 누락률
- raw label fidelity 실패 수
- circuit breaker open 횟수
- Worker 오류 중 검색 오류로 전파된 건수

원문 내용과 사용자의 민감한 검색어는 기본 로그에 남기지 않는다. 오류 추적에는 자료 ID, 첨부 ID, content hash 일부, parser/profile 버전만 사용한다.

### 기능 플래그

- `achievement_search_enabled`
- `achievement_pdf_read_enabled`
- `achievement_hwp_read_enabled`
- `achievement_hwpx_read_enabled`
- `achievement_auto_attachment_selection_enabled`

파서 문제가 발생하면 읽기 기능만 끄고 `search_edunet`은 유지한다. rollback은 parser 배포와 source registry 변경을 독립적으로 되돌릴 수 있어야 한다.

---

## 15. 최종 수용 기준

다음 질문에 모두 “예”라고 답할 수 있어야 한다.

1. 기존 `search_edunet`만 사용할 때 응답과 안정성이 바뀌지 않는가?
2. 공식 API 검색결과에 문서가 바로 나오지 않는 경우를 상태와 범위로 설명하는가?
3. 성취기준 코드가 문서에 없을 때 코드를 만들어내지 않는가?
4. `A/B/C`와 `상/중/하`를 서로 바꾸지 않고 원문 라벨을 보존하는가?
5. 학년·과목·설명 문구에 실제 원문 근거가 붙는가?
6. 표의 페이지·행·열 또는 가능한 가장 정확한 위치를 반환하는가?
7. PDF/HWP/HWPX 문서별 지원 범위와 실패 이유가 구분되는가?
8. OCR이 필요한 문서를 읽은 것처럼 답하지 않는가?
9. 첨부가 여러 개일 때 근거 없이 하나를 고르지 않는가?
10. Worker·parser가 다운되어도 검색 MCP가 살아 있는가?
11. 검색 실패, 첨부 실패, 파싱 실패, 원문 무텍스트가 서로 다른 상태인가?
12. 기존 검색 회귀 테스트와 성취수준 golden/eval을 모두 통과하는가?
13. 문제가 생겼을 때 성취수준 읽기만 즉시 끄고 기존 검색으로 rollback할 수 있는가?

이 조건을 만족한 뒤의 제품 구조는 다음과 같다.

```text
search_edunet                         # 안정적인 기존 코어
search_edunet_achievement             # 성취수준 자료 발견
read_edunet_achievement               # 원문 읽기·구조화·근거
read_edunet_resource                  # 일반 문서 보조 읽기
```

핵심은 도구 수를 늘리는 것이 아니다. **성취수준이라는 하나의 중요한 과업을 검색 → 원문 → 구조화 → 근거 추적으로 끝까지 닫되, 그 확장이 이미 안정적인 검색 코어를 흔들지 않게 하는 것**이다.
