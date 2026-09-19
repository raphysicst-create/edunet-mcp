import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { createLogger } from "./logger.js";
import { loadAchievementConfig } from "./achievement/config.js";
import { createWorkerGateway } from "./achievement/gateway.js";

type RemoteRequest = IncomingMessage & { body?: unknown };
type ServerFactory = () => McpServer | Promise<McpServer>;
export interface RemoteHttpOptions {
  /** Extra trusted browser origins; desktop MCP requests normally omit Origin. */
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
}

const logger = createLogger();
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: number, message: string) { super(message); }
}

function decodeBody(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new RequestFailure(400, -32700, "Invalid JSON body."); }
}

async function readBody(request: RemoteRequest, limit: number): Promise<string> {
  // Vercel may have parsed JSON before invoking the Node function.
  if (request.body !== undefined) {
    if (Buffer.isBuffer(request.body) && request.body.length > limit) throw new RequestFailure(413, -32600, "Request body too large.");
    const body = Buffer.isBuffer(request.body) ? decodeBody(request.body)
      : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (body === undefined) throw new RequestFailure(400, -32700, "Invalid JSON body.");
    if (Buffer.byteLength(body) > limit) throw new RequestFailure(413, -32600, "Request body too large.");
    return body;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw new RequestFailure(413, -32600, "Request body too large.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) {
      request.resume();
      throw new RequestFailure(413, -32600, "Request body too large.");
    }
    chunks.push(bytes);
  }
  return decodeBody(Buffer.concat(chunks));
}

function errorResponse(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

/** A fresh MCP serving instance for every HTTP request, safe across Vercel replicas. */
export function createRemoteHandler(factory: ServerFactory = createDefaultFactory(), options: RemoteHttpOptions = {}) {
  return async (request: RemoteRequest, response: ServerResponse): Promise<void> => {
    const controller = new AbortController();
    let closeServing: (() => Promise<void>) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => cleanupPromise ??= (closeServing?.() ?? Promise.resolve()).catch(() => {
      logger.warn("remote_cleanup_failed");
    });
    const disconnect = (): void => {
      if (!response.writableFinished) controller.abort();
      if (closeServing) void cleanup();
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");

    const abortable = <T>(work: Promise<T>, discard?: (value: T) => Promise<void>): Promise<T> => new Promise((resolve, reject) => {
      const abort = (): void => { done(); reject(new Error("Request disconnected.")); };
      const done = (): void => controller.signal.removeEventListener("abort", abort);
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      void work.then(value => {
        done();
        if (controller.signal.aborted) {
          if (discard) void Promise.resolve().then(() => discard(value)).catch(() => logger.warn("remote_cleanup_failed"));
          abort();
        } else resolve(value);
      }, error => { done(); reject(error); });
    });

    const openServer = (): Promise<McpServer> => abortable(Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Request disconnected.");
      return factory();
    }), server => server.close());

    const send = async (result: Response): Promise<void> => {
      if (response.destroyed || controller.signal.aborted) return;
      response.statusCode = result.status;
      for (const [name, value] of result.headers) response.setHeader(name, value);
      const bytes = result.body === null ? undefined : Buffer.from(await result.arrayBuffer());
      if (response.destroyed || controller.signal.aborted) return;
      await new Promise<void>((resolve, reject) => {
        const onDone = (): void => { response.off("finish", onDone); response.off("close", onDone); response.off("error", onError); resolve(); };
        const onError = (error: Error): void => { response.off("finish", onDone); response.off("close", onDone); reject(error); };
        response.once("finish", onDone);
        response.once("close", onDone);
        response.once("error", onError);
        response.end(bytes);
      });
    };

    try {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        await send(errorResponse(405, -32000, "Method not allowed."));
        return;
      }
      const host = request.headers.host ?? "localhost";
      const protocol = host === "localhost" || host.startsWith("localhost:") || host.startsWith("127.0.0.1:") || host.startsWith("[::1]:") ? "http" : "https";
      const base = new URL(`${protocol}://${host}`);
      const url = new URL(request.url ?? "/api/mcp", base);
      const origin = request.headers.origin;
      if (url.origin !== base.origin || (origin !== undefined && origin !== base.origin && !options.allowedOrigins?.includes(origin))) {
        await send(errorResponse(403, -32000, "Origin not allowed."));
        return;
      }
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        await send(errorResponse(415, -32000, "Content-Type must be application/json."));
        return;
      }
      const body = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (controller.signal.aborted) return;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const webRequest = new Request(url, { method: "POST", headers, body, signal: controller.signal });
      let result: Response;
      if (await isLegacyRequest(webRequest)) {
        const server = await openServer();
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        closeServing = async () => { await server.close(); };
        if (controller.signal.aborted) return;
        await server.connect(transport);
        if (controller.signal.aborted) return;
        // The legacy JSON response promise can remain pending after close().
        // Disconnect must also settle the Vercel invocation itself.
        result = await abortable(transport.handleRequest(webRequest));
      } else {
        const handler = createMcpHandler(openServer, { legacy: "reject", responseMode: "json", maxSubscriptions: 0,
          onerror: () => logger.warn("remote_protocol_error"),
        });
        closeServing = () => handler.close();
        if (controller.signal.aborted) return;
        result = await abortable(handler.fetch(webRequest));
      }
      await send(result);
    } catch (error) {
      if (!response.destroyed && !controller.signal.aborted) {
        if (error instanceof RequestFailure) await send(errorResponse(error.status, error.code, error.message));
        else {
          logger.error("remote_request_failed");
          if (!response.headersSent) await send(errorResponse(500, -32603, "Internal server error."));
          else response.destroy();
        }
      }
    } finally {
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      await cleanup();
    }
  };
}

function createDefaultFactory(): ServerFactory {
  let achievement: NonNullable<Parameters<typeof createServer>[1]>["achievement"];
  return () => {
    if (!achievement) {
      const config = loadAchievementConfig();
      // Transport instances are stateless; parser limits and the circuit breaker
      // must still be shared by requests handled by the same Vercel process.
      achievement = { config, gateway: createWorkerGateway({ secret: config.referenceSecret ?? "" }) };
    }
    return createServer(undefined, { achievement });
  };
}

export const handleRemoteRequest = createRemoteHandler();
