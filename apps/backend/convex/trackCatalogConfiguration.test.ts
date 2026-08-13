import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
} from "./lib/intakePolicy.ts";
import {
  loadTrackCatalogTracks,
  maximumSponsorTrackCount,
  publishTrackCatalog,
  requirePinnedTrackCatalog,
  requireSponsorTrackSelection,
  saveTrackCatalogDraft,
  trackCatalogChecksum,
  type TrackCatalogTrack,
} from "./lib/trackCatalog.ts";
import schema from "./schema.ts";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
type BackendTest = TestConvex<typeof schema>;

describe("track catalog configuration", () => {
  test("publishes the configured core-track count and bounds reads from that version", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const threeCoreTracks = tracks("three").slice(0, 3);
    expect(trackCatalogChecksum(3, threeCoreTracks)).not.toBe(
      trackCatalogChecksum(5, threeCoreTracks),
    );

    const draft = await backend.run((ctx) =>
      saveTrackCatalogDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        requiredCoreTrackCount: 3,
        tracks: threeCoreTracks,
        now: fixture.now + 1,
      }),
    );
    await backend.run((ctx) =>
      publishTrackCatalog(ctx, {
        event: fixture.event,
        draftCatalogId: draft.catalogVersionId,
        expectedDraftChecksum: draft.checksum,
        now: fixture.now + 2,
      }),
    );

    const published = await backend.run(async (ctx) => ({
      catalog: await ctx.db.get(draft.catalogVersionId),
      tracks: await loadTrackCatalogTracks(ctx, draft.catalogVersionId),
    }));
    expect(published.catalog?.requiredCoreTrackCount).toBe(3);
    expect(published.tracks.map((track) => track.displayName)).toEqual(
      threeCoreTracks.map((track) => track.displayName),
    );

    await expect(
      backend.run((ctx) =>
        saveTrackCatalogDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          requiredCoreTrackCount: 4,
          tracks: threeCoreTracks,
          now: fixture.now + 3,
        }),
      ),
    ).rejects.toThrow("must contain 4 core tracks");
  });

  test("publishes a new default without moving an active participant draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const nextTracks = tracks("v2");
    const firstTrack = nextTracks[0];
    if (!firstTrack) throw new Error("The fixture needs a first track.");
    nextTracks[0] = {
      ...firstTrack,
      displayName: "Human-centered systems",
    };
    const draft = await backend.run((ctx) =>
      saveTrackCatalogDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        requiredCoreTrackCount: 5,
        tracks: nextTracks,
        now: fixture.now + 1,
      }),
    );
    const published = await backend.run((ctx) =>
      publishTrackCatalog(ctx, {
        event: fixture.event,
        draftCatalogId: draft.catalogVersionId,
        expectedDraftChecksum: draft.checksum,
        now: fixture.now + 2,
      }),
    );

    expect(published.catalogVersion).toBe(2);
    const state = await backend.run(async (ctx) => {
      const event = await ctx.db.get(fixture.event._id);
      const oldCatalog = await ctx.db.get(fixture.catalogId);
      const newCatalog = await ctx.db.get(draft.catalogVersionId);
      const participantDraft = await ctx.db.get(fixture.projectDraftId);
      if (!participantDraft) throw new Error("The participant draft is missing.");
      const pin = await requirePinnedTrackCatalog(ctx, participantDraft);
      return {
        eventCatalogId: event?.publishedTrackCatalogId,
        eventVersion: event?.version,
        oldStatus: oldCatalog?.status,
        newStatus: newCatalog?.status,
        participantCatalogId: pin.catalog._id,
        participantTrackNames: pin.tracks.map((track) => track.displayName),
      };
    });
    expect(state).toEqual({
      eventCatalogId: draft.catalogVersionId,
      eventVersion: 2,
      oldStatus: "superseded",
      newStatus: "published",
      participantCatalogId: fixture.catalogId,
      participantTrackNames: tracks("v1").map((track) => track.displayName),
    });
  });

  test("rejects publication of a replaced draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const first = await backend.run((ctx) =>
      saveTrackCatalogDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        requiredCoreTrackCount: 5,
        tracks: tracks("first"),
        now: fixture.now + 1,
      }),
    );
    const second = await backend.run((ctx) =>
      saveTrackCatalogDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        requiredCoreTrackCount: 5,
        tracks: tracks("second"),
        expectedDraftCatalogId: first.catalogVersionId,
        now: fixture.now + 2,
      }),
    );

    await expect(
      backend.run((ctx) =>
        publishTrackCatalog(ctx, {
          event: fixture.event,
          draftCatalogId: first.catalogVersionId,
          expectedDraftChecksum: first.checksum,
          now: fixture.now + 3,
        }),
      ),
    ).rejects.toThrow("changed in another session");
    const state = await backend.run(async (ctx) => ({
      event: await ctx.db.get(fixture.event._id),
      first: await ctx.db.get(first.catalogVersionId),
      second: await ctx.db.get(second.catalogVersionId),
    }));
    expect(state.event?.publishedTrackCatalogId).toBe(fixture.catalogId);
    expect(state.first?.status).toBe("retired");
    expect(state.second?.status).toBe("draft");
  });

  test("settles an in-flight recommendation against the participant's pinned catalog", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const interpretation = await backend.mutation(
      internal.intelligence.beginIntakeInterpretation,
      { draftId: fixture.projectDraftId, modelAvailable: true },
    );
    if (!interpretation) throw new Error("The intake interpretation did not start.");
    const nextTracks = tracks("new-default");
    const nextDraft = await backend.run((ctx) =>
      saveTrackCatalogDraft(ctx, {
        event: fixture.event,
        actorPersonId: fixture.personId,
        requiredCoreTrackCount: 5,
        tracks: nextTracks,
        now: fixture.now + 1,
      }),
    );
    await backend.run((ctx) =>
      publishTrackCatalog(ctx, {
        event: fixture.event,
        draftCatalogId: nextDraft.catalogVersionId,
        expectedDraftChecksum: nextDraft.checksum,
        now: fixture.now + 2,
      }),
    );

    await backend.mutation(internal.intelligence.finishIntakeInterpretation, {
      interpretationId: interpretation.interpretationId,
      inputFingerprint: interpretation.inputFingerprint,
      state: "succeeded",
      recommendedTrackStableKey: "people",
      recommendationReason: "The idea is centered on a practical community workflow.",
      recommendationSourceAnswerVersionIds: [fixture.initialAnswerId],
      coveragePurposeKeys: ["problem"],
      nextQuestionText: "What should a participant be able to finish with this project?",
      nextQuestionPurposeKey: "event_goal",
      nextQuestionAnswerLength: "medium",
      nextQuestionSourceAnswerVersionIds: [fixture.initialAnswerId],
      stopReason: "needs_question",
      latencyMs: 120,
    });

    const result = await backend.run(async (ctx) => {
      const participantDraft = await ctx.db.get(fixture.projectDraftId);
      const recommendation = participantDraft?.recommendedCoreTrackVersionId
        ? await ctx.db.get(participantDraft.recommendedCoreTrackVersionId)
        : null;
      return {
        catalogId: recommendation?.catalogVersionId,
        name: recommendation?.displayName,
      };
    });
    expect(result).toEqual({ catalogId: fixture.catalogId, name: "People v1" });
  });

  test("keeps sponsor opt-ins unique and in published catalog order", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const sponsorIds = await backend.run(async (ctx) => {
      const core = await ctx.db
        .query("trackVersions")
        .withIndex("by_catalog_type_order", (index) =>
          index.eq("catalogVersionId", fixture.catalogId).eq("type", "core"),
        )
        .first();
      if (!core) throw new Error("The fixture needs a core track.");
      const first = await ctx.db.insert("trackVersions", {
        eventId: fixture.event._id,
        catalogVersionId: fixture.catalogId,
        stableKey: "sponsor_cloud",
        slug: "sponsor-cloud",
        displayName: "Cloud sponsor",
        description: "Build a useful project with the sponsor's published cloud tools.",
        examples: ["A deployed event workflow"],
        displayOrder: 0,
        type: "sponsor",
        status: "published",
        eligibilityText: "The submitted project must use the sponsor's cloud service.",
        createdAt: fixture.now,
      });
      const second = await ctx.db.insert("trackVersions", {
        eventId: fixture.event._id,
        catalogVersionId: fixture.catalogId,
        stableKey: "sponsor_data",
        slug: "sponsor-data",
        displayName: "Data sponsor",
        description: "Build a useful project with the sponsor's published data tools.",
        examples: ["A data-backed participant tool"],
        displayOrder: 1,
        type: "sponsor",
        status: "published",
        eligibilityText: "The submitted project must use the sponsor's data service.",
        createdAt: fixture.now,
      });
      const foreignCatalogId = await ctx.db.insert("trackCatalogVersions", {
        eventId: fixture.event._id,
        version: 2,
        status: "draft",
        requiredCoreTrackCount: 5,
        checksum: "foreign-catalog",
        createdByPersonId: fixture.personId,
        createdAt: fixture.now,
      });
      const foreign = await ctx.db.insert("trackVersions", {
        eventId: fixture.event._id,
        catalogVersionId: foreignCatalogId,
        stableKey: "foreign_sponsor",
        slug: "foreign-sponsor",
        displayName: "Foreign sponsor",
        description: "A sponsor track that is not part of the participant's pinned catalog.",
        examples: ["A foreign catalog example"],
        displayOrder: 0,
        type: "sponsor",
        status: "draft",
        eligibilityText: "The project must meet a requirement from another catalog.",
        createdAt: fixture.now,
      });
      return { core: core._id, first, second, foreign };
    });
    const ordered = await backend.run(async (ctx) => {
      const draft = await ctx.db.get(fixture.projectDraftId);
      if (!draft) throw new Error("The participant draft is missing.");
      const pinned = await requirePinnedTrackCatalog(ctx, draft);
      return requireSponsorTrackSelection(
        pinned.tracks,
        [sponsorIds.second, sponsorIds.first],
      ).map((track) => track.displayName);
    });
    expect(ordered).toEqual(["Cloud sponsor", "Data sponsor"]);
    await expect(
      backend.run(async (ctx) => {
        const draft = await ctx.db.get(fixture.projectDraftId);
        if (!draft) throw new Error("The participant draft is missing.");
        const pinned = await requirePinnedTrackCatalog(ctx, draft);
        return requireSponsorTrackSelection(
          pinned.tracks,
          [sponsorIds.first, sponsorIds.first],
        );
      }),
    ).rejects.toThrow("selected more than once");
    for (const invalidTrackId of [sponsorIds.core, sponsorIds.foreign]) {
      await expect(
        backend.run(async (ctx) => {
          const draft = await ctx.db.get(fixture.projectDraftId);
          if (!draft) throw new Error("The participant draft is missing.");
          const pinned = await requirePinnedTrackCatalog(ctx, draft);
          return requireSponsorTrackSelection(pinned.tracks, [invalidTrackId]);
        }),
      ).rejects.toThrow("not available in this project intake");
    }
  });

  test("fails loudly before oversized catalog or selection reads can grow", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    await expect(
      backend.run(async (ctx) => {
        const draft = await ctx.db.get(fixture.projectDraftId);
        if (!draft) throw new Error("The participant draft is missing.");
        const pinned = await requirePinnedTrackCatalog(ctx, draft);
        const firstTrack = pinned.tracks[0];
        if (!firstTrack) throw new Error("The pinned catalog is empty.");
        return requireSponsorTrackSelection(
          pinned.tracks,
          Array.from(
            { length: maximumSponsorTrackCount + 1 },
            () => firstTrack._id,
          ),
        );
      }),
    ).rejects.toThrow(`no more than ${maximumSponsorTrackCount} sponsor tracks`);

    await backend.run(async (ctx) => {
      await ctx.db.insert("trackVersions", {
        eventId: fixture.event._id,
        catalogVersionId: fixture.catalogId,
        stableKey: "overflow_core",
        slug: "overflow-core",
        displayName: "Overflow core",
        description: "This direct row simulates a broken catalog owner invariant.",
        examples: ["A catalog overflow"],
        displayOrder: 5,
        type: "core",
        status: "published",
        createdAt: fixture.now,
      });
    });
    await expect(
      backend.run(async (ctx) => {
        const draft = await ctx.db.get(fixture.projectDraftId);
        if (!draft) throw new Error("The participant draft is missing.");
        return requirePinnedTrackCatalog(ctx, draft);
      }),
    ).rejects.toThrow("does not match its published track limits");
  });

  test("allows exactly one concurrent replacement from the same expected draft", async () => {
    const backend = convexTest(schema, modules);
    const fixture = await seedFixture(backend);
    const attempts = await Promise.allSettled([
      backend.run((ctx) =>
        saveTrackCatalogDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          requiredCoreTrackCount: 5,
          tracks: tracks("alpha"),
          now: fixture.now + 1,
        }),
      ),
      backend.run((ctx) =>
        saveTrackCatalogDraft(ctx, {
          event: fixture.event,
          actorPersonId: fixture.personId,
          requiredCoreTrackCount: 5,
          tracks: tracks("beta"),
          now: fixture.now + 1,
        }),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const drafts = await backend.run((ctx) =>
      ctx.db
        .query("trackCatalogVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", fixture.event._id).eq("status", "draft"),
        )
        .collect(),
    );
    expect(drafts).toHaveLength(1);
  });
});

function tracks(suffix: string): TrackCatalogTrack[] {
  return ["people", "health", "climate", "learning", "open"].map(
    (key, displayOrder) => ({
      stableKey: key,
      slug: key,
      displayName: `${key[0]?.toUpperCase()}${key.slice(1)} ${suffix}`,
      description: `Build a practical ${key} project for the event community.`,
      examples: [`A useful ${key} workflow`],
      displayOrder,
      type: "core",
    }),
  );
}

async function seedFixture(backend: BackendTest) {
  const now = Date.UTC(2027, 8, 10, 9, 0, 0);
  return backend.run(async (ctx) => {
    const personId = await ctx.db.insert("people", {
      authUserId: `track-config-user-${now}`,
      googleSubject: `track-config-subject-${now}`,
      verifiedEmail: `track-config-${now}@example.test`,
      displayName: "Mira Shah",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      slug: `track-config-${now}`,
      name: "Code2Create track configuration fixture",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      createdByPersonId: personId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const catalogId = await ctx.db.insert("trackCatalogVersions", {
      eventId,
      version: 1,
      status: "published",
      requiredCoreTrackCount: 5,
      checksum: "fixture-v1",
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    for (const track of tracks("v1")) {
      await ctx.db.insert("trackVersions", {
        eventId,
        catalogVersionId: catalogId,
        ...track,
        status: "published",
        createdAt: now,
      });
    }
    const intakePolicy = normalizeIntakePolicy({
      ...defaultDeterministicIntakePolicy,
      model: {
        mode: "assisted",
        modelId: "intake-test-model",
        systemInstruction:
          "Ask one welcoming, plain-language project question grounded only in the supplied answers. Recommend at most one supplied core track and never judge, rank, reject, or request personal information.",
        instructionVersion: "test-v1",
        schemaVersion: "test-v1",
        redactionVersion: "test-v1",
        questionPolicyVersion: "test-v1",
        evaluationSuiteVersion: "test-v1",
        maxOutputTokens: 500,
        timeoutMs: 8_000,
      },
    });
    const intakePolicyId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...intakePolicy,
      checksum: intakePolicyChecksum(intakePolicy),
      createdByPersonId: personId,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedTrackCatalogId: catalogId,
      publishedIntakePolicyId: intakePolicyId,
    });
    const subjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId,
      emailNormalized: `track-config-${now}@example.test`,
      displayName: "Mira Shah",
      status: "active",
      linkedBy: "participant_provisioning",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId,
      personId,
      eventAccessSubjectId: subjectId,
      participantClass: "external_participant",
      eligibilityStatus: "eligible",
      onboardingStatus: "project_required",
      acceptedParticipantPolicyVersionIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const teamId = await ctx.db.insert("teams", {
      eventId,
      name: "Pinned Petal",
      publicCode: "PINNED1",
      leadMembershipId: membershipId,
      status: "forming",
      activeMemberCount: 1,
      activeVitMemberCount: 0,
      activeExternalMemberCount: 1,
      membershipLocked: false,
      trackLocked: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const projectDraftId = await ctx.db.insert("projectDrafts", {
      eventId,
      teamId,
      trackCatalogVersionId: catalogId,
      intakePolicyVersionId: intakePolicyId,
      stage: "track_selection",
      initialIdea: "A practical project that is still choosing its event track.",
      chosenSponsorTrackVersionIds: [],
      recommendationState: "pending",
      version: 1,
      lastEditedByMembershipId: membershipId,
      updatedAt: now,
    });
    const initialAnswerId = await ctx.db.insert("intakeAnswerVersions", {
      eventId,
      teamId,
      draftId: projectDraftId,
      promptKey: "initial_idea",
      answerVersion: 1,
      value: "A practical project that is still choosing its event track.",
      status: "active",
      writtenByMembershipId: membershipId,
      writtenAt: now,
      clientOperationId: "track-fixture-initial",
    });
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("The event fixture did not persist.");
    return { event, personId, catalogId, projectDraftId, initialAnswerId, now };
  });
}
