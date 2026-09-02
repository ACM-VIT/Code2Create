"use node";

import { randomInt } from "node:crypto";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";
import { readAwsSmsConfiguration, sendPhoneVerificationSms } from "./lib/awsSms";
import {
  phoneVerificationCodeDigest,
  phoneVerificationLifetimeMs,
  requirePhoneVerificationSecret,
} from "./lib/phoneVerification";

function deliveryFailureCode(error: unknown) {
  if (!(error instanceof Error)) return "provider_error";
  switch (error.name) {
    case "AccessDeniedException":
      return "provider_access_denied";
    case "ConflictException":
    case "ValidationException":
      return "provider_configuration_invalid";
    case "OptedOutException":
      return "phone_opted_out";
    case "ServiceQuotaExceededException":
      return "provider_quota_exceeded";
    case "ThrottlingException":
      return "provider_rate_limited";
    default:
      return "provider_unavailable";
  }
}

export const deliver = internalAction({
  args: { verificationId: v.id("participantPhoneVerifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      readAwsSmsConfiguration();
      const secret = requirePhoneVerificationSecret();
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const prepared = await ctx.runMutation(
        internal.phoneVerifications.prepareDelivery,
        {
          verificationId: args.verificationId,
          codeDigest: phoneVerificationCodeDigest({
            secret,
            verificationId: args.verificationId,
            phone: await verificationPhone(ctx, args.verificationId),
            code,
          }),
          expiresAt: Date.now() + phoneVerificationLifetimeMs,
        },
      );
      if (!prepared) return null;
      const providerMessageId = await sendPhoneVerificationSms({
        phone: prepared.phone,
        code,
      });
      await ctx.runMutation(internal.phoneVerifications.completeDelivery, {
        verificationId: args.verificationId,
        providerMessageId,
      });
    } catch (error) {
      await ctx.runMutation(internal.phoneVerifications.failDelivery, {
        verificationId: args.verificationId,
        failureCode: deliveryFailureCode(error),
      });
      console.error("Phone verification delivery failed", {
        verificationId: args.verificationId,
        failureCode: deliveryFailureCode(error),
      });
    }
    return null;
  },
});

async function verificationPhone(
  ctx: ActionCtx,
  verificationId: Id<"participantPhoneVerifications">,
) {
  const prepared = await ctx.runQuery(internal.phoneVerifications.readPhoneForDelivery, {
    verificationId,
  });
  if (!prepared) throw new Error("The phone verification request is no longer deliverable.");
  return prepared.phone;
}
