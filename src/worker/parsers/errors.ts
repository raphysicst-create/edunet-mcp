export class ParseDocumentError extends Error {
  constructor(readonly code: string, message: string, readonly status: "no_text" | "unsupported_format" | "parse_failed" = "parse_failed") {
    super(message);
    this.name = "ParseDocumentError";
  }
}
