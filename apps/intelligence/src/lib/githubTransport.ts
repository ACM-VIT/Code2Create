import {
  githubSyncCallbackContext,
  githubWebhookCallbackContext,
  signServiceBody,
  type GithubRepositorySyncCallback,
  type GithubRepositorySyncReceipt,
  type GithubWebhookCallback,
  type GithubWebhookReceipt,
} from "@code2create/domain";
import * as v from "valibot";

import { readBoundedJsonResponse } from "./boundedHttpBody.ts";
import { requireStrongServiceSecret } from "./serviceSecret.ts";
import { serviceUrl } from "./serviceUrl.ts";

type CallbackBindings = Pick<
  Cloudflare.Env,
  "CONVEX_INTELLIGENCE_CALLBACK_URL" | "INTELLIGENCE_CALLBACK_SECRET"
>;

const syncReceipt = v.strictObject({
  state: v.picklist(["accepted", "already_settled", "stale"]),
});
const webhookReceipt = v.strictObject({
  state: v.picklist(["accepted", "ignored", "duplicate"]),
});

async function deliver(
  path: string,
  context: string,
  payload: unknown,
  bindings: CallbackBindings,
  request: typeof fetch,
) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context,
    secret: requireStrongServiceSecret(
      bindings.INTELLIGENCE_CALLBACK_SECRET,
      "INTELLIGENCE_CALLBACK_SECRET",
    ),
    timestamp,
    body,
  });
  const response = await request(
    new URL(
      path,
      serviceUrl(bindings.CONVEX_INTELLIGENCE_CALLBACK_URL, "Convex intelligence callback"),
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-timestamp": timestamp,
        "x-c2c-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    },
  );
  return { status: response.status, value: await readBoundedJsonResponse(response, 8_192) };
}

/** Settles one repository reconciliation; Convex applies it at most once per revision. */
export async function publishRepositorySync(
  payload: GithubRepositorySyncCallback,
  bindings: CallbackBindings,
  request: typeof fetch = fetch,
): Promise<GithubRepositorySyncReceipt> {
  const delivered = await deliver(
    "/intelligence/github/repository-syncs",
    githubSyncCallbackContext,
    payload,
    bindings,
    request,
  );
  const receipt = v.safeParse(syncReceipt, delivered.value);
  if (delivered.status !== 202 || !receipt.success) {
    throw new Error("The repository sync callback was rejected.");
  }
  return receipt.output;
}

/** Forwards one verified provider delivery; Convex deduplicates by delivery identifier. */
export async function forwardGithubWebhook(
  payload: GithubWebhookCallback,
  bindings: CallbackBindings,
  request: typeof fetch = fetch,
): Promise<GithubWebhookReceipt> {
  const delivered = await deliver(
    "/intelligence/github/webhooks",
    githubWebhookCallbackContext,
    payload,
    bindings,
    request,
  );
  const receipt = v.safeParse(webhookReceipt, delivered.value);
  if (delivered.status !== 202 || !receipt.success) {
    throw new Error("The GitHub webhook callback was rejected.");
  }
  return receipt.output;
}
