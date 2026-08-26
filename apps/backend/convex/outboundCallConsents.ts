import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { normalizedE164Phone } from "./lib/outboundCalls";
import { requirePermission } from "./lib/permissions";

export const reviewerCallConsentPolicyVersion = "reviewer-page-call-consent-2026-08-25";
export const reviewerCallScriptPolicyVersion = "reviewer-substitute-page-v1";

const reviewerCallPurpose = "reviewer_substitute_page" as const;

export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    state: v.union(
      v.literal("not_configured"),
      v.literal("granted"),
      v.literal("revoked"),
      v.literal("needs_confirmation"),
    ),
    destinationPhoneE164: v.optional(v.string()),
    suggestedPhoneE164: v.optional(v.string()),
    consentPolicyVersion: v.string(),
    scriptPolicyVersion: v.string(),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "communications.call_consent.manage",
      scopeType: "self",
      scopeId: subject._id,
    });
    const [consent, profile] = await Promise.all([
      ctx.db
        .query("outboundCallConsents")
        .withIndex("by_event_person_purpose", (index) =>
          index
            .eq("eventId", event._id)
            .eq("personId", person._id)
            .eq("purpose", reviewerCallPurpose),
        )
        .unique(),
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", person._id),
        )
        .unique(),
    ]);
    const state: "not_configured" | "granted" | "revoked" | "needs_confirmation" =
      consent === null
        ? "not_configured"
        : consent.state === "granted" &&
            (consent.consentPolicyVersion !== reviewerCallConsentPolicyVersion ||
              consent.scriptPolicyVersion !== reviewerCallScriptPolicyVersion)
          ? "needs_confirmation"
          : consent.state;
    return {
      state,
      ...(consent?.destinationPhoneE164 !== undefined
        ? { destinationPhoneE164: consent.destinationPhoneE164 }
        : {}),
      ...(profile?.contactPhone !== undefined
        ? { suggestedPhoneE164: profile.contactPhone }
        : {}),
      consentPolicyVersion: reviewerCallConsentPolicyVersion,
      scriptPolicyVersion: reviewerCallScriptPolicyVersion,
      version: consent?.version ?? 0,
    };
  },
});

export const saveReviewerConsent = mutation({
  args: {
    eventSlug: v.string(),
    state: v.union(v.literal("granted"), v.literal("revoked")),
    destinationPhone: v.optional(v.string()),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    consentId: v.id("outboundCallConsents"),
    state: v.union(v.literal("granted"), v.literal("revoked")),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const destinationPhoneE164 = normalizedE164Phone(args.destinationPhone);
    if (args.state === "granted" && destinationPhoneE164 === null) {
      throw new ConvexError({
        code: "INVALID_CALL_DESTINATION",
        message: "Enter a phone number in international format, for example +919876543210.",
      });
    }
    const requestFingerprint = operationFingerprint([
      args.state,
      destinationPhoneE164,
      args.expectedVersion,
      reviewerCallConsentPolicyVersion,
      reviewerCallScriptPolicyVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "communications.call_consent.save",
      requestFingerprint,
    });
    if (prior) {
      const consentId = ctx.db.normalizeId("outboundCallConsents", prior.targetId);
      if (!consentId) throw new Error("Stored call-consent result is invalid.");
      return {
        consentId,
        state: args.state,
        version: storedOperationVersion(prior.resultJson, "outbound call consent"),
      };
    }
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "communications.call_consent.manage",
      scopeType: "self",
      scopeId: subject._id,
    });
    const [profile, current] = await Promise.all([
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", event._id).eq("personId", person._id),
        )
        .unique(),
      ctx.db
        .query("outboundCallConsents")
        .withIndex("by_event_person_purpose", (index) =>
          index
            .eq("eventId", event._id)
            .eq("personId", person._id)
            .eq("purpose", reviewerCallPurpose),
        )
        .unique(),
    ]);
    if (!profile) {
      throw new ConvexError({
        code: "REVIEWER_PROFILE_REQUIRED",
        message: "Ask the review desk to finish your reviewer profile first.",
      });
    }
    const currentVersion = current?.version ?? 0;
    if (args.expectedVersion !== currentVersion) {
      throw new ConvexError({
        code: "CALL_CONSENT_CHANGED",
        message: "Your call setting changed. Review the latest value and try again.",
      });
    }
    const now = Date.now();
    const version = currentVersion + 1;
    const fields = {
      eventId: event._id,
      personId: person._id,
      purpose: reviewerCallPurpose,
      state: args.state,
      consentPolicyVersion: reviewerCallConsentPolicyVersion,
      scriptPolicyVersion: reviewerCallScriptPolicyVersion,
      version,
      updatedAt: now,
    };
    let consentId: Id<"outboundCallConsents">;
    if (current) {
      consentId = current._id;
      if (args.state === "granted") {
        if (destinationPhoneE164 === null) {
          throw new Error("A validated call destination is missing.");
        }
        await ctx.db.patch(current._id, {
          ...fields,
          destinationPhoneE164,
          grantedAt: now,
          revokedAt: undefined,
        });
      } else {
        await ctx.db.patch(current._id, {
          ...fields,
          destinationPhoneE164: undefined,
          grantedAt: undefined,
          revokedAt: now,
        });
      }
    } else {
      if (args.state === "granted") {
        if (destinationPhoneE164 === null) {
          throw new Error("A validated call destination is missing.");
        }
        consentId = await ctx.db.insert("outboundCallConsents", {
          ...fields,
          destinationPhoneE164,
          grantedAt: now,
          createdAt: now,
        });
      } else {
        consentId = await ctx.db.insert("outboundCallConsents", {
          ...fields,
          revokedAt: now,
          createdAt: now,
        });
      }
    }
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "communications.call_consent.save",
      requestFingerprint,
      targetType: "outbound_call_consent",
      targetId: consentId,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "communications.call_consent.manage",
      grantIds,
      scopeType: "self",
      scopeId: subject._id,
      action: args.state === "granted"
        ? "communications.call_consent_granted"
        : "communications.call_consent_revoked",
      targetType: "outbound_call_consent",
      targetId: consentId,
      ...(current
        ? { previousSummary: JSON.stringify({ state: current.state, version: current.version }) }
        : {}),
      nextSummary: JSON.stringify({ state: args.state, version }),
      reason: args.state === "granted"
        ? "Reviewer enabled phone fallback"
        : "Reviewer disabled phone fallback",
    });
    return { consentId, state: args.state, version };
  },
});
