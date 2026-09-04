import aggregate from "@convex-dev/aggregate/convex.config.js";
import agent from "@convex-dev/agent/convex.config.js";
import betterAuth from "@convex-dev/better-auth/convex.config";
import presence from "@convex-dev/presence/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    DISCORD_SUPPORT_ACTOR_EMAIL: v.optional(v.string()),
    DISCORD_SUPPORT_BRIDGE_SECRET: v.optional(v.string()),
  },
});

app.use(betterAuth);
app.use(agent);
app.use(aggregate, { name: "reviewQueue" });
app.use(aggregate, { name: "synesthesiaVotes" });
app.use(workpool, { name: "admissionWorkpool" });
app.use(workpool, { name: "integrationWorkpool" });
app.use(workpool, { name: "exportWorkpool" });
app.use(workpool, { name: "intelligenceWorkpool" });
app.use(presence, { name: "intakePresence" });
app.use(rateLimiter, { name: "noveltyRateLimiter" });
app.use(rateLimiter, { name: "participantAssistantRateLimiter" });

export default app;
