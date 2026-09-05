import { instrument } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { createAutonomyInstrumentation } from "./lib/autonomyInstrumentation.ts";
import {
  captureIntelligenceFailure,
  captureIntelligenceRequest,
  installPostHogIntelligenceObservability,
  postHogIntelligenceObservabilityConfigured,
} from "./lib/posthogObservability.ts";
import { autonomyRoutes } from "./routes/autonomyRoutes.ts";
import { reviewQuestionRoutes } from "./routes/reviewQuestionRoutes.ts";
import { briefRoutes } from "./routes/briefRoutes.ts";
import { copilotRoutes } from "./routes/copilotRoutes.ts";
import { episodeRoutes } from "./routes/episodeRoutes.ts";
import { healthRoutes } from "./routes/healthRoutes.ts";
import { ideaRoutes } from "./routes/ideaRoutes.ts";
import { streamRoutes } from "./routes/streamRoutes.ts";

instrument(createCloudflareTracing({ content: false }));
instrument(createAutonomyInstrumentation(env));
installPostHogIntelligenceObservability(env);

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.use("*", async (context, next) => {
  const startedAt = Date.now();
  await next();
  if (postHogIntelligenceObservabilityConfigured(context.env)) {
    context.executionCtx.waitUntil(
      captureIntelligenceRequest(context.env, {
        method: context.req.method,
        route: new URL(context.req.url).pathname,
        status: context.res.status,
        durationMs: Date.now() - startedAt,
      }),
    );
  }
});

app.route("/", healthRoutes);
app.route("/", streamRoutes);
app.route("/", autonomyRoutes);
app.route("/", briefRoutes);
app.route("/", reviewQuestionRoutes);
app.route("/", copilotRoutes);
app.route("/", episodeRoutes);
app.route("/", ideaRoutes);

app.onError((_error, context) => {
  if (postHogIntelligenceObservabilityConfigured(context.env)) {
    context.executionCtx.waitUntil(captureIntelligenceFailure(context.env, "unhandled_request"),
    );
  }
  return new Response(JSON.stringify({ error: "internal_error" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
});

export default app;
