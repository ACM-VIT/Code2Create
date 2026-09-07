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
    },
    );
    if (!claim) return null;

    const data = reviewerPagePushData({
      pageId: claim.pageId,
      roundName: claim.roundName,
      expiresAt: claim.expiresAt,
    });
    const outcome = await sendReviewerPush({
      ...claim,
      title: "Substitute request",
      body: data.body,
      collapseKey: `reviewer-page-${claim.pageId}`,
      data,
    });
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

export async function sendReviewerPush(claim: PushClaim): Promise<PushOutcome> {
  return claim.provider === "fcm"
    ? sendFcmNotification(claim)
    : sendApnsNotification(claim);
}

async function sendFcmNotification(claim: PushClaim): Promise<PushOutcome> {
  try {
    const app = firebaseApp();
    const ttl = Math.max(1_000, claim.expiresAt - Date.now());
    // Data-only FCM reaches PagerMessagingService for full-screen handling.
    const messageId = await getMessaging(app).send({
      token: claim.token,
      ...(claim.data.kind === "reviewer_substitute_page"
        ? {}
        : { notification: { title: claim.title, body: claim.body } }),
      data: claim.data,
      android: {
        priority: "high",
        ttl,
        collapseKey: claim.collapseKey,
        ...(claim.notificationChannel
          ? { notification: { channelId: claim.notificationChannel, sound: "default" } }
          : {}),
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
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replaceAll("\\n", "\n",
    ).trim(),
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
    collapseId: claim.collapseKey,
    payload: {
      aps: {
        alert: { title: claim.title, body: claim.body },
        "interruption-level": "time-sensitive",
        "relevance-score": 1,
        sound: "default",
        "thread-id": claim.notificationChannel ?? "reviewer-pages",
      },
      ...claim.data,
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
      new Set(["TooManyRequests", "InternalServerError", "ServiceUnavailable", "Shutdown",
      ]).has(reason);
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
      finish(() => resolvePromise({ status, body, ...(apnsId ? { apnsId } : {}) }),
      );
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
  title: string;
  body: string;
  collapseKey: string;
  notificationChannel?: string;
  data: Record<string, string>;
  token: string;
  provider: "fcm" | "apns";
  environment: "development" | "production";
  expiresAt: number;
};

type NativeAlertAps = {
  alert: { title: string; body: string };
  sound: string;
  "thread-id": string;
  "interruption-level": "time-sensitive";
  "relevance-score"?: number;
};
type NativeAlertPayload = { aps: NativeAlertAps } & Record<
  string,
  string | number | NativeAlertAps
>;

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
