/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/src/component/schema.ts";
import { describe, expect, test } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { defaultParticipantPolicy, normalizeParticipantPolicy, participantPolicyChecksum } from "./lib/participantPolicy";
import { defaultDeterministicIntakePolicy, intakePolicyChecksum, normalizeIntakePolicy } from "./lib/intakePolicy";
import { admissionPolicyForConfiguration, admissionPolicyChecksum, defaultAdmissionCriteria,
  defaultAdmissionReasonCodes, normalizeAdmissionConfiguration } from "./lib/admissionPolicy";
import { insertPermissionGrant } from "./lib/permissions";
import { createTestSubmissionSnapshot, linkTestSubmissionSnapshot } from "./lib/testSubmissionSnapshot";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const authModules = import.meta.glob("../node_modules/@convex-dev/better-auth/src/component/**/*.ts");
type Backend = TestConvex<typeof schema>;
const eventSlug = "roster-recovery-test";
const emails = ["atharva.test@vitstudent.ac.in", "utkarsh.test@vitstudent.ac.in"];
const registrations = ["26BDS0141", "26BCE0603"];

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
  const students = [await account(backend, emails[0]!, `Atharva Test ${registrations[0]}`),
    await account(backend, emails[1]!, `Utkarsh Test ${registrations[1]}`)];
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
      publishedAdmissionPolicyId: admissionPolicyId, admissionResultsReleasedAt: now - 1000 });
    const bucketId = await ctx.db.insert("admissionCapacityBuckets", { eventId, admissionPolicyVersionId: admissionPolicyId, capacity: 100, reserved: 0, version: 1, updatedAt: now });
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
      status: "admitted", activeMemberCount: 3, activeVitMemberCount: 3, activeExternalMemberCount: 0,
      membershipLocked: true, lockParticipantPolicyVersionId: policyId, lockedAt: now - 120_000,
      version: 5, createdAt: now - 3_600_000, updatedAt: now });
    const teamMemberIds = [];
    for (const [i, membershipId] of membershipIds.entries()) {
      teamMemberIds.push(await ctx.db.insert("teamMembers", { eventId, teamId, membershipId,
        role: i === 0 ? "lead" : "member", status: "active", source: "backfill", joinedAt: now - 3_600_000 }));
    }
    const attemptId = await createTestSubmissionSnapshot(ctx, { eventId, teamId, teamMemberIds,
      intakePolicyVersionId: intakePolicyId, participantPolicyVersionId: policyId,
      admissionPolicyVersionId: admissionPolicyId, submittedAt: now - 120_000 });
    const projectId = await ctx.db.insert("projectVersions", { eventId, teamId, version: 1, initialIdea: "An unchanged accepted idea",
      intakePolicyVersionId: intakePolicyId, intakeResponses: [], lockedRosterSnapshotId: attemptId,
      lockedMemberCount: 3, lockedLeadMembershipId: leadId,
      freshForEventAttestation: { participantPolicyVersionId: policyId, acceptedByMembershipId: leadId, acceptedAt: now - 120_000 },
      finalConfirmation: { participantPolicyVersionId: policyId, previewedDraftVersion: 1, previewedTeamVersion: 3,
        confirmedByMembershipId: leadId, confirmedAt: now - 120_000 },
      participantPolicyVersionId: policyId, admissionPolicyVersionId: admissionPolicyId,
      sourceDraftVersion: 1, submittedByMembershipId: leadId, submittedAt: now - 120_000 });
    const applicationId = await ctx.db.insert("applications", { eventId, teamId, submittedProjectVersionId: projectId,
      admissionPolicyVersionId: admissionPolicyId, state: "accepted", experienceBand: "first_year",
      humanDecision: "accept", humanReasonCode: "clear_and_workable", aiDisposition: "cleared", decisionStage: "released",
      assignedReviewCount: 2, completedReviewCount: 2, contentVersion: 2, version: 10, submittedAt: now - 120_000 });
    await linkTestSubmissionSnapshot(ctx, { submissionAttemptId: attemptId, projectVersionId: projectId, applicationId });
    await ctx.db.patch(teamId, { lockedProjectVersionId: projectId });
    const importId = await ctx.db.insert("teamRosterImports", { eventId, sourceName: "Original roster", previewChecksum: "fixture",
      rowCount: 5, createdCount: 5, replacedCount: 0, alreadyAssignedCount: 0, choiceRequiredCount: 0,
      waitingForLeadCount: 0, identityConflictCount: 0, appliedNowCount: 0, reason: "Original participant list",
      authorizingGrantIds: [], createdByPersonId: adminId, clientOperationId: "fixture-import", createdAt: now - 3_600_000 });
    const entryIds = [];
    for (const [i, reg] of registrations.entries()) {
      entryIds.push(await ctx.db.insert("teamRosterEntries", { eventId, teamRosterImportId: importId, sourceRowNumber: i + 4,
        vitRegistrationNumber: reg, displayName: reg, teamName: "VANTAGE", role: "member", status: "pending", version: 1,
        createdByPersonId: adminId, createdAt: now - 3_600_000 }));
    }
    return { eventId, teamId, bucketId, applicationId, projectId, attemptId, entryIds, policyId, adminId,
      adminSubjectId: subjectId, expiresAt: now + 43_200_000 };
  });
  return { backend, admin, students, ...seed };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

test.each(["success", "capacity", "mixed-class", "event-started"] as const)("operator roster move: %s", async kind => {
  const f = await fixture();
  const setup = await f.backend.run(async ctx => {
    const now = Date.now();
    await ctx.db.insert("eventRoles", { eventId: f.eventId, personId: f.adminId,
      eventAccessSubjectId: f.adminSubjectId, role: "supreme", validFrom: now - 1,
      status: "active", sourceType: "manual", sourceId: "operator-move-test",
      assignedByPersonId: f.adminId, createdAt: now, reason: "Operator roster move test" });
    const personId = await ctx.db.insert("people", { authUserId: "moved-person",
      verifiedEmail: "moved.person@vitstudent.ac.in", displayName: "Moved Person",
      status: "active", createdAt: now, updatedAt: now });
    const subjectId = await ctx.db.insert("eventAccessSubjects", { eventId: f.eventId, personId,
      emailNormalized: "moved.person@vitstudent.ac.in", displayName: "Moved Person", status: "active",
      linkedBy: "participant_provisioning", accessVersion: 1, createdAt: now, updatedAt: now });
    const membershipId = await ctx.db.insert("eventMemberships", { eventId: f.eventId, personId,
      eventAccessSubjectId: subjectId, participantClass: "vit_student",
      vitStudentIdentity: { fullName: "Moved Person", registrationNumber: "24BEL0054",
        programmeCode: "BEL", yearOfStudy: "third" }, eligibilityStatus: "eligible",
      onboardingStatus: "project_required", acceptedParticipantPolicyVersionIds: [f.policyId],
      googleHostedDomain: "vitstudent.ac.in", createdAt: now, updatedAt: now });
    await ctx.db.insert("participantProfiles", { eventId: f.eventId, membershipId,
      participantClass: "vit_student", fullName: "Moved Person", phone: "+919000000001",
      gender: "female", institution: "VIT Vellore", yearOfStudy: "third",
      vitRegistrationNumber: "24BEL0054", vitProgramme: "BEL", vitResidenceType: "day_scholar",
      profileVersion: 1, updatedAt: now });
    const sourceTeamId = await ctx.db.insert("teams", { eventId: f.eventId, name: "Source team",
      publicCode: "SOURCE1", leadMembershipId: membershipId, status: "forming",
      activeMemberCount: 1, activeVitMemberCount: 1, activeExternalMemberCount: 0,
      membershipLocked: false, version: 1, createdAt: now, updatedAt: now });
    await ctx.db.insert("teamMembers", { eventId: f.eventId, teamId: sourceTeamId, membershipId,
      role: "lead", status: "active", source: "created", joinedAt: now });
    return { personId, membershipId, sourceTeamId };
  });
  const args = { eventSlug, personId: setup.personId, sourceTeamId: setup.sourceTeamId,
    expectedSourceTeamVersion: 1, targetTeamId: f.teamId, expectedTargetTeamVersion: 5, clientOperationId: "roster-move-fixture",
    reason: "Move participant into the organizer-approved accepted team" };
  if (kind !== "success") {
    await f.backend.run(async ctx => {
      if (kind === "capacity") await ctx.db.patch(f.bucketId, { capacity: 3 });
      if (kind === "mixed-class") await ctx.db.patch(setup.membershipId, { participantClass: "external_participant" });
      if (kind === "event-started") await ctx.db.patch(f.eventId, { startsAt: Date.now() - 1 });
    });
    await expect(f.admin.client.mutation(api.operatorRosterMoves.moveSoleMemberIntoAcceptedTeam, args)).rejects.toThrow();
    await f.backend.run(async ctx => {
      expect(await ctx.db.get(setup.sourceTeamId)).toMatchObject({ status: "forming", activeMemberCount: 1 });
      expect(await ctx.db.get(f.teamId)).toMatchObject({ activeMemberCount: 3, version: 5 });
      expect(await ctx.db.query("projectVersions").collect()).toHaveLength(1);
    });
    return;
  }
  const result = await f.admin.client.mutation(api.operatorRosterMoves.moveSoleMemberIntoAcceptedTeam, args);
  expect(await f.admin.client.mutation(api.operatorRosterMoves.moveSoleMemberIntoAcceptedTeam, args)).toEqual(result);
  await expect(f.admin.client.mutation(api.operatorRosterMoves.moveSoleMemberIntoAcceptedTeam, {
    ...args, reason: "Different move request with the same operation ID",
  })).rejects.toThrow("already used");
  await f.backend.run(async ctx => {
    expect(await ctx.db.get(setup.sourceTeamId)).toMatchObject({ status: "withdrawn", activeMemberCount: 0 });
    const target = await ctx.db.get(f.teamId);
    expect(target).toMatchObject({ status: "admitted", activeMemberCount: 4, version: 6 });
    expect(await ctx.db.get(f.applicationId)).toMatchObject({ state: "accepted", humanDecision: "accept",
      completedReviewCount: 2, contentVersion: 2, version: 11, experienceBand: "mixed_or_external",
      submittedProjectVersionId: target!.lockedProjectVersionId });
    expect(await ctx.db.get(f.projectId)).toMatchObject({ lockedMemberCount: 3 });
    expect(await ctx.db.get(target!.lockedProjectVersionId!)).toMatchObject({ lockedMemberCount: 4,
      initialIdea: "An unchanged accepted idea" });
    expect(await ctx.db.query("admissionOffers").take(1)).toEqual([]);
    expect((await ctx.db.query("auditEvents").collect()).some(row =>
      row.action === "team.operator_member_moved" && row.actorPersonId === f.adminId)).toBe(true);
  });
});

function approval(f: Fixture, i = 0) {
  return { eventSlug, teamId: f.teamId, rosterEntryId: f.entryIds[i]!, email: emails[i]!,
    vitRegistrationNumber: registrations[i]!, expiresAt: f.expiresAt, reason: "Recover this previously imported VANTAGE member" };
}
async function ready(f: Fixture, i = 0) {
  const client = f.students[i]!.client;
  const { membershipId } = await client.mutation(api.participants.provision, { eventSlug, participantClass: "vit_student" });
  await client.mutation(api.participants.acceptPolicy, { eventSlug, participantPolicyVersionId: f.policyId,
    accepted: true, clientOperationId: `accept-policy-${i}` });
  await client.mutation(api.participants.saveProfile, { eventSlug, participantPolicyVersionId: f.policyId,
    phone: "+919000000000", gender: "male", vitResidenceType: "day_scholar", expectedProfileVersion: 0,
    clientOperationId: `save-profile-${i}` });
  await f.backend.run(async ctx => {
    const membership = await ctx.db.get(membershipId);
    if (!membership) throw new Error("Missing test membership");
    await ctx.db.insert("githubStarCompletions", { eventId: f.eventId, membershipId, personId: membership.personId,
      githubUserId: `fixture-${i}`, githubLogin: `fixture-${i}`, repositoryOwner: "sgl-project", repositoryName: "sglang",
      completedAt: Date.now() });
  });
  return membershipId;
}
function accept(f: Fixture, i = 0) {
  return f.students[i]!.client.mutation(api.teams.acceptAssignedTeam, { eventSlug, teamRosterEntryId: f.entryIds[i]!,
    expectedEntryVersion: 1, currentTeam: null, clientOperationId: `accept-recovered-team-${i}` });
}

describe("approved roster recovery", () => {
  test("recovers both members with real consent and keeps the accepted idea and old snapshots unchanged", async () => {
    const f = await fixture();
    const original = await f.backend.run(async ctx => ({ app: await ctx.db.get(f.applicationId), project: await ctx.db.get(f.projectId) }));
    for (let i = 0; i < 2; i++) {
      const id = await f.admin.client.mutation(api.rosterRecovery.approve, approval(f, i));
      expect(await f.admin.client.mutation(api.rosterRecovery.approve, approval(f, i))).toEqual(id);
      expect(await f.students[i]!.client.query(api.rosterRecovery.current, { eventSlug, now: Date.now() })).toMatchObject({ teamName: "VANTAGE" });
      await ready(f, i);
      expect(await f.backend.run(ctx => ctx.db.get(f.teamId))).toMatchObject({ activeMemberCount: 3 + i });
      const result = await accept(f, i);
      expect(await accept(f, i)).toEqual(result);
    }
    await f.backend.run(async ctx => {
      const team = await ctx.db.get(f.teamId);
      const app = await ctx.db.get(f.applicationId);
      expect(team).toMatchObject({ activeMemberCount: 5, activeVitMemberCount: 5, status: "admitted", membershipLocked: true });
      expect(app).toEqual({ ...original.app, submittedProjectVersionId: team!.lockedProjectVersionId, version: 12 });
      expect(await ctx.db.get(f.projectId)).toEqual(original.project);
      const project = await ctx.db.get(team!.lockedProjectVersionId!);
      expect(project).toMatchObject({ initialIdea: original.project!.initialIdea, lockedMemberCount: 5,
        submittedAt: original.project!.submittedAt, finalConfirmation: original.project!.finalConfirmation });
      expect(await ctx.db.get(f.eventId)).toMatchObject({ status: "registration_closed", version: 1 });
      expect(await ctx.db.query("participantRosterRecoveries").take(10)).toHaveLength(2);
      expect((await ctx.db.query("participantRosterRecoveries").take(10)).every(r => r.status === "completed")).toBe(true);
      expect(await ctx.db.query("admissionOffers").take(1)).toEqual([]);
      expect(await ctx.db.query("participantNotificationDeliveries").take(1)).toEqual([]);
    });
  });

  test("requires operator permissions, an exact approved identity, consent, profile and GitHub completion", async () => {
    const f = await fixture();
    await expect(f.students[0]!.client.mutation(api.rosterRecovery.approve, approval(f))).rejects.toThrow();
    await expect(f.students[0]!.client.mutation(api.participants.provision, { eventSlug, participantClass: "vit_student" })).rejects.toThrow("Applications are closed");
    await f.admin.client.mutation(api.rosterRecovery.approve, approval(f));
    expect(await f.students[1]!.client.query(api.rosterRecovery.current, { eventSlug, now: Date.now() })).toBeNull();
    await expect(f.students[1]!.client.mutation(api.participants.provision, { eventSlug, participantClass: "vit_student" })).rejects.toThrow("Applications are closed");
    await f.students[0]!.client.mutation(api.participants.provision, { eventSlug, participantClass: "vit_student" });
    await expect(f.students[0]!.client.mutation(api.rosterRecovery.approve, approval(f, 1))).rejects.toThrow();
    await expect(accept(f)).rejects.toThrow("Accept the current participant policy");
    await f.students[0]!.client.mutation(api.participants.acceptPolicy, { eventSlug, participantPolicyVersionId: f.policyId,
      accepted: true, clientOperationId: "consent-gating-check" });
    await expect(accept(f)).rejects.toThrow("Complete your participant details");
    await f.students[0]!.client.mutation(api.participants.saveProfile, { eventSlug, participantPolicyVersionId: f.policyId,
      phone: "+919000000000", gender: "male", vitResidenceType: "day_scholar", expectedProfileVersion: 0,
      clientOperationId: "profile-gating-check" });
    await expect(accept(f)).rejects.toThrow("star sgl-project/sglang");
    await expect(f.students[0]!.client.mutation(api.teams.create, { eventSlug, name: "Another team", clientOperationId: "new-team-denied" })).rejects.toThrow("Applications are closed");
    await expect(f.students[0]!.client.mutation(api.intake.submit, { eventSlug, participantPolicyVersionId: f.policyId,
      expectedDraftVersion: 1, expectedTeamVersion: 1, clientOperationId: "new-idea-denied" })).rejects.toThrow();
    expect(await f.backend.run(ctx => ctx.db.get(f.teamId))).toMatchObject({ activeMemberCount: 3 });
  });

  test("expiry, revocation and wrong-registration approvals do not open onboarding", async () => {
    const f = await fixture();
    await expect(f.admin.client.mutation(api.rosterRecovery.approve, { ...approval(f), vitRegistrationNumber: "26BCE9999" })).rejects.toThrow();
    const id = await f.admin.client.mutation(api.rosterRecovery.approve, approval(f));
    expect(await f.students[0]!.client.query(api.rosterRecovery.current, { eventSlug, now: f.expiresAt })).toBeNull();
    await f.admin.client.mutation(api.rosterRecovery.revoke, { recoveryId: id, reason: "Operator cancelled the test recovery" });
    await expect(f.students[0]!.client.mutation(api.participants.provision, { eventSlug, participantClass: "vit_student" })).rejects.toThrow("Applications are closed");
  });

  test("rolls back a roster claim if the accepted application can no longer be recovered", async () => {
    const f = await fixture();
    await f.admin.client.mutation(api.rosterRecovery.approve, approval(f));
    await ready(f);
    await f.backend.run(ctx => ctx.db.patch(f.applicationId, { state: "offer_sent" }));
    await expect(accept(f)).rejects.toThrow();
    expect(await f.backend.run(ctx => ctx.db.get(f.teamId))).toMatchObject({ activeMemberCount: 3 });
    expect(await f.backend.run(ctx => ctx.db.get(f.entryIds[0]!))).toMatchObject({ status: "pending" });
  });

  test("rolls back member insertion when the locked snapshot fails validation", async () => {
    const f = await fixture();
    await f.admin.client.mutation(api.rosterRecovery.approve, approval(f));
    await ready(f);
    await f.backend.run(ctx => ctx.db.patch(f.projectId, { lockedMemberCount: 4 }));
    await expect(accept(f)).rejects.toThrow();
    expect(await f.backend.run(ctx => ctx.db.get(f.teamId))).toMatchObject({ activeMemberCount: 3, version: 5 });
    expect(await f.backend.run(ctx => ctx.db.get(f.entryIds[0]!))).toMatchObject({ status: "pending", version: 1 });
  });

  test("rejects expired mutations and registration-number mismatches even with an approved email", async () => {
    const f = await fixture();
    const id = await f.admin.client.mutation(api.rosterRecovery.approve, approval(f));
    await f.backend.run(ctx => ctx.db.patch(id, { expiresAt: Date.now() - 1 }));
    await expect(f.students[0]!.client.mutation(api.participants.provision, { eventSlug, participantClass: "vit_student" })).rejects.toThrow("Applications are closed");
    await f.backend.run(ctx => ctx.db.patch(id, { expiresAt: f.expiresAt, emailNormalized: emails[1]! }));
    expect(await f.students[1]!.client.query(api.rosterRecovery.current, { eventSlug, now: Date.now() })).toBeNull();
    await expect(f.students[1]!.client.mutation(api.participants.provision, { eventSlug, participantClass: "vit_student" })).rejects.toThrow("Applications are closed");
  });
});


test("recovery checks the full selected cohort and rolls back a claim when capacity is exhausted", async () => {
  const f = await fixture();
  await f.admin.client.mutation(api.rosterRecovery.approve, approval(f));
  await ready(f);
  await f.backend.run(ctx => ctx.db.patch(f.bucketId, { capacity: 3 }));
  await expect(accept(f)).rejects.toThrow("capacity");
  await f.backend.run(async ctx => {
    expect(await ctx.db.get(f.teamId)).toMatchObject({ activeMemberCount: 3 });
    expect(await ctx.db.get(f.entryIds[0]!)).toMatchObject({ status: "pending" });
    expect(await ctx.db.query("projectVersions").collect()).toHaveLength(1);
  });
});

test("an approved recovery works for a team beyond first year and updates its experience category", async () => {
  const f = await fixture();
  await f.backend.run(async ctx => {
    const profiles = await ctx.db.query("participantProfiles").collect();
    for (const profile of profiles) await ctx.db.patch(profile._id, { yearOfStudy: "third" });
    await ctx.db.patch(f.applicationId, { experienceBand: "later_year" });
  });
  await f.admin.client.mutation(api.rosterRecovery.approve, approval(f));
  await ready(f);
  await accept(f);
  expect(await f.backend.run(ctx => ctx.db.get(f.applicationId)))
    .toMatchObject({ state: "accepted", experienceBand: "mixed_or_external" });
});
