"use agent";
import { defineTool, useInitialData, useModel, useTool } from "@flue/runtime";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import {
  shortlistCallbackContext,
  shortlistProfileSchema,
  shortlistTaskSchema,
  shortlistVersion,
  signServiceBody,
} from "@code2create/domain";
import {
  analyzeShortlistTask,
  embedShortlistProfile,
} from "../lib/shortlistModel.ts";
import { serviceUrl } from "../lib/serviceUrl.ts";
import { requireStrongServiceSecret } from "../lib/serviceSecret.ts";

export const shortlistDispatchSchema = v.strictObject({
  version: v.literal(shortlistVersion),
  jobId: v.string(),
  runId: v.string(),
  attempt: v.number(),
  modelId: v.string(),
  inputJson: v.pipe(v.string(), v.maxLength(180_000)),
});
export function AdmissionShortlist() {
  const input = useInitialData<v.InferOutput<typeof shortlistDispatchSchema>>();
  useModel(`openai/${input.modelId}`, {
    thinkingLevel: "minimal",
    compaction: false,
  });
  useTool(
    defineTool({
      name: "analyze_shortlist_task",
      description:
        "Analyze and publish this frozen shortlist task. No admission decisions are changed.",
      input: v.strictObject({}),
      output: v.strictObject({ completed: v.literal(true) }),
      durable: true,
      async run({ step }) {
        const task = shortlistTaskSchema.parse(JSON.parse(input.inputJson));
        const result = await step.do("analyze", () =>
          analyzeShortlistTask({
            task,
            modelId: input.modelId,
            apiKey: env.OPENAI_API_KEY,
          }),
        );
        const embedding =
          task.kind === "profile"
            ? await step.do("embed", () => {
                const p = shortlistProfileSchema.parse(result);
                return embedShortlistProfile(
                  [
                    p.user,
                    p.problem,
                    p.workflow,
                    p.mechanism,
                    p.distinction,
                  ].join("\n"),
                  env.OPENAI_API_KEY,
                );
              })
            : [];
        await step.do("publish", async () => {
          const body = JSON.stringify({
            version: shortlistVersion,
            jobId: input.jobId,
            runId: input.runId,
            attempt: input.attempt,
            resultJson: JSON.stringify(result),
            embedding,
          });
          const timestamp = String(Date.now());
          const signature = await signServiceBody({
            context: shortlistCallbackContext,
            secret: requireStrongServiceSecret(
              env.INTELLIGENCE_CALLBACK_SECRET,
              "INTELLIGENCE_CALLBACK_SECRET",
            ),
            timestamp,
            body,
          });
          const url = serviceUrl(
            env.CONVEX_INTELLIGENCE_IDEA_CALLBACK_URL,
            "shortlist callback",
          );
          url.pathname = "/intelligence/admission-shortlist/callback";
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-c2c-timestamp": timestamp,
              "x-c2c-signature": signature,
            },
            body,
            signal: AbortSignal.timeout(20_000),
          });
          if (response.status !== 202)
            throw new Error(
              `Shortlist callback returned HTTP ${response.status}`,
            );
        });
        return { output: { completed: true as const }, terminate: true };
      },
    }),
  );
  return "Call analyze_shortlist_task exactly once. The trusted tool owns the frozen analysis and publication. Do not answer with prose or perform any other work.";
}
AdmissionShortlist.agentName = "admission-shortlist";
AdmissionShortlist.initialData = shortlistDispatchSchema;
AdmissionShortlist.durability = { timeoutMs: 6 * 60_000 };
