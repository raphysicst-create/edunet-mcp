export type DownloadErrorCode =
  | "DOWNLOAD_BLOCKED"
  | "DOWNLOAD_TOO_LARGE"
  | "DOWNLOAD_TIMEOUT"
  | "DOWNLOAD_ABORTED"
  | "DOWNLOAD_FAILED"
  | "INVALID_RESPONSE"
  | "FORMAT_MISMATCH";

/** Controlled messages only: never include signed URLs, headers, or upstream bodies. */
export class DownloadError extends Error {
  constructor(readonly code: DownloadErrorCode, readonly retryable = false) {
    super(code);
    this.name = "DownloadError";
  }
}
