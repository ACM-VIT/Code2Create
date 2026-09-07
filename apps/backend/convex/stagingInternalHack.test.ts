import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { defaultParticipantEmailTemplates } from "@code2create/domain";
import { internal } from "./_generated/api";
import { createInitialEvent } from "./system";
import { defaultParticipantPolicy } from "./lib/participantPolicy";
import { defaultDeterministicIntakePolicy } from "./lib/intakePolicy";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
afterEach(() => vi.unstubAllEnvs());
test("staging reset is unavailable in production", async () => {
  vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "production");
  const t = convexTest(schema, modules);
  const eventId = await t.run((ctx) => ctx.db.insert("events", {
    slug: "production", name: "Production", timezone: "Asia/Kolkata",
    status: "registration_closed", vitEmailDomains: [], applicationsCloseAt: 0,
    startsAt: 1, endsAt: 2, version: 1, createdAt: 0, updatedAt: 0,
  }));
  await expect(
    t.mutation(internal.stagingInternalHack.clearOperationalRemainders, { eventId }),
  ).rejects.toThrow("requires staging");
});
test.each([2, 5])(
  "seeds a %i-person locked application, answers and own-team conflicts without sending mail",
  async (size) => {
    vi.stubEnv("C2C_DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("INITIAL_EVENT_SLUG", "internal");
    const t = convexTest(schema, modules);
    const now = Date.now();
    const setup = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("people", {
        authUserId: "owner",
        verifiedEmail: "owner@example.test",
        displayName: "Operator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const owner = await ctx.db.get(ownerId);
      if (!owner) throw new Error("Missing owner");
      const { eventId } = await createInitialEvent(
        ctx,
        {
          eventSlug: "internal",
          eventName: "Internal staging",
          timezone: "Asia/Kolkata",
          applicationsCloseAt: now + 3600000,
          externalApplicationsCloseAt: now + 3600000,
          vitEmailDomains: ["vitstudent.ac.in"],
          participantPolicy: defaultParticipantPolicy,
          admissionPolicyVersion: "internal-v1",
          admissionParticipantCapacity: 1000,
          admissionMinimumHumanReviews: 2,
          intakePolicy: defaultDeterministicIntakePolicy,
          communicationsPolicy: {
            venueName: "Internal",
            startsAt: now + 7200000,
            endsAt: now + 14400000,
            nextSteps: [
              {
                stableKey: "rsvp",
                title: "Confirm your spot",
                detail: "Team lead confirms in staging.",
              },
            ],
            discordUrl: "https://discord.gg/code2create",
            discordLabel: "Discord",
            notificationProvider: "cloudflare_email",
            emailTemplates: defaultParticipantEmailTemplates(),
          },
          integrationPolicy: {
            version: "internal-v1",
            requiredGitHubTopic: "internal",
            maxActiveGitHubRepositoriesPerTeam: 10,
            },
        },
        owner,
        "registration_open",
      );
      const people = [];
      for (let i = 0; i < size; i++)
        people.push(
          await ctx.db.insert("people", {
            authUserId: `person-${i}`,
            verifiedEmail: `person${i}@vitstudent.ac.in`,
            displayName: `Person ${i}`,
            status: "active",
            createdAt: now,
            updatedAt: now,
          }),
        );
      return { eventId, ownerPersonId: ownerId, people };
    });
    await t.run(async (ctx) => {
      const event = await ctx.db.get(setup.eventId);
      if (!event?.publishedCommunicationsPolicyId) throw new Error("Missing communications");
      const policy = await ctx.db.get(event.publishedCommunicationsPolicyId);
      if (!policy) throw new Error("Missing communications");
      await ctx.db.patch(policy._id, { emailTemplates: policy.emailTemplates.slice(0, 3) });
    });
    const other = await t.run(async (ctx) => {
      const event = await ctx.db.get(setup.eventId);
      if (!event) throw new Error("Missing event");
      const { _id, _creationTime, ...fields } = event;
      const eventId = await ctx.db.insert("events", { ...fields, slug: "unrelated" });
      const bucket = await ctx.db.query("admissionCapacityBuckets").first();
      if (!bucket) throw new Error("Missing bucket");
      const { _id: bucketId, _creationTime: _bucketTime, ...bucketFields } = bucket;
      const policy = await ctx.db.get(bucket.admissionPolicyVersionId);
      if (!policy) throw new Error("Missing admission policy");
      const { _id: _policyId, _creationTime: _policyTime, ...policyFields } = policy;
      const admissionPolicyVersionId = await ctx.db.insert("admissionPolicyVersions", { ...policyFields, eventId });
      const otherBucketId = await ctx.db.insert("admissionCapacityBuckets", {
        ...bucketFields, eventId, admissionPolicyVersionId, reserved: 17,
      });
      await ctx.db.patch(bucketId, { reserved: 9 });
      return { eventId, bucketId: otherBucketId };
    });
    await t.mutation(internal.stagingInternalHack.prepare, {
      eventId: setup.eventId,
      startsAt: now + 7200000,
      endsAt: now + 14400000,
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(other.bucketId))?.reserved).toBe(17);
      expect((await ctx.db.query("admissionCapacityBuckets")
        .withIndex("by_event", (q) => q.eq("eventId", setup.eventId)).unique())?.reserved).toBe(0);
    });
    const args = {
      ...setup,
      number: 1,
      name: "Seeded team",
      idea: "A campus navigation app with accessible routes and live building access information.",
    };
    const id = await t.mutation(internal.stagingInternalHack.populateTeam, args);
    expect(await t.mutation(internal.stagingInternalHack.populateTeam, args)).toBe(id);
    expect(
      await t.mutation(internal.stagingInternalHack.completeFixtureProfiles, {
        eventId: setup.eventId,
      }),
    ).toBe(size);
    await t.run(async (ctx) => {
      const team = await ctx.db.get(id);
      expect(team?.activeMemberCount).toBe(size);
      expect(team?.status).toBe("admitted");
      const project = team?.lockedProjectVersionId
        ? await ctx.db.get(team.lockedProjectVersionId)
        : null;
      expect(project?.intakeResponses.length).toBeGreaterThanOrEqual(2);
      expect(project?.lockedMemberCount).toBe(size);
      expect((await ctx.db.query("reviewerConflicts").collect()).length).toBe(size);
      expect(await ctx.db.query("admissionOffers").collect()).toHaveLength(0);
      expect(await ctx.db.query("participantNotificationDeliveries").collect()).toHaveLength(0);
    });
    await t.mutation(internal.stagingInternalHack.sendTeamOffer, {
      eventId: setup.eventId,
      teamId: id,
      ownerPersonId: setup.ownerPersonId,
      expiresAt: now + 3600000,
    });
    const offerId = await t.run(async (ctx) => {
      const offer = await ctx.db.query("admissionOffers").first();
      if (!offer) throw new Error("Offer missing");
      await ctx.db.patch(offer._id, { expiresAt: now - 1 });
      return offer._id;
    });
    await t.mutation(internal.admissions.expireOffer, { offerId, expectedOfferVersion: 1 });
    const roundId = await t.run(async (ctx) => {
      const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
        eventId: setup.eventId,
        version: 1,
        name: "Internal rubric",
        status: "published",
        scoreMinimum: 0,
        scoreMaximum: 4,
        aggregationFormula: "criterion_mean_weighted_v1",
        spreadThreshold: 2,
        checksum: "fixture",
        createdByPersonId: setup.ownerPersonId,
        createdAt: now,
      });
      return ctx.db.insert("reviewRounds", {
        eventId: setup.eventId,
        rubricVersionId,
        stableKey: "internal_review_1",
        name: "Review 1",
        sequence: 1,
        status: "open",
        startsAt: now - 1000,
        openedAt: now - 1000,
        endsAt: now + 14400000,
        reviewerReportAt: now - 601000,
        correctionRequestsCloseAt: now + 14400000,
        noShowGraceSeconds: 300,
        reviewDurationSeconds: 420,
        ordinaryExtensionSeconds: 60,
        maximumOrdinaryExtensions: 1,
        missedCallGraceSeconds: 120,
        requiredCallAttempts: 2,
        substituteResponseSeconds: 60,
        missedReentryPolicy: "preserve_queue_time",
        requiredPanelSize: 3,
        staffing: {
          allowSeniorLeadFallback: false,
          assignmentReminderCalls: false,
          assignmentReminderSeconds: 300,
          automaticReplacement: false,
          juniorRotationReviews: 1,
          juniorSeats: 1,
          reviewerArrivalSeconds: 90,
          seniorSeats: 1,
        },
        minimumScorersPerCriterion: 2,
        minimumPresentParticipants: 1,
        requiresSharedCommitments: true,
        requiresFinalComment: true,
        minimumReviewerBuild: 1,
        requiresCamera: false,
        requiresNotifications: false,
        version: 2,
        configurationChecksum: "fixture",
        createdByPersonId: setup.ownerPersonId,
        createdAt: now,
      });
    });
    const cleanup = await t.run(async (ctx) => {
      const row = { source: "operations_attention" as const, sequence: 1, updatedAt: now };
      const targetRow = await ctx.db.insert("operationsAutonomyReadFactStates", { ...row, eventId: setup.eventId });
      const otherRow = await ctx.db.insert("operationsAutonomyReadFactStates", { ...row, eventId: other.eventId });
      const targetJob = await ctx.scheduler.runAfter(3600000, internal.stagingInternalHack.start,
        { eventId: setup.eventId, startsAt: now });
      const otherJob = await ctx.scheduler.runAfter(3600000, internal.stagingInternalHack.start,
        { eventId: other.eventId, startsAt: now });
      const indirectJob = await ctx.scheduler.runAfter(3600000, internal.stagingInternalHack.openScheduledRound, { roundId });
      return { targetRow, otherRow, targetJob, otherJob, indirectJob };
    });
    expect(await t.mutation(internal.stagingInternalHack.clearOperationalRemainders, { eventId: setup.eventId })).toBeGreaterThan(0);
    expect(await t.mutation(internal.stagingInternalHack.clearOperationalRemainders, { eventId: setup.eventId })).toBe(0);
    await t.mutation(internal.stagingInternalHack.cancelScheduled, { eventId: setup.eventId, cursor: null });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(cleanup.targetRow)).toBeNull();
      expect(await ctx.db.get(cleanup.otherRow)).not.toBeNull();
      expect((await ctx.db.system.get(cleanup.targetJob))?.state.kind).toBe("canceled");
      expect((await ctx.db.system.get(cleanup.otherJob))?.state.kind).toBe("pending");
      expect((await ctx.db.system.get(cleanup.indirectJob))?.state.kind).toBe("pending");
    });
    const startsAt = now + 11400000;
    await t.mutation(internal.stagingInternalHack.rescheduleRound, { roundId, startsAt });
    await t.mutation(internal.stagingInternalHack.rescheduleRound, { roundId, startsAt });
    await t.mutation(internal.stagingInternalHack.openScheduledRound, { roundId });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(roundId)).toMatchObject({
        status: "published",
        startsAt,
        version: 3,
        reviewerReportAt: startsAt - 600000,
      });
    });
    const extension = {
      eventId: setup.eventId,
      ownerPersonId: setup.ownerPersonId,
      expiresAt: now + 10800000,
    };
    expect(await t.mutation(internal.stagingInternalHack.extendRsvp, extension)).toBe(1);
    expect(await t.mutation(internal.stagingInternalHack.extendRsvp, extension)).toBe(0);
    await t.mutation(internal.admissions.expireOffer, { offerId, expectedOfferVersion: 1 });
    await t.run(async (ctx) => {
      const offer = await ctx.db.get(offerId);
      expect(offer?.state).toBe("offered");
      expect(offer?.expiresAt).toBe(extension.expiresAt);
      expect((await ctx.db.get(id))?.status).toBe("admitted");
      const reservations = await ctx.db.query("admissionCapacityReservations").collect();
      expect(reservations.filter((r) => r.state === "active")).toHaveLength(1);
      expect((await ctx.db.query("admissionCapacityBuckets").withIndex("by_event", (q) => q.eq("eventId", setup.eventId)).unique())?.reserved).toBe(size);
    });
  },
);
