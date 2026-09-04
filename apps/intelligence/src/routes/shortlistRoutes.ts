import { AgentInstanceExistsError, dispatch } from "@flue/runtime";
import { Hono } from "hono";
import * as v from "valibot";
import {
  shortlistIngressContext,
  shortlistTaskSchema,
  verifyServiceBody,
} from "@code2create/domain";
import {
  AdmissionShortlist,
  shortlistDispatchSchema,
} from "../agents/admission-shortlist.ts";
import { readBoundedRequestText } from "../lib/boundedHttpBody.ts";
import { requireStrongServiceSecret } from "../lib/serviceSecret.ts";
import { settleWithin } from "../lib/deadline.ts";

export const shortlistRoutes = new Hono<{ Bindings: Cloudflare.Env }>();
shortlistRoutes.post("/v1/admission-shortlist", async (c) => {
  if (c.req.header("content-type")?.split(";")[0] !== "application/json")
    return c.json({ error: "unsupported_media_type" }, 415);
  let body: string;
  try {
    body = await readBoundedRequestText(c.req.raw, 200 * 1024);
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  if (
    !(await verifyServiceBody({
      context: shortlistIngressContext,
      secret: requireStrongServiceSecret(
        c.env.INTELLIGENCE_INGRESS_SECRET,
        "INTELLIGENCE_INGRESS_SECRET",
      ),
      timestamp: c.req.header("x-c2c-timestamp") ?? "",
      signature: c.req.header("x-c2c-signature") ?? "",
      body,
      now: Date.now(),
      maximumAgeMs: 5 * 60_000,
    }))
  )
    return c.json({ error: "unauthorized" }, 401);
  let parsed: v.InferOutput<typeof shortlistDispatchSchema>;
  try {
    parsed = v.parse(shortlistDispatchSchema, JSON.parse(body));
    shortlistTaskSchema.parse(JSON.parse(parsed.inputJson));
  } catch {
    return c.json({ error: "invalid_task" }, 422);
  }
  try {
    await settleWithin(
      dispatch(AdmissionShortlist, {
        id: `${parsed.jobId}:${parsed.attempt}`,
        uid: null,
        initialData: parsed,
        message: {
          kind: "signal",
          type: "shortlist.task",
          body: "Analyze the frozen shortlist task.",
        },
      }),
      10_000,
    );
  } catch (error) {
    if (!(error instanceof AgentInstanceExistsError)) throw error;
  }
  return c.json({ state: "accepted" }, 202);
});
