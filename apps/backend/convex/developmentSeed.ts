import { defaultParticipantEmailTemplates } from "@code2create/domain";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { defaultDeterministicIntakePolicy } from "./lib/intakePolicy";
import { moveZoneCounter } from "./lib/attendanceCounters";
import { defaultParticipantPolicy } from "./lib/participantPolicy";
import { addEventSubjectSelfGrants, insertPermissionGrant } from "./lib/permissions";
import { addTeamMemberGrants } from "./lib/teamMembership";
import { createTestSubmissionSnapshot, linkTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";
import { phaseScheduleChecksum, type NormalizedPhase } from "./lib/phaseSchedule";
import { bootstrapEventInput, type BootstrapEventInput } from "./system";

function requireLocalDevelopment() {
  if (process.env.C2C_DEPLOYMENT_ENVIRONMENT !== "development" ||
      process.env.AUTH_SITE_URL !== "http://localhost:3211") {
    throw new ConvexError("Development fixtures require the local development backend.");
  }
}

function documentId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("_id" in value) ||
      typeof value._id !== "string") throw new Error("Fixture auth document was not created.");
  return value._id;
}

export const createAccount = internalMutation({
  args: { key: v.string(), name: v.string(), email: v.string() },
  returns: v.object({ personId: v.id("people"), authUserId: v.string(), sessionId: v.string(), token: v.string() }),
  handler: async (ctx, args) => {
    requireLocalDevelopment();
    if (!args.key.startsWith("local-") || !args.email.endsWith("@example.test")) {
      throw new ConvexError("Use explicit local fixture identities.");
    }
    const now = Date.now();
    const existing = await ctx.db.query("people").withIndex("by_verified_email", q => q.eq("verifiedEmail", args.email)).unique();
    let authUserId = existing?.authUserId;
    if (!authUserId) authUserId = documentId(await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: { name: args.name, email: args.email, emailVerified: true, createdAt: now, updatedAt: now } },
    }));
    const token = crypto.randomUUID();
    const sessionId = documentId(await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "session", data: { userId: authUserId, token, expiresAt: now + 7 * 86_400_000, createdAt: now, updatedAt: now } },
    }));
    const personId = existing?._id ?? await ctx.db.insert("people", {
      authUserId, googleSubject: args.key, verifiedEmail: args.email, displayName: args.name,
      status: "active", createdAt: now, updatedAt: now,
    });
    const claim = await ctx.db.query("googleIdentityClaims").withIndex("by_auth_user", q => q.eq("authUserId", authUserId)).unique();
    if (!claim) await ctx.db.insert("googleIdentityClaims", {
      authUserId, googleSubject: args.key, verifiedEmail: args.email, displayName: args.name,
      tokenIssuedAt: now - 1000, tokenExpiresAt: now + 7 * 86_400_000, verifiedAt: now,
    });
    return { personId, authUserId, sessionId, token };
  },
});

export const createLoginToken = internalMutation({
  args: { sessionToken: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireLocalDevelopment();
    const token = crypto.randomUUID();
    const now = Date.now();
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "verification", data: {
        identifier: `one-time-token:${token}`, value: args.sessionToken,
        expiresAt: now + 180_000, createdAt: now, updatedAt: now,
      } },
    });
    return token;
  },
});

export const bootstrapConfiguration = internalQuery({
  args: {},
  returns: bootstrapEventInput,
  handler: async (): Promise<BootstrapEventInput> => {
    requireLocalDevelopment();
    const now = Date.now();
    return {
      eventSlug: "code2create-7", eventName: "Code2Create · Local playground", timezone: "Asia/Kolkata",
      applicationsCloseAt: now + 7 * 86_400_000, externalApplicationsCloseAt: now + 7 * 86_400_000,
      vitEmailDomains: ["vitstudent.ac.in"], participantPolicy: defaultParticipantPolicy,
      admissionPolicyVersion: "local-v1", admissionParticipantCapacity: 1000, admissionMinimumHumanReviews: 2,
      intakePolicy: defaultDeterministicIntakePolicy,
      communicationsPolicy: {
        venueName: "Local event hall", venueAddress: "Simulator and localhost",
        startsAt: now + 8 * 86_400_000, endsAt: now + 9 * 86_400_000,
        nextSteps: [{ stableKey: "review", title: "Prepare for review", detail: "Open your team dashboard and review queue." }],
        discordUrl: "https://discord.gg/code2create", discordLabel: "Event Discord",
        notificationProvider: "cloudflare_email", emailTemplates: defaultParticipantEmailTemplates(),
      },
      integrationPolicy: { version: "local-v1", requiredGitHubTopic: "code2create-7", maxActiveGitHubRepositoriesPerTeam: 10, maxActiveFigmaFilesPerTeam: 10 },
    };
  },
});

export const addReviewer = internalMutation({
  args: { eventId: v.id("events"), personId: v.id("people"), ownerPersonId: v.id("people"), role: v.union(v.literal("board"), v.literal("sc"), v.literal("jc")) },
  returns: v.id("eventAccessSubjects"),
  handler: async (ctx, args): Promise<Id<"eventAccessSubjects">> => {
    requireLocalDevelopment();
    const person = await ctx.db.get(args.personId);
    if (!person) throw new Error("Fixture reviewer missing.");
    const existing = await ctx.db.query("eventAccessSubjects").withIndex("by_event_person", q => q.eq("eventId", args.eventId).eq("personId", person._id)).unique();
    if (existing) return existing._id;
    const now = Date.now();
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId: args.eventId, personId: person._id, emailNormalized: person.verifiedEmail,
      displayName: person.displayName, status: "active", linkedBy: "access_invitation", accessVersion: 1, createdAt: now, updatedAt: now,
    });
    await addEventSubjectSelfGrants(ctx, { eventId: args.eventId, personId: person._id, eventAccessSubjectId: subjectId });
    await ctx.db.insert("eventRoles", {
      eventId: args.eventId, personId: person._id, eventAccessSubjectId: subjectId,
      role: args.role, validFrom: now - 60_000, status: "active", sourceType: "manual",
      sourceId: "local-playground", assignedByPersonId: args.ownerPersonId, createdAt: now,
      reason: "Local development fixture",
    });
    return subjectId;
  },
});

export const populateTeam = internalMutation({
  args: {
    eventId: v.id("events"), ownerPersonId: v.id("people"), number: v.number(),
    name: v.string(), idea: v.string(), people: v.array(v.id("people")),
    stage: v.union(v.literal("live"), v.literal("submitted"), v.literal("draft")), inside: v.boolean(),
  },
  returns: v.id("teams"),
  handler: async (ctx, args) => {
    requireLocalDevelopment();
    if (args.people.length !== 3) throw new Error("Local teams have three participants.");
    const event = await ctx.db.get(args.eventId);
    if (!event?.publishedParticipantPolicyId || !event.publishedIntakePolicyId || !event.publishedAdmissionPolicyId) throw new Error("Bootstrap the local event first.");
    const existing = await ctx.db.query("teams").withIndex("by_event_name", q => q.eq("eventId", event._id).eq("name", args.name)).unique();
    if (existing) return existing._id;
    const now = Date.now();
    const membershipIds: Id<"eventMemberships">[] = [];
    for (const [index, personId] of args.people.entries()) {
      const person = await ctx.db.get(personId);
      if (!person) throw new Error("Local participant missing.");
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: event._id, personId, emailNormalized: person.verifiedEmail, displayName: person.displayName,
        status: "active", linkedBy: "participant_provisioning", accessVersion: 1, createdAt: now, updatedAt: now,
      });
      const membershipId = await ctx.db.insert("eventMemberships", {
        eventId: event._id, personId, eventAccessSubjectId: subjectId, participantClass: "external_participant",
        eligibilityStatus: "eligible", onboardingStatus: args.stage === "live" ? "accepted" : args.stage === "submitted" ? "submitted" : "project_required",
        acceptedParticipantPolicyVersionIds: [event.publishedParticipantPolicyId], createdAt: now, updatedAt: now,
      });
      membershipIds.push(membershipId);
      await ctx.db.insert("participantProfiles", {
        eventId: event._id, membershipId, participantClass: "external_participant", fullName: person.displayName,
        phone: `+1555010${String(args.number * 3 + index).padStart(4, "0")}`,
        gender: index % 2 === 0 ? "male" : "female", institution: "Local Demo University", yearOfStudy: "third",
        externalUniversity: "Local Demo University", externalCollege: "Engineering", profileVersion: 1, updatedAt: now,
      });
      await addEventSubjectSelfGrants(ctx, { eventId: event._id, personId, eventAccessSubjectId: subjectId });
      for (const permissionKey of ["participant.profile.read", "participant.profile.write", "team.join", "communications.delivery.self.read", "attendance.self.read", "attendance.remedy.self.read", "attendance.remedy.self.open", "attendance.external_pass.read"] as const) {
        await insertPermissionGrant(ctx, { eventId: event._id, personId, eventAccessSubjectId: subjectId,
          permissionKey, scopeType: "self", scopeId: membershipId, sourceType: "participant_membership", sourceId: membershipId, reason: "Local participant fixture" });
      }
      await ctx.db.insert("githubStarCompletions", {
        eventId: event._id, membershipId, personId, githubUserId: `local-${personId}`, githubLogin: `local-fixture-${args.number}-${index}`,
        repositoryOwner: "sgl-project", repositoryName: "sglang", completedAt: now,
      });
      await ctx.db.insert("attendanceVenueStates", { eventId: event._id, membershipId, state: args.inside ? "inside" : "not_arrived", version: 1, updatedAt: now });
    }
    const leadId = membershipIds[0];
    if (!leadId) throw new Error("Local team lead missing.");
    const teamId = await ctx.db.insert("teams", {
      eventId: event._id, name: args.name, publicCode: `DEV${String(args.number).padStart(4, "0")}`, leadMembershipId: leadId,
      status: args.stage === "live" ? "active" : args.stage === "submitted" ? "submitted" : "forming",
      activeMemberCount: 3, activeVitMemberCount: 0, activeExternalMemberCount: 3,
      membershipLocked: args.stage !== "draft", version: 1, createdAt: now, updatedAt: now,
    });
    const teamMemberIds: Id<"teamMembers">[] = [];
    for (const [index, membershipId] of membershipIds.entries()) {
      const membership = await ctx.db.get(membershipId);
      if (!membership) throw new Error("Local membership missing.");
      const teamMemberId = await ctx.db.insert("teamMembers", { eventId: event._id, teamId, membershipId,
        role: index === 0 ? "lead" : "member", status: "active", joinedAt: now, source: index === 0 ? "created" : "code" });
      teamMemberIds.push(teamMemberId);
      await addTeamMemberGrants(ctx, { event, membership, teamId, teamMemberId, actorPersonId: args.ownerPersonId, lead: index === 0 });
    }
    await ctx.db.insert("attendanceTeamAvailability", { eventId: event._id, teamId, activeMemberCount: 3, insideMemberCount: args.inside ? 3 : 0, version: 1, updatedAt: now });
    await ctx.db.insert("projectDrafts", {
      eventId: event._id, teamId, intakePolicyVersionId: event.publishedIntakePolicyId,
      stage: args.stage === "draft" ? "opening" : "submitted", initialIdea: args.idea,
      freshnessAttestedByMembershipId: leadId, freshnessAttestedAt: now,
      version: 1, lastEditedByMembershipId: leadId, updatedAt: now,
    });
    if (args.stage !== "draft") {
      const snapshotId = await createTestSubmissionSnapshot(ctx, {
        eventId: event._id, teamId, teamMemberIds, intakePolicyVersionId: event.publishedIntakePolicyId,
        participantPolicyVersionId: event.publishedParticipantPolicyId, admissionPolicyVersionId: event.publishedAdmissionPolicyId, submittedAt: now,
      });
      const projectVersionId = await ctx.db.insert("projectVersions", {
        eventId: event._id, teamId, version: 1, initialIdea: args.idea, additionalInformation: "Synthetic local project for exercising event operations.",
        intakePolicyVersionId: event.publishedIntakePolicyId, intakeResponses: [], lockedRosterSnapshotId: snapshotId,
        lockedMemberCount: 3, lockedLeadMembershipId: leadId,
        freshForEventAttestation: { participantPolicyVersionId: event.publishedParticipantPolicyId, acceptedByMembershipId: leadId, acceptedAt: now },
        finalConfirmation: { participantPolicyVersionId: event.publishedParticipantPolicyId, previewedDraftVersion: 1, previewedTeamVersion: 1, confirmedByMembershipId: leadId, confirmedAt: now },
        participantPolicyVersionId: event.publishedParticipantPolicyId, admissionPolicyVersionId: event.publishedAdmissionPolicyId,
        sourceDraftVersion: 1, submittedByMembershipId: leadId, submittedAt: now,
      });
      const applicationId = await ctx.db.insert("applications", {
        eventId: event._id, teamId, submittedProjectVersionId: projectVersionId, admissionPolicyVersionId: event.publishedAdmissionPolicyId,
        state: args.stage === "live" ? "confirmed" : "submitted", experienceBand: "mixed_or_external",
        decisionStage: args.stage === "live" ? "released" : "unrecorded",
        ...(args.stage === "live" ? { humanDecision: "accept" as const, humanReasonCode: "meets_requirements", decidedByPersonId: args.ownerPersonId, decidedAt: now, releasedByPersonId: args.ownerPersonId, releasedAt: now } : {}),
        assignedReviewCount: 0, completedReviewCount: 0, contentVersion: 1, version: 1, submittedAt: now,
      });
      await linkTestSubmissionSnapshot(ctx, { submissionAttemptId: snapshotId, projectVersionId, applicationId });
      await ctx.db.patch(teamId, { lockedProjectVersionId: projectVersionId, lockedAt: now, lockParticipantPolicyVersionId: event.publishedParticipantPolicyId });
    }
    return teamId;
  },
});

export const openPlayground = internalMutation({
  args: { eventId: v.id("events"), ownerPersonId: v.id("people") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDevelopment();
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Local event missing.");
    if (event.publishedEventPhaseScheduleId) return null;
    const now = Date.now();
    const hour = 3_600_000;
    const phases: NormalizedPhase[] = [
      { phaseKey: "introduction", displayName: "Welcome", description: "Event introduction", startsAt: now - 3 * hour, endsAt: now - 2 * hour, displayOrder: 0 },
      { phaseKey: "ideation", displayName: "Ideation", description: "Shape the project", startsAt: now - 2 * hour, endsAt: now - hour, displayOrder: 1 },
      { phaseKey: "build", displayName: "Build", description: "Build and test your project", startsAt: now - hour, endsAt: now + 24 * hour, displayOrder: 2 },
      { phaseKey: "intermediate_update", displayName: "Progress update", description: "Share progress", startsAt: now + 24 * hour, endsAt: now + 25 * hour, displayOrder: 3 },
      { phaseKey: "final_update", displayName: "Final update", description: "Prepare the final demo", startsAt: now + 25 * hour, endsAt: now + 26 * hour, displayOrder: 4 },
    ];
    const scheduleVersionId = await ctx.db.insert("eventPhaseScheduleVersions", {
      eventId: event._id, version: 1, status: "published", checksum: phaseScheduleChecksum(phases),
      createdByPersonId: args.ownerPersonId, createdAt: now, publishedAt: now,
    });
    for (const phase of phases) await ctx.db.insert("eventPhaseWindows", { eventId: event._id, scheduleVersionId, ...phase, status: "published", createdAt: now });
    await ctx.db.patch(event._id, { status: "live", startsAt: now - 3 * hour, endsAt: now + 26 * hour,
      publishedEventPhaseScheduleId: scheduleVersionId, version: event.version + 1, updatedAt: now });
    return null;
  },
});

export const seedArrivalHistory = internalMutation({
  args: { eventId: v.id("events"), ownerPersonId: v.id("people") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDevelopment();
    const event = await ctx.db.get(args.eventId);
    if (!event?.publishedAttendancePlanVersionId) throw new Error("Publish the local attendance plan first.");
    const planVersionId = event.publishedAttendancePlanVersionId;
    const zone = await ctx.db.query("attendanceZones").withIndex("by_plan_key", q => q.eq("planVersionId", planVersionId).eq("stableKey", "local_hall")).unique();
    if (!zone) throw new Error("Publish the local attendance plan first.");
    const memberships = await ctx.db.query("eventMemberships").withIndex("by_event_person", q => q.eq("eventId", args.eventId)).collect();
    for (const membership of memberships) {
      const person = await ctx.db.get(membership.personId);
      if (!person?.verifiedEmail.endsWith("@example.test")) continue;
      const state = await ctx.db.query("attendanceVenueStates").withIndex("by_event_membership", q => q.eq("eventId", args.eventId).eq("membershipId", membership._id)).unique();
      if (state?.state !== "inside" || state.currentIntervalId) continue;
      const now = Date.now();
      const presenceEventId = await ctx.db.insert("attendancePresenceEvents", {
        eventId: args.eventId, membershipId: membership._id, zoneId: zone._id,
        sourceKind: "staff_reconciliation", operatorPersonId: args.ownerPersonId,
        credentialKind: "manual", clientOperationId: crypto.randomUUID(),
        requestFingerprint: `local-arrival-${membership._id}`, capturedAt: now, receivedAt: now,
        isOfflineReplay: false, transition: "venue_entry", outcome: "accepted",
        reasonCode: "local_fixture_arrival", previousState: "not_arrived", nextState: "inside",
      });
      const intervalId = await ctx.db.insert("attendancePresenceIntervals", {
        eventId: args.eventId, membershipId: membership._id, zoneId: zone._id,
        kind: "venue", status: "open", openedByEventId: presenceEventId, openedAt: now,
      });
      await ctx.db.patch(state._id, { currentIntervalId: intervalId, zoneId: zone._id, lastEventId: presenceEventId, version: state.version + 1, updatedAt: now });
      await moveZoneCounter(ctx, { eventId: args.eventId, membershipId: membership._id,
        previousState: "not_arrived", nextState: "inside", nextZoneId: zone._id, now });
    }
    return null;
  },
});
