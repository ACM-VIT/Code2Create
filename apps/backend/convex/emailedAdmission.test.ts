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
  return { ...seed, backend, admin: admin.client, args: { teamId: seed.teamId, expectedTeamVersion: 5,
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
