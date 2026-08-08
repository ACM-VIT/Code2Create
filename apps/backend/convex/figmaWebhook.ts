import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const providerId = z
  .union([z.string().min(1).max(128), z.number().int().positive()])
  .transform((value) => String(value));

const pingPayload = z.object({
  event_type: z.literal("PING"),
  passcode: z.string().min(1).max(100),
  timestamp: z.string().min(1).max(80),
  webhook_id: providerId,
});

const fileUpdatePayload = z.object({
  event_type: z.literal("FILE_UPDATE"),
  passcode: z.string().min(1).max(100),
  timestamp: z.string().min(1).max(80),
  webhook_id: providerId,
  file_key: z.string().min(1).max(256),
});

const webhookPayload = z.discriminatedUnion("event_type", [pingPayload, fileUpdatePayload]);

async function digest(value: ArrayBuffer | string) {
  const input =
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function providerTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const figmaWebhook = httpAction(async (ctx, request) => {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
    return new Response("Payload too large.", { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > 1_000_000) return new Response("Payload too large.", { status: 413 });
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const parsed = webhookPayload.safeParse(parsedJson);
  if (!parsed.success) return new Response("Unsupported webhook payload.", { status: 400 });
  const providerAt = providerTime(parsed.data.timestamp);
  if (providerAt === null) return new Response("Invalid webhook timestamp.", { status: 400 });
  const result: { duplicate: boolean; accepted: boolean } = await ctx.runMutation(
    internal.figmaIntegrations.acceptWebhook,
    {
      deliveryKey: await digest(body),
      webhookId: parsed.data.webhook_id,
      passcodeDigest: await digest(parsed.data.passcode),
      eventType: parsed.data.event_type,
      ...(parsed.data.event_type === "FILE_UPDATE"
        ? { fileKey: parsed.data.file_key }
        : {}),
      providerAt,
    },
  );
  if (!result.accepted) {
    return new Response("Invalid webhook passcode or binding.", { status: 400 });
  }
  return Response.json({ accepted: true, duplicate: result.duplicate });
});
