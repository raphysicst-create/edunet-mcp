export type LogFields = Readonly<Record<string, unknown>>;
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Redact literal and URL-encoded secrets, plus sno query/structured values. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(new URLSearchParams({ value: secret }).toString().slice("value=".length));
    let encoded = secret;
    for (let depth = 0; depth < 3; depth++) {
      try { encoded = encodeURIComponent(encoded); } catch { break; }
      variants.add(encoded);
      variants.add(encoded.replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase()));
      variants.add(encoded.replace(/%20/g, "+"));
    }
  }
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    const pattern = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/%[0-9a-f]{2}/gi, (value) => value.replace(/[a-f]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`));
    safe = safe.replace(new RegExp(pattern, "g"), "[REDACTED]");
  }
  safe = safe.replace(/(\bsno\s*[=:]\s*)([^&\s,;"'}]+)/gi, "$1[REDACTED]");
  safe = safe.replace(/("(?:sno|apiKey|EDUNET_API_KEY)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
  safe = safe.replace(/(sno%3[dD])[^&\s]+/gi, "$1[REDACTED]");
  return safe;
}

/** App logs go exclusively to stderr; injected sinks support local verification. */
export function createLogger(options: {
  secrets?: readonly string[];
  sink?: (line: string) => void;
} = {}): Logger {
  const sink = options.sink ?? ((line: string) => { process.stderr.write(line + "\n"); });
  const secrets = [...(options.secrets ?? []), process.env.EDUNET_API_KEY ?? ""];
  const write = (level: string, event: string, fields?: LogFields): void => {
    try {
      const line = JSON.stringify({ time: new Date().toISOString(), level, event, fields }, (key, value: unknown) =>
        /^(?:sno|apiKey|EDUNET_API_KEY)$/i.test(key) ? "[REDACTED]" : value);
      sink(redact(line, secrets));
    } catch {
      // Logging failures must neither leak unserialized values nor break a request.
    }
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
