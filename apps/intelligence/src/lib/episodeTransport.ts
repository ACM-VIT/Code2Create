import {
  operationsEpisodeCallbackSignatureContext,
  operationsEpisodeReadSignatureContext,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
  type OperationsEpisodeAnalysisCallback,
} from "@code2create/domain";
import * as v from "valibot";

import {
  operationsEpisodeProjectionSchema,
  type OperationsEpisodeAnalysis,
  type OperationsEpisodeProjection,
} from "./episodeProtocol.ts";
import { readBoundedJsonResponse } from "./boundedHttpBody.ts";
import { requireStrongServiceSecret } from "./serviceSecret.ts";
import { serviceUrl } from "./serviceUrl.ts";

type EpisodeReadBindings = Pick<
  Cloudflare.Env,
  "CONVEX_INTELLIGENCE_EPISODE_READ_URL" | "INTELLIGENCE_READ_SECRET"
>;

type EpisodeCallbackBindings = Pick<
  Cloudflare.Env,
  "CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL" | "INTELLIGENCE_CALLBACK_SECRET"
>;

export async function readEpisodeProjection(args: {
  episodeId: string;
  operationId: string;
  bindings: EpisodeReadBindings;
  request?: typeof fetch;
}): Promise<OperationsEpisodeProjection> {
  const body = JSON.stringify({
    protocolVersion: operationsIntelligenceProtocolVersion,
    episodeId: args.episodeId,
    operationId: args.operationId,
  });
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: operationsEpisodeReadSignatureContext,
    secret: requireStrongServiceSecret(
      args.bindings.INTELLIGENCE_READ_SECRET,
      "INTELLIGENCE_READ_SECRET",
    ),
    timestamp,
    body,
  });
  const response = await (args.request ?? fetch)(
    serviceUrl(args.bindings.CONVEX_INTELLIGENCE_EPISODE_READ_URL, "Convex episode read"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status !== 200) {
    throw new Error(`Convex refused the episode read with HTTP ${response.status}.`);
  }
  const parsed = v.safeParse(
    operationsEpisodeProjectionSchema,
    await readBoundedJsonResponse(response, 128 * 1_024),
  );
  if (!parsed.success || parsed.output.episodeId !== args.episodeId) {
    throw new Error("Convex returned an invalid episode projection.");
  }
  return parsed.output;
}

const callbackReceiptSchema = v.strictObject({
  state: v.picklist(["accepted", "already_exists"]),
});

export async function deliverEpisodeAnalysis(args: {
  projection: OperationsEpisodeProjection;
  analysis: OperationsEpisodeAnalysis;
  operationId: string;
  agentVersion: string;
  model: string;
  bindings: EpisodeCallbackBindings;
  request?: typeof fetch;
}) {
  const callback: OperationsEpisodeAnalysisCallback = {
    protocolVersion: operationsIntelligenceProtocolVersion,
    episodeId: args.projection.episodeId,
    revision: args.projection.revision,
    operationId: args.operationId,
    ...args.analysis,
    agentVersion: args.agentVersion,
    model: args.model,
    completedAt: Date.now(),
  };
  const body = JSON.stringify(callback);
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: operationsEpisodeCallbackSignatureContext,
    secret: requireStrongServiceSecret(
      args.bindings.INTELLIGENCE_CALLBACK_SECRET,
      "INTELLIGENCE_CALLBACK_SECRET",
    ),
    timestamp,
    body,
  });
  const response = await (args.request ?? fetch)(
    serviceUrl(args.bindings.CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL, "Convex episode callback"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status !== 202) {
    throw new Error(`Convex rejected the episode analysis with HTTP ${response.status}.`);
  }
  const receipt = v.safeParse(
    callbackReceiptSchema,
    await readBoundedJsonResponse(response, 8 * 1_024),
  );
  if (!receipt.success) throw new Error("Convex returned an invalid episode receipt.");
  return receipt.output;
}
