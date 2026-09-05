import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { writeAuditEvent } from "./lib/audit";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject, requireVerifiedIdentity,
  participantIdentityAccessAllowed } from "./lib/identity";
import { loadPublishedParticipantPolicy } from "./lib/participantPolicy";
import { requirePermission } from "./lib/permissions";
import { approvedRosterRecovery, recoveryUnavailable } from "./lib/rosterRecovery";
import { normalizeEmail, normalizedText } from "./lib/strings";
import { isApprovedVitStudentIdentity, parseVitStudentGoogleDisplayName,
  vitIdentityReferenceYear } from "./lib/vitStudentIdentity";

export const current = query({
  args: { eventSlug: v.string(), now: v.number() },
  returns: v.union(v.null(), v.object({ teamName: v.string(), expiresAt: v.number() })),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { identity } = await requireVerifiedIdentity(ctx);
    if (!isApprovedVitStudentIdentity({ verifiedEmail: identity.verifiedEmail,
      ...(identity.hostedDomain !== undefined ? { hostedDomain: identity.hostedDomain } : {}), allowedDomains: event.vitEmailDomains }) ||
      !(await participantIdentityAccessAllowed(ctx, event, identity))) return null;
    const vit = parseVitStudentGoogleDisplayName(identity.displayName, vitIdentityReferenceYear(event));
    const approved = await approvedRosterRecovery(ctx, event, identity.verifiedEmail,
      vit?.registrationNumber, args.now);
    return approved ? { teamName: approved.team.name, expiresAt: approved.recovery.expiresAt } : null;
  },
});

/** Operator approval does not manufacture a profile, consent, star, or team acceptance. */
export const approve = mutation({
  args: { eventSlug: v.string(), teamId: v.id("teams"), rosterEntryId: v.id("teamRosterEntries"),
    email: v.string(), vitRegistrationNumber: v.string(), expiresAt: v.number(), reason: v.string() },
  returns: v.id("participantRosterRecoveries"),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const rosterGrants = await requirePermission(ctx, { eventId: event._id,
      eventAccessSubjectId: subject._id, permissionKey: "team.roster.import", scopeType: "event" });
    const application = await ctx.db.query("applications")
      .withIndex("by_team", q => q.eq("teamId", args.teamId)).unique();
    if (!application || application.eventId !== event._id) return recoveryUnavailable();
    const decisionGrants = await requirePermission(ctx, { eventId: event._id,
      eventAccessSubjectId: subject._id, permissionKey: "application.decide",
      scopeType: "application", scopeId: application._id });
    const emailNormalized = normalizeEmail(args.email);
    if (!/^[^\s@]+@vitstudent\.ac\.in$/u.test(emailNormalized)) return recoveryUnavailable();
    const now = Date.now();
    if (event.startsAt === undefined || !Number.isFinite(args.expiresAt) || args.expiresAt <= now || args.expiresAt > event.startsAt) {
      throw new ConvexError({ code: "INVALID_RECOVERY_EXPIRY", message: "Recovery must expire before the event starts." });
    }
    const reason = normalizedText(args.reason, "Recovery reason", 10, 500);
    const existing = await ctx.db.query("participantRosterRecoveries")
      .withIndex("by_event_email", q => q.eq("eventId", event._id).eq("emailNormalized", emailNormalized)).unique();
    if (existing) {
      if (existing.teamId !== args.teamId || existing.rosterEntryId !== args.rosterEntryId ||
          existing.vitRegistrationNumber !== args.vitRegistrationNumber || existing.reason !== reason ||
          existing.expiresAt !== args.expiresAt || existing.status === "revoked") return recoveryUnavailable();
      return existing._id;
    }
    const forEntry = await ctx.db.query("participantRosterRecoveries")
      .withIndex("by_roster_entry", q => q.eq("rosterEntryId", args.rosterEntryId)).unique();
    if (forEntry) return recoveryUnavailable();
    const authorizingGrantIds = [...rosterGrants, ...decisionGrants];
    const id = await ctx.db.insert("participantRosterRecoveries", {
      eventId: event._id, teamId: args.teamId, rosterEntryId: args.rosterEntryId,
      emailNormalized, vitRegistrationNumber: args.vitRegistrationNumber,
      status: "approved", expiresAt: args.expiresAt, approvedByPersonId: person._id,
      authorizingGrantIds, reason, approvedAt: now,
    });
    const approved = await approvedRosterRecovery(ctx, event, emailNormalized, args.vitRegistrationNumber, now);
    if (!approved) return recoveryUnavailable();
    const policy = await loadPublishedParticipantPolicy(ctx, event);
    const pending = await ctx.db.query("participantRosterRecoveries")
      .withIndex("by_team_status", q => q.eq("teamId", args.teamId).eq("status", "approved"))
      .take(policy.normalized.teamMaximumSize + 1);
    if (approved.team.activeMemberCount + pending.filter(r => r.expiresAt > now).length > policy.normalized.teamMaximumSize) {
      throw new ConvexError({ code: "TEAM_FULL", message: "The team has no room for these recoveries." });
    }
    await writeAuditEvent(ctx, { eventId: event._id, actorPersonId: person._id,
      permissionKey: "team.roster.import", grantIds: authorizingGrantIds, scopeType: "event",
      action: "participant.roster_recovery.approved", targetType: "participant_roster_recovery", targetId: id,
      nextSummary: JSON.stringify({ teamId: args.teamId, rosterEntryId: args.rosterEntryId, emailNormalized,
        vitRegistrationNumber: args.vitRegistrationNumber, expiresAt: args.expiresAt }), reason });
    return id;
  },
});

export const revoke = mutation({
  args: { recoveryId: v.id("participantRosterRecoveries"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recovery = await ctx.db.get(args.recoveryId);
    if (!recovery) return recoveryUnavailable();
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, recovery.eventId, person._id);
    const grants = await requirePermission(ctx, { eventId: recovery.eventId,
      eventAccessSubjectId: subject._id, permissionKey: "team.roster.revoke", scopeType: "event" });
    if (recovery.status === "completed") return recoveryUnavailable();
    if (recovery.status === "revoked") return null;
    const reason = normalizedText(args.reason, "Revocation reason", 10, 500);
    await ctx.db.patch(recovery._id, { status: "revoked", revokedAt: Date.now(), revokedByPersonId: person._id });
    await writeAuditEvent(ctx, { eventId: recovery.eventId, actorPersonId: person._id,
      permissionKey: "team.roster.revoke", grantIds: grants, scopeType: "event",
      action: "participant.roster_recovery.revoked", targetType: "participant_roster_recovery",
      targetId: recovery._id, nextSummary: JSON.stringify({ status: "revoked" }), reason });
    return null;
  },
});
