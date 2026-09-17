import * as z from "zod/v4";
import { inputHelp } from "./search-guidance.js";

/** EDUNET's official Open API manual v4.5, see docs/api-findings.md. */
export const categoryLabels = {
  total: "전체",
  lsn_design: "수업설계",
  tpc_lrng: "주제학습",
  evl_data: "평가자료",
  ednwkst: "주제별 학습자료",
  edntpd: "주제별 사진·영상",
  edunanum: "선생님들의 나눔공간",
  webrlstccont_inc: "웹 실감형콘텐츠",
  asset: "글꼴·이미지·음악·PPT",
  ednstdyschl: "연구학교",
  ednstdyconfr: "연구대회",
  crclm: "교육과정",
  ednaisw: "AI·SW교육",
  ncs: "직업계고 교육과정",
  cre_sys: "고교학점제",
  sel: "사회정서교육",
  archive: "아카이브",
  qst_cntr: "질문 중심 수업",
} as const;

export const categorySchema = z.enum(Object.keys(categoryLabels) as [keyof typeof categoryLabels, ...(keyof typeof categoryLabels)[]], { error: inputHelp.category })
  .describe(Object.entries(categoryLabels).map(([code, name]) => `${code}: ${name}`).join(", "));
