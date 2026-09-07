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
import { finalizeAcceptedRosterRecovery } from "./lib/acceptedRosterRecovery";
import { insertActiveTeamMember } from "./lib/teamRoster";
import { addTeamMemberGrants } from "./lib/teamMembership";
import { operationFingerprint } from "./lib/operations";

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
    email: v.string(), vitRegistrationNumber: v.string(), expiresAt: v.number(), reason: v.string(),
    lateJoin: v.optional(v.literal(true)) },
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
    const deadline = args.lateJoin ? event.endsAt : event.startsAt;
    if (deadline === undefined || !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= now || args.expiresAt > deadline) {
      throw new ConvexError({ code: "INVALID_RECOVERY_EXPIRY", message: "Recovery must expire within its approved event window." });
    }
    const reason = normalizedText(args.reason, "Recovery reason", 10, 500);
    const existing = await ctx.db.query("participantRosterRecoveries")
      .withIndex("by_event_email", q => q.eq("eventId", event._id).eq("emailNormalized", emailNormalized)).unique();
    if (existing) {
      if (existing.teamId !== args.teamId || existing.rosterEntryId !== args.rosterEntryId ||
          existing.vitRegistrationNumber !== args.vitRegistrationNumber || existing.reason !== reason ||
          existing.expiresAt !== args.expiresAt || existing.lateJoin !== args.lateJoin || existing.status === "revoked") return recoveryUnavailable();
      return existing._id;
    }
    const forEntry = await ctx.db.query("participantRosterRecoveries")
      .withIndex("by_roster_entry", q => q.eq("rosterEntryId", args.rosterEntryId)).unique();
    if (forEntry) return recoveryUnavailable();
    const authorizingGrantIds = [...rosterGrants, ...decisionGrants];
    const id = await ctx.db.insert("participantRosterRecoveries", {
      eventId: event._id, teamId: args.teamId, rosterEntryId: args.rosterEntryId,
      emailNormalized, vitRegistrationNumber: args.vitRegistrationNumber,
      ...(args.lateJoin ? { lateJoin: true as const } : {}),
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
        vitRegistrationNumber: args.vitRegistrationNumber, expiresAt: args.expiresAt,
        lateJoin: args.lateJoin === true }), reason });
    return id;
  },
});

/** An organizer can waive GitHub setup, never identity verification or participant-policy consent. */
export const completeLateJoin = mutation({
  args: { recoveryId: v.id("participantRosterRecoveries"), expectedTeamVersion: v.number() },
  returns: v.object({ membershipId: v.id("eventMemberships"), teamId: v.id("teams") }),
  handler: async (ctx, args) => {
    const recovery = await ctx.db.get(args.recoveryId);
    if (!recovery?.lateJoin) return recoveryUnavailable();
    const event = await ctx.db.get(recovery.eventId);
    if (!event) return recoveryUnavailable();
    const { person: actor } = await requireCurrentPerson(ctx);
    const actorSubject = await requireEventSubject(ctx, event._id, actor._id);
    const rosterGrants = await requirePermission(ctx, { eventId: event._id,
      eventAccessSubjectId: actorSubject._id, permissionKey: "team.roster.import", scopeType: "event" });
    const application = await ctx.db.query("applications")
      .withIndex("by_team", q => q.eq("teamId", recovery.teamId)).unique();
    if (!application) return recoveryUnavailable();
    const decisionGrants = await requirePermission(ctx, { eventId: event._id,
      eventAccessSubjectId: actorSubject._id, permissionKey: "application.decide",
      scopeType: "application", scopeId: application._id });
    if (recovery.status === "completed" && recovery.completedByMembershipId) {
      return { membershipId: recovery.completedByMembershipId, teamId: recovery.teamId };
    }
    const now = Date.now();
    const approved = await approvedRosterRecovery(ctx, event, recovery.emailNormalized,
      recovery.vitRegistrationNumber, now);
    if (!approved || approved.team.version !== args.expectedTeamVersion) return recoveryUnavailable();
    const person = await ctx.db.query("people")
      .withIndex("by_verified_email", q => q.eq("verifiedEmail", recovery.emailNormalized)).unique();
    const membership = person ? await ctx.db.query("eventMemberships")
      .withIndex("by_event_person", q => q.eq("eventId", event._id).eq("personId", person._id)).unique() : null;
    if (!person || person.status !== "active" || !membership || membership.eligibilityStatus !== "eligible" ||
        membership.vitStudentIdentity?.registrationNumber !== recovery.vitRegistrationNumber) {
      throw new ConvexError({ code: "PARTICIPANT_ACCOUNT_REQUIRED", message: "The participant must first sign in with the approved VIT account." });
    }
    await requireEventSubject(ctx, event._id, person._id);
    const current = await ctx.db.query("teamMembers").withIndex("by_event_membership_status", q =>
      q.eq("eventId", event._id).eq("membershipId", membership._id).eq("status", "active")).unique();
    if (current) throw new ConvexError({ code: "CURRENT_TEAM_CHANGED", message: "The participant already belongs to a team." });
    const { teamMemberId } = await insertActiveTeamMember(ctx, { team: approved.team,
      membership, role: "member", source: "backfill", joinedAt: now });
    await addTeamMemberGrants(ctx, { event, membership, teamId: approved.team._id,
      teamMemberId, actorPersonId: actor._id, lead: false });
    await ctx.db.patch(approved.team._id, { version: approved.team.version + 1, updatedAt: now });
    await ctx.db.patch(approved.entry._id, { status: "claimed", version: approved.entry.version + 1,
      claimedByMembershipId: membership._id, claimedTeamId: approved.team._id, claimedAt: now });
    await finalizeAcceptedRosterRecovery(ctx, { event, recovery, membership, person,
      clientOperationId: `late-join:${recovery._id}`,
      requestFingerprint: operationFingerprint([recovery._id, args.expectedTeamVersion]),
      grantIds: [...rosterGrants, ...decisionGrants], now, operatorPersonId: actor._id });
    return { membershipId: membership._id, teamId: approved.team._id };
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
