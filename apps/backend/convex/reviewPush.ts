"use node";

import { randomUUID } from "node:crypto";
import { connect } from "node:http2";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FirebaseMessagingError, getMessaging } from "firebase-admin/messaging";
import { importPKCS8, SignJWT } from "jose";
import { v } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { reviewerPagePushData } from "./lib/reviewerPagePush";

const firebaseAppName = "code2create-reviewer-push";

const firebaseCredentialsSchema = z.object({
  projectId: z.string().min(1).max(128),
  clientEmail: z.email(),
  privateKey: z.string().includes("BEGIN PRIVATE KEY").includes("END PRIVATE KEY"),
});

const apnsCredentialsSchema = z.object({
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  bundleId: z.string().regex(/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/),
  privateKey: z.string().includes("BEGIN PRIVATE KEY").includes("END PRIVATE KEY"),
});

const apnsErrorSchema = z.object({
  reason: z.string().min(1).max(128),
  timestamp: z.number().optional(),
});

export const deliverPage = internalAction({
  args: { deliveryId: v.id("reviewerPushDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = randomUUID();
    const claim = await ctx.runMutation(internal.reviewPushState.claimDelivery, {
      deliveryId: args.deliveryId,
      attemptId,
    });
    if (!claim) return null;

    const outcome =
      claim.provider === "fcm"
        ? await sendFcmNotification(claim)
        : await sendApnsNotification(claim);
    if (outcome.ok) {
      await ctx.runMutation(internal.reviewPushState.recordProviderAcceptance, {
        deliveryId: args.deliveryId,
        attemptId,
        providerMessageId: outcome.messageId,
      });
      return null;
    }

    await ctx.runMutation(internal.reviewPushState.recordSendFailure, {
      deliveryId: args.deliveryId,
      attemptId,
      errorCode: outcome.errorCode,
      retryable: outcome.retryable,
      invalidateToken: outcome.invalidateToken,
    });
    return null;
  },
});

async function sendFcmNotification(claim: PushClaim): Promise<PushOutcome> {
  try {
    const app = firebaseApp();
    const ttl = Math.max(1_000, claim.expiresAt - Date.now());
    // Data-only FCM reaches PagerMessagingService for full-screen handling.
    const messageId = await getMessaging(app).send({
      token: claim.token,
      data: reviewerPagePushData({
        pageId: claim.pageId,
        roundName: claim.roundName,
        expiresAt: claim.expiresAt,
      }),
      android: {
        priority: "high",
        ttl,
        collapseKey: `reviewer-page-${claim.pageId}`,
      },
    });
    return { ok: true, messageId };
  } catch (error) {
    if (error instanceof FirebaseMessagingError) return fcmFailure(error.code);
    return {
      ok: false,
      errorCode: "fcm_request_failed",
      retryable: true,
      invalidateToken: false,
    };
  }
}

function firebaseApp() {
  const existing = getApps().find((app) => app.name === firebaseAppName);
  if (existing) return existing;
  const credentials = firebaseCredentialsSchema.parse({
    projectId: process.env.FIREBASE_PROJECT_ID?.trim(),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL?.trim(),
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replaceAll("\\n", "\n").trim(),
  });
  return initializeApp({ credential: cert(credentials) }, firebaseAppName);
}

function fcmFailure(code: string): PushFailure {
  const invalidateToken =
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token";
  const retryable = new Set([
    "messaging/internal-error",
    "messaging/server-unavailable",
    "messaging/unknown-error",
    "messaging/quota-exceeded",
    "messaging/message-rate-exceeded",
    "messaging/device-message-rate-exceeded",
  ]).has(code);
  return {
    ok: false,
    errorCode: normalizedProviderCode(code),
    retryable,
    invalidateToken,
  };
}

async function sendApnsNotification(claim: PushClaim): Promise<PushOutcome> {
  return sendApnsAlert({
    ...claim,
    collapseId: `reviewer-${claim.pageId}`,
    payload: {
      aps: {
        alert: {
          title: "Substitute request",
          body: reviewerPagePushData(claim).body,
        },
        "interruption-level": "time-sensitive",
        "relevance-score": 1,
        sound: "default",
        "thread-id": "reviewer-pages",
      },
      kind: "reviewer_substitute_page",
      pageId: claim.pageId,
      expiresAt: claim.expiresAt,
    },
  });
}

async function sendApnsAlert(claim: {
  token: string;
  environment: "development" | "production";
  expiresAt: number;
  collapseId: string;
  payload: NativeAlertPayload;
}): Promise<PushOutcome> {
  let credentials: z.infer<typeof apnsCredentialsSchema>;
  try {
    credentials = apnsCredentialsSchema.parse({
      keyId: process.env.APNS_KEY_ID?.trim().toUpperCase(),
      teamId: process.env.APNS_TEAM_ID?.trim().toUpperCase(),
      bundleId: process.env.APNS_BUNDLE_ID?.trim(),
      privateKey: process.env.APNS_PRIVATE_KEY?.replaceAll("\\n", "\n").trim(),
    });
  } catch {
    return {
      ok: false,
      errorCode: "apns_credentials_invalid",
      retryable: false,
      invalidateToken: false,
    };
  }

  try {
    const signingKey = await importPKCS8(credentials.privateKey, "ES256");
    const providerToken = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
      .setIssuer(credentials.teamId)
      .setIssuedAt()
      .sign(signingKey);
    const requestId = randomUUID();
    const origin =
      claim.environment === "development"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
    const response = await apnsRequest({
      origin,
      path: `/3/device/${claim.token}`,
      headers: {
        authorization: `bearer ${providerToken}`,
        "apns-id": requestId,
        "apns-expiration": String(Math.floor(claim.expiresAt / 1_000)),
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-topic": credentials.bundleId,
        "apns-collapse-id": claim.collapseId.slice(0, 64),
      },
      body: JSON.stringify(claim.payload),
    });
    if (response.status === 200) {
      return { ok: true, messageId: response.apnsId ?? requestId };
    }

    const parsedError = apnsErrorSchema.safeParse(parseJson(response.body));
    const reason = parsedError.success ? parsedError.data.reason : "UnknownError";
    const invalidateToken = new Set([
      "BadDeviceToken",
      "DeviceTokenNotForTopic",
      "Unregistered",
    ]).has(reason);
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      new Set(["TooManyRequests", "InternalServerError", "ServiceUnavailable", "Shutdown"]).has(
        reason,
      );
    return {
      ok: false,
      errorCode: normalizedProviderCode(`apns_${response.status}_${reason}`),
      retryable,
      invalidateToken,
    };
  } catch {
    return {
      ok: false,
      errorCode: "apns_request_failed",
      retryable: true,
      invalidateToken: false,
    };
  }
}

async function apnsRequest(args: {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}) {
  return new Promise<ApnsResponse>((resolvePromise, rejectPromise) => {
    const session = connect(args.origin);
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      session.close();
      operation();
    };
    session.once("error", (error) => finish(() => rejectPromise(error)));

    const stream = session.request({
      ":method": "POST",
      ":path": args.path,
      "content-type": "application/json",
      ...args.headers,
    });
    let status = 0;
    let apnsId: string | undefined;
    const chunks: Buffer[] = [];
    stream.setEncoding("utf8");
    stream.setTimeout(10_000, () => {
      stream.close();
      finish(() => rejectPromise(new Error("APNs request timed out.")));
    });
    stream.on("response", (headers) => {
      const responseStatus = headers[":status"];
      status = typeof responseStatus === "number" ? responseStatus : 0;
      const responseId = headers["apns-id"];
      apnsId = typeof responseId === "string" ? responseId : undefined;
    });
    stream.on("data", (chunk: string) => chunks.push(Buffer.from(chunk)));
    stream.once("error", (error) => finish(() => rejectPromise(error)));
    stream.once("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      finish(() => resolvePromise({ status, body, ...(apnsId ? { apnsId } : {}) }));
    });
    stream.end(args.body);
  });
}

function parseJson(body: string): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function normalizedProviderCode(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

type PushClaim = {
  pageId: string;
  token: string;
  provider: "fcm" | "apns";
  environment: "development" | "production";
  roundName: string;
  expiresAt: number;
};

type NativeAlertPayload = {
  aps: {
    alert: { title: string; body: string };
    sound: string;
    "thread-id": string;
    "interruption-level": "time-sensitive";
    "relevance-score"?: number;
  };
  kind: "reviewer_substitute_page" | "reviewer_venue_absence";
  expiresAt: number;
  pageId?: string;
  departureId?: string;
  url?: string;
};

export const deliverVenueReminder = internalAction({
  args: { departureId: v.id("reviewerVenueDepartures") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = randomUUID();
    const claim = await ctx.runMutation(
      internal.reviewerVenueEscalation.claimNotification,
      { ...args, attemptId },
    );
    if (!claim) return null;
    let outcome: PushOutcome;
    try {
      if (claim.provider === "fcm") {
        const messageId = await getMessaging(firebaseApp()).send({
          token: claim.token,
          notification: { title: claim.title, body: claim.body },
          data: {
            kind: "reviewer_venue_absence",
            departureId: args.departureId,
            url: "/venue",
            expiresAt: String(claim.expiresAt),
          },
          android: {
            priority: "high",
            ttl: Math.max(1_000, claim.expiresAt - Date.now()),
            collapseKey: `venue-${args.departureId}`,
            notification: { channelId: "reviewer-venue", sound: "default" },
          },
        });
        outcome = { ok: true, messageId };
      } else {
        outcome = await sendApnsAlert({
          ...claim,
          collapseId: `venue-${args.departureId}`,
          payload: {
            aps: {
              alert: { title: claim.title, body: claim.body },
              sound: "default",
              "thread-id": "reviewer-venue",
              "interruption-level": "time-sensitive",
            },
            kind: "reviewer_venue_absence",
            departureId: args.departureId,
            url: "/venue",
            expiresAt: claim.expiresAt,
          },
        });
      }
    } catch {
      outcome = {
        ok: false,
        errorCode: "venue_push_failed",
        retryable: true,
        invalidateToken: false,
      };
    }
    await ctx.runMutation(internal.reviewerVenueEscalation.recordNotification, {
      ...args,
      attemptId,
      sent: outcome.ok,
      ...(!outcome.ok ? { errorCode: outcome.errorCode } : {}),
    });
    return null;
  },
});

type PushOutcome = { ok: true; messageId: string } | PushFailure;

type PushFailure = {
  ok: false;
  errorCode: string;
  retryable: boolean;
  invalidateToken: boolean;
};

type ApnsResponse = {
  status: number;
  body: string;
  apnsId?: string;
};
