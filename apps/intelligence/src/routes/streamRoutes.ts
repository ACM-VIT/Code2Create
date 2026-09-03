import {
  operationsAutonomyStreamTicketSignatureContext,
  operationsBriefStreamTicketSignatureContext,
  operationsCopilotStreamTicketSignatureContext,
  operationsIntelligenceStreamTicketHeaders,
  type OperationsIntelligenceStreamAgentName,
} from "@code2create/domain";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";

import { OperationsAutopilot } from "../agents/operations-autopilot.ts";
import { OperationsBrief } from "../agents/operations-brief.ts";
import { OperationsCopilot } from "../agents/operations-copilot.ts";
import {
  createIntelligenceHistoryCursor,
  intelligenceHistoryPageHeaders,
  internalFlueHistoryPageHeaders,
  readIntelligenceHistoryCursor,
} from "../lib/historyCursor.ts";
import {
  intelligenceStreamReadMode,
  sanitizeAgentStreamResponse,
  type IntelligenceStreamProjectionPolicy,
} from "../lib/streamProjection.ts";
import { verifyIntelligenceStreamTicket } from "../lib/streamTicket.ts";

const nativeHistoryMessageLimit = "6";
const briefRouter = createAgentRouter(OperationsBrief);
const copilotRouter = createAgentRouter(OperationsCopilot);
const autopilotRouter = createAgentRouter(OperationsAutopilot);
const ticketHeaderNames = Object.values(operationsIntelligenceStreamTicketHeaders).join(", ");
const exposedHeaders = [
  "Stream-Next-Offset",
  "Stream-Up-To-Date",
  intelligenceHistoryPageHeaders.before,
  intelligenceHistoryPageHeaders.hasEarlier,
].join(", ");

function exactOpsOrigin(value: string) {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error("OPS_ORIGIN must be an exact HTTPS origin outside local development.");
  return url.origin;
}

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": exposedHeaders,
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function withCors(response: Response, origin: string) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readAgentStream(args: {
  request: Request;
  environment: Cloudflare.Env;
  routeInstanceId: string;
  agentName: OperationsIntelligenceStreamAgentName;
  signatureContext: string;
  router: ReturnType<typeof createAgentRouter>;
  projectionPolicy: IntelligenceStreamProjectionPolicy;
}) {
  if (args.request.method !== "GET" && args.request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { allow: "GET, HEAD", "content-type": "application/json; charset=UTF-8" },
    });
  }
  if (intelligenceStreamReadMode(args.request) === null) {
    return Response.json({ error: "invalid_stream_read" }, { status: 400 });
  }
  const allowedOrigin = exactOpsOrigin(args.environment.OPS_ORIGIN);
  const requestOrigin = args.request.headers.get("origin");
  if (requestOrigin !== null && requestOrigin !== allowedOrigin) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=UTF-8", vary: "Origin" },
    });
  }
  const ticket = await verifyIntelligenceStreamTicket({
    request: args.request,
    secret: args.environment.INTELLIGENCE_STREAM_SECRET,
    signatureContext: args.signatureContext,
    agentName: args.agentName,
    routeInstanceId: args.routeInstanceId,
    now: Date.now(),
  });
  if (ticket === null) {
    return withCors(Response.json({ error: "unauthorized" }, { status: 401 }), allowedOrigin);
  }
  const publicBefore = new URL(args.request.url).searchParams.get("before");
  const nativeBefore =
    publicBefore === null
      ? undefined
      : await readIntelligenceHistoryCursor({
          cursor: publicBefore,
          instanceId: args.routeInstanceId,
          secret: args.environment.INTELLIGENCE_STREAM_SECRET,
        });
  if (publicBefore !== null && nativeBefore === null) {
    return withCors(
      Response.json({ error: "invalid_history_cursor" }, { status: 400 }),
      allowedOrigin,
    );
  }

  const internalUrl = new URL(args.request.url);
  internalUrl.pathname = `/${encodeURIComponent(args.routeInstanceId)}`;
  internalUrl.searchParams.delete("before");
  const internalHeaders = new Headers({
    accept: args.request.headers.get("accept") ?? "*/*",
    "x-flue-history-message-limit": nativeHistoryMessageLimit,
  });
  if (typeof nativeBefore === "string") {
    internalHeaders.set(internalFlueHistoryPageHeaders.beforeMessageKey, nativeBefore);
  }
  const internalRequest = new Request(internalUrl, {
    method: args.request.method,
    headers: internalHeaders,
    signal: args.request.signal,
  });
  try {
    const internalResponse = await args.router.fetch(internalRequest, args.environment);
    const projected = await sanitizeAgentStreamResponse({
      request: args.request,
      response: internalResponse,
      policy: args.projectionPolicy,
      publicConversationId: args.routeInstanceId,
    });
    if (
      args.request.method === "GET" &&
      intelligenceStreamReadMode(args.request) === "history" &&
      internalResponse.ok
    ) {
      const hasEarlier = internalResponse.headers.get(internalFlueHistoryPageHeaders.hasEarlier);
      if (hasEarlier !== null) {
        if (hasEarlier !== "true" && hasEarlier !== "false") {
          throw new Error("The native intelligence history page metadata is invalid.");
        }
        const headers = new Headers(projected.headers);
        headers.set(intelligenceHistoryPageHeaders.hasEarlier, hasEarlier);
        if (hasEarlier === "true") {
          const earliest = internalResponse.headers.get(
            internalFlueHistoryPageHeaders.earliestMessageKey,
          );
          if (earliest === null) {
            throw new Error("The native intelligence history page cursor is missing.");
          }
          headers.set(
            intelligenceHistoryPageHeaders.before,
            await createIntelligenceHistoryCursor({
              instanceId: args.routeInstanceId,
              messageKey: earliest,
              secret: args.environment.INTELLIGENCE_STREAM_SECRET,
            }),
          );
        }
        return withCors(
          new Response(projected.body, {
            status: projected.status,
            statusText: projected.statusText,
            headers,
          }),
          allowedOrigin,
        );
      }
    }
    return withCors(projected, allowedOrigin);
  } catch {
    if (args.request.signal.aborted)
      return withCors(new Response(null, { status: 499 }), allowedOrigin);
    return withCors(
      Response.json(
        { error: "stream_unavailable" },
        {
          status: 502,
          headers: { "retry-after": "1" },
        },
      ),
      allowedOrigin,
    );
  }
}

export const streamRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

for (const path of [
  "/v1/operations-copilot/conversations/:instanceId",
  "/v1/operations-brief-runs/:instanceId",
  "/v1/operations-autonomy-runs/:runId",
]) {
  streamRoutes.options(path, (context) => {
    const allowedOrigin = exactOpsOrigin(context.env.OPS_ORIGIN);
    if (context.req.header("origin") !== allowedOrigin) {
      return context.json({ error: "forbidden_origin" }, 403, { vary: "Origin" });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(allowedOrigin),
        "access-control-allow-headers": ticketHeaderNames,
        "access-control-allow-methods": "GET, HEAD",
        "access-control-max-age": "300",
      },
    });
  });
}

streamRoutes.all("/v1/operations-copilot/conversations/:instanceId", (context) =>
  readAgentStream({
    request: context.req.raw,
    environment: context.env,
    routeInstanceId: context.req.param("instanceId"),
    agentName: "operations-copilot",
    signatureContext: operationsCopilotStreamTicketSignatureContext,
    router: copilotRouter,
    projectionPolicy: "copilot",
  }),
);

streamRoutes.all("/v1/operations-brief-runs/:instanceId", (context) =>
  readAgentStream({
    request: context.req.raw,
    environment: context.env,
    routeInstanceId: context.req.param("instanceId"),
    agentName: "operations-brief",
    signatureContext: operationsBriefStreamTicketSignatureContext,
    router: briefRouter,
    projectionPolicy: "brief",
  }),
);

streamRoutes.all("/v1/operations-autonomy-runs/:runId", (context) =>
  readAgentStream({
    request: context.req.raw,
    environment: context.env,
    routeInstanceId: context.req.param("runId"),
    agentName: "operations-autopilot",
    signatureContext: operationsAutonomyStreamTicketSignatureContext,
    router: autopilotRouter,
    projectionPolicy: "autopilot",
  }),
);
