import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireMembership,
} from "./lib/identity";
import { requirePermission } from "./lib/permissions";
import { currentTeamForMembership } from "./lib/teamMembership";
import { normalizedE164Phone } from "./lib/outboundCalls";
import {
  findOperation,
  operationFingerprint,
  recordOperation,
  storedOperationVersion,
} from "./lib/operations";
import { writeAuditEvent } from "./lib/audit";

const consentVersion = "team-review-calls-v1";
const scriptVersion = "team-review-call-up-v1";
async function ownContext(ctx: QueryCtx | MutationCtx, eventSlug: string) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  const membership = await requireMembership(ctx, event._id, person._id);
  const team = await currentTeamForMembership(ctx, event._id, membership._id);
  const grantIds = await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "participant.profile.write",
    scopeType: "self",
    scopeId: membership._id,
  });
  const current = await ctx.db
    .query("outboundCallConsents")
    .withIndex("by_event_person_purpose", (q) =>
      q
        .eq("eventId", event._id)
        .eq("personId", person._id)
        .eq("purpose", "participant_event_update"),
    )
    .unique();
  return { event, person, membership, team, grantIds, current };
}
export const mine = query({
  args: { eventSlug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      enabled: v.boolean(),
      phone: v.optional(v.string()),
      version: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { current, team, membership } = await ownContext(ctx, args.eventSlug);
    if (!team || team.team.leadMembershipId !== membership._id) return null;
    return {
      enabled:
        current?.state === "granted" &&
        current.consentPolicyVersion === consentVersion &&
        current.scriptPolicyVersion === scriptVersion,
      version: current?.version ?? 0,
      ...(current?.destinationPhoneE164
        ? { phone: current.destinationPhoneE164 }
        : {}),
    };
  },
});
export const save = mutation({
  args: {
    eventSlug: v.string(),
    enabled: v.boolean(),
    phone: v.optional(v.string()),
    expectedVersion: v.number(),
    clientOperationId: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    const { event, person, membership, team, grantIds, current } =
      await ownContext(ctx, args.eventSlug);
    if (!team || team.team.leadMembershipId !== membership._id)
      throw new ConvexError({
        code: "TEAM_LEAD_REQUIRED",
        message: "Review calls are managed by the current team lead.",
      });
    const phone = normalizedE164Phone(args.phone);
    if (args.enabled && !phone)
      throw new ConvexError({
        code: "INVALID_PHONE",
        message: "Use an international phone number, such as +919876543210.",
      });
    const requestFingerprint = operationFingerprint([
      args.enabled,
      phone,
      args.expectedVersion,
      consentVersion,
      scriptVersion,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.team_call_consent",
      requestFingerprint,
    });
    if (prior)
      return {
        version: storedOperationVersion(
          prior.resultJson,
          "review call setting",
        ),
      };
    if ((current?.version ?? 0) !== args.expectedVersion)
      throw new ConvexError({
        code: "CALL_SETTING_CHANGED",
        message: "Your call setting changed. Refresh before saving.",
      });
    const now = Date.now();
    const version = args.expectedVersion + 1;
    const fields = {
      eventId: event._id,
      personId: person._id,
      purpose: "participant_event_update" as const,
      state: args.enabled ? ("granted" as const) : ("revoked" as const),
      consentPolicyVersion: consentVersion,
      scriptPolicyVersion: scriptVersion,
      version,
      updatedAt: now,
    };
    const id =
      current?._id ??
      (await ctx.db.insert("outboundCallConsents", {
        ...fields,
        ...(args.enabled && phone
          ? { destinationPhoneE164: phone, grantedAt: now }
          : { revokedAt: now }),
        createdAt: now,
      }));
    if (current)
      await ctx.db.patch(current._id, {
        ...fields,
        destinationPhoneE164: args.enabled && phone ? phone : undefined,
        grantedAt: args.enabled ? now : undefined,
        revokedAt: args.enabled ? undefined : now,
      });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "review.team_call_consent",
      requestFingerprint,
      targetType: "outbound_call_consent",
      targetId: id,
      resultJson: String(version),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "participant.profile.write",
      grantIds,
      scopeType: "self",
      scopeId: membership._id,
      action: "review.team_call_consent_changed",
      targetType: "outbound_call_consent",
      targetId: id,
      nextSummary: JSON.stringify({ enabled: args.enabled, version }),
      reason: args.enabled
        ? "Team lead opted into review calls"
        : "Team lead disabled review calls",
    });
    return { version };
  },
});
