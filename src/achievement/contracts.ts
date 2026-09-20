import * as z from "zod/v4";

const filter = z.string().trim().min(1).max(300).refine(value => !/(?:https?:\/\/|file:|^[a-z]:[\\/]|^\/)/i.test(value), "URL과 파일 경로 대신 검색 조건을 입력하세요.");
export const searchAchievementInputSchema = z.strictObject({
  query: filter.optional(), grade: filter.optional(), subject: filter.optional(),
  achievementStandardCode: filter.optional(), levelLabel: filter.optional(),
  resourceType: z.enum(["achievement_standard", "achievement_level", "assessment_criteria", "unknown"]).optional(),
  page: z.number().int().min(1).max(50).default(1), pageSize: z.number().int().min(1).max(20).default(10),
}).refine(input => !!(input.query || input.grade || input.subject || input.achievementStandardCode), "query, grade, subject, achievementStandardCode 중 하나는 필요합니다.");
const ref = z.string().min(1).max(16000);
export const readAchievementInputSchema = z.strictObject({
  achievementRef: ref, attachmentRef: ref.optional(), grade: filter.optional(), subject: filter.optional(),
  achievementStandardCode: filter.optional(), levelLabel: filter.optional(), cursor: ref.optional(),
  maxItems: z.number().int().min(1).max(100).default(50).describe("반환 레코드/블록 수. 첨부 목록은 한 번에 최대 20개이며 cursor로 이어 읽습니다."), maxChars: z.number().int().min(500).max(20000).default(8000).describe("records와 rawBlocks의 JSON 문자 예산. 제한된 출처·경고·첨부 목록 메타데이터는 별도입니다. 큰 원문 블록은 charStart/charEnd를 보존하여 나눕니다."),
});
export const readResourceInputSchema = readAchievementInputSchema.omit({achievementRef:true,grade:true,subject:true,achievementStandardCode:true,levelLabel:true}).extend({resourceRef:ref});
export type SearchAchievementInput = z.infer<typeof searchAchievementInputSchema>;
export type ReadAchievementInput = z.infer<typeof readAchievementInputSchema>;
export type ReadResourceInput = z.infer<typeof readResourceInputSchema>;
export const warningSchema = z.object({code:z.string(), message:z.string()});
export type Warning = z.infer<typeof warningSchema>;
export const formatSchema = z.enum(["pdf","hwp","hwpx","unknown"]);
export type DocumentFormat = z.infer<typeof formatSchema>;
export const resourceIdentitySchema = z.object({id:z.string().min(1).max(300),title:z.string().max(2000),sourceUrl:z.string().max(4000).optional(),snippet:z.string().max(4000).optional(),sourceType:z.string().max(200).optional()});
export type ResourceIdentity = z.infer<typeof resourceIdentitySchema>;
export interface ResolvedAttachment {id:string;fileName:string;url:string;declaredMimeType?:string;byteSize?:number;format:DocumentFormat}
export interface ResourceDetails {resource:ResourceIdentity;attachments:ResolvedAttachment[];warnings:Warning[]}
export const evidenceLocationSchema = z.object({page:z.number().int().positive().optional(),paragraph:z.number().int().positive().optional(),block:z.number().int().positive().optional(),table:z.number().int().positive().optional(),row:z.number().int().positive().optional(),column:z.number().int().positive().optional(),charStart:z.number().int().nonnegative().optional(),charEnd:z.number().int().nonnegative().optional(),anchor:z.string().optional()});
export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;
export const evidenceSpanSchema = z.object({quote:z.string(),location:evidenceLocationSchema,sourceHash:z.string().optional()});
export type EvidenceSpan = z.infer<typeof evidenceSpanSchema>;
export const rawBlockSchema = z.object({text:z.string(),kind:z.enum(["heading","paragraph","table_cell"]),location:evidenceLocationSchema,rowSpan:z.number().int().positive().optional(),columnSpan:z.number().int().positive().optional()});
export type RawBlock = z.infer<typeof rawBlockSchema>;
export interface ParsedDocument {blocks:RawBlock[];parserName:string;parserVersion:string;documentExtractionComplete:boolean;warnings:Warning[]}
export const fieldValueSchema = z.object({raw:z.string(),normalized:z.string().optional(),evidence:z.array(evidenceSpanSchema).min(1)});
export type FieldValue = z.infer<typeof fieldValueSchema>;
export const achievementLevelValueSchema = z.object({rawLabel:z.string(),labelSystem:z.enum(["alphabetic","abc","상중하","descriptive","numeric","document_defined","unknown"]).optional().describe("표기 분류이며 수준 개수가 아닙니다. alphabetic은 A~E 등의 알파벳 라벨입니다. abc는 이전 Worker 호환용입니다. 원문 라벨을 다른 등급으로 환산하지 마세요."),normalizedLabel:z.string().optional(),ordinal:z.number().optional(),evidence:z.array(evidenceSpanSchema).min(1)});
export type AchievementLevelValue = z.infer<typeof achievementLevelValueSchema>;
export const achievementRecordSchema = z.object({id:z.string(),grade:fieldValueSchema.optional(),subject:fieldValueSchema.optional(),domain:fieldValueSchema.optional(),achievementStandardCode:fieldValueSchema.optional(),achievementStandardText:fieldValueSchema.optional(),achievementLevel:achievementLevelValueSchema.optional(),description:fieldValueSchema.optional(),evidence:z.array(evidenceSpanSchema).min(1),extraction:z.object({method:z.enum(["table","paragraph","heading_context","mixed"]),confidence:z.enum(["high","medium","low"]),parserWarnings:z.array(z.string()).optional()})});
export type AchievementRecord = z.infer<typeof achievementRecordSchema>;
export const documentProfileSchema = z.object({profileId:z.string(),profileVersion:z.string(),matchedBy:z.array(z.string()),headerPatterns:z.array(z.string()),codePatterns:z.array(z.string()),levelPatterns:z.array(z.string()),tableOrientation:z.enum(["levels_in_columns","levels_in_rows","unknown"]),knownLimitations:z.array(z.string())});
export type DocumentProfile = z.infer<typeof documentProfileSchema>;
export const sourceProvenanceSchema = z.object({resourceRef:z.string(),achievementRef:z.string().optional(),title:z.string().optional(),sourceUrl:z.string().optional(),sourceSystem:z.literal("edunet"),retrievedAt:z.string(),contentHash:z.string().optional(),searchEvidence:z.array(evidenceSpanSchema).optional()});
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;
export const attachmentProvenanceSchema = z.object({attachmentRef:z.string(),fileName:z.string(),declaredMimeType:z.string().optional(),detectedMimeType:z.string().optional(),byteSize:z.number().optional(),format:formatSchema,parserName:z.string().optional(),parserVersion:z.string().optional(),downloadStatus:z.enum(["downloaded","blocked","failed"])});
export type AttachmentProvenance = z.infer<typeof attachmentProvenanceSchema>;
export const achievementCandidateSchema = z.object({achievementRef:z.string(),resourceRef:z.string(),title:z.string(),snippet:z.string().optional(),sourceUrl:z.string().optional(),sourceType:z.string().optional(),gradeHint:z.string().optional(),subjectHint:z.string().optional(),codeHint:z.string().optional(),levelLabelHint:z.string().optional(),candidateReason:z.array(z.string()),readCapability:z.enum(["possible","unsupported","unknown"])});
export type AchievementCandidate = z.infer<typeof achievementCandidateSchema>;
export const achievementSearchResponseSchema = z.object({kind:z.literal("edunet_achievement_search"),status:z.enum(["ok","partial","not_found_in_official_index","search_unavailable"]),results:z.array(achievementCandidateSchema),pagination:z.object({page:z.number(),pageSize:z.number(),hasNext:z.boolean(),nextPage:z.number().optional()}).optional(),coverage:z.object({officialApiQueried:z.boolean(),queryVariantsTried:z.array(z.string()),attachmentMetadataChecked:z.boolean(),registryPathsChecked:z.array(z.string()),officialListing:z.object({attempted:z.boolean(),status:z.enum(["ok","unavailable"]),page:z.number(),keyword:z.string().optional(),school:z.string().optional(),hasNext:z.boolean().optional()}).optional(),limitation:z.string().optional()}),warnings:z.array(warningSchema)});
export type AchievementSearchResponse = z.infer<typeof achievementSearchResponseSchema>;
export const levelCoverageSchema = z.object({
  scope:z.literal("attachment_and_filters").describe("선택한 첨부와 현재 필터에 한정합니다. 여러 코드가 있으면 라벨은 합집합입니다."),
  extractedLabels:z.array(z.string().max(100)).max(20).describe("추출된 원문 라벨이며 원문 전체 수준 목록이나 각 코드의 수준 개수를 보증하지 않습니다."),
  labelsTruncated:z.boolean(),matchingRecordCount:z.number().int().nonnegative(),returnedRecordCount:z.number().int().nonnegative(),
  remainingRecordCount:z.number().int().nonnegative(),omittedRecordCount:z.number().int().nonnegative(),
  allMatchingRecordsDelivered:z.boolean().describe("이전 cursor 응답까지 합쳐 일치하는 추출 레코드가 모두 전달되었는지 여부입니다. 원문 수준의 완전성을 뜻하지 않습니다."),
  levelLabelFilterApplied:z.boolean(),sourceCompleteness:z.literal("unverified"),
});
export const readAchievementResponseSchema = z.object({kind:z.literal("edunet_achievement_read"),status:z.enum(["attachment_selection_required","metadata_only","verified_extraction","no_text","unsupported_format","parse_failed","worker_unavailable","source_unavailable"]),source:sourceProvenanceSchema,attachment:attachmentProvenanceSchema.optional(),attachments:z.array(z.object({attachmentRef:z.string(),fileName:z.string(),format:formatSchema,byteSize:z.number().optional(),readCapability:z.enum(["possible","unsupported","unknown"]),selectionReason:z.string()})).optional(),documentProfile:documentProfileSchema.optional(),records:z.array(achievementRecordSchema),levelCoverage:levelCoverageSchema.optional(),rawBlocks:z.array(rawBlockSchema).optional(),pagination:z.object({cursor:z.string().optional(),hasMore:z.boolean()}).optional(),documentExtractionComplete:z.boolean().optional(),responseTruncated:z.boolean().optional(),visualContentInterpreted:z.literal(false).default(false),warnings:z.array(warningSchema)});
export type ReadAchievementResponse = z.infer<typeof readAchievementResponseSchema>;
export const workerResultSchema = readAchievementResponseSchema.omit({kind:true,source:true,attachments:true,pagination:true,responseTruncated:true,levelCoverage:true}).extend({contentHash:z.string().optional()});
export type WorkerResult = z.infer<typeof workerResultSchema>;
export const readResourceResponseSchema = readAchievementResponseSchema.omit({kind:true,records:true,levelCoverage:true}).extend({kind:z.literal("edunet_resource_read"),achievementToolRecommended:z.boolean()});
