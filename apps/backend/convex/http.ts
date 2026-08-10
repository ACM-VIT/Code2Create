import { httpRouter } from "convex/server";

import { admissionIntelligenceReadEndpoint } from "./admissionCohort";
import { authComponent, createAuth } from "./auth";
import { figmaWebhook } from "./figmaWebhook";
import { githubWebhook } from "./githubWebhook";
import { intelligenceReadEndpoint } from "./intelligenceReads";
import { intelligenceRecommendationWebhook } from "./intelligenceRecommendations";
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
http.route({
  path: "/intelligence/operations-reads",
  method: "POST",
  handler: intelligenceReadEndpoint,
});
http.route({
  path: "/intelligence/operations-recommendations",
  method: "POST",
  handler: intelligenceRecommendationWebhook,
});
http.route({
  path: "/intelligence/admission-reads",
  method: "POST",
  handler: admissionIntelligenceReadEndpoint,
});

export default http;
