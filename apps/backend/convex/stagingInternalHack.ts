import { defaultParticipantEmailTemplates } from "@code2create/domain";
import { participantPolicyChecksum, participantPolicyFromDocument } from "./lib/participantPolicy";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { addEventSubjectSelfGrants, insertPermissionGrant } from "./lib/permissions";
import { addTeamMemberGrants } from "./lib/teamMembership";
import {
  createTestSubmissionSnapshot,
  linkTestSubmissionSnapshot,
} from "./lib/testSubmissionSnapshot";
import { createAdmissionOffer } from "./admissions";
import {
  communicationsPolicyChecksum,
  communicationsPolicyFromDocument,
} from "./lib/communicationsPolicy";

function requireStaging() {
  if (process.env.C2C_DEPLOYMENT_ENVIRONMENT !== "staging")
    throw new ConvexError("Internal hack setup requires staging.");
}
export const populateTeam = internalMutation({
  args: {
    eventId: v.id("events"),
    ownerPersonId: v.id("people"),
    number: v.number(),
    name: v.string(),
    idea: v.string(),
    people: v.array(v.id("people")),
  },
  returns: v.id("teams"),
  handler: async (ctx, args) => {
    requireStaging();
    if (args.people.length < 2 || args.people.length > 5)
      throw new Error("Teams require 2–5 people.");
    const event = await ctx.db.get(args.eventId);
    if (
      !event?.publishedParticipantPolicyId ||
      !event.publishedIntakePolicyId ||
      !event.publishedAdmissionPolicyId
    )
      throw new Error("Bootstrap the staging event first.");
    const existing = await ctx.db
      .query("teams")
      .withIndex("by_event_name", (q) => q.eq("eventId", event._id).eq("name", args.name))
      .unique();
    if (existing) return existing._id;
    const now = Date.now();
    const membershipIds: Id<"eventMemberships">[] = [];
    for (const [index, personId] of args.people.entries()) {
      const person = await ctx.db.get(personId);
      if (!person) throw new Error("Staging participant missing.");
      const existingSubject = await ctx.db
        .query("eventAccessSubjects")
        .withIndex("by_event_person", (q) => q.eq("eventId", event._id).eq("personId", personId))
        .unique();
      const subjectId =
        existingSubject?._id ??
        (await ctx.db.insert("eventAccessSubjects", {
          eventId: event._id,
          personId,
          emailNormalized: person.verifiedEmail,
          displayName: person.displayName,
          status: "active",
          linkedBy: "participant_provisioning",
          accessVersion: 1,
          createdAt: now,
          updatedAt: now,
        }));
      const membershipId = await ctx.db.insert("eventMemberships", {
        eventId: event._id,
        personId,
        eventAccessSubjectId: subjectId,
        participantClass: "vit_student",
        eligibilityStatus: "eligible",
        onboardingStatus: "selected",
        acceptedParticipantPolicyVersionIds: [event.publishedParticipantPolicyId],
        createdAt: now,
        updatedAt: now,
      });
      membershipIds.push(membershipId);
      await ctx.db.insert("participantProfiles", {
        eventId: event._id,
        membershipId,
        participantClass: "vit_student",
        fullName: person.displayName,
        phone: `+1202555${String(100 + ((args.number * 5 + index) % 100)).padStart(4, "0")}`,
        gender: index % 2 === 0 ? "female" : "male",
        institution: "VIT Vellore",
        yearOfStudy: person.verifiedEmail.includes("2025") ? "second" : "third",
        vitRegistrationNumber: `STAGING${String(args.number * 5 + index).padStart(4, "0")}`,
        vitProgramme: "B.Tech — internal test fixture",
        vitResidenceType: "day_scholar",
        profileVersion: 1,
        updatedAt: now,
      });
      await addEventSubjectSelfGrants(ctx, {
        eventId: event._id,
        personId,
        eventAccessSubjectId: subjectId,
      });
      for (const permissionKey of [
        "participant.profile.read",
        "participant.profile.write",
        "team.join",
        "communications.delivery.self.read",
        "attendance.self.read",
        "attendance.remedy.self.read",
        "attendance.remedy.self.open",
        "attendance.external_pass.read",
      ] as const) {
        await insertPermissionGrant(ctx, {
          eventId: event._id,
          personId,
          eventAccessSubjectId: subjectId,
          permissionKey,
          scopeType: "self",
          scopeId: membershipId,
          sourceType: "participant_membership",
          sourceId: membershipId,
          reason: "Staging participant fixture",
        });
      }
    }
    const leadId = membershipIds[0];
    if (!leadId) throw new Error("Staging team lead missing.");
    const teamId = await ctx.db.insert("teams", {
      eventId: event._id,
      name: args.name,
      publicCode: `INT${String(args.number).padStart(4, "0")}`,
      leadMembershipId: leadId,
      status: "admitted",
      activeMemberCount: args.people.length,
      activeVitMemberCount: args.people.length,
      activeExternalMemberCount: 0,
      membershipLocked: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const teamMemberIds: Id<"teamMembers">[] = [];
    for (const [index, membershipId] of membershipIds.entries()) {
      const membership = await ctx.db.get(membershipId);
      if (!membership) throw new Error("Staging membership missing.");
      const teamMemberId = await ctx.db.insert("teamMembers", {
        eventId: event._id,
        teamId,
        membershipId,
        role: index === 0 ? "lead" : "member",
        status: "active",
        joinedAt: now,
        source: index === 0 ? "created" : "code",
      });
      teamMemberIds.push(teamMemberId);
      await ctx.db.insert("reviewerConflicts", {
        eventId: event._id,
        reviewerPersonId: membership.personId,
        teamId,
        kind: "policy",
        reason: "Internal hack: cannot review own team",
        status: "active",
        createdByPersonId: args.ownerPersonId,
        createdAt: now,
      });
      await addTeamMemberGrants(ctx, {
        event,
        membership,
        teamId,
        teamMemberId,
        actorPersonId: args.ownerPersonId,
        lead: index === 0,
      });
    }

    const draftId = await ctx.db.insert("projectDrafts", {
      eventId: event._id,
      teamId,
      intakePolicyVersionId: event.publishedIntakePolicyId,
      stage: "submitted",
      initialIdea: args.idea,
      freshnessAttestedByMembershipId: leadId,
      freshnessAttestedAt: now,
      version: 1,
      lastEditedByMembershipId: leadId,
      updatedAt: now,
    });
    await ctx.db.insert("intakeAnswerVersions", {
      eventId: event._id,
      teamId,
      draftId,
      promptKey: "initial_idea",
      answerVersion: 1,
      value: args.idea,
      status: "active",
      writtenByMembershipId: leadId,
      writtenAt: now,
      clientOperationId: `internal-idea:${teamId}`,
    });
    {
      const snapshotId = await createTestSubmissionSnapshot(ctx, {
        eventId: event._id,
        teamId,
        teamMemberIds,
        intakePolicyVersionId: event.publishedIntakePolicyId,
        participantPolicyVersionId: event.publishedParticipantPolicyId,
        admissionPolicyVersionId: event.publishedAdmissionPolicyId,
        submittedAt: now,
      });
      const intake = await ctx.db.get(event.publishedIntakePolicyId);
      if (!intake) throw new Error("Intake policy missing.");
      const intakeResponses: Doc<"projectVersions">["intakeResponses"] = [];
      for (const question of intake.fallbackQuestions) {
        const answer = `${args.name} is a synthetic internal-hack project for students and event organizers. We will build a working web prototype with a clear onboarding flow, accessible screens, a small backend and realistic demo data. We will validate the main workflow with teammates and show a complete demo at review one. ${args.idea}`;
        const questionId = await ctx.db.insert("intakeGeneratedQuestions", {
          eventId: event._id,
          teamId,
          draftId,
          ordinal: question.ordinal,
          text: question.text,
          purposeKey: question.purposeKey,
          answerLength: question.answerLength,
          source: "fallback",
          sourceAnswerVersionIds: [],
          intakePolicyVersionId: intake._id,
          state: "answered",
          validationCategory: "staging_fixture",
          answeredAt: now,
          createdAt: now,
        });
        await ctx.db.insert("intakeAnswerVersions", {
          eventId: event._id,
          teamId,
          draftId,
          promptKey: `follow_up:${questionId}`,
          generatedQuestionId: questionId,
          answerVersion: 1,
          value: answer,
          status: "active",
          writtenByMembershipId: leadId,
          writtenAt: now,
          clientOperationId: `staging:${questionId}`,
        });
        intakeResponses.push({
          questionId,
          ordinal: question.ordinal,
          question: question.text,
          purposeKey: question.purposeKey,
          answerLength: question.answerLength,
          source: "fallback",
          answer,
        });
      }
      const projectVersionId = await ctx.db.insert("projectVersions", {
        eventId: event._id,
        teamId,
        version: 1,
        initialIdea: args.idea,
        additionalInformation: "Synthetic staging project for exercising event operations.",
        intakePolicyVersionId: event.publishedIntakePolicyId,
        intakeResponses,
        lockedRosterSnapshotId: snapshotId,
        lockedMemberCount: args.people.length,
        lockedLeadMembershipId: leadId,
        freshForEventAttestation: {
          participantPolicyVersionId: event.publishedParticipantPolicyId,
          acceptedByMembershipId: leadId,
          acceptedAt: now,
        },
        finalConfirmation: {
          participantPolicyVersionId: event.publishedParticipantPolicyId,
          previewedDraftVersion: 1,
          previewedTeamVersion: 1,
          confirmedByMembershipId: leadId,
          confirmedAt: now,
        },
        participantPolicyVersionId: event.publishedParticipantPolicyId,
        admissionPolicyVersionId: event.publishedAdmissionPolicyId,
        sourceDraftVersion: 1,
        submittedByMembershipId: leadId,
        submittedAt: now,
      });
      const applicationId = await ctx.db.insert("applications", {
        eventId: event._id,
        teamId,
        submittedProjectVersionId: projectVersionId,
        admissionPolicyVersionId: event.publishedAdmissionPolicyId,
        state: "accepted",
        experienceBand: "mixed_or_external",
        decisionStage: "released",
        ...{
          humanDecision: "accept" as const,
          humanReasonCode: "meets_requirements",
          decidedByPersonId: args.ownerPersonId,
          decidedAt: now,
          releasedByPersonId: args.ownerPersonId,
          releasedAt: now,
        },
        assignedReviewCount: 0,
        completedReviewCount: 0,
        contentVersion: 1,
        version: 1,
        submittedAt: now,
      });
      await linkTestSubmissionSnapshot(ctx, {
        submissionAttemptId: snapshotId,
        projectVersionId,
        applicationId,
      });
      await ctx.db.patch(teamId, {
        lockedProjectVersionId: projectVersionId,
        lockedAt: now,
        lockParticipantPolicyVersionId: event.publishedParticipantPolicyId,
      });
    }
    return teamId;
  },
});

export const prepare = internalMutation({
  args: { eventId: v.id("events"), startsAt: v.number(), endsAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireStaging();
    const event = await ctx.db.get(args.eventId);
    if (!event?.publishedCommunicationsPolicyId) throw new Error("Event policy missing.");
    const policy = await ctx.db.get(event.publishedCommunicationsPolicyId);
    if (!policy) throw new Error("Communications missing.");
    const updates = {
      ...communicationsPolicyFromDocument(policy),
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      emailTemplates: defaultParticipantEmailTemplates().map((template) =>
        template.templateKey === "offer"
          ? {
              ...template,
              subject: "[STAGING INTERNAL HACK] Confirm {{team_name}}",
              text: "Hi {{participant_name}},\n\nYou are on {{team_name}} for our internal staging hack tonight, 5 September. Hack starts 11:00pm IST; review round 1 starts 11:30pm IST; ends 2:00am IST. Your team and project are seeded test data. The team lead must confirm the team's place before 11:00pm: {{portal_url}}\n\nThis is an internal staging test, not your production admission result.",
              html: "<p>Hi {{participant_name}},</p><p>You are on <strong>{{team_name}}</strong> for our internal staging hack tonight, 5 September.</p><p>Hack: 11:00pm IST. Review 1: 11:30pm IST. Ends: 2:00am IST.</p><p>Your team and project are seeded test data. <strong>The team lead must confirm before 11:00pm.</strong></p><p><a href='{{portal_url}}'>Open staging and confirm your team</a></p><p>This is an internal staging test, not your production admission result.</p>",
            }
          : template,
      ),
      venueName: "Code2Create internal hack — staging",
      venueAddress: "Internal online testing",
      nextSteps: [
        {
          stableKey: "review_one",
          title: "Review round 1 at 11:30pm IST",
          detail:
            "Internal hack starts at 11:00pm IST on 5 September. Your team lead must confirm the offer in the staging portal.",
        },
      ],
    };
    await ctx.db.patch(policy._id, { ...updates, checksum: communicationsPolicyChecksum(updates) });
    await ctx.db.patch(event._id, {
      name: "Code2Create · Internal hack (staging)",
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      applicationsCloseAt: Date.now() - 1000,
      externalApplicationsCloseAt: Date.now() - 1000,
      status: "registration_closed",
      version: event.version + 1,
      updatedAt: Date.now(),
    });
    for (const bucket of await ctx.db.query("admissionCapacityBuckets").collect())
      await ctx.db.patch(bucket._id, {
        reserved: 0,
        version: bucket.version + 1,
        updatedAt: Date.now(),
      });
    for (const rosterImport of await ctx.db.query("rosterImports").collect()) {
      if (rosterImport.validUntil > Date.now()) await ctx.scheduler.runAt(rosterImport.validUntil, internal.rosters.expireImportEntries, {rosterImportId:rosterImport._id});
    }
    await ctx.scheduler.runAt(args.startsAt, internal.stagingInternalHack.start, {
      eventId: event._id,
      startsAt: args.startsAt,
    });
    return null;
  },
});
export const start = internalMutation({
  args: { eventId: v.id("events"), startsAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireStaging();
    const event = await ctx.db.get(args.eventId);
    if (event && event.startsAt === args.startsAt && event.status === "registration_closed")
      await ctx.db.patch(event._id, {
        status: "live",
        version: event.version + 1,
        updatedAt: Date.now(),
      });
    return null;
  },
});
export const provisionPerson = internalMutation({
  args: {
    email: v.string(),
    name: v.string(),
    authUserId: v.optional(v.string()),
    role: v.union(v.literal("board"), v.literal("sc"), v.literal("jc")),
    eventId: v.id("events"),
    ownerPersonId: v.id("people"),
  },
  returns: v.id("people"),
  handler: async (ctx, args) => {
    requireStaging();
    const now = Date.now();
    const email = args.email.trim().toLowerCase();
    const existing = await ctx.db
      .query("people")
      .withIndex("by_verified_email", (q) => q.eq("verifiedEmail", email))
      .unique();
    let personId = existing?._id;
    if (!personId) {
      let authUserId = args.authUserId;
      if (!authUserId) {
        const user: unknown = await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "user",
            data: { name: args.name, email, emailVerified: false, createdAt: now, updatedAt: now },
          },
        });
        if (typeof user !== "object" || !user || !("_id" in user) || typeof user._id !== "string")
          throw new Error("Could not provision user.");
        authUserId = user._id;
      }
      personId = await ctx.db.insert("people", {
        authUserId,
        verifiedEmail: email,
        displayName: args.name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    const existingSubject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (q) => q.eq("eventId", args.eventId).eq("personId", personId))
      .unique();
    const subjectId =
      existingSubject?._id ??
      (await ctx.db.insert("eventAccessSubjects", {
        eventId: args.eventId,
        personId,
        emailNormalized: email,
        displayName: args.name,
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      }));
    await addEventSubjectSelfGrants(ctx, {
      eventId: args.eventId,
      personId,
      eventAccessSubjectId: subjectId,
    });
    const roles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event_person_status", (q) =>
        q.eq("eventId", args.eventId).eq("personId", personId).eq("status", "active"),
      )
      .collect();
    if (!roles.some((r) => r.role === args.role))
      await ctx.db.insert("eventRoles", {
        eventId: args.eventId,
        personId,
        eventAccessSubjectId: subjectId,
        role: args.role,
        validFrom: now,
        status: "active",
        sourceType: "manual",
        sourceId: "staging-internal-hack",
        assignedByPersonId: args.ownerPersonId,
        createdAt: now,
        reason: "Internal hack reviewer cohort",
      });
    return personId;
  },
});

export const clearOperationalRemainders = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    requireStaging();
    let count = 0;
    const tables = [
      "supportCases",
      "supportCaseActions",
      "supportCaseStatShards",
      "operationsAutonomyStates",
      "operationsAutonomyReadFactStates",
      "operationsAutonomyReadFacts",
      "operationsHealthSnapshots",
      "operationsIntelligenceOutcomes",
      "operationsIntelligenceEpisodes",
      "operationsIntelligenceEpisodeFacts",
      "operationsIntelligenceFacts",
    ] as const;
    for (const table of tables) {
      const rows = await ctx.db.query(table).take(200);
      for (const row of rows) await ctx.db.delete(row._id);
      count += rows.length;
    }
    return count;
  },
});
export const cancelScheduled = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cursor: v.string(), done: v.boolean(), cancelled: v.number() }),
  handler: async (ctx, args) => {
    requireStaging();
    const page = await ctx.db.system
      .query("_scheduled_functions")
      .paginate({ cursor: args.cursor, numItems: 1000 });
    let cancelled = 0;
    for (const fn of page.page)
      if (fn.state.kind === "pending") {
        await ctx.scheduler.cancel(fn._id);
        cancelled++;
      }
    return { cursor: page.continueCursor, done: page.isDone, cancelled };
  },
});

export const sendTeamOffer = internalMutation({
  args: {
    eventId: v.id("events"),
    teamId: v.id("teams"),
    ownerPersonId: v.id("people"),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireStaging();
    const event = await ctx.db.get(args.eventId);
    if (!event?.publishedAdmissionPolicyId) throw new Error("Policy missing.");
    const teamId = args.teamId;
    const now = Date.now();
    const application = await ctx.db
      .query("applications")
      .withIndex("by_team", (q) => q.eq("teamId", teamId))
      .unique();
    const team = await ctx.db.get(teamId);
    const project = team?.lockedProjectVersionId
      ? await ctx.db.get(team.lockedProjectVersionId)
      : null;
    const policy = await ctx.db.get(event.publishedAdmissionPolicyId);
    if (!application || !team || !project || !policy)
      throw new Error("Seeded application incomplete.");
    if (application.currentOfferId) return null;
    await createAdmissionOffer(ctx, {
      event,
      application,
      team,
      project,
      policy,
      actorPersonId: args.ownerPersonId,
      grantIds: [],
      expiresAt: args.expiresAt,
      now,
    });
    return null;
  },
});
export const scheduleRound = internalMutation({
  args: { roundId: v.id("reviewRounds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireStaging();
    const round = await ctx.db.get(args.roundId);
    if (!round) throw new Error("Round missing.");
    await ctx.scheduler.runAt(
      round.startsAt,
      internal.stagingInternalHack.openScheduledRound,
      args,
    );
    return null;
  },
});
export const openScheduledRound = internalMutation({
  args: { roundId: v.id("reviewRounds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireStaging();
    const round = await ctx.db.get(args.roundId);
    if (!round || round.status !== "published") return null;
    const event = await ctx.db.get(round.eventId);
    if (event?.status !== "live") throw new Error("Internal hack is not live.");
    await ctx.db.patch(round._id, {
      status: "open",
      openedAt: Date.now(),
      version: round.version + 1,
    });
    return null;
  },
});

export const completeFixtureProfiles = internalMutation({args:{eventId:v.id("events")},returns:v.number(),handler:async(ctx,args)=>{requireStaging();const event=await ctx.db.get(args.eventId);if(!event?.publishedParticipantPolicyId)throw new Error("Policy missing.");const policy=await ctx.db.get(event.publishedParticipantPolicyId);if(!policy)throw new Error("Policy missing.");const normalized={...participantPolicyFromDocument(policy),phoneVerificationEnabled:false};await ctx.db.patch(policy._id,{...normalized,checksum:participantPolicyChecksum(normalized)});const profiles=await ctx.db.query("participantProfiles").collect();for(const profile of profiles){if(profile.eventId!==event._id)continue;await ctx.db.patch(profile.membershipId,{vitStudentIdentity:{fullName:profile.fullName,registrationNumber:profile.vitRegistrationNumber??"STAGING",programmeCode:profile.vitProgramme??"Internal fixture",yearOfStudy:profile.yearOfStudy}});}return profiles.length;}});
