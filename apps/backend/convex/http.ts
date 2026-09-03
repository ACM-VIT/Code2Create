import { httpRouter } from "convex/server";

import { admissionIntelligenceReadEndpoint } from "./admissionCohort";
import {
  ideaIntelligenceCallbackEndpoint,
  ideaIntelligenceReadEndpoint,
} from "./admissionAgentHttp";
import { authComponent, createAuth } from "./auth";
import {
  importBundleEndpoint,
  importBundleOptions,
} from "./communicationsEmailAssetActions";
import { figmaWebhook } from "./figmaWebhook";
import { githubWebhook } from "./githubWebhook";
import { intelligenceReadEndpoint } from "./intelligenceReads";
import { intelligenceRecommendationWebhook } from "./intelligenceRecommendations";
import { operationsIntelligenceWebhook } from "./operationsIntelligenceWebhook";
import {
  operationsEpisodeCallbackEndpoint,
  operationsEpisodeReadEndpoint,
} from "./operationsEpisodeHttp";
import { outboundCallEvent } from "./outboundCallEvent";
import {
  autonomyCallbackEndpoint,
  autonomyReadEndpoint,
  autonomyRecommendationEndpoint,
  autonomyRecommendationEvidenceEndpoint,
  autonomyWorkEndpoint,
} from "./operationsAutonomyHttp";
import { participantEmailEvent } from "./participantEmailEvent";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });
http.route({
  path: "/configuration/communications/email-template",
  method: "POST",
  handler: importBundleEndpoint,
});
http.route({
  path: "/configuration/communications/email-template",
  method: "OPTIONS",
  handler: importBundleOptions,
});
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
  path: "/communications/outbound-call/events",
  method: "POST",
  handler: outboundCallEvent,
});
http.route({
  path: "/intelligence/operations-briefs/callback",
  method: "POST",
  handler: operationsIntelligenceWebhook,
});
http.route({
  path: "/intelligence/operations-episodes/read",
  method: "POST",
  handler: operationsEpisodeReadEndpoint,
});
http.route({
  path: "/intelligence/operations-episodes/callback",
  method: "POST",
  handler: operationsEpisodeCallbackEndpoint,
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
  path: "/intelligence/operations-autonomy/reads",
  method: "POST",
  handler: autonomyReadEndpoint,
});
http.route({
  path: "/intelligence/operations-autonomy/work",
  method: "POST",
  handler: autonomyWorkEndpoint,
});
http.route({
  path: "/intelligence/operations-autonomy/recommendation-evidence",
  method: "POST",
  handler: autonomyRecommendationEvidenceEndpoint,
});
http.route({
  path: "/intelligence/operations-autonomy/recommendations",
  method: "POST",
  handler: autonomyRecommendationEndpoint,
});
http.route({
  path: "/intelligence/operations-autonomy/callback",
  method: "POST",
  handler: autonomyCallbackEndpoint,
});
http.route({
  path: "/intelligence/admission-reads",
  method: "POST",
  handler: admissionIntelligenceReadEndpoint,
});
http.route({
  path: "/intelligence/idea-submissions/read",
  method: "POST",
  handler: ideaIntelligenceReadEndpoint,
});
http.route({
  path: "/intelligence/idea-submissions/callback",
  method: "POST",
  handler: ideaIntelligenceCallbackEndpoint,
});

export default http;
