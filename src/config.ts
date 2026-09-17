import { EdunetError } from "./errors.js";

export interface EdunetConfig {
  readonly apiKey: string;
  /** API registration domain value; this is not an upstream endpoint. */
  readonly domain: string;
}

/** Read configuration on demand so a missing key does not prevent MCP startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EdunetConfig {
  const apiKey = env.EDUNET_API_KEY?.trim();
  const domain = env.EDUNET_DOMAIN?.trim();
  if (!apiKey || !domain || /[\r\n\0]/u.test(apiKey + domain)) {
    throw new EdunetError("CONFIGURATION");
  }
  return Object.freeze({ apiKey, domain });
}
