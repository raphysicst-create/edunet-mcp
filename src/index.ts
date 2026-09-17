#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { createLogger } from "./logger.js";

const logger = createLogger();
const handle = serveStdio(() => createServer(), {
  onerror: () => logger.error("protocol_error"),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void handle.close(); });
}
