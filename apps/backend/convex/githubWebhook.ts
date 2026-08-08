import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const installation = z.object({ id: z.number().int().positive() });
const repository = z.object({ id: z.number().int().positive() });
const pushPayload = z.object({
  installation,
  repository,
  ref: z.string().min(1).max(1_024),
  before: z.string().min(1).max(100),
  after: z.string().min(1).max(100),
  created: z.boolean(),
  deleted: z.boolean(),
  forced: z.boolean(),
  commits: z.array(z.object({ id: z.string().min(1).max(100) })).max(2_048),
  head_commit: z
    .object({ timestamp: z.string().min(1).max(80) })
    .nullable()
    .optional(),
});
const installationPayload = z.object({
  action: z.string().min(1).max(80),
  installation,
});
const installationRepositoriesPayload = z.object({
  action: z.string().min(1).max(80),
  installation,
  repositories_added: z.array(repository).max(500),
  repositories_removed: z.array(repository).max(500),
});
const pingPayload = z.object({ zen: z.string().optional() });

function hexBytes(value: string) {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function verifySignature(secret: string, body: ArrayBuffer, header: string) {
  if (!header.startsWith("sha256=")) return false;
  const received = hexBytes(header.slice("sha256=".length).toLowerCase());
  if (!received) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return equalBytes(received, expected);
}

async function payloadHash(body: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function providerTime(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const githubWebhook = httpAction(async (ctx, request) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) return new Response("GitHub webhook is not configured.", { status: 503 });
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
    return new Response("Payload too large.", { status: 413 });
  }
  const signature = request.headers.get("x-hub-signature-256");
  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  const eventName = request.headers.get("x-github-event")?.trim();
  if (!signature || !deliveryId || !eventName || deliveryId.length > 100 || eventName.length > 80) {
    return new Response("Required GitHub headers are missing.", { status: 400 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > 2_000_000) return new Response("Payload too large.", { status: 413 });
  if (!(await verifySignature(secret, body, signature))) {
    return new Response("Invalid signature.", { status: 401 });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }
  const hash = await payloadHash(body);
  try {
    if (eventName === "push") {
      const payload = pushPayload.parse(parsedJson);
      const timestamp = providerTime(payload.head_commit?.timestamp);
      await ctx.runMutation(internal.githubIntegrations.acceptWebhook, {
        deliveryId,
        eventName,
        payloadHash: hash,
        event: {
          kind: "push",
          installationId: String(payload.installation.id),
          repositoryId: String(payload.repository.id),
          ref: payload.ref,
          beforeSha: payload.before,
          afterSha: payload.after,
          created: payload.created,
          deleted: payload.deleted,
          forced: payload.forced,
          pushedCommitCount: payload.commits.length,
          ...(timestamp !== undefined ? { providerAt: timestamp } : {}),
        },
      });
    } else if (eventName === "installation") {
      const payload = installationPayload.parse(parsedJson);
      await ctx.runMutation(internal.githubIntegrations.acceptWebhook, {
        deliveryId,
        eventName,
        payloadHash: hash,
        event: {
          kind: "installation",
          installationId: String(payload.installation.id),
          action: payload.action,
        },
      });
    } else if (eventName === "installation_repositories") {
      const payload = installationRepositoriesPayload.parse(parsedJson);
      await ctx.runMutation(internal.githubIntegrations.acceptWebhook, {
        deliveryId,
        eventName,
        payloadHash: hash,
        event: {
          kind: "installation_repositories",
          installationId: String(payload.installation.id),
          action: payload.action,
          addedRepositoryIds: payload.repositories_added.map((item) => String(item.id)),
          removedRepositoryIds: payload.repositories_removed.map((item) => String(item.id)),
        },
      });
    } else if (eventName === "ping") {
      pingPayload.parse(parsedJson);
      await ctx.runMutation(internal.githubIntegrations.acceptWebhook, {
        deliveryId,
        eventName,
        payloadHash: hash,
        event: { kind: "ping" },
      });
    } else {
      return new Response(null, { status: 204 });
    }
  } catch (error) {
    if (error instanceof z.ZodError) return new Response("Invalid webhook payload.", { status: 400 });
    throw error;
  }
  return Response.json({ accepted: true }, { status: 202 });
});
