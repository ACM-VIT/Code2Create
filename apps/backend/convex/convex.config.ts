import aggregate from "@convex-dev/aggregate/convex.config.js";
import betterAuth from "@convex-dev/better-auth/convex.config";
import presence from "@convex-dev/presence/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();

app.use(betterAuth);
app.use(aggregate, { name: "reviewQueue" });
app.use(aggregate, { name: "synesthesiaVotes" });
app.use(workpool, { name: "intakeWorkpool" });
app.use(workpool, { name: "admissionWorkpool" });
app.use(workpool, { name: "integrationWorkpool" });
app.use(workpool, { name: "exportWorkpool" });
app.use(workpool, { name: "intelligenceWorkpool" });
app.use(presence, { name: "intakePresence" });

export default app;
