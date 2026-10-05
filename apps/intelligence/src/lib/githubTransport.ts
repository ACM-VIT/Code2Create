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

export type GithubCallbackFailure = "timeout" | "unreachable" | "rejected" | "invalid_receipt";

/** A Convex callback that did not settle; configuration faults are thrown as plain errors. */
export class GithubCallbackError extends Error {
  constructor(
    readonly reason: GithubCallbackFailure,
    readonly upstreamStatus?: number,
  ) {
    super(`The Convex GitHub callback failed: ${reason}.`);
    this.name = "GithubCallbackError";
  }
}

function timedOut(error: unknown) {
  return error instanceof DOMException && error.name === "TimeoutError";
}

async function deliver(
  path: string,
  context: string,
  payload: unknown,
  bindings: CallbackBindings,
  request: typeof fetch,
  timeoutMs: number,
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
  const url = new URL(
    path,
    serviceUrl(bindings.CONVEX_INTELLIGENCE_CALLBACK_URL, "Convex intelligence callback"),
  );
  let response: Response;
  try {
    response = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-timestamp": timestamp,
        "x-c2c-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new GithubCallbackError(timedOut(error) ? "timeout" : "unreachable");
  }
  if (response.status !== 202) {
    await response.body?.cancel();
    throw new GithubCallbackError("rejected", response.status);
  }
  try {
    return await readBoundedJsonResponse(response, 8_192);
  } catch (error) {
    throw new GithubCallbackError(timedOut(error) ? "timeout" : "invalid_receipt", 202);
  }
}

/** Settles one repository reconciliation; Convex applies it at most once per revision. */
export async function publishRepositorySync(
  payload: GithubRepositorySyncCallback,
  bindings: CallbackBindings,
  request: typeof fetch = fetch,
): Promise<GithubRepositorySyncReceipt> {
  const value = await deliver(
    "/intelligence/github/repository-syncs",
    githubSyncCallbackContext,
    payload,
    bindings,
    request,
    20_000,
  );
  const receipt = v.safeParse(syncReceipt, value);
  if (!receipt.success) throw new GithubCallbackError("invalid_receipt", 202);
  return receipt.output;
}

/** Forwards one verified provider delivery; Convex deduplicates by delivery identifier. */
export async function forwardGithubWebhook(
  payload: GithubWebhookCallback,
  bindings: CallbackBindings,
  request: typeof fetch = fetch,
): Promise<GithubWebhookReceipt> {
  const value = await deliver(
    "/intelligence/github/webhooks",
    githubWebhookCallbackContext,
    payload,
    bindings,
    request,
    // GitHub abandons a delivery after ten seconds; fail fast so it can redeliver.
    8_000,
  );
  const receipt = v.safeParse(webhookReceipt, value);
  if (!receipt.success) throw new GithubCallbackError("invalid_receipt", 202);
  return receipt.output;
}
