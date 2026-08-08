import { httpRouter } from "convex/server";

import { authComponent, createAuth } from "./auth";
import { figmaWebhook } from "./figmaWebhook";
import { githubWebhook } from "./githubWebhook";
import { operationsIntelligenceWebhook } from "./operationsIntelligenceWebhook";
import { participantEmailEvent } from "./participantEmailEvent";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });
http.route({
  path: "/integrations/github/webhook",
  method: "POST",
  handler: githubWebhook,
});
http.route({
  path: "/integrations/figma/webhook",
  method: "POST",
  handler: figmaWebhook,
});
http.route({
  path: "/communications/cloudflare-email/events",
  method: "POST",
  handler: participantEmailEvent,
});
http.route({
  path: "/intelligence/operations-briefs/callback",
  method: "POST",
  handler: operationsIntelligenceWebhook,
});

export default http;
