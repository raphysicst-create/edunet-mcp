import { timingSafeEqual } from "node:crypto";
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { createLogger } from "./logger.js";

/** Each HTTP request gets an independent server; no in-memory sessions or Redis. */
export function createHttpHandler(factory: McpServerFactory = () => createServer(),
  env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger();
  const mcp = createMcpHandler(factory, {
    legacy: "stateless",
    onerror: () => logger.warn("http_protocol_error"),
  });
  return {
    close: mcp.close,
    async fetch(request: Request): Promise<Response> {
      const headers = { "Cache-Control": "no-store" };
      const origin = request.headers.get("origin");
      const allowedOrigins = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean);
      if (origin && origin !== new URL(request.url).origin && !allowedOrigins.includes(origin)) {
        return Response.json({ error: "Forbidden origin" }, { status: 403, headers });
      }
      // Public access requires an explicit deployment choice. Missing auth fails closed.
      if (env.MCP_AUTH_MODE !== "public") {
        const token = env.MCP_ACCESS_TOKEN?.trim();
        if (!token || token.length < 32) {
          return Response.json({ error: "Remote authentication is not configured" }, { status: 503, headers });
        }
        const supplied = Buffer.from(request.headers.get("authorization") ?? "");
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          return Response.json({ error: "Unauthorized" }, {
            status: 401, headers: { ...headers, "WWW-Authenticate": 'Bearer realm="edunet-mcp"' },
          });
        }
      }
      try {
        const response = await mcp.fetch(request);
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch {
        logger.error("http_request_failed");
        return Response.json({ error: "Internal server error" }, { status: 500, headers });
      }
    },
  };
}
