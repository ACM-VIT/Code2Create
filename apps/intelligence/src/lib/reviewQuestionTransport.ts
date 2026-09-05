import {
  reviewQuestionCallbackContext,
  signServiceBody,
  type ReviewQuestionCallback,
} from "@code2create/domain";
import { requireStrongServiceSecret } from "./serviceSecret.ts";
import { serviceUrl } from "./serviceUrl.ts";
import { readBoundedJsonResponse } from "./boundedHttpBody.ts";
import * as v from "valibot";

const receipt = v.strictObject({
  state: v.picklist(["accepted", "already_settled", "stale"]),
});
export async function publishReviewQuestions(
  payload: ReviewQuestionCallback,
  bindings: Pick<
    Cloudflare.Env,
    "CONVEX_INTELLIGENCE_CALLBACK_URL" | "INTELLIGENCE_CALLBACK_SECRET"
  >,
  request: typeof fetch = fetch,
) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: reviewQuestionCallbackContext,
    secret: requireStrongServiceSecret(
      bindings.INTELLIGENCE_CALLBACK_SECRET,
      "INTELLIGENCE_CALLBACK_SECRET",
    ),
    timestamp,
    body,
  });
  const response = await request(
    new URL(
      "/intelligence/review-questions",
      serviceUrl(
        bindings.CONVEX_INTELLIGENCE_CALLBACK_URL,
        "Convex intelligence callback",
      ),
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-timestamp": timestamp,
        "x-c2c-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(20000),
    },
  );
  if (
    response.status !== 202 ||
    !v.safeParse(receipt, await readBoundedJsonResponse(response, 8192)).success
  )
    throw new Error("Review question callback was rejected.");
  return { delivered: true } as const;
}
