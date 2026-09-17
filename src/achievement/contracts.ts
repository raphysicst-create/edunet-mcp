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
  maxItems: z.number().int().min(1).max(100).default(50), maxChars: z.number().int().min(500).max(20000).default(8000),
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
export const achievementLevelValueSchema = z.object({rawLabel:z.string(),labelSystem:z.enum(["abc","상중하","descriptive","numeric","document_defined","unknown"]).optional(),normalizedLabel:z.string().optional(),ordinal:z.number().optional(),evidence:z.array(evidenceSpanSchema).min(1)});
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
export const achievementSearchResponseSchema = z.object({kind:z.literal("edunet_achievement_search"),status:z.enum(["ok","partial","not_found_in_official_index","search_unavailable"]),results:z.array(achievementCandidateSchema),pagination:z.object({page:z.number(),pageSize:z.number(),hasNext:z.boolean(),nextPage:z.number().optional()}).optional(),coverage:z.object({officialApiQueried:z.boolean(),queryVariantsTried:z.array(z.string()),attachmentMetadataChecked:z.boolean(),registryPathsChecked:z.array(z.string()),limitation:z.string().optional()}),warnings:z.array(warningSchema)});
export type AchievementSearchResponse = z.infer<typeof achievementSearchResponseSchema>;
export const readAchievementResponseSchema = z.object({kind:z.literal("edunet_achievement_read"),status:z.enum(["attachment_selection_required","metadata_only","verified_extraction","no_text","unsupported_format","parse_failed","worker_unavailable","source_unavailable"]),source:sourceProvenanceSchema,attachment:attachmentProvenanceSchema.optional(),attachments:z.array(z.object({attachmentRef:z.string(),fileName:z.string(),format:formatSchema,byteSize:z.number().optional(),readCapability:z.enum(["possible","unsupported","unknown"]),selectionReason:z.string()})).optional(),documentProfile:documentProfileSchema.optional(),records:z.array(achievementRecordSchema),rawBlocks:z.array(rawBlockSchema).optional(),pagination:z.object({cursor:z.string().optional(),hasMore:z.boolean()}).optional(),documentExtractionComplete:z.boolean().optional(),responseTruncated:z.boolean().optional(),visualContentInterpreted:z.literal(false).default(false),warnings:z.array(warningSchema)});
export type ReadAchievementResponse = z.infer<typeof readAchievementResponseSchema>;
export const workerResultSchema = readAchievementResponseSchema.omit({kind:true,source:true,attachments:true,pagination:true,responseTruncated:true}).extend({contentHash:z.string().optional()});
export type WorkerResult = z.infer<typeof workerResultSchema>;
export const readResourceResponseSchema = readAchievementResponseSchema.omit({kind:true,records:true}).extend({kind:z.literal("edunet_resource_read"),achievementToolRecommended:z.boolean()});
