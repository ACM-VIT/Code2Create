import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  type ActionCtx,
} from "./_generated/server";
import {
  admissionPolicyChecksum,
  admissionPolicyForConfiguration,
  defaultAdmissionCriteria,
  defaultAdmissionReasonCodes,
  normalizeAdmissionConfiguration,
} from "./lib/admissionPolicy";
import {
  communicationsPolicyChecksum,
  normalizeCommunicationsPolicy,
} from "./lib/communicationsPolicy";
import { attendancePlanChecksum } from "./lib/attendancePlan";
import { floorConfigurationChecksum } from "./lib/floor";
import {
  defaultDeterministicIntakePolicy,
  intakePolicyChecksum,
  normalizeIntakePolicy,
} from "./lib/intakePolicy";
import {
  defaultNoveltyPolicy,
  localNoveltyEmbedding,
  normalizeNoveltyCorpusEntries,
  normalizeNoveltyPolicy,
  noveltyCorpusChecksum,
} from "./lib/novelty";
import {
  defaultOperationsAutonomyPolicy,
  normalizeOperationsAutonomyPolicy,
  operationsAutonomyPolicyChecksum,
} from "./lib/operationsAutonomyPolicy";
import { appendAttendanceStationReadFactById } from "./lib/operationsAutonomyReadFacts/attendanceOperations";
import {
  localBrowserFixtureOrigins,
  requireLocalDeployment,
} from "./lib/localBrowserFixtures";
import {
  defaultParticipantPolicy,
  normalizeParticipantPolicy,
  participantPolicyChecksum,
} from "./lib/participantPolicy";
import {
  addEventSubjectSelfGrants,
  insertPermissionGrantGroup,
  type PermissionGrantPlan,
} from "./lib/permissions";
import {
  normalizePhaseSchedule,
  phaseScheduleChecksum,
} from "./lib/phaseSchedule";
import {
  isPermissionKey,
  permissionCatalog,
} from "./lib/permissionCatalog";
import {
  normalizeProjectCheckpointPlan,
  projectCheckpointPlanChecksum,
} from "./lib/projectCheckpointPlan";
import { fingerprintText } from "./lib/strings";
import { normalizeTrackCatalog, trackCatalogChecksum } from "./lib/trackCatalog";

const localTracks = [
  {
    stableKey: "open_innovation",
    slug: "open-innovation",
    displayName: "Open Innovation",
    description: "Build useful technology for everyday problems and overlooked opportunities.",
    examples: ["Civic tools", "Community platforms", "New digital services"],
  },
  {
    stableKey: "health_wellbeing",
    slug: "health-wellbeing",
    displayName: "Health & Wellbeing",
    description: "Improve physical, mental, or community wellbeing through thoughtful technology.",
    examples: ["Care access", "Healthy routines", "Assistive experiences"],
  },
  {
    stableKey: "future_learning",
    slug: "future-learning",
    displayName: "Future of Learning",
    description: "Rethink how people learn, teach, practise, and collaborate.",
    examples: ["Learning tools", "Peer education", "Creative practice"],
  },
  {
    stableKey: "sustainable_systems",
    slug: "sustainable-systems",
    displayName: "Sustainable Systems",
    description: "Design more resilient places, services, and ways to use resources.",
    examples: ["Climate adaptation", "Waste reduction", "Resource visibility"],
  },
  {
    stableKey: "ai_for_people",
    slug: "ai-for-people",
    displayName: "AI for People",
    description: "Use intelligence responsibly to extend human capability and access.",
    examples: ["Creative copilots", "Accessible AI", "Responsible automation"],
  },
] as const;

const hour = 60 * 60 * 1_000;
const localSeedDate = new Date();
const localEventStartsAt = Date.UTC(
  localSeedDate.getUTCFullYear(),
  localSeedDate.getUTCMonth(),
  localSeedDate.getUTCDate() + 7,
  3,
  30,
);
const localEventEndsAt = localEventStartsAt + 48 * hour;

const localPhases = [
  {
    phaseKey: "introduction",
    displayName: "Welcome",
    description: "Meet the event team, settle into the hall, and understand the build window.",
    startsAt: localEventStartsAt,
    endsAt: localEventStartsAt + hour,
  },
  {
    phaseKey: "ideation",
    displayName: "Shape the idea",
    description: "Choose the problem, user, track, and first version the team can finish here.",
    startsAt: localEventStartsAt + hour,
    endsAt: localEventStartsAt + 4 * hour,
  },
  {
    phaseKey: "build",
    displayName: "Build",
    description: "Make the project work, connect the evidence, and keep the team update current.",
    startsAt: localEventStartsAt + 4 * hour,
    endsAt: localEventStartsAt + 32 * hour,
  },
  {
    phaseKey: "intermediate_update",
    displayName: "Midpoint update",
    description: "Show what works, record the next commitment, and continue the build.",
    startsAt: localEventStartsAt + 32 * hour,
    endsAt: localEventStartsAt + 46 * hour,
  },
  {
    phaseKey: "final_update",
    displayName: "Final handoff",
    description: "Freeze the final project evidence and prepare for the assigned review.",
    startsAt: localEventStartsAt + 46 * hour,
    endsAt: localEventEndsAt,
  },
] as const;

const localCheckpointDefinitions = [
  {
    checkpointKey: "ideation",
    phaseKey: "ideation",
    displayName: "Idea commitment",
    prompt: "What problem and user is your team committing to for this event?",
    followUpQuestion: "What is the smallest useful version you can finish here?",
    graceMinutes: 30,
  },
  {
    checkpointKey: "intermediate_update",
    phaseKey: "intermediate_update",
    displayName: "Midpoint update",
    prompt: "What works now, and what will the team finish next?",
    followUpQuestion: "What is the main risk to that next commitment?",
    graceMinutes: 45,
  },
  {
    checkpointKey: "final_update",
    phaseKey: "final_update",
    displayName: "Final handoff",
    prompt: "What did the team finish, and where can reviewers see it?",
    followUpQuestion: "What should a reviewer try first?",
    graceMinutes: 15,
  },
] as const;

const localNoveltyEntries = [
  {
    sourceKey: "civic-pothole-routing-2025",
    sourceYear: 2025,
    themeLabel: "Civic issue reporting",
    summary:
      "Residents photograph road damage, route it to a municipal team, and follow repair progress.",
    reflectionPrompt:
      "What happens after a report so the issue reaches a repair team and closes the loop?",
  },
  {
    sourceKey: "medicine-routine-2024",
    sourceYear: 2024,
    themeLabel: "Medication routines",
    summary:
      "A mobile companion helps families remember medicine and notice missed daily routines.",
    reflectionPrompt:
      "Which daily obstacle does your approach solve beyond sending another reminder?",
  },
  {
    sourceKey: "campus-navigation-2025",
    sourceYear: 2025,
    themeLabel: "Campus navigation",
    summary:
      "Students find rooms, accessible paths, and live campus services from one map-based guide.",
    reflectionPrompt:
      "Which moment on campus needs information that an ordinary map does not provide?",
  },
  {
    sourceKey: "food-surplus-matching-2024",
    sourceYear: 2024,
    themeLabel: "Food surplus matching",
    summary:
      "Food providers publish safe surplus while nearby community groups coordinate collection.",
    reflectionPrompt:
      "How will the handoff stay timely and trustworthy for both sides?",
  },
  {
    sourceKey: "peer-learning-planner-2025",
    sourceYear: 2025,
    themeLabel: "Peer learning",
    summary:
      "Learners form short study groups around a topic, shared availability, and a concrete goal.",
    reflectionPrompt:
      "What keeps a matched group useful after the first meeting?",
  },
  {
    sourceKey: "waste-sorting-guide-2024",
    sourceYear: 2024,
    themeLabel: "Waste sorting guidance",
    summary:
      "People identify household waste and receive local disposal or reuse instructions.",
    reflectionPrompt:
      "How will the guidance reflect the facilities that are actually available nearby?",
  },
] as const;

const localAttendanceZones = [
  { stableKey: "main_hall", name: "Main hack hall", safeCapacity: 500 },
] as const;

const localAttendanceSessionPlans = [
  {
    stableKey: "hacking_1",
    name: "Hacking session 1",
    kind: "hacking",
    requirement: "required",
    expectedCohort: { kind: "all_admitted" },
    zoneKey: "main_hall",
    startsAfterHours: 1,
    endsAfterHours: 9,
    checkInOpensAfterHours: 0.5,
    checkInClosesAfterHours: 2,
    awayAlertAfterMinutes: 20,
  },
  {
    stableKey: "overnight_1",
    name: "Overnight access 1",
    kind: "overnight_access",
    requirement: "optional",
    expectedCohort: { kind: "all_admitted" },
    zoneKey: "main_hall",
    startsAfterHours: 10,
    endsAfterHours: 22,
    checkInOpensAfterHours: 9.5,
    checkInClosesAfterHours: 12,
    awayAlertAfterMinutes: 25,
  },
  {
    stableKey: "hacking_2",
    name: "Hacking session 2",
    kind: "hacking",
    requirement: "required",
    expectedCohort: { kind: "all_admitted" },
    zoneKey: "main_hall",
    startsAfterHours: 24,
    endsAfterHours: 34,
    checkInOpensAfterHours: 23.5,
    checkInClosesAfterHours: 25,
    awayAlertAfterMinutes: 20,
  },
  {
    stableKey: "overnight_2",
    name: "Overnight access 2",
    kind: "overnight_access",
    requirement: "optional",
    expectedCohort: { kind: "all_admitted" },
    zoneKey: "main_hall",
    startsAfterHours: 35,
    endsAfterHours: 46,
    checkInOpensAfterHours: 34.5,
    checkInClosesAfterHours: 37,
    awayAlertAfterMinutes: 25,
  },
  {
    stableKey: "final_handoff",
    name: "Final handoff",
    kind: "review_preparation",
    requirement: "required",
    expectedCohort: { kind: "all_admitted" },
    zoneKey: "main_hall",
    startsAfterHours: 46,
    endsAfterHours: 48,
    checkInOpensAfterHours: 45.5,
    checkInClosesAfterHours: 47,
    awayAlertAfterMinutes: 15,
  },
] as const;

function localAttendanceSessions(eventStartsAt: number) {
  return localAttendanceSessionPlans.map((session) => ({
    stableKey: session.stableKey,
    name: session.name,
    kind: session.kind,
    requirement: session.requirement,
    expectedCohort: session.expectedCohort,
    zoneKey: session.zoneKey,
    startsAt: eventStartsAt + session.startsAfterHours * hour,
    endsAt: eventStartsAt + session.endsAfterHours * hour,
    checkInOpensAt: eventStartsAt + session.checkInOpensAfterHours * hour,
    checkInClosesAt: eventStartsAt + session.checkInClosesAfterHours * hour,
    awayAlertAfterMinutes: session.awayAlertAfterMinutes,
  }));
}

const localAttendanceStations = [
  {
    stableKey: "main_hall_entry",
    name: "Main hall entry",
    zoneKey: "main_hall",
    mode: "venue_entry" as const,
    allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "portal_qr"] as const,
  },
  {
    stableKey: "main_hall_exit",
    name: "Main hall exit",
    zoneKey: "main_hall",
    mode: "venue_exit" as const,
    allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "portal_qr"] as const,
  },
  {
    stableKey: "hacking_start_confirmation",
    name: "Hacking start confirmation",
    zoneKey: "main_hall",
    mode: "session_confirm" as const,
    sessionKey: "hacking_1",
    allowedCredentialKinds: ["vit_id_barcode", "badge_qr", "portal_qr"] as const,
  },
];

export function localAttendancePlanContent(eventStartsAt: number) {
  return {
    name: "Code2Create hacking sessions",
    // Accept only the Code 128 symbology used by VIT identity cards.
    vitBarcodeSymbologies: ["code128" as const],
    vitBarcodeNormalizationVersion: "trim-v1",
    offlineQueueMaxScans: 8,
    offlineQueueMaxAgeSeconds: 180,
    zones: localAttendanceZones,
    sessions: localAttendanceSessions(eventStartsAt),
    stations: localAttendanceStations,
  };
}

export function localIntegrationPolicy(eventStartsAt: number) {
  return {
    policyVersion: "local-development-v1",
    requiredGitHubTopic: "code2create-7-0",
    maxActiveGitHubRepositoriesPerTeam: 5,
    maxActiveFigmaFilesPerTeam: 5,
    githubFreezeAt: eventStartsAt + 46 * hour,
    figmaFreezeAt: eventStartsAt + 46 * hour,
  };
}

// Model Anna Auditorium as one flat floor with movable tables.
const localFloorZones = [
  {
    stableKey: "anna_auditorium",
    name: "Anna Auditorium",
    // Approximate the auditorium's published floor area.
    widthMeters: 44,
    depthMeters: 33,
    displayOrder: 0,
    landmarks: [
      { stableKey: "anna_stage", name: "the stage", x: 50, y: 4, displayOrder: 0 },
      { stableKey: "anna_green_rooms", name: "the green rooms", x: 8, y: 8, displayOrder: 1 },
      { stableKey: "anna_left_aisle", name: "the left aisle", x: 6, y: 52, displayOrder: 2 },
      { stableKey: "anna_right_aisle", name: "the right aisle", x: 94, y: 52, displayOrder: 3 },
      { stableKey: "anna_sound_desk", name: "the sound desk", x: 92, y: 88, displayOrder: 4 },
      { stableKey: "anna_entrance", name: "the main entrance", x: 50, y: 96, displayOrder: 5 },
    ],
  },
] as const;

const localActors = {
  vitParticipant: {
    name: "Aarav Menon",
    email: "aarav.menon@vitstudent.ac.in",
    googleSubject: "local-google-vit-participant",
    hostedDomain: "vitstudent.ac.in",
  },
  externalParticipant: {
    name: "Maya Shah",
    email: "maya.shah@example.test",
    googleSubject: "local-google-external-participant",
  },
  supreme: {
    name: "Local Supreme",
    email: "supreme@example.test",
    googleSubject: "local-google-supreme",
  },
} as const;

type LocalActorKey = keyof typeof localActors;

type AuthUserDocument = {
  _id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

function parseAuthUser(value: unknown, actor: LocalActorKey): AuthUserDocument | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !("_id" in value) ||
    !("name" in value) ||
    !("email" in value) ||
    !("emailVerified" in value) ||
    typeof value._id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.email !== "string" ||
    typeof value.emailVerified !== "boolean"
  ) {
    throw new Error(`The ${actor} Better Auth fixture has an invalid shape.`);
  }
  return {
    _id: value._id,
    name: value.name,
    email: value.email,
    emailVerified: value.emailVerified,
  };
}

function requireCreatedDocument(value: unknown, label: string) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("_id" in value) ||
    typeof value._id !== "string" ||
    value._id.length === 0
  ) {
    throw new Error(`${label} did not return a document ID.`);
  }
}

async function findLocalAuthUser(
  ctx: ActionCtx,
  actor: LocalActorKey,
) {
  const fixture = localActors[actor];
  const result: unknown = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [
      { field: "email", value: fixture.email },
      { field: "name", value: fixture.name },
    ],
  });
  return parseAuthUser(result, actor);
}

async function ensureLocalAuthUser(
  ctx: ActionCtx,
  actor: LocalActorKey,
) {
  const fixture = localActors[actor];
  const existing = await findLocalAuthUser(ctx, actor);
  if (existing) {
    if (
      existing.email !== fixture.email ||
      existing.name !== fixture.name ||
      !existing.emailVerified
    ) {
      throw new Error(`The ${actor} Better Auth fixture does not match its local contract.`);
    }
    return existing;
  }

  try {
    const created: unknown = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: fixture.name,
          email: fixture.email,
          emailVerified: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    const user = parseAuthUser(created, actor);
    if (!user) throw new Error(`The ${actor} Better Auth fixture was not created.`);
    return user;
  } catch (error) {
    const concurrent = await findLocalAuthUser(ctx, actor);
    if (concurrent) return concurrent;
    throw error;
  }
}

async function createLocalSession(
  ctx: ActionCtx,
  actor: LocalActorKey,
  now: number,
) {
  const fixture = localActors[actor];
  const user = await ensureLocalAuthUser(ctx, actor);
  await ctx.runMutation(internal.identityClaims.recordVerifiedGoogleIdentity, {
    authUserId: user._id,
    googleSubject: fixture.googleSubject,
    verifiedEmail: fixture.email,
    displayName: fixture.name,
    ...(actor === "vitParticipant"
      ? { hostedDomain: localActors.vitParticipant.hostedDomain }
      : {}),
    tokenIssuedAt: now,
    tokenExpiresAt: now + 24 * 60 * 60 * 1_000,
    verifiedAt: now,
  });
  if (actor === "supreme") {
    await ctx.runMutation(internal.localDevelopment.ensureSupremeAccess, {
      authUserId: user._id,
      googleSubject: fixture.googleSubject,
      verifiedEmail: fixture.email,
      displayName: fixture.name,
    });
  }

  const sessionToken = crypto.randomUUID();
  const session: unknown = await ctx.runMutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        expiresAt: now + 12 * 60 * 60 * 1_000,
        token: sessionToken,
        createdAt: now,
        updatedAt: now,
        userId: user._id,
      },
    },
  });
  requireCreatedDocument(session, `${actor} Better Auth session`);

  const oneTimeToken = crypto.randomUUID();
  const tokenExpiresAt = now + 10 * 60 * 1_000;
  const verification: unknown = await ctx.runMutation(
    components.betterAuth.adapter.create,
    {
      input: {
        model: "verification",
        data: {
          identifier: `one-time-token:${oneTimeToken}`,
          value: sessionToken,
          expiresAt: tokenExpiresAt,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  );
  requireCreatedDocument(verification, `${actor} one-time token`);

  return { token: oneTimeToken, expiresAt: tokenExpiresAt };
}

async function createLocalBrowserUrl(
  ctx: ActionCtx,
  actor: LocalActorKey,
  origin: string,
  now: number,
) {
  const session = await createLocalSession(ctx, actor, now);
  const url = new URL(origin);
  url.searchParams.set("ott", session.token);
  return { url: url.toString(), expiresAt: session.expiresAt };
}

export const ensureSupremeAccess = internalMutation({
  args: {
    authUserId: v.string(),
    googleSubject: v.string(),
    verifiedEmail: v.string(),
    displayName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const event = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (!event) {
      throw new ConvexError({
        code: "LOCAL_EVENT_REQUIRED",
        message: "Seed the local event before creating browser fixtures.",
      });
    }

    const now = Date.now();
    let person = await ctx.db
      .query("people")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", args.authUserId))
      .unique();
    if (person) {
      if (
        person.googleSubject !== args.googleSubject ||
        person.verifiedEmail !== args.verifiedEmail ||
        person.status !== "active"
      ) {
        throw new Error("The local Supreme identity does not match its application account.");
      }
      if (person.displayName !== args.displayName) {
        await ctx.db.patch("people", person._id, {
          displayName: args.displayName,
          updatedAt: now,
        });
        person = { ...person, displayName: args.displayName, updatedAt: now };
      }
    } else {
      const conflictingSubject = await ctx.db
        .query("people")
        .withIndex("by_google_subject", (index) =>
          index.eq("googleSubject", args.googleSubject),
        )
        .unique();
      const conflictingEmail = await ctx.db
        .query("people")
        .withIndex("by_verified_email", (index) =>
          index.eq("verifiedEmail", args.verifiedEmail),
        )
        .unique();
      if (conflictingSubject || conflictingEmail) {
        throw new Error("The local Supreme identity is already linked to another account.");
      }
      const personId = await ctx.db.insert("people", {
        authUserId: args.authUserId,
        googleSubject: args.googleSubject,
        verifiedEmail: args.verifiedEmail,
        displayName: args.displayName,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      person = await ctx.db.get("people", personId);
    }
    if (!person) throw new Error("The local Supreme person was not created.");

    let subject = await ctx.db
      .query("eventAccessSubjects")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", event._id).eq("personId", person._id),
      )
      .unique();
    if (subject) {
      if (subject.status !== "active") {
        throw new Error("The local Supreme event account is not active.");
      }
      if (
        subject.emailNormalized !== args.verifiedEmail ||
        subject.displayName !== args.displayName
      ) {
        await ctx.db.patch("eventAccessSubjects", subject._id, {
          emailNormalized: args.verifiedEmail,
          displayName: args.displayName,
          updatedAt: now,
        });
        subject = {
          ...subject,
          emailNormalized: args.verifiedEmail,
          displayName: args.displayName,
          updatedAt: now,
        };
      }
    } else {
      const subjectId = await ctx.db.insert("eventAccessSubjects", {
        eventId: event._id,
        personId: person._id,
        emailNormalized: args.verifiedEmail,
        displayName: args.displayName,
        status: "active",
        linkedBy: "access_invitation",
        accessVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      subject = await ctx.db.get("eventAccessSubjects", subjectId);
    }
    if (!subject) throw new Error("The local Supreme event account was not created.");

    const activeRoles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event_person_status", (index) =>
        index
          .eq("eventId", event._id)
          .eq("personId", person._id)
          .eq("status", "active"),
      )
      .collect();
    if (!activeRoles.some((role) => role.role === "supreme")) {
      await ctx.db.insert("eventRoles", {
        eventId: event._id,
        personId: person._id,
        eventAccessSubjectId: subject._id,
        role: "supreme",
        validFrom: now,
        status: "active",
        sourceType: "production_seed",
        sourceId: `local-development:${event._id}`,
        assignedByPersonId: person._id,
        createdAt: now,
        reason: "Local full-flow fixture",
      });
    }

    let createdGrantCount = await addEventSubjectSelfGrants(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
    });
    const supremeGrantPlans: PermissionGrantPlan[] = [
      {
        permissionKey: "reviewer.device.register",
        scopeType: "self",
        scopeId: subject._id,
      },
    ];
    for (const permissionKey of Object.keys(permissionCatalog)) {
      if (!isPermissionKey(permissionKey)) {
        throw new Error(`The permission catalog contains an invalid key: ${permissionKey}.`);
      }
      if (
        !permissionCatalog[permissionKey].eventWide ||
        permissionKey === "access.permissions.grant_scoped" ||
        permissionKey === "access.permissions.revoke_scoped"
      ) {
        continue;
      }
      supremeGrantPlans.push({
        permissionKey,
        scopeType: "event",
      });
    }
    const supremeGrants = await insertPermissionGrantGroup(ctx, {
      eventId: event._id,
      personId: person._id,
      eventAccessSubjectId: subject._id,
      sourceType: "production_seed",
      sourceId: `local-development:${event._id}`,
      grantedByPersonId: person._id,
      reason: "Local full-flow fixture",
      grants: supremeGrantPlans,
    });
    createdGrantCount += supremeGrants.createdCount;
    if (createdGrantCount > 0) {
      await ctx.db.patch("eventAccessSubjects", subject._id, {
        accessVersion: subject.accessVersion + 1,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const createBrowserSession = action({
  args: {
    confirmation: v.literal("create-code2create-local-browser-session"),
    actor: v.union(
      v.literal("vitParticipant"),
      v.literal("externalParticipant"),
      v.literal("supreme"),
    ),
    surface: v.union(
      v.literal("participant"),
      v.literal("operations"),
      v.literal("handbook"),
    ),
  },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const origins = localBrowserFixtureOrigins();
    if (!origins) {
      throw new ConvexError({
        code: "LOCAL_ONLY",
        message: "Local browser fixtures require the fixed localhost auth and app origins.",
      });
    }
    const participantActor = args.actor !== "supreme";
    if (
      (args.surface === "participant" && !participantActor) ||
      (args.surface !== "participant" && participantActor)
    ) {
      throw new ConvexError({
        code: "INVALID_LOCAL_FIXTURE",
        message: "That local test identity cannot open the requested surface.",
      });
    }
    const origin = args.surface === "participant"
      ? origins.participant
      : args.surface === "operations"
        ? origins.operations
        : origins.handbook;
    return createLocalBrowserUrl(ctx, args.actor, origin, Date.now());
  },
});

export const createNativeSession = action({
  args: {
    confirmation: v.literal("create-code2create-local-native-session"),
    surface: v.literal("reviewer"),
  },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    requireLocalDeployment();
    if (!localBrowserFixtureOrigins()) {
      throw new ConvexError({
        code: "LOCAL_ONLY",
        message: "The local event operator is available only with the full localhost stack.",
      });
    }
    return createLocalSession(ctx, "supreme", Date.now());
  },
});

export const seedEvent = mutation({
  args: { confirmation: v.literal("seed-code2create-local") },
  returns: v.object({
    eventId: v.id("events"),
    catalogVersionId: v.id("trackCatalogVersions"),
    created: v.boolean(),
  }),
  handler: async (ctx) => {
    requireLocalDeployment();

    const existingEvent = await ctx.db
      .query("events")
      .withIndex("by_slug", (index) => index.eq("slug", "code2create-7"))
      .unique();
    if (
      existingEvent?.publishedTrackCatalogId &&
      existingEvent.publishedParticipantPolicyId &&
      existingEvent.publishedEventPhaseScheduleId &&
      existingEvent.publishedProjectCheckpointPlanId &&
      existingEvent.publishedIntakePolicyId &&
      existingEvent.publishedNoveltyCorpusVersionId &&
      existingEvent.publishedAdmissionPolicyId &&
      existingEvent.publishedCommunicationsPolicyId &&
      existingEvent.publishedAttendancePlanVersionId &&
      existingEvent.publishedFloorPlanVersionId &&
      existingEvent.publishedIntegrationPolicyId &&
      (await ctx.db
        .query("operationsAutonomyPolicyVersions")
        .withIndex("by_event_status", (index) =>
          index.eq("eventId", existingEvent._id).eq("status", "published"),
        )
        .unique())
    ) {
      await ctx.scheduler.runAfter(0, internal.operationsHealth.refresh, {});
      return {
        eventId: existingEvent._id,
        catalogVersionId: existingEvent.publishedTrackCatalogId,
        created: false,
      };
    }
    if (existingEvent) {
      throw new ConvexError({
        code: "LOCAL_SEED_OUTDATED",
        message: "Clear the old local deployment before seeding the current event shape.",
      });
    }

    const now = Date.now();
    let seedPerson = await ctx.db
      .query("people")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", "local-development-seed"))
      .unique();
    if (!seedPerson) {
      const seedPersonId = await ctx.db.insert("people", {
        authUserId: "local-development-seed",
        googleSubject: "local-development-seed",
        verifiedEmail: "local-development@code2create.invalid",
        displayName: "Local development seed",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      seedPerson = await ctx.db.get(seedPersonId);
    }
    if (!seedPerson) throw new Error("The local development seed person was not created.");

    const eventId = await ctx.db.insert("events", {
      slug: "code2create-7",
      name: "Code2Create 7.0",
      timezone: "Asia/Kolkata",
      status: "registration_open",
      vitEmailDomains: ["vitstudent.ac.in"],
      startsAt: localEventStartsAt,
      endsAt: localEventEndsAt,
      createdByPersonId: seedPerson._id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const seedSubjectId = await ctx.db.insert("eventAccessSubjects", {
      eventId,
      personId: seedPerson._id,
      emailNormalized: seedPerson.verifiedEmail,
      displayName: seedPerson.displayName,
      status: "active",
      linkedBy: "access_invitation",
      accessVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    const localTrackCatalog = normalizeTrackCatalog(
      localTracks.length,
      localTracks.map((track, displayOrder) => ({
        ...track,
        examples: [...track.examples],
        displayOrder,
        type: "core" as const,
      })),
    );
    const catalogVersionId = await ctx.db.insert("trackCatalogVersions", {
      eventId,
      version: 1,
      status: "published",
      requiredCoreTrackCount: localTrackCatalog.length,
      checksum: trackCatalogChecksum(localTrackCatalog.length, localTrackCatalog),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });

    for (const track of localTrackCatalog) {
      await ctx.db.insert("trackVersions", {
        eventId,
        catalogVersionId,
        ...track,
        status: "published",
        createdAt: now,
      });
    }
    const phases = normalizePhaseSchedule(localPhases);
    const phaseScheduleVersionId = await ctx.db.insert("eventPhaseScheduleVersions", {
      eventId,
      version: 1,
      status: "published",
      checksum: phaseScheduleChecksum(phases),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });
    for (const phase of phases) {
      await ctx.db.insert("eventPhaseWindows", {
        eventId,
        scheduleVersionId: phaseScheduleVersionId,
        ...phase,
        status: "published",
        createdAt: now,
      });
    }
    const checkpoints = normalizeProjectCheckpointPlan(localCheckpointDefinitions);
    const checkpointPlanVersionId = await ctx.db.insert(
      "projectCheckpointPlanVersions",
      {
        eventId,
        version: 1,
        status: "published",
        checksum: projectCheckpointPlanChecksum(checkpoints),
        createdByPersonId: seedPerson._id,
        createdAt: now,
        publishedAt: now,
      },
    );
    for (const checkpoint of checkpoints) {
      await ctx.db.insert("projectCheckpointDefinitions", {
        eventId,
        planVersionId: checkpointPlanVersionId,
        ...checkpoint,
        status: "published",
        createdAt: now,
      });
    }
    const participantPolicy = normalizeParticipantPolicy(defaultParticipantPolicy);
    const participantPolicyVersionId = await ctx.db.insert("participantPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...participantPolicy,
      checksum: participantPolicyChecksum(participantPolicy),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });
    const intakePolicy = normalizeIntakePolicy(defaultDeterministicIntakePolicy);
    const intakePolicyVersionId = await ctx.db.insert("intakePolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...intakePolicy,
      checksum: intakePolicyChecksum(intakePolicy),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });
    const noveltyPolicy = normalizeNoveltyPolicy({
      ...defaultNoveltyPolicy,
      label: "Local test comparison set",
      distinctSimilarityBoundary: 0.08,
      commonSimilarityBoundary: 0.34,
    });
    const noveltyEntries = normalizeNoveltyCorpusEntries(localNoveltyEntries);
    const noveltyCorpusVersionId = await ctx.db.insert("noveltyCorpusVersions", {
      eventId,
      version: 1,
      revision: 1,
      status: "published",
      importState: "ready",
      ...noveltyPolicy,
      entryCount: noveltyEntries.length,
      checksum: noveltyCorpusChecksum(noveltyPolicy, noveltyEntries),
      createdByPersonId: seedPerson._id,
      lastEditedByPersonId: seedPerson._id,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    });
    for (const entry of noveltyEntries) {
      await ctx.db.insert("noveltyCorpusEntries", {
        eventId,
        corpusVersionId: noveltyCorpusVersionId,
        ...entry,
        embedding: localNoveltyEmbedding(`${entry.themeLabel}\n${entry.summary}`),
        createdAt: now,
      });
    }
    const admissionConfiguration = normalizeAdmissionConfiguration({
      version: "local-development-v1",
      minimumHumanReviews: 1,
      overallParticipantCapacity: 1_000,
      criteria: defaultAdmissionCriteria,
      decisionReasonCodes: defaultAdmissionReasonCodes,
      model: null,
    });
    const admissionPolicy = admissionPolicyForConfiguration(admissionConfiguration);
    const admissionPolicyVersionId = await ctx.db.insert("admissionPolicyVersions", {
      eventId,
      ...admissionPolicy,
      status: "published",
      checksum: admissionPolicyChecksum(admissionPolicy),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.insert("admissionCapacityBuckets", {
      eventId,
      admissionPolicyVersionId,
      scope: "overall",
      capacity: admissionPolicy.overallParticipantCapacity,
      reserved: 0,
      version: 1,
      updatedAt: now,
    });
    const communicationsPolicy = normalizeCommunicationsPolicy({
      venueName: "VIT Chennai",
      venueAddress: "Vandalur–Kelambakkam Road, Chennai",
      startsAt: localEventStartsAt,
      endsAt: localEventEndsAt,
      nextSteps: [
        {
          stableKey: "join_discord",
          title: "Join Discord",
          detail: "Use the event server for announcements and participant support.",
          actionUrl: "https://discord.gg/code2create-local",
        },
        {
          stableKey: "check_schedule",
          title: "Review the event schedule",
          detail: "Check the portal again before arrival for the latest operational timings.",
        },
      ],
      discordUrl: "https://discord.gg/code2create-local",
      discordLabel: "Open event Discord",
      notificationProvider: "cloudflare_email",
      notificationSubject: "Code2Create application update",
      notificationIntro: "There is an update to your team's Code2Create application.",
    });
    const communicationsPolicyVersionId = await ctx.db.insert(
      "communicationsPolicyVersions",
      {
        eventId,
        version: 1,
        status: "published",
        ...communicationsPolicy,
        checksum: communicationsPolicyChecksum(communicationsPolicy),
        createdByPersonId: seedPerson._id,
        createdAt: now,
        publishedAt: now,
      },
    );
    const attendancePlanContent = localAttendancePlanContent(localEventStartsAt);
    const attendancePlanVersionId = await ctx.db.insert("attendancePlanVersions", {
      eventId,
      version: 1,
      name: attendancePlanContent.name,
      vitBarcodeSymbologies: attendancePlanContent.vitBarcodeSymbologies,
      vitBarcodeNormalizationVersion: attendancePlanContent.vitBarcodeNormalizationVersion,
      offlineQueueMaxScans: attendancePlanContent.offlineQueueMaxScans,
      offlineQueueMaxAgeSeconds: attendancePlanContent.offlineQueueMaxAgeSeconds,
      status: "published",
      checksum: attendancePlanChecksum(attendancePlanContent),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });
    const attendanceZoneIds = new Map<string, Id<"attendanceZones">>();
    for (const zone of localAttendanceZones) {
      const zoneId = await ctx.db.insert("attendanceZones", {
        eventId,
        planVersionId: attendancePlanVersionId,
        ...zone,
        createdAt: now,
      });
      attendanceZoneIds.set(zone.stableKey, zoneId);
    }
    const attendanceSessionIds = new Map<string, Id<"attendanceSessions">>();
    for (const session of attendancePlanContent.sessions) {
      const zoneId = attendanceZoneIds.get(session.zoneKey);
      if (!zoneId) throw new Error("The local attendance session has no zone.");
      const sessionId = await ctx.db.insert("attendanceSessions", {
        eventId,
        planVersionId: attendancePlanVersionId,
        stableKey: session.stableKey,
        name: session.name,
        kind: session.kind,
        requirement: session.requirement,
        expectedCohort: session.expectedCohort,
        zoneId,
        status: "scheduled",
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        checkInOpensAt: session.checkInOpensAt,
        checkInClosesAt: session.checkInClosesAt,
        awayAlertAfterMinutes: session.awayAlertAfterMinutes,
        expectationBuildState: "not_started",
        expectationCount: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      attendanceSessionIds.set(session.stableKey, sessionId);
    }
    for (const station of localAttendanceStations) {
      const zoneId = attendanceZoneIds.get(station.zoneKey);
      if (!zoneId) throw new Error("The local attendance station has no zone.");
      const sessionKey = "sessionKey" in station ? station.sessionKey : undefined;
      const sessionId = sessionKey !== undefined
        ? attendanceSessionIds.get(sessionKey)
        : undefined;
      if (sessionKey !== undefined && sessionId === undefined) {
        throw new Error("The local attendance station has no session.");
      }
      const stationId = await ctx.db.insert("attendanceStations", {
        eventId,
        planVersionId: attendancePlanVersionId,
        zoneId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        stableKey: station.stableKey,
        name: station.name,
        mode: station.mode,
        allowedCredentialKinds: [...station.allowedCredentialKinds],
        status: "inactive",
        configurationVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      await appendAttendanceStationReadFactById(ctx, stationId, now);
    }
    const floorPlanName = "Main hall layout";
    const floorPlanVersionId = await ctx.db.insert("floorPlanVersions", {
      eventId,
      planNumber: 1,
      name: floorPlanName,
      status: "published",
      mappingState: "open",
      checksum: floorConfigurationChecksum({
        name: floorPlanName,
        zones: localFloorZones,
      }),
      version: 2,
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedByPersonId: seedPerson._id,
      publishedAt: now,
    });
    for (const zone of localFloorZones) {
      const zoneId = await ctx.db.insert("floorZones", {
        eventId,
        planVersionId: floorPlanVersionId,
        stableKey: zone.stableKey,
        name: zone.name,
        widthMeters: zone.widthMeters,
        depthMeters: zone.depthMeters,
        displayOrder: zone.displayOrder,
        createdAt: now,
      });
      for (const landmark of zone.landmarks) {
        await ctx.db.insert("floorLandmarks", {
          eventId,
          planVersionId: floorPlanVersionId,
          zoneId,
          stableKey: landmark.stableKey,
          name: landmark.name,
          x: landmark.x,
          y: landmark.y,
          displayOrder: landmark.displayOrder,
          createdAt: now,
        });
      }
    }
    const integrationPolicy = localIntegrationPolicy(localEventStartsAt);
    const integrationPolicyVersionId = await ctx.db.insert("integrationPolicyVersions", {
      eventId,
      version: 1,
      ...integrationPolicy,
      status: "published",
      checksum: fingerprintText(JSON.stringify(integrationPolicy)),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });
    const autonomyPolicy = normalizeOperationsAutonomyPolicy(
      defaultOperationsAutonomyPolicy(seedSubjectId),
    );
    const autonomyPolicyVersionId = await ctx.db.insert("operationsAutonomyPolicyVersions", {
      eventId,
      version: 1,
      status: "published",
      ...autonomyPolicy,
      checksum: operationsAutonomyPolicyChecksum(autonomyPolicy),
      createdByPersonId: seedPerson._id,
      createdAt: now,
      publishedAt: now,
    });
    await ctx.db.insert("operationsAutonomyStates", {
      eventId,
      policyVersionId: autonomyPolicyVersionId,
      lifecycle: {
        kind: "disabled",
        disabledAt: now,
        disabledByPersonId: seedPerson._id,
        reason: "Autonomous operations start disabled.",
      },
      nextEvaluationAt: now,
      pendingWorkCount: 0,
      cycle: 1,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.patch(eventId, {
      publishedTrackCatalogId: catalogVersionId,
      publishedParticipantPolicyId: participantPolicyVersionId,
      publishedEventPhaseScheduleId: phaseScheduleVersionId,
      publishedProjectCheckpointPlanId: checkpointPlanVersionId,
      publishedIntakePolicyId: intakePolicyVersionId,
      publishedNoveltyCorpusVersionId: noveltyCorpusVersionId,
      publishedAdmissionPolicyId: admissionPolicyVersionId,
      publishedCommunicationsPolicyId: communicationsPolicyVersionId,
      publishedAttendancePlanVersionId: attendancePlanVersionId,
      publishedFloorPlanVersionId: floorPlanVersionId,
      publishedIntegrationPolicyId: integrationPolicyVersionId,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.operationsHealth.refresh, {});
    return { eventId, catalogVersionId, created: true };
  },
});
