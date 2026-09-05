/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { expect, test } from "vitest";
import { internal, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { defaultParticipantPolicy, normalizeParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum, normalizeIntakePolicy } from "./lib/intakePolicy";
import { admissionPolicyForConfiguration, admissionPolicyChecksum, defaultAdmissionCriteria,
  defaultAdmissionReasonCodes, normalizeAdmissionConfiguration } from "./lib/admissionPolicy";
import { insertPermissionGrant } from "./lib/permissions";
import { createTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";
import { defaultParticipantEmailTemplates } from "@code2create/domain";
import { normalizeCommunicationsPolicy, communicationsPolicyChecksum } from "./lib/communicationsPolicy";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const authModules = import.meta.glob("../node_modules/@convex-dev/better-auth/src/component/**/*.ts");
type Backend = TestConvex<typeof schema>;
const eventSlug = "roster-recovery-test";


function idOf(value: unknown) {
  if (!value || typeof value !== "object" || !("_id" in value) || typeof value._id !== "string") throw new Error("Missing auth ID");
  return value._id;
}

async function account(backend: Backend, email: string, name: string) {
  const now = Date.now();
  const userId = idOf(await backend.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { email, name, emailVerified: true, createdAt: now, updatedAt: now } },
  }));
  const sessionId = idOf(await backend.mutation(components.betterAuth.adapter.create, {
    input: { model: "session", data: { userId, token: `session-${email}`, expiresAt: now + 86_400_000, createdAt: now, updatedAt: now } },
  }));
  await backend.run(ctx => ctx.db.insert("googleIdentityClaims", {
    authUserId: userId, googleSubject: `google-${email}`, verifiedEmail: email, displayName: name,
    hostedDomain: "vitstudent.ac.in", tokenIssuedAt: now, tokenExpiresAt: now + 3_600_000, verifiedAt: now,
  }));
  return { userId, client: backend.withIdentity({ subject: userId, sessionId }) };
}

async function fixture() {
  const backend = convexTest(schema, modules);
  backend.registerComponent("betterAuth", betterAuthSchema, authModules);
  const admin = await account(backend, "admin.test@vitstudent.ac.in", "Event Admin 23BCE0001");
  const seed = await backend.run(async ctx => {
    const now = Date.now();
    const adminId = await ctx.db.insert("people", { authUserId: admin.userId, verifiedEmail: "admin.test@vitstudent.ac.in",
      displayName: "Event Admin", status: "active", createdAt: now, updatedAt: now });
    const eventId = await ctx.db.insert("events", { slug: eventSlug, name: "Recovery fixture", timezone: "Asia/Kolkata",
      status: "registration_closed", startsAt: now + 86_400_000, applicationsCloseAt: now - 60_000,
      externalApplicationsCloseAt: now - 60_000, vitEmailDomains: ["vitstudent.ac.in"],
      createdByPersonId: adminId, version: 1, createdAt: now - 86_400_000, updatedAt: now });
    const policy = normalizeParticipantPolicy({ ...defaultParticipantPolicy, phoneVerificationEnabled: false,
      teamMaximumSize: 5, teamMinimumSize: 2 });
    const policyId = await ctx.db.insert("participantPolicyVersions", { eventId, version: 1, status: "published", ...policy,
      checksum: participantPolicyChecksum(policy), createdByPersonId: adminId, createdAt: now, publishedAt: now });
    const intake = normalizeIntakePolicy(defaultDeterministicIntakePolicy);
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", { eventId, version: 1, status: "published", ...intake,
      checksum: intakePolicyChecksum(intake), createdByPersonId: adminId, createdAt: now, publishedAt: now });
    const admission = admissionPolicyForConfiguration(normalizeAdmissionConfiguration({ version: "test-v1",
      minimumHumanReviews: 2, overallParticipantCapacity: 100, criteria: defaultAdmissionCriteria,
      decisionReasonCodes: defaultAdmissionReasonCodes, model: null }));
    const admissionPolicyId = await ctx.db.insert("admissionPolicyVersions", { eventId, ...admission, status: "published",
      checksum: admissionPolicyChecksum(admission), createdByPersonId: adminId, createdAt: now, publishedAt: now });
    await ctx.db.patch(eventId, { publishedParticipantPolicyId: policyId, publishedIntakePolicyId: intakePolicyId,
      publishedAdmissionPolicyId: admissionPolicyId });
    const subjectId = await ctx.db.insert("eventAccessSubjects", { eventId, personId: adminId,
      emailNormalized: "admin.test@vitstudent.ac.in", displayName: "Admin", status: "active",
      linkedBy: "participant_provisioning", accessVersion: 1, createdAt: now, updatedAt: now });
    for (const permissionKey of ["team.roster.import", "team.roster.revoke", "application.decide"] as const) {
      await insertPermissionGrant(ctx, { eventId, personId: adminId, eventAccessSubjectId: subjectId,
        permissionKey, scopeType: "event", sourceType: "manual", sourceId: subjectId, reason: "Recovery test operator" });
    }
    const membershipIds: Id<"eventMemberships">[] = [];
    for (let i = 0; i < 3; i++) {
      const personId = await ctx.db.insert("people", { authUserId: `existing-${i}`, verifiedEmail: `existing${i}@vitstudent.ac.in`,
        displayName: `Existing Member ${i}`, status: "active", createdAt: now, updatedAt: now });
      const subject = await ctx.db.insert("eventAccessSubjects", { eventId, personId,
        emailNormalized: `existing${i}@vitstudent.ac.in`, displayName: `Existing Member ${i}`, status: "active",
        linkedBy: "participant_provisioning", accessVersion: 1, createdAt: now, updatedAt: now });
      const membershipId = await ctx.db.insert("eventMemberships", { eventId, personId, eventAccessSubjectId: subject,
        participantClass: "vit_student", vitStudentIdentity: { fullName: `Existing Member ${i}`, registrationNumber: `26BCE000${i}`,
          programmeCode: "BCE", yearOfStudy: "first" }, eligibilityStatus: "eligible", onboardingStatus: "selected",
        acceptedParticipantPolicyVersionIds: [policyId], googleHostedDomain: "vitstudent.ac.in", createdAt: now, updatedAt: now });
      membershipIds.push(membershipId);
      await ctx.db.insert("participantProfiles", { eventId, membershipId, participantClass: "vit_student",
        fullName: `Existing Member ${i}`, phone: "+919000000000", gender: "male", institution: "VIT Vellore",
        yearOfStudy: "first", vitRegistrationNumber: `26BCE000${i}`, vitProgramme: "BCE", vitResidenceType: "day_scholar",
        profileVersion: 1, updatedAt: now });
    }
    const leadId = membershipIds[0]!;
    const teamId = await ctx.db.insert("teams", { eventId, name: "VANTAGE", publicCode: "TEST123", leadMembershipId: leadId,
      status: "forming", activeMemberCount: 3, activeVitMemberCount: 3, activeExternalMemberCount: 0,
      membershipLocked: false,
      version: 5, createdAt: now - 3_600_000, updatedAt: now });
    for (const [i, membershipId] of membershipIds.entries())
      await ctx.db.insert("teamMembers", { eventId, teamId, membershipId,
        role: i === 0 ? "lead" : "member", status: "active", source: "backfill", joinedAt: now - 3600000 });
    const comms = normalizeCommunicationsPolicy({ venueName: "Test venue", startsAt: now + 86400000,
      endsAt: now + 172800000, nextSteps: [{ stableKey: "rsvp", title: "Confirm attendance", detail: "Team lead confirms the offer." }], discordUrl: "https://discord.gg/test", discordLabel: "Discord",
      notificationProvider: "cloudflare_email", emailTemplates: defaultParticipantEmailTemplates() });
    const communicationsId = await ctx.db.insert("communicationsPolicyVersions", {
      eventId, version: 1, status: "published", ...comms, checksum: communicationsPolicyChecksum(comms),
      createdByPersonId: adminId, createdAt: now, publishedAt: now });
    await ctx.db.patch(eventId, { publishedCommunicationsPolicyId: communicationsId, admissionResultsReleasedAt: now - 1000 });
    const bucketId = await ctx.db.insert("admissionCapacityBuckets", {
      eventId, admissionPolicyVersionId: admissionPolicyId, capacity: 100, reserved: 0, version: 1, updatedAt: now });
    const roleId = await ctx.db.insert("eventRoles", { eventId, personId: adminId, eventAccessSubjectId: subjectId,
      role: "supreme", status: "active", validFrom: now - 1000, sourceType: "manual", sourceId: "fixture",
      assignedByPersonId: adminId, createdAt: now });
    return { eventId, teamId, bucketId, roleId, adminId };
  });
  return { ...seed, backend, admin: admin.client, args: { teamId: seed.teamId, expectedTeamVersion: 5, clientOperationId: "email-import-fixture",
    memberEmails: [0,1,2].map(i => `existing${i}@vitstudent.ac.in`), idea: "Emailed project proposal",
    evidence: "Forwarded submission received by event outreach", receivedAt: Date.now() - 3600000,
    expiresAt: Date.now() + 3600000 } };
}

test("imports once, reserves capacity and offers RSVP without manufacturing consent or reviews", async () => {
  const f = await fixture();
  const before = await f.backend.run(ctx => ctx.db.query("participantProfiles").collect());
  const offerId = await f.admin.mutation(internal.emailedAdmission.accept, f.args);
  expect(await f.admin.mutation(internal.emailedAdmission.accept, f.args)).toBe(offerId);
  await f.backend.run(async ctx => {
    expect((await ctx.db.get(offerId))?.state).toBe("offered");
    expect((await ctx.db.get(f.bucketId))?.reserved).toBe(3);
    expect(await ctx.db.query("admissionOffers").collect()).toHaveLength(1);
    expect(await ctx.db.query("applications").collect()).toMatchObject([{ state: "offer_sent", humanDecision: "accept", completedReviewCount: 0 }]);
    expect(await ctx.db.query("projectVersions").collect()).toMatchObject([{ initialIdea: f.args.idea,
      freshForEventAttestation: null, finalConfirmation: null, organizerImport: { importedByPersonId: f.adminId } }]);
    expect(await ctx.db.query("teamSubmissionMembers").collect()).toHaveLength(3);
    expect(await ctx.db.query("participantProfiles").collect()).toEqual(before);
    expect(await ctx.db.query("admissionHumanReviews").collect()).toHaveLength(0);
    expect((await ctx.db.query("auditEvents").collect()).some(e => e.action === "admission.email_import.accept")).toBe(true);
  });
});

test.each(["capacity", "roster", "role", "version"] as const)("rejects %s mismatch without partial writes", async kind => {
  const f = await fixture();
  if (kind === "capacity") await f.backend.run(ctx => ctx.db.patch(f.bucketId, { capacity: 2 }));
  if (kind === "role") await f.backend.run(ctx => ctx.db.patch(f.roleId, { role: "board" }));
  const args = { ...f.args, ...(kind === "roster" ? { memberEmails: ["wrong@example.test"] } : {}),
    ...(kind === "version" ? { expectedTeamVersion: 1 } : {}) };
  await expect(f.admin.mutation(internal.emailedAdmission.accept, args)).rejects.toThrow();
  await f.backend.run(async ctx => {
    expect(await ctx.db.query("applications").collect()).toHaveLength(0);
    expect(await ctx.db.query("admissionOffers").collect()).toHaveLength(0);
    expect((await ctx.db.get(f.teamId))?.status).toBe("forming");
    expect((await ctx.db.get(f.bucketId))?.reserved).toBe(0);
  });
});

async function draftExceptionFixture() {
  const f = await fixture();
  const draftId = await f.backend.run(async ctx => {
    const event = await ctx.db.get(f.eventId);
    const team = await ctx.db.get(f.teamId);
    if (!event?.publishedIntakePolicyId || !team) throw new Error("Fixture missing");
    return ctx.db.insert("projectDrafts", { eventId: f.eventId, teamId: f.teamId,
      intakePolicyVersionId: event.publishedIntakePolicyId, stage: "follow_up", initialIdea: "Saved unfinished idea",
      additionalInformation: "Original participant notes", lastEditedByMembershipId: team.leadMembershipId,
      version: 16, updatedAt: Date.now() - 86400000 });
  });
  return { ...f, draftId, exceptionArgs: { teamId: f.teamId, expectedTeamName: "VANTAGE", expectedTeamVersion: 5,
    source: { kind: "draft" as const, draftId, expectedVersion: 16 },
    reason: "Organizer explicitly approved accepting this saved draft as an exception", clientOperationId: "exception-import-1" } };
}

test("saved draft exception is truthful, idempotent and does not create offers or change source evidence", async () => {
  const f = await draftExceptionFixture();
  const before = await f.backend.run(async ctx => ({ draft: await ctx.db.get(f.draftId), event: await ctx.db.get(f.eventId),
    profiles: await ctx.db.query("participantProfiles").collect() }));
  const applicationId = await f.admin.mutation(internal.admissionExceptions.accept, f.exceptionArgs);
  expect(await f.admin.mutation(internal.admissionExceptions.accept, f.exceptionArgs)).toBe(applicationId);
  await f.backend.run(async ctx => {
    expect(await ctx.db.get(f.draftId)).toEqual(before.draft);
    expect(await ctx.db.get(f.eventId)).toEqual(before.event);
    expect(await ctx.db.query("participantProfiles").collect()).toEqual(before.profiles);
    expect(await ctx.db.query("applications").collect()).toMatchObject([{ state: "accepted", completedReviewCount: 0 }]);
    expect(await ctx.db.query("projectVersions").collect()).toMatchObject([{ initialIdea: "Saved unfinished idea",
      additionalInformation: "Original participant notes", freshForEventAttestation: null, finalConfirmation: null,
      sourceDraftVersion: 16, organizerImport: { importedByPersonId: f.adminId } }]);
    expect(await ctx.db.query("admissionOffers").collect()).toHaveLength(0);
    expect(await ctx.db.query("participantNotificationDeliveries").collect()).toHaveLength(0);
    expect((await ctx.db.get(f.bucketId))?.reserved).toBe(0);
    expect(await ctx.db.query("auditEvents").collect()).toHaveLength(1);
    expect(await ctx.db.query("operationResults").collect()).toHaveLength(1);
    expect((await ctx.db.query("eventMemberships").collect()).every(m => m.onboardingStatus === "selected")).toBe(true);
  });
});

test("released decline correction preserves project, content version and review counts with an audited prior decision", async () => {
  const f = await draftExceptionFixture();
  const applicationId = await f.admin.mutation(internal.admissionExceptions.accept, f.exceptionArgs);
  await f.backend.run(async ctx => {
    await ctx.db.patch(applicationId, { state: "declined", humanDecision: "decline", humanReasonCode: "application_not_yet_clear",
      assignedReviewCount: 2, completedReviewCount: 2, contentVersion: 17, version: 9 });
    await ctx.db.patch(f.teamId, { status: "submitted" });
  });
  const before = await f.backend.run(async ctx => ({ application: await ctx.db.get(applicationId),
    projects: await ctx.db.query("projectVersions").collect(), snapshots: await ctx.db.query("teamSubmissionMembers").collect(),
    reviews: await ctx.db.query("admissionHumanReviews").collect() }));
  const args = { ...f.exceptionArgs, expectedTeamVersion: 6, source: { kind: "released" as const, applicationId, expectedVersion: 9 },
    clientOperationId: "exception-correction-1" };
  expect(await f.admin.mutation(internal.admissionExceptions.accept, args)).toBe(applicationId);
  expect(await f.admin.mutation(internal.admissionExceptions.accept, args)).toBe(applicationId);
  await f.backend.run(async ctx => {
    expect(await ctx.db.get(applicationId)).toMatchObject({ state: "accepted", humanDecision: "accept", version: 10,
      assignedReviewCount: 2, completedReviewCount: 2, contentVersion: 17, submittedAt: before.application?.submittedAt,
      submittedProjectVersionId: before.application?.submittedProjectVersionId });
    expect(await ctx.db.query("projectVersions").collect()).toEqual(before.projects);
    expect(await ctx.db.query("teamSubmissionMembers").collect()).toEqual(before.snapshots);
    expect(await ctx.db.query("admissionHumanReviews").collect()).toEqual(before.reviews);
    const audits = await ctx.db.query("auditEvents").collect();
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]!.previousSummary!)).toEqual(before.application);
    expect(await ctx.db.query("admissionOffers").collect()).toHaveLength(0);
  });
});

test.each(["capacity", "role", "expired-role", "name", "team-version", "draft-version", "empty-idea", "event-started"] as const)(
  "draft exception rejects %s without partial writes", async kind => {
    const f = await draftExceptionFixture();
    if (kind === "capacity") await f.backend.run(ctx => ctx.db.patch(f.bucketId, { capacity: 2 }));
    if (kind === "role") await f.backend.run(ctx => ctx.db.patch(f.roleId, { role: "board" }));
    if (kind === "expired-role") await f.backend.run(ctx => ctx.db.patch(f.roleId, { validUntil: Date.now() - 1 }));
    if (kind === "empty-idea") await f.backend.run(ctx => ctx.db.patch(f.draftId, { initialIdea: " " }));
    if (kind === "event-started") await f.backend.run(ctx => ctx.db.patch(f.eventId, { startsAt: Date.now() - 1 }));
    const args = { ...f.exceptionArgs,
      ...(kind === "name" ? { expectedTeamName: "Wrong team" } : {}),
      ...(kind === "team-version" ? { expectedTeamVersion: 1 } : {}),
      ...(kind === "draft-version" ? { source: { ...f.exceptionArgs.source, expectedVersion: 1 } } : {}) };
    await expect(f.admin.mutation(internal.admissionExceptions.accept, args)).rejects.toThrow();
    await f.backend.run(async ctx => {
      expect(await ctx.db.query("applications").collect()).toHaveLength(0);
      expect(await ctx.db.query("projectVersions").collect()).toHaveLength(0);
      expect(await ctx.db.query("auditEvents").collect()).toHaveLength(0);
      expect((await ctx.db.get(f.teamId))?.status).toBe("forming");
    });
  },
);

test("reused operation IDs cannot authorize a changed acceptance request", async () => {
  const f = await draftExceptionFixture();
  await f.admin.mutation(internal.admissionExceptions.accept, f.exceptionArgs);
  await expect(f.admin.mutation(internal.admissionExceptions.accept, { ...f.exceptionArgs, reason: "Different organizer approval reason" })).rejects.toThrow();
});

test("capacity increase preserves reservations and immutable policy, is audited and idempotent", async () => {
  const f = await fixture();
  await f.backend.run(async ctx => {
    const subject = await ctx.db.query("eventAccessSubjects").withIndex("by_event_person", q =>
      q.eq("eventId", f.eventId).eq("personId", f.adminId)).unique();
    if (!subject) throw new Error("Subject missing");
    await insertPermissionGrant(ctx, { eventId: f.eventId, personId: f.adminId, eventAccessSubjectId: subject._id,
      permissionKey: "configuration.admission.publish", scopeType: "event", sourceType: "manual",
      sourceId: subject._id, reason: "Explicit capacity approval" });
    await ctx.db.patch(f.bucketId, { reserved: 8 });
  });
  const before = await f.backend.run(ctx => ctx.db.query("admissionPolicyVersions").collect());
  const args = { eventId: f.eventId, expectedBucketVersion: 1, expectedCapacity: 100, capacity: 110,
    reason: "Organizer approved ten additional participant places", clientOperationId: "capacity-1" };
  expect(await f.admin.mutation(internal.admissionExceptions.increaseCapacity, args)).toBe(110);
  expect(await f.admin.mutation(internal.admissionExceptions.increaseCapacity, args)).toBe(110);
  await expect(f.admin.mutation(internal.admissionExceptions.increaseCapacity, { ...args, capacity: 120 })).rejects.toThrow();
  await expect(f.admin.mutation(internal.admissionExceptions.increaseCapacity, {
    ...args, clientOperationId: "capacity-stale", capacity: 120 })).rejects.toThrow();
  await f.backend.run(async ctx => {
    expect(await ctx.db.get(f.bucketId)).toMatchObject({ capacity: 110, reserved: 8, version: 2 });
    expect(await ctx.db.query("admissionPolicyVersions").collect()).toEqual(before);
    expect(await ctx.db.query("auditEvents").collect()).toHaveLength(1);
    expect(await ctx.db.query("applications").collect()).toHaveLength(0);
  });
});

test("capacity increase requires publication permission as well as the Supreme role", async () => {
  const f = await fixture();
  await expect(f.admin.mutation(internal.admissionExceptions.increaseCapacity, {
    eventId: f.eventId, expectedBucketVersion: 1, expectedCapacity: 100, capacity: 110,
    reason: "Organizer approved ten additional participant places", clientOperationId: "unauthorized-capacity",
  })).rejects.toThrow();
  expect((await f.backend.run(ctx => ctx.db.get(f.bucketId)))?.capacity).toBe(100);
});


test.each(["roster", "deadline", "receipt-time"] as const)("emailed import rejects changed %s on replay", async kind => {
  const f = await fixture();
  await f.admin.mutation(internal.emailedAdmission.accept, f.args);
  const changed = { ...f.args,
    ...(kind === "roster" ? { memberEmails: ["someone.else@vitstudent.ac.in"] } : {}),
    ...(kind === "deadline" ? { expiresAt: f.args.expiresAt + 1000 } : {}),
    ...(kind === "receipt-time" ? { receivedAt: f.args.receivedAt - 1000 } : {}),
  };
  await expect(f.admin.mutation(internal.emailedAdmission.accept, changed)).rejects.toThrow("already used");
  expect(await f.backend.run(ctx => ctx.db.query("admissionOffers").collect())).toHaveLength(1);
});

test.each(["import", "exception"] as const)("%s accounts for other selected teams before admitting anyone", async kind => {
  const f = await draftExceptionFixture();
  await f.backend.run(async ctx => {
    const team = await ctx.db.get(f.teamId);
    const policy = await ctx.db.query("admissionPolicyVersions").first();
    const draft = await ctx.db.get(f.draftId);
    if (!team || !policy || !draft) throw new Error("Fixture missing");
    const event = await ctx.db.get(f.eventId);
    if (!event?.publishedParticipantPolicyId) throw new Error("Policy missing");
    const now = Date.now();
    const personId = await ctx.db.insert("people", { authUserId: "other-selected-person", verifiedEmail: "other@vitstudent.ac.in",
      displayName: "Other participant", status: "active", createdAt: now, updatedAt: now });
    const subjectId = await ctx.db.insert("eventAccessSubjects", { eventId: f.eventId, personId,
      emailNormalized: "other@vitstudent.ac.in", displayName: "Other participant", status: "active",
      linkedBy: "participant_provisioning", accessVersion: 1, createdAt: now, updatedAt: now });
    const membershipId = await ctx.db.insert("eventMemberships", { eventId: f.eventId, personId, eventAccessSubjectId: subjectId,
      participantClass: "vit_student", eligibilityStatus: "eligible", onboardingStatus: "selected",
      acceptedParticipantPolicyVersionIds: [event.publishedParticipantPolicyId], createdAt: now, updatedAt: now });
    const otherTeamId = await ctx.db.insert("teams", { eventId: f.eventId, name: "Other selected team", publicCode: "OTHER12",
      leadMembershipId: membershipId, status: "admitted", activeMemberCount: 1, activeVitMemberCount: 1,
      activeExternalMemberCount: 0, membershipLocked: true, version: 1, createdAt: now, updatedAt: now });
    const memberId = await ctx.db.insert("teamMembers", { eventId: f.eventId, teamId: otherTeamId, membershipId,
      role: "lead", status: "active", source: "created", joinedAt: now });
    const attemptId = await createTestSubmissionSnapshot(ctx, { eventId: f.eventId, teamId: otherTeamId,
      teamMemberIds: [memberId], intakePolicyVersionId: draft.intakePolicyVersionId,
      participantPolicyVersionId: event.publishedParticipantPolicyId, admissionPolicyVersionId: policy._id, submittedAt: now });
    const projectId = await ctx.db.insert("projectVersions", {
      eventId: f.eventId, teamId: otherTeamId, version: 1, initialIdea: "Existing selected idea",
      intakePolicyVersionId: draft.intakePolicyVersionId, intakeResponses: [],
      lockedRosterSnapshotId: attemptId, lockedMemberCount: 1, lockedLeadMembershipId: membershipId,
      freshForEventAttestation: null, finalConfirmation: null,
      organizerImport: { importedByPersonId: f.adminId, importedAt: now, evidence: "Existing organizer acceptance" },
      participantPolicyVersionId: event.publishedParticipantPolicyId, admissionPolicyVersionId: policy._id,
      sourceDraftVersion: 1, submittedByMembershipId: membershipId, submittedAt: now,
    });
    await ctx.db.patch(f.bucketId, { capacity: 3 });
    await ctx.db.insert("applications", { eventId: f.eventId, teamId: otherTeamId, submittedProjectVersionId: projectId,
      admissionPolicyVersionId: policy._id, state: "accepted", experienceBand: "first_year", decisionStage: "released",
      humanDecision: "accept", assignedReviewCount: 0, completedReviewCount: 0, contentVersion: 1, version: 1, submittedAt: Date.now() });
  });
  await expect(kind === "import" ? f.admin.mutation(internal.emailedAdmission.accept, f.args) :
    f.admin.mutation(internal.admissionExceptions.accept, f.exceptionArgs)).rejects.toThrow("capacity");
  expect(await f.backend.run(ctx => ctx.db.query("admissionOffers").collect())).toHaveLength(0);
  expect(await f.backend.run(ctx => ctx.db.get(f.teamId))).toMatchObject({ status: "forming" });
});
