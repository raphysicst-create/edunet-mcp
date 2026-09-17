export interface AchievementConfig {
  searchEnabled:boolean; pdfReadEnabled:boolean; hwpReadEnabled:boolean; hwpxReadEnabled:boolean;
  autoAttachmentSelectionEnabled:boolean; resourceReadEnabled:boolean; referenceSecret?:string;
}
const flag = (env:NodeJS.ProcessEnv,key:string):boolean => env[key]?.toLowerCase() === "true";
/** Beta is opt-in until public-document and educator review gates have been completed. */
export function loadAchievementConfig(env:NodeJS.ProcessEnv=process.env):AchievementConfig {
  return {searchEnabled:flag(env,"EDUNET_ACHIEVEMENT_SEARCH_ENABLED"),pdfReadEnabled:flag(env,"EDUNET_ACHIEVEMENT_PDF_READ_ENABLED"),hwpReadEnabled:flag(env,"EDUNET_ACHIEVEMENT_HWP_READ_ENABLED"),hwpxReadEnabled:flag(env,"EDUNET_ACHIEVEMENT_HWPX_READ_ENABLED"),autoAttachmentSelectionEnabled:flag(env,"EDUNET_ACHIEVEMENT_AUTO_ATTACHMENT_SELECTION_ENABLED"),resourceReadEnabled:flag(env,"EDUNET_RESOURCE_READ_ENABLED"),...(env.EDUNET_REFERENCE_SECRET ? {referenceSecret:env.EDUNET_REFERENCE_SECRET} : {})};
}
