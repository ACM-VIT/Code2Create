import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { advanceAccessVersion } from "./lib/accessVersion";
import { attendancePlanChecksum } from "./lib/attendancePlan";
import {
  initializeAttendanceTeamAvailability,
  moveAttendanceTeamAvailability,
} from "./lib/attendanceTeamAvailability";
import { writeAuditEvent } from "./lib/audit";
import {
  communicationsPolicyChecksum,
  communicationsPolicyFromDocument,
} from "./lib/communicationsPolicy";
import {
  eventLifecycleTransitionAllowed,
  type EventLifecycleStatus,
} from "./lib/eventLifecycle";
import { requireLocalDeployment } from "./lib/localBrowserFixtures";
import {
  completeLocalSubmissionSnapshot,
  createLocalSubmissionSnapshot,
} from "./lib/localSubmissionSnapshot";
import { operationFingerprint } from "./lib/operations";
import { appendReviewPanelVacancyReadFactById } from "./lib/operationsAutonomyReadFacts";
import { isPermissionKey, permissionCatalog, type PermissionKey } from "./lib/permissionCatalog";
import {
  addEventSubjectSelfGrants,
  insertPermissionGrant,
  revokeSourceGrants,
} from "./lib/permissions";
import {
  loadPublishedPhaseSchedule,
  normalizePhaseSchedule,
  phaseScheduleChecksum,
  phaseWindowInput,
} from "./lib/phaseSchedule";
import { grantPanelMemberAccess, grantReviewAssignmentAccess } from "./lib/reviewAccess";
import { insertTeamRoundState } from "./lib/reviewQueueProjection";
import { computeReviewEvaluation } from "./lib/reviewScores";
import { sendNextPage } from "./reviewSubstitutions";
import { fingerprintText } from "./lib/strings";
import { localAttendancePlanContent, localIntegrationPolicy } from "./localDevelopment";
import { createEvidenceCheckpoint } from "./reviewOperations";
import { addTeamMemberGrants } from "./teams";

const minute = 60 * 1_000;
const hour = 60 * minute;
const demoEventSlug = "code2create-7";
const demoRoundStableKey = "demo_final";
const localOperatorEmail = "supreme@example.test";
const localLivePanelStableKey = "panel_d";
const demoSourceId = "local-demo-seed";
const demoReason = "Local demo fixture";
const teamsPerBatch = 1;
const operationsLeadPermissionsPerBatch = 20;
const reviewersPerBatch = 3;

const demoOperationsLead = {
  key: "operations-lead",
  displayName: "Nithya Raghunathan",
} as const;

const demoStaff = [
  {
    key: "attendance-lead",
    displayName: "Priya Nair",
    role: "sc",
    permissionKeys: [
      "attendance.plan.publish",
      "attendance.session.manage",
      "attendance.station.manage",
      "attendance.venue_check_in.read",
      "attendance.venue_check_in.record",
      "attendance.credential.enrol",
      "attendance.badge.issue",
      "attendance.history.read",
      "attendance.presence.reconcile",
      "attendance.roll_call.read",
      "attendance.roll_call.start",
      "attendance.roll_call.close",
      "attendance.remedy.read",
      "attendance.remedy.decide",
      "attendance.manual_sheet.read",
      "attendance.manual_sheet.verify",
    ],
  },
  {
    key: "review-desk",
    displayName: "Kunal Bhaskar",
    role: "sc",
    permissionKeys: [
      "review.configuration.read",
      "reviewer.profile.read",
      "round.read",
      "round.manage",
      "panel.read",
      "queue.manage",
      "review.prepare",
      "review.read",
      "review.start",
      "review.timer.extend",
      "review.complete",
      "review.queue.hold",
      "review.queue.resume",
      "review.queue.miss",
      "review.queue.move",
      "review.panel.pause",
      "review.round.pause",
      "review.round.resume",
      "review.substitute.page",
      "review.substitute.assign",
      "review.reviewer.no_show",
    ],
  },
  {
    key: "score-ops",
    displayName: "Ritika Sen",
    role: "sc",
    permissionKeys: [
      "score.completeness.read",
      "score.values.read",
      "scorecard.correction.open",
      "scorecard.void",
      "review.manual_record.read",
      "review.manual_record.verify",
      "round.close",
      "round.export.read",
      "round.export.verify",
      "round.export.retry",
      "score.release",
    ],
  },
  {
    key: "support-desk-day",
    displayName: "Mohit Ranjan",
    role: "jc",
    permissionKeys: ["support.case.read", "support.case.manage"],
  },
  {
    key: "support-desk-night",
    displayName: "Aparna Iyengar",
    role: "jc",
    permissionKeys: ["support.case.read", "support.case.manage"],
  },
  {
    key: "incident-lead",
    displayName: "Vivaan Tandon",
    role: "board",
    permissionKeys: [
      "incident.read",
      "incident.create",
      "incident.manual_mode.approve",
      "incident.resolve",
    ],
  },
] as const;

const demoReviewers = [
  { displayName: "Ananya Krishnan", role: "jc" },
  { displayName: "Rajesh Iyer", role: "external_judge" },
  { displayName: "Fatima Sheikh", role: "jc" },
  { displayName: "Daniel Abraham", role: "external_judge" },
  { displayName: "Sanjana Bose", role: "jc" },
  { displayName: "Vikas Chandra", role: "jc" },
  { displayName: "Leela Murthy", role: "external_judge" },
  { displayName: "Arnav Sethi", role: "jc" },
  { displayName: "Priyanka Dutta", role: "jc" },
  { displayName: "Hemant Joshi", role: "external_judge" },
  { displayName: "Nadia Rahman", role: "jc" },
  { displayName: "Suresh Balan", role: "jc" },
  { displayName: "Gita Venkatesan", role: "external_judge" },
  { displayName: "Michael Dsouza", role: "jc" },
  { displayName: "Tanvi Kulkarni", role: "jc" },
] as const;

const demoRubricCriteria = [
  {
    stableKey: "problem_fit",
    label: "Problem fit",
    question: "Is the problem real, specific, and owned by a named user?",
    guidance: "Look for a concrete user and a problem the team can describe without jargon.",
    weight: 25,
    displayOrder: 0,
    anchors: {
      zero: "No identifiable user or problem.",
      one: "A vague problem with no named user.",
      two: "A plausible problem with a broad user group.",
      three: "A specific problem with a named user group.",
      four: "A specific problem grounded in direct evidence from users.",
    },
  },
  {
    stableKey: "working_product",
    label: "Working product",
    question: "Does the demonstrated build actually do the useful thing?",
    guidance: "Score what runs in front of you, not what is described as planned.",
    weight: 30,
    displayOrder: 1,
    anchors: {
      zero: "Nothing runs.",
      one: "Fragments run in isolation.",
      two: "A partial path works with manual help.",
      three: "The main path works end to end.",
      four: "The main path works end to end and handles failure clearly.",
    },
  },
  {
    stableKey: "technical_depth",
    label: "Technical depth",
    question: "Did the team make and defend real engineering decisions?",
    guidance: "Ask what was hard and why the chosen approach was picked over alternatives.",
    weight: 25,
    displayOrder: 2,
    anchors: {
      zero: "No decisions the team can explain.",
      one: "Defaults accepted without reasoning.",
      two: "One considered decision.",
      three: "Several considered decisions with trade-offs named.",
      four: "Considered decisions with measured trade-offs and known limits.",
    },
  },
  {
    stableKey: "communication",
    label: "Communication",
    question: "Can the team explain the work clearly to someone new to it?",
    guidance: "Score clarity and honesty, not polish or presentation flair.",
    weight: 20,
    displayOrder: 3,
    anchors: {
      zero: "The explanation does not land.",
      one: "The explanation needs constant prompting.",
      two: "The explanation covers the basics.",
      three: "The explanation is clear and honest about gaps.",
      four: "The explanation is clear, honest, and anticipates the obvious questions.",
    },
  },
] as const;

const demoPanels = [
  { stableKey: "panel_a", name: "Panel A", memberCount: 3 },
  { stableKey: "panel_b", name: "Panel B", memberCount: 3 },
  { stableKey: "panel_c", name: "Panel C", memberCount: 3 },
  { stableKey: "panel_d", name: "Panel D", memberCount: 2 },
] as const;

/** Index into `demoTeams` of the team held below the round's participant minimum. */
const shortHandedDemoTeamIndex = 10;

/** Seeds non-terminal admission stages so every workflow remains reachable. */
type DemoAdmission =
  | { state: "submitted" }
  | { state: "under_review" }
  | { state: "accepted"; decision: "accept"; reasonCode: string }
  | { state: "declined"; decision: "decline"; reasonCode: string }
  | { state: "confirmed"; decision: "accept"; reasonCode: string };

const confirmedAdmission: DemoAdmission = {
  state: "confirmed",
  decision: "accept",
  reasonCode: "clear_and_workable",
};

const demoTeams = [
  {
    publicCode: "DEMOT001",
    name: "Pothole Patrol",
    participantClass: "vit_student",
    initialIdea:
      "Residents photograph road damage on their commute and follow the repair until the ward closes it.",
    members: ["Aarav Kulkarni", "Sneha Iyer", "Rohan Das", "Ananya Bose"],
  },
  {
    publicCode: "DEMOT002",
    name: "Clinic Compass",
    participantClass: "vit_student",
    initialIdea:
      "Carers find the nearest clinic that is actually open, staffed, and reachable without a car.",
    members: ["Devika Rao", "Karthik Menon", "Meera Pillai", "Arjun Varma"],
  },
  {
    publicCode: "DEMOT003",
    name: "Study Circle",
    participantClass: "vit_student",
    initialIdea:
      "Learners form four-person study groups around one topic, a shared hour, and a concrete goal.",
    members: ["Ishita Ghosh", "Nikhil Reddy", "Tara Sharma", "Vikram Joshi"],
  },
  {
    publicCode: "DEMOT004",
    name: "Grid Sense",
    participantClass: "vit_student",
    initialIdea:
      "Hostel blocks see which appliances drive their evening peak and what shifting them would save.",
    members: ["Farhan Qureshi", "Lakshmi Nair", "Aditya Sinha", "Riya Chawla"],
  },
  {
    publicCode: "DEMOT005",
    name: "Caption Craft",
    participantClass: "vit_student",
    initialIdea:
      "Lecture recordings get accurate captions and a glossary for the terms the course actually uses.",
    members: ["Neha Kapoor", "Sameer Bhatt", "Pooja Rane", "Yash Malhotra"],
  },
  {
    publicCode: "DEMOT006",
    name: "Transit Tally",
    participantClass: "vit_student",
    initialIdea:
      "Riders report which shared shuttles actually arrived so the next rider plans on real timings.",
    members: ["Harsh Vora", "Divya Prasad", "Manav Shetty", "Kavya Nambiar"],
  },
  {
    publicCode: "DEMOT007",
    name: "Calm Hours",
    participantClass: "external_participant",
    initialIdea:
      "Shift workers plan sleep around rosters that change weekly instead of a fixed daily routine.",
    members: ["Ritu Deshpande", "Omkar Patil", "Sara Fernandes", "Imran Sheikh"],
  },
  {
    publicCode: "DEMOT008",
    name: "Lab Ledger",
    participantClass: "vit_student",
    initialIdea:
      "Lab groups record what they actually changed between attempts so results can be reproduced.",
    members: ["Gaurav Mehta", "Anjali Saxena", "Prateek Jain", "Shreya Kulkarni"],
  },
  {
    publicCode: "DEMOT009",
    name: "Water Watch",
    participantClass: "vit_student",
    initialIdea:
      "Apartment committees spot a leak from the overnight tank curve before the bill tells them.",
    members: ["Naveen Kumar", "Bhavna Agarwal", "Rahul Pandey", "Swati Mishra"],
  },
  {
    publicCode: "DEMOT010",
    name: "Voice Bridge",
    participantClass: "external_participant",
    initialIdea:
      "Frontline staff take a spoken note in their own language and file it in the form the office needs.",
    members: ["Zoya Ansari", "Tanmay Gupta", "Preeti Yadav", "Aman Bhatia"],
  },
  {
    publicCode: "DEMOT011",
    name: "Repair Radar",
    participantClass: "vit_student",
    initialIdea:
      "Owners of a broken appliance find the nearest person who has fixed that exact model before.",
    members: ["Siddharth Naik", "Ira Chatterjee", "Vivek Raghavan", "Nandini Rao"],
  },
  {
    publicCode: "DEMOT012",
    name: "Shelf Share",
    participantClass: "external_participant",
    initialIdea:
      "Canteens publish safe surplus at closing time and nearby collection groups claim it in one tap.",
    members: ["Aisha Khan", "Rudra Sengupta", "Maitri Shah", "Dev Anand"],
  },
  {
    publicCode: "DEMOT013",
    name: "Ledger Lantern",
    participantClass: "vit_student",
    initialIdea:
      "Hostel mess committees publish what they spent each week so residents can question it before the next cycle.",
    members: ["Devika Rao", "Imran Sheikh", "Tara Nambiar"],
    admission: { state: "submitted" },
  },
  {
    publicCode: "DEMOT014",
    name: "Signal Shed",
    participantClass: "external_participant",
    initialIdea:
      "Rural clinics log which medicines ran out and when, so the district can see the pattern rather than the excuse.",
    members: ["Joseph Mathew", "Lakshmi Pillai", "Farid Ansari", "Nisha Verma"],
    admission: { state: "under_review" },
  },
  {
    publicCode: "DEMOT015",
    name: "Kiln Watch",
    participantClass: "vit_student",
    initialIdea:
      "Brick kiln workers report air quality from their own phones and the reading is tied to the kiln, not the person.",
    members: ["Ravi Chandran", "Meera Joshi", "Sahil Kapoor"],
    admission: {
      state: "accepted",
      decision: "accept",
      reasonCode: "clear_and_workable",
    },
  },
  {
    publicCode: "DEMOT016",
    name: "Parcel Pilot",
    participantClass: "external_participant",
    initialIdea:
      "A delivery route planner that reorders stops when a road closes partway through the shift.",
    members: ["Kabir Malhotra", "Sunita Reddy", "Arjun Bhat"],
    admission: {
      state: "declined",
      decision: "decline",
      reasonCode: "scope_not_yet_workable",
    },
  },
] as const;

/** Demo destinations use mapped hall areas because tables are not numbered. */
const demoHallLocations = [
  "North-east corner of Anna Auditorium, near the stage",
  "South side of Anna Auditorium, near the main entrance",
  "Middle of Anna Auditorium, near the sound desk",
  "North-west corner of Anna Auditorium, near the left aisle",
  "East side of Anna Auditorium, near the right aisle",
  "South-west corner of Anna Auditorium, near the left aisle",
] as const;

function demoHallLocation(teamIndex: number) {
  const location = demoHallLocations[teamIndex % demoHallLocations.length];
  if (location === undefined) throw new Error("The demo hall location list is empty.");
  return location;
}

const demoQueuePlacements = [
  {
    teamIndex: 2,
    panelKey: "panel_a",
    state: "queued",
    queuedMinutesAgo: 45,
    calledMinutesAgo: null,
    completedMinutesAgo: null,
  },
  {
    teamIndex: 3,
    panelKey: "panel_b",
    state: "queued",
    queuedMinutesAgo: 20,
    calledMinutesAgo: null,
    completedMinutesAgo: null,
  },
  {
    teamIndex: 4,
    panelKey: "panel_c",
    state: "queued",
    queuedMinutesAgo: 8,
    calledMinutesAgo: null,
    completedMinutesAgo: null,
  },
  {
    teamIndex: 5,
    panelKey: "panel_a",
    state: "called",
    queuedMinutesAgo: 50,
    calledMinutesAgo: 15,
    completedMinutesAgo: null,
  },
  {
    teamIndex: 6,
    panelKey: "panel_b",
    state: "in_review",
    queuedMinutesAgo: 35,
    calledMinutesAgo: 12,
    completedMinutesAgo: null,
  },
  {
    teamIndex: 7,
    panelKey: "panel_c",
    state: "in_review",
    queuedMinutesAgo: 55,
    calledMinutesAgo: 30,
    completedMinutesAgo: null,
  },
  {
    teamIndex: 8,
    panelKey: "panel_a",
    state: "completed",
    queuedMinutesAgo: 95,
    calledMinutesAgo: 65,
    completedMinutesAgo: 45,
  },
  {
    teamIndex: 9,
    panelKey: "panel_b",
    state: "completed",
    queuedMinutesAgo: 90,
    calledMinutesAgo: 65,
    completedMinutesAgo: 45,
  },
  {
    teamIndex: 10,
    panelKey: "panel_c",
    state: "completed",
    queuedMinutesAgo: 85,
    calledMinutesAgo: 65,
    completedMinutesAgo: 45,
  },
  {
    teamIndex: 11,
    panelKey: "panel_a",
    state: "held",
    queuedMinutesAgo: 40,
    calledMinutesAgo: null,
    completedMinutesAgo: null,
  },
] as const;

const demoReviewSessionBatches = [
  [
    {
      teamIndex: 5,
      panelKey: "panel_a",
      status: "awaiting_presence",
      createdMinutesAgo: 15,
      startedMinutesAgo: null,
      completedMinutesAgo: null,
    },
    {
      teamIndex: 6,
      panelKey: "panel_b",
      status: "active",
      createdMinutesAgo: 12,
      startedMinutesAgo: 8,
      completedMinutesAgo: null,
    },
    {
      teamIndex: 7,
      panelKey: "panel_c",
      status: "overdue",
      createdMinutesAgo: 30,
      startedMinutesAgo: 25,
      completedMinutesAgo: null,
    },
  ],
  [
    {
      teamIndex: 8,
      panelKey: "panel_a",
      status: "completed",
      createdMinutesAgo: 65,
      startedMinutesAgo: 60,
      completedMinutesAgo: 45,
    },
    {
      teamIndex: 9,
      panelKey: "panel_b",
      status: "completed",
      createdMinutesAgo: 65,
      startedMinutesAgo: 60,
      completedMinutesAgo: 45,
    },
    {
      teamIndex: 10,
      panelKey: "panel_c",
      status: "completed",
      createdMinutesAgo: 65,
      startedMinutesAgo: 60,
      completedMinutesAgo: 45,
    },
  ],
] as const;

const demoHoldReason =
  "Team asked for ten minutes to reconnect the demo laptop to the hall network.";

const studyYears = ["first", "second", "third", "fourth"] as const;
const vitProgrammes = [
  "B.Tech Computer Science and Engineering",
  "B.Tech Electronics and Communication",
  "B.Tech Mechanical Engineering",
  "M.Tech Software Engineering",
] as const;
const externalCities = ["Bengaluru", "Pune", "Hyderabad", "Kochi"] as const;

function demoSlug(displayName: string) {
  return displayName.toLowerCase().replaceAll(" ", ".");
}

function demoEmail(displayName: string) {
  return `${demoSlug(displayName)}@code2create.invalid`;
}

function demoAuthUserId(displayName: string) {
  return `local-demo:${demoSlug(displayName)}`;
}

async function requireDemoEvent(ctx: MutationCtx) {
  const event = await ctx.db
    .query("events")
    .withIndex("by_slug", (index) => index.eq("slug", demoEventSlug))
    .unique();
  if (!event) {
    throw new ConvexError({
      code: "LOCAL_EVENT_REQUIRED",
      message: "Seed the local event before seeding the demonstration state.",
    });
  }
  return event;
}

async function findDemoPerson(ctx: MutationCtx, displayName: string) {
  return ctx.db
    .query("people")
    .withIndex("by_auth_user", (index) => index.eq("authUserId", demoAuthUserId(displayName)))
    .unique();
}

async function requireDemoPerson(ctx: MutationCtx, displayName: string) {
  const person = await findDemoPerson(ctx, displayName);
  if (!person) throw new Error(`The demo account for ${displayName} is missing.`);
  return person;
}

async function requireDemoSubject(
  ctx: MutationCtx,
  eventId: Id<"events">,
  personId: Id<"people">,
) {
  const subject = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", eventId).eq("personId", personId),
    )
    .unique();
  if (!subject) throw new Error("A demo account has no event access subject.");
  return subject;
}

async function createDemoAccount(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    displayName: string;
    linkedBy: Doc<"eventAccessSubjects">["linkedBy"];
    now: number;
  },
) {
  const email = demoEmail(args.displayName);
  const personId = await ctx.db.insert("people", {
    authUserId: demoAuthUserId(args.displayName),
    googleSubject: `local-demo-google:${demoSlug(args.displayName)}`,
    verifiedEmail: email,
    displayName: args.displayName,
    status: "active",
    createdAt: args.now,
    updatedAt: args.now,
  });
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId: args.eventId,
    personId,
    emailNormalized: email,
    displayName: args.displayName,
    status: "active",
    linkedBy: args.linkedBy,
    accessVersion: 1,
    createdAt: args.now,
    updatedAt: args.now,
  });
  await addEventSubjectSelfGrants(ctx, {
    eventId: args.eventId,
    personId,
    eventAccessSubjectId: subjectId,
  });
  return { personId, subjectId };
}

async function grantEventWide(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    permissionKeys: readonly PermissionKey[];
    grantedByPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  let createdCount = 0;
  for (const permissionKey of args.permissionKeys) {
    const result = await insertPermissionGrant(ctx, {
      eventId: args.eventId,
      personId: args.personId,
      eventAccessSubjectId: args.eventAccessSubjectId,
      permissionKey,
      scopeType: "event",
      sourceType: "production_seed",
      sourceId: demoSourceId,
      grantedByPersonId: args.grantedByPersonId,
      reason: args.reason,
    });
    if (result.created) createdCount += 1;
  }
  if (createdCount > 0) {
    await advanceAccessVersion(ctx, args.eventAccessSubjectId, args.now);
  }
}

async function assignDemoRole(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    personId: Id<"people">;
    eventAccessSubjectId: Id<"eventAccessSubjects">;
    role: Doc<"eventRoles">["role"];
    assignedByPersonId: Id<"people">;
    now: number;
  },
) {
  await ctx.db.insert("eventRoles", {
    eventId: args.eventId,
    personId: args.personId,
    eventAccessSubjectId: args.eventAccessSubjectId,
    role: args.role,
    validFrom: args.now,
    status: "active",
    sourceType: "production_seed",
    sourceId: demoSourceId,
    assignedByPersonId: args.assignedByPersonId,
    createdAt: args.now,
    reason: demoReason,
  });
}

function eventWidePermissionKeys() {
  const keys: PermissionKey[] = [];
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
    keys.push(permissionKey);
  }
  return keys;
}

function assertPermissionKeys(values: readonly string[]) {
  return values.map((value) => {
    if (!isPermissionKey(value)) {
      throw new Error(`The demo staff area names an unknown permission: ${value}.`);
    }
    return value;
  });
}

export const retimeEvent = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    if (event.status === "live") return null;
    if (event.startsAt === undefined || event.endsAt === undefined) {
      throw new Error("The local event has no scheduled window to retime.");
    }
    const seedPerson = await ctx.db
      .query("people")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", "local-development-seed"))
      .unique();
    if (!seedPerson) throw new Error("The local development seed person is missing.");

    const now = Date.now();
    const startsAt = now - 26 * hour;
    const endsAt = startsAt + 48 * hour;
    const shift = startsAt - event.startsAt;

    const phaseSchedule = await loadPublishedPhaseSchedule(ctx, event);
    if (!phaseSchedule) throw new Error("The local event has no published phase schedule.");
    for (const window of phaseSchedule.windows) {
      await ctx.db.patch(window._id, {
        startsAt: window.startsAt + shift,
        endsAt: window.endsAt + shift,
      });
    }
    const shiftedPhases = normalizePhaseSchedule(
      phaseSchedule.windows.map((window) => ({
        ...phaseWindowInput(window),
        startsAt: window.startsAt + shift,
        endsAt: window.endsAt + shift,
      })),
    );
    await ctx.db.patch(phaseSchedule.schedule._id, {
      checksum: phaseScheduleChecksum(shiftedPhases),
    });

    const attendancePlanVersionId = event.publishedAttendancePlanVersionId;
    if (!attendancePlanVersionId) {
      throw new Error("The local event has no published attendance plan.");
    }
    const attendanceSessions = await ctx.db
      .query("attendanceSessions")
      .withIndex("by_event_status_start", (index) => index.eq("eventId", event._id))
      .collect();
    for (const session of attendanceSessions) {
      await ctx.db.patch(session._id, {
        startsAt: session.startsAt + shift,
        endsAt: session.endsAt + shift,
        checkInOpensAt: session.checkInOpensAt + shift,
        checkInClosesAt: session.checkInClosesAt + shift,
        version: session.version + 1,
        updatedAt: now,
      });
    }
    await ctx.db.patch(attendancePlanVersionId, {
      checksum: attendancePlanChecksum(localAttendancePlanContent(startsAt)),
    });

    const communicationsPolicyId = event.publishedCommunicationsPolicyId;
    if (!communicationsPolicyId) {
      throw new Error("The local event has no published communications policy.");
    }
    const communicationsPolicy = await ctx.db.get(communicationsPolicyId);
    if (!communicationsPolicy) {
      throw new Error("The published communications policy no longer resolves.");
    }
    await ctx.db.patch(communicationsPolicy._id, {
      startsAt,
      endsAt,
      checksum: communicationsPolicyChecksum({
        ...communicationsPolicyFromDocument(communicationsPolicy),
        startsAt,
        endsAt,
      }),
    });

    const integrationPolicyId = event.publishedIntegrationPolicyId;
    if (!integrationPolicyId) {
      throw new Error("The local event has no published integration policy.");
    }
    const integrationPolicy = localIntegrationPolicy(startsAt);
    await ctx.db.patch(integrationPolicyId, {
      githubFreezeAt: integrationPolicy.githubFreezeAt,
      figmaFreezeAt: integrationPolicy.figmaFreezeAt,
      checksum: fingerprintText(JSON.stringify(integrationPolicy)),
    });

    let status: EventLifecycleStatus = event.status;
    for (const target of ["registration_closed", "live"] as const) {
      if (!eventLifecycleTransitionAllowed(status, target)) {
        throw new Error(`The local event cannot move from ${status} to ${target}.`);
      }
      status = target;
    }
    await ctx.db.patch(event._id, {
      startsAt,
      endsAt,
      status: "live",
      version: event.version + 1,
      updatedAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: seedPerson._id,
      permissionKey: "event.lifecycle.manage",
      grantIds: [],
      scopeType: "event",
      action: "event.lifecycle_changed",
      targetType: "event",
      targetId: event._id,
      previousSummary: JSON.stringify({
        status: event.status,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
      }),
      nextSummary: JSON.stringify({ status: "live", startsAt, endsAt }),
      reason: "Local demo seed moved the event into a live mid-event window",
    });
    return null;
  },
});

export const seedOperationsLead = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    if (await findDemoPerson(ctx, demoOperationsLead.displayName)) return null;
    const now = Date.now();
    const lead = await createDemoAccount(ctx, {
      eventId: event._id,
      displayName: demoOperationsLead.displayName,
      linkedBy: "access_invitation",
      now,
    });
    await assignDemoRole(ctx, {
      eventId: event._id,
      personId: lead.personId,
      eventAccessSubjectId: lead.subjectId,
      role: "board",
      assignedByPersonId: lead.personId,
      now,
    });
    return null;
  },
});

export const seedOperationsLeadGrantBatch = internalMutation({
  args: { batchIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const permissionKeys = eventWidePermissionKeys().slice(
      args.batchIndex * operationsLeadPermissionsPerBatch,
      (args.batchIndex + 1) * operationsLeadPermissionsPerBatch,
    );
    if (permissionKeys.length === 0) {
      throw new Error("The demo operations lead permission batch is empty.");
    }
    const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);
    const subject = await requireDemoSubject(ctx, event._id, lead._id);
    await grantEventWide(ctx, {
      eventId: event._id,
      personId: lead._id,
      eventAccessSubjectId: subject._id,
      permissionKeys,
      grantedByPersonId: lead._id,
      reason: "Local demo operations lead",
      now: Date.now(),
    });
    return null;
  },
});

export const seedStaffMember = internalMutation({
  args: { staffIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const staff = demoStaff[args.staffIndex];
    if (!staff) throw new Error("The demo staff index is outside the fixture.");
    if (await findDemoPerson(ctx, staff.displayName)) return null;
    const event = await requireDemoEvent(ctx);
    const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);
    const now = Date.now();
    const account = await createDemoAccount(ctx, {
      eventId: event._id,
      displayName: staff.displayName,
      linkedBy: "access_invitation",
      now,
    });
    await assignDemoRole(ctx, {
      eventId: event._id,
      personId: account.personId,
      eventAccessSubjectId: account.subjectId,
      role: staff.role,
      assignedByPersonId: lead._id,
      now,
    });
    await grantEventWide(ctx, {
      eventId: event._id,
      personId: account.personId,
      eventAccessSubjectId: account.subjectId,
      permissionKeys: assertPermissionKeys(staff.permissionKeys),
      grantedByPersonId: lead._id,
      reason: `Local demo ${staff.key.replaceAll("-", " ")}`,
      now,
    });
    return null;
  },
});

export const seedReviewerBatch = internalMutation({
  args: { batchIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);
    const batch = demoReviewers.slice(
      args.batchIndex * reviewersPerBatch,
      (args.batchIndex + 1) * reviewersPerBatch,
    );
    if (batch.length === 0) throw new Error("The demo reviewer batch is empty.");
    const now = Date.now();
    const criterionKeys = demoRubricCriteria.map((criterion) => criterion.stableKey);
    for (const [offset, reviewer] of batch.entries()) {
      if (await findDemoPerson(ctx, reviewer.displayName)) continue;
      const index = args.batchIndex * reviewersPerBatch + offset;
      const account = await createDemoAccount(ctx, {
        eventId: event._id,
        displayName: reviewer.displayName,
        linkedBy: "access_invitation",
        now,
      });
      await assignDemoRole(ctx, {
        eventId: event._id,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        role: reviewer.role,
        assignedByPersonId: lead._id,
        now,
      });
      await ctx.db.insert("reviewerProfiles", {
        eventId: event._id,
        personId: account.personId,
        technicalDomains: index % 2 === 0 ? ["backend", "data"] : ["frontend", "mobile"],
        productDomains: index % 3 === 0 ? ["civic"] : ["education", "health"],
        languages: ["English", index % 2 === 0 ? "Hindi" : "Tamil"],
        criterionKeys,
        availabilityWindows: [{ startsAt: now - 6 * hour, endsAt: now + 7 * hour }],
        trainingStatus: "complete",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("reviewerDevices", {
        eventId: event._id,
        personId: account.personId,
        installationId: `local-demo-device-${index + 1}`,
        name: `${reviewer.displayName.split(" ")[0] ?? "Reviewer"}'s phone`,
        platform: index % 3 === 0 ? "ios" : "android",
        appBuild: 42,
        cameraReady: true,
        encryptedDraftReady: true,
        pushTokenStatus: "not_registered",
        pushTokenUpdatedAt: now,
        status: "active",
        version: 1,
        registeredAt: now - 5 * hour,
        lastSeenAt: now - (index + 1) * minute,
      });
    }
    return null;
  },
});

async function createDemoTeam(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    definition: (typeof demoTeams)[number];
    teamIndex: number;
    leadPersonId: Id<"people">;
    participantPolicyVersionId: Id<"participantPolicyVersions">;
    intakePolicyVersionId: Id<"intakePolicyVersions">;
    admissionPolicyVersionId: Id<"admissionPolicyVersions">;
    now: number;
  },
) {
  const { event, definition, now } = args;
  const memberships: Doc<"eventMemberships">[] = [];
  for (const [memberIndex, displayName] of definition.members.entries()) {
    const account = await createDemoAccount(ctx, {
      eventId: event._id,
      displayName,
      linkedBy: "participant_provisioning",
      now,
    });
    const membershipId = await ctx.db.insert("eventMemberships", {
      eventId: event._id,
      personId: account.personId,
      eventAccessSubjectId: account.subjectId,
      participantClass: definition.participantClass,
      eligibilityStatus: "eligible",
      onboardingStatus: "accepted",
      acceptedParticipantPolicyVersionIds: [args.participantPolicyVersionId],
      createdAt: now,
      updatedAt: now,
    });
    for (const permissionKey of [
      "participant.profile.read",
      "participant.profile.write",
      "team.join",
      "communications.delivery.self.read",
      "attendance.self.read",
      "attendance.remedy.self.read",
      "attendance.remedy.self.open",
      "attendance.portal_qr.mint",
    ] as const) {
      await insertPermissionGrant(ctx, {
        eventId: event._id,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        permissionKey,
        scopeType: "self",
        scopeId: membershipId,
        sourceType: "participant_membership",
        sourceId: membershipId,
        reason: "Participant membership",
      });
    }
    const isVitStudent = definition.participantClass === "vit_student";
    const studyYear = studyYears[memberIndex % studyYears.length] ?? "first";
    await ctx.db.insert("participantProfiles", {
      eventId: event._id,
      membershipId,
      participantClass: definition.participantClass,
      fullName: displayName,
      institution: isVitStudent ? "VIT Chennai" : "Independent",
      yearOfStudy: studyYear,
      ...(isVitStudent
        ? {
            vitRegistrationNumber: `${23 + (args.teamIndex % 2)}BCE${String(
              args.teamIndex * 10 + memberIndex + 101,
            ).padStart(4, "0")}`,
            vitProgramme: vitProgrammes[memberIndex % vitProgrammes.length] ?? vitProgrammes[0],
            vitCampus: "Chennai",
          }
        : {
            externalCity: externalCities[memberIndex % externalCities.length] ?? externalCities[0],
            externalCountry: "India",
          }),
      profileVersion: 1,
      updatedAt: now,
    });
    const membership = await ctx.db.get(membershipId);
    if (!membership) throw new Error("A demo participant membership did not persist.");
    memberships.push(membership);
  }
  const leadMembership = memberships[0];
  if (!leadMembership) throw new Error("A demo team has no lead membership.");

  const teamId = await ctx.db.insert("teams", {
    eventId: event._id,
    name: definition.name,
    publicCode: definition.publicCode,
    leadMembershipId: leadMembership._id,
    status: "confirmed",
    activeMemberCount: memberships.length,
    activeVitMemberCount: memberships.filter(
      (membership) => membership.participantClass === "vit_student",
    ).length,
    activeExternalMemberCount: memberships.filter(
      (membership) => membership.participantClass === "external_participant",
    ).length,
    membershipLocked: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const team = await ctx.db.get(teamId);
  if (!team) throw new Error("A demo team did not persist.");

  const teamMemberIds: Id<"teamMembers">[] = [];
  for (const [memberIndex, membership] of memberships.entries()) {
    const lead = memberIndex === 0;
    const teamMemberId = await ctx.db.insert("teamMembers", {
      eventId: event._id,
      teamId,
      membershipId: membership._id,
      role: lead ? "lead" : "member",
      status: "active",
      joinedAt: now,
      source: lead ? "created" : "code",
    });
    teamMemberIds.push(teamMemberId);
    await addTeamMemberGrants(ctx, {
      event,
      membership,
      teamId,
      teamMemberId,
      actorPersonId: args.leadPersonId,
      lead,
    });
  }

  const projectDraftId = await ctx.db.insert("projectDrafts", {
    eventId: event._id,
    teamId,
    intakePolicyVersionId: args.intakePolicyVersionId,
    stage: "submitted",
    initialIdea: definition.initialIdea,
    freshnessAttestedByMembershipId: leadMembership._id,
    freshnessAttestedAt: now - 30 * hour,
    version: 2,
    lastEditedByMembershipId: leadMembership._id,
    updatedAt: now - 29 * hour,
  });
  const submissionAttemptId = await createLocalSubmissionSnapshot(ctx, {
    eventId: event._id,
    team,
    draftId: projectDraftId,
    teamMemberIds,
    participantPolicyVersionId: args.participantPolicyVersionId,
    admissionPolicyVersionId: args.admissionPolicyVersionId,
    requesterMembershipId: leadMembership._id,
    requesterPersonId: leadMembership.personId,
    submittedAt: now - 29 * hour,
  });
  const projectVersionId = await ctx.db.insert("projectVersions", {
    eventId: event._id,
    teamId,
    version: 1,
    initialIdea: definition.initialIdea,
    intakePolicyVersionId: args.intakePolicyVersionId,
    intakeResponses: [],
    lockedRosterSnapshotId: submissionAttemptId,
    lockedMemberCount: teamMemberIds.length,
    lockedLeadMembershipId: leadMembership._id,
    freshForEventAttestation: {
      participantPolicyVersionId: args.participantPolicyVersionId,
      acceptedByMembershipId: leadMembership._id,
      acceptedAt: now - 30 * hour,
    },
    finalConfirmation: {
      participantPolicyVersionId: args.participantPolicyVersionId,
      previewedDraftVersion: 2,
      previewedTeamVersion: 1,
      confirmedByMembershipId: leadMembership._id,
      confirmedAt: now - 29 * hour,
    },
    participantPolicyVersionId: args.participantPolicyVersionId,
    admissionPolicyVersionId: args.admissionPolicyVersionId,
    sourceDraftVersion: 2,
    submittedByMembershipId: leadMembership._id,
    submittedAt: now - 29 * hour,
  });
  // Leave some teams in earlier admission stages while keeping enough confirmed for review.
  const admission: DemoAdmission =
    "admission" in definition ? definition.admission : confirmedAdmission;
  const decided = "decision" in admission;
  const applicationId = await ctx.db.insert("applications", {
    eventId: event._id,
    teamId,
    submittedProjectVersionId: projectVersionId,
    admissionPolicyVersionId: args.admissionPolicyVersionId,
    state: admission.state,
    experienceBand:
      definition.participantClass === "vit_student" ? "early_year" : "mixed_or_external",
    aiDisposition: "unavailable",
    ...(decided
      ? {
          humanDecision: admission.decision,
          humanReasonCode: admission.reasonCode,
          decidedByPersonId: args.leadPersonId,
          decidedAt: now - 28 * hour,
        }
      : {}),
    assignedReviewCount: 0,
    completedReviewCount: 0,
    contentVersion: 1,
    version: decided ? 3 : 1,
    submittedAt: now - 29 * hour,
  });
  await completeLocalSubmissionSnapshot(ctx, {
    submissionAttemptId,
    projectVersionId,
    applicationId,
    completedAt: now - 29 * hour,
  });
  await ctx.db.patch(teamId, {
    submissionAttemptId,
    lockedProjectVersionId: projectVersionId,
    lockedAt: now - 29 * hour,
    lockParticipantPolicyVersionId: args.participantPolicyVersionId,
    version: team.version + 1,
    updatedAt: now,
  });
  // Every team needs an availability projection; absence is an invariant failure.
  await initializeAttendanceTeamAvailability(ctx, {
    eventId: event._id,
    teamId,
    activeMemberCount: memberships.length,
    now,
  });
  if (admission.state !== "confirmed") {
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: args.leadPersonId,
      permissionKey: "application.decide",
      grantIds: [],
      scopeType: "team",
      scopeId: teamId,
      action: `application.${admission.state}`,
      targetType: "team",
      targetId: teamId,
      previousSummary: JSON.stringify({ status: "submitted" }),
      nextSummary: JSON.stringify({ status: admission.state }),
      reason: demoReason,
    });
    return;
  }
  // Keep one team below the round's minimum for review-desk testing.
  const insideCount = args.teamIndex === shortHandedDemoTeamIndex ? 1 : memberships.length;
  for (const [memberIndex, membership] of memberships.entries()) {
    const inside = memberIndex < insideCount;
    await ctx.db.insert("attendanceVenueStates", {
      eventId: event._id,
      membershipId: membership._id,
      state: inside ? "inside" : "temporarily_out",
      version: 1,
      updatedAt: now,
    });
    if (!inside) continue;
    await moveAttendanceTeamAvailability(ctx, {
      eventId: event._id,
      membershipId: membership._id,
      previousState: "not_arrived",
      nextState: "inside",
      now,
    });
  }
  await writeAuditEvent(ctx, {
    eventId: event._id,
    actorPersonId: args.leadPersonId,
    permissionKey: "application.decide",
    grantIds: [],
    scopeType: "team",
    scopeId: teamId,
    action: "application.confirmed",
    targetType: "team",
    targetId: teamId,
    previousSummary: JSON.stringify({ status: "submitted" }),
    nextSummary: JSON.stringify({
      status: "confirmed",
      memberCount: memberships.length,
      projectVersionId,
    }),
    reason: demoReason,
  });
}

export const seedTeamBatch = internalMutation({
  args: { batchIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const batch = demoTeams.slice(
      args.batchIndex * teamsPerBatch,
      (args.batchIndex + 1) * teamsPerBatch,
    );
    const first = batch[0];
    if (!first) throw new Error("The demo team batch is empty.");
    const existing = await ctx.db
      .query("teams")
      .withIndex("by_event_code", (index) =>
        index.eq("eventId", event._id).eq("publicCode", first.publicCode),
      )
      .unique();
    if (existing) {
      const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);
      await reconcileDemoTeamAccess(ctx, event, batch, lead._id);
      return null;
    }

    const participantPolicyVersionId = event.publishedParticipantPolicyId;
    const intakePolicyVersionId = event.publishedIntakePolicyId;
    const admissionPolicyVersionId = event.publishedAdmissionPolicyId;
    if (
      !participantPolicyVersionId ||
      !intakePolicyVersionId ||
      !admissionPolicyVersionId
    ) {
      throw new Error("The local event is missing a published policy the demo teams need.");
    }
    const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);

    const now = Date.now();
    for (const [offset, definition] of batch.entries()) {
      await createDemoTeam(ctx, {
        event,
        definition,
        teamIndex: args.batchIndex * teamsPerBatch + offset,
        leadPersonId: lead._id,
        participantPolicyVersionId,
        intakePolicyVersionId,
        admissionPolicyVersionId,
        now,
      });
    }
    return null;
  },
});

async function reconcileDemoTeamAccess(
  ctx: MutationCtx,
  event: Doc<"events">,
  definitions: readonly (typeof demoTeams)[number][],
  actorPersonId: Id<"people">,
) {
  for (const definition of definitions) {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_event_code", (index) =>
        index.eq("eventId", event._id).eq("publicCode", definition.publicCode),
      )
      .unique();
    if (!team) throw new Error(`The local demo team ${definition.publicCode} is missing.`);
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_status", (index) =>
        index.eq("teamId", team._id).eq("status", "active"),
      )
      .collect();
    for (const member of members) {
      const membership = await ctx.db.get(member.membershipId);
      if (!membership) throw new Error("A local demo team member has no event membership.");
      await addTeamMemberGrants(ctx, {
        event,
        membership,
        teamId: team._id,
        teamMemberId: member._id,
        actorPersonId,
        lead: member.role === "lead",
      });
    }
  }
}

export const seedReviewRound = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const existing = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_key", (index) =>
        index.eq("eventId", event._id).eq("stableKey", demoRoundStableKey),
      )
      .unique();
    if (existing) return null;

    const now = Date.now();
    const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);
    const rubricName = "Code2Create judging rubric";
    const aggregationFormula = "criterion_mean_weighted_v1" as const;
    const spreadThreshold = 2;
    const rubricChecksum = operationFingerprint([
      rubricName,
      aggregationFormula,
      spreadThreshold,
      JSON.stringify(demoRubricCriteria),
    ]);
    const rubricVersionId = await ctx.db.insert("reviewRubricVersions", {
      eventId: event._id,
      version: 1,
      name: rubricName,
      status: "published",
      scoreMinimum: 0,
      scoreMaximum: 4,
      aggregationFormula,
      spreadThreshold,
      checksum: rubricChecksum,
      createdByPersonId: lead._id,
      createdAt: now - 20 * hour,
      publishedAt: now - 20 * hour,
    });
    const criterionIds: Id<"reviewRubricCriteria">[] = [];
    for (const criterion of demoRubricCriteria) {
      const criterionId = await ctx.db.insert("reviewRubricCriteria", {
        eventId: event._id,
        rubricVersionId,
        stableKey: criterion.stableKey,
        label: criterion.label,
        question: criterion.question,
        guidance: criterion.guidance,
        weight: criterion.weight,
        displayOrder: criterion.displayOrder,
        anchors: criterion.anchors,
        createdAt: now - 20 * hour,
      });
      criterionIds.push(criterionId);
    }

    const roundConfiguration = {
      name: "Final judging round",
      sequence: 1,
      reviewDurationSeconds: 900,
      ordinaryExtensionSeconds: 300,
      maximumOrdinaryExtensions: 2,
      missedCallGraceSeconds: 600,
      requiredCallAttempts: 2,
      substituteResponseSeconds: 300,
      missedReentryPolicy: "queue_end" as const,
      requiredPanelSize: 3,
      minimumScorersPerCriterion: 2,
      minimumPresentParticipants: 2,
      requiresSharedCommitments: true,
      minimumReviewerBuild: 40,
      requiresCamera: true,
      requiresNotifications: false,
      correctionRequestsCloseAt: now + 5 * hour,
    };
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId: event._id,
      rubricVersionId,
      stableKey: demoRoundStableKey,
      ...roundConfiguration,
      status: "open",
      startsAt: now - 3 * hour,
      endsAt: now + 6 * hour,
      clockInOpensAt: now - 3 * hour - 10 * minute,
      reviewerReportAt: now - 3 * hour - 5 * minute,
      noShowGraceSeconds: 300,
      version: 2,
      configurationChecksum: operationFingerprint([
        rubricChecksum,
        JSON.stringify(roundConfiguration),
        JSON.stringify(demoPanels),
      ]),
      createdByPersonId: lead._id,
      createdAt: now - 20 * hour,
      publishedAt: now - 20 * hour,
      openedAt: now - 3 * hour,
    });

    const panelMemberPersonIds: Id<"people">[] = [];
    let reviewerCursor = 0;
    for (const panel of demoPanels) {
      const members = demoReviewers.slice(
        reviewerCursor,
        reviewerCursor + panel.memberCount,
      );
      reviewerCursor += panel.memberCount;
      const coordinator = members[0];
      if (!coordinator) throw new Error("A demo panel has no coordinator.");
      const coordinatorPerson = await requireDemoPerson(ctx, coordinator.displayName);
      const panelId = await ctx.db.insert("reviewPanels", {
        eventId: event._id,
        roundId,
        stableKey: panel.stableKey,
        name: panel.name,
        coordinatorPersonId: coordinatorPerson._id,
        status: panel.memberCount === roundConfiguration.requiredPanelSize
          ? "ready"
          : "needs_reviewer",
        version: 1,
        createdAt: now - 19 * hour,
        updatedAt: now - 19 * hour,
      });
      for (const [memberIndex, member] of members.entries()) {
        const person = await requireDemoPerson(ctx, member.displayName);
        const subject = await requireDemoSubject(ctx, event._id, person._id);
        const isCoordinator = memberIndex === 0;
        const panelMemberId = await ctx.db.insert("reviewPanelMembers", {
          eventId: event._id,
          roundId,
          panelId,
          personId: person._id,
          eventAccessSubjectId: subject._id,
          assignedCriterionIds: criterionIds,
          isCoordinator,
          status: "active",
          assignedAt: now - 19 * hour,
        });
        await grantPanelMemberAccess(ctx, {
          eventId: event._id,
          roundId,
          panelId,
          panelMemberId,
          reviewerPersonId: person._id,
          eventAccessSubjectId: subject._id,
          grantedByPersonId: lead._id,
          isCoordinator,
          reason: "Local demo panel assignment",
        });
        panelMemberPersonIds.push(person._id);
      }
    }

    const unavailablePersonId = panelMemberPersonIds.at(-1);
    const staleHeartbeatPersonId = panelMemberPersonIds[1];
    if (!unavailablePersonId || !staleHeartbeatPersonId) {
      throw new Error("The demo round has too few panel members.");
    }
    const spareReviewer = demoReviewers[panelMemberPersonIds.length];
    if (!spareReviewer) throw new Error("The demo round has no spare reviewer to clock in.");
    const sparePerson = await requireDemoPerson(ctx, spareReviewer.displayName);
    for (const personId of [...panelMemberPersonIds, sparePerson._id]) {
      const device = await ctx.db
        .query("reviewerDevices")
        .withIndex("by_event_person_status", (index) =>
          index.eq("eventId", event._id).eq("personId", personId).eq("status", "active"),
        )
        .unique();
      if (!device) throw new Error("A demo reviewer has no active device.");
      const unavailable = personId === unavailablePersonId;
      await ctx.db.insert("reviewerClockIns", {
        eventId: event._id,
        roundId,
        reviewerPersonId: personId,
        reviewerDeviceId: device._id,
        status: unavailable ? "temporarily_unavailable" : "present",
        ...(unavailable
          ? {
              unavailableReason: "Stepped away for a short break.",
              expectedReturnAt: now + 10 * minute,
            }
          : {}),
        clockedInAt: now - 3 * hour,
        lastHeartbeatAt:
          personId === staleHeartbeatPersonId ? now - 6 * minute : now - 30 * 1_000,
        version: 1,
      });
    }
    return null;
  },
});

async function requireDemoRound(ctx: MutationCtx, eventId: Id<"events">) {
  const round = await ctx.db
    .query("reviewRounds")
    .withIndex("by_event_key", (index) =>
      index.eq("eventId", eventId).eq("stableKey", demoRoundStableKey),
    )
    .unique();
  if (!round) throw new Error("The demo review round is missing.");
  return round;
}

async function demoRoundContext(ctx: MutationCtx, event: Doc<"events">) {
  const round = await requireDemoRound(ctx, event._id);
  const panels = await ctx.db
    .query("reviewPanels")
    .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
    .collect();
  const panelByKey = new Map(panels.map((panel) => [panel.stableKey, panel]));
  const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);
  return { round, panelByKey, lead };
}

async function requireLocalOperator(ctx: MutationCtx) {
  const operator = await ctx.db
    .query("people")
    .withIndex("by_verified_email", (index) =>
      index.eq("verifiedEmail", localOperatorEmail),
    )
    .unique();
  if (!operator || operator.status !== "active") {
    throw new ConvexError({
      code: "LOCAL_OPERATOR_MISSING",
      message: "Sign in as the local operator once before preparing reviewer mode.",
    });
  }
  return operator;
}

async function requireLocalLivePanel(
  ctx: MutationCtx,
  roundId: Id<"reviewRounds">,
) {
  const panel = await ctx.db
    .query("reviewPanels")
    .withIndex("by_round_key", (index) =>
      index.eq("roundId", roundId).eq("stableKey", localLivePanelStableKey),
    )
    .unique();
  if (!panel) throw new Error("The local live-review panel is missing.");
  return panel;
}

async function ensureLocalOperatorSubject(
  ctx: MutationCtx,
  event: Doc<"events">,
  operator: Doc<"people">,
  now: number,
) {
  const existing = await ctx.db
    .query("eventAccessSubjects")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", event._id).eq("personId", operator._id),
    )
    .unique();
  if (existing) {
    if (existing.status !== "active") {
      throw new ConvexError({
        code: "LOCAL_OPERATOR_ACCESS_INACTIVE",
        message: "The local operator's event access is inactive.",
      });
    }
    return existing;
  }
  const subjectId = await ctx.db.insert("eventAccessSubjects", {
    eventId: event._id,
    personId: operator._id,
    emailNormalized: operator.verifiedEmail,
    displayName: operator.displayName,
    status: "active",
    linkedBy: "access_invitation",
    accessVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  await addEventSubjectSelfGrants(ctx, {
    eventId: event._id,
    personId: operator._id,
    eventAccessSubjectId: subjectId,
  });
  const subject = await ctx.db.get(subjectId);
  if (!subject) throw new Error("The local operator event subject did not persist.");
  return subject;
}

function isLiveDemoReview(status: Doc<"reviewSessions">["status"]) {
  return status === "awaiting_presence" || status === "active" || status === "overdue";
}

async function ensureLocalOperatorPanelSeat(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    round: Doc<"reviewRounds">;
    panel: Doc<"reviewPanels">;
    operator: Doc<"people">;
    grantedByPersonId: Id<"people">;
    now: number;
  },
) {
  const activeSeats = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_round_person_status", (index) =>
      index
        .eq("roundId", args.round._id)
        .eq("personId", args.operator._id)
        .eq("status", "active"),
    )
    .collect();
  const reserve = await ctx.db
    .query("reviewRoundReserves")
    .withIndex("by_round_person", (index) =>
      index.eq("roundId", args.round._id).eq("personId", args.operator._id),
    )
    .unique();
  if (reserve?.status === "paged" || reserve?.status === "assigned") {
    throw new ConvexError({
      code: "LOCAL_OPERATOR_RESERVE_BUSY",
      message: "Resolve the local operator's active reserve page before seating them on a panel.",
    });
  }
  if (reserve?.status === "available") {
    await ctx.db.patch(reserve._id, {
      status: "removed",
      version: reserve.version + 1,
      updatedAt: args.now,
    });
    await revokeSourceGrants(ctx, {
      eventId: args.event._id,
      sourceType: "reserve_assignment",
      sourceId: reserve._id,
      revokedByPersonId: args.grantedByPersonId,
      reason: "Local operator took the live-review fixture panel seat",
    });
  }
  const currentTargetSeat = activeSeats.find((seat) => seat.panelId === args.panel._id);
  if (currentTargetSeat) {
    if (activeSeats.length !== 1) {
      throw new Error("The local operator has duplicate active panel seats.");
    }
    return { membership: currentTargetSeat, changed: false };
  }

  const assignedReviews = await ctx.db
    .query("reviewAssignments")
    .withIndex("by_person_status", (index) =>
      index.eq("reviewerPersonId", args.operator._id).eq("status", "assigned"),
    )
    .collect();
  for (const assignment of assignedReviews) {
    const session = await ctx.db.get(assignment.reviewSessionId);
    if (
      session &&
      session.eventId === args.event._id &&
      session.roundId === args.round._id &&
      isLiveDemoReview(session.status)
    ) {
      throw new ConvexError({
        code: "LOCAL_OPERATOR_ALREADY_REVIEWING",
        message: "Finish the local operator's current live review before moving their panel seat.",
      });
    }
  }

  const targetSeats = await ctx.db
    .query("reviewPanelMembers")
    .withIndex("by_panel_status", (index) => index.eq("panelId", args.panel._id))
    .take(args.round.requiredPanelSize + 2);
  const targetSeatCount = args.round.requiredPanelSize - 1;
  let targetActiveSeats = targetSeats.filter((seat) => seat.status === "active");
  if (targetActiveSeats.length < targetSeatCount) {
    const restorableSeats = targetSeats.filter(
      (seat) => seat.status === "removed" && seat.personId !== args.operator._id,
    );
    const seatsToRestore = restorableSeats.slice(
      0,
      targetSeatCount - targetActiveSeats.length,
    );
    for (const seat of seatsToRestore) {
      await ctx.db.patch(seat._id, { status: "active", endedAt: undefined });
      await grantPanelMemberAccess(ctx, {
        eventId: args.event._id,
        roundId: args.round._id,
        panelId: args.panel._id,
        panelMemberId: seat._id,
        reviewerPersonId: seat.personId,
        eventAccessSubjectId: seat.eventAccessSubjectId,
        grantedByPersonId: args.grantedByPersonId,
        isCoordinator: seat.isCoordinator,
        reason: "Local live-review fixture restored the seed panel seat",
      });
    }
    targetActiveSeats = [...targetActiveSeats, ...seatsToRestore];
  }
  if (targetActiveSeats.length !== args.round.requiredPanelSize - 1) {
    throw new Error("The local live-review panel does not have exactly one open seat.");
  }
  const template = targetActiveSeats[0];
  if (!template) throw new Error("The local live-review panel has no criterion assignment.");
  const subject = await ensureLocalOperatorSubject(ctx, args.event, args.operator, args.now);

  for (const oldSeat of activeSeats) {
    await ctx.db.patch(oldSeat._id, { status: "removed", endedAt: args.now });
    await revokeSourceGrants(ctx, {
      eventId: args.event._id,
      sourceType: "panel_assignment",
      sourceId: oldSeat._id,
      revokedByPersonId: args.grantedByPersonId,
      reason: "Local operator moved to the live-review fixture panel",
    });
    const oldPanel = await ctx.db.get(oldSeat.panelId);
    if (oldPanel && oldPanel.status !== "closed") {
      const remaining = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", oldPanel._id).eq("status", "active"),
        )
        .collect();
      const status = remaining.length === args.round.requiredPanelSize
        ? "ready" as const
        : "needs_reviewer" as const;
      if (oldPanel.status !== status) {
        await ctx.db.patch(oldPanel._id, {
          status,
          version: oldPanel.version + 1,
          updatedAt: args.now,
        });
        await appendReviewPanelVacancyReadFactById(ctx, oldPanel._id, args.now);
      }
    }
  }

  const reusableSeat = targetSeats.find((seat) => seat.personId === args.operator._id);
  const seatFields = {
    eventId: args.event._id,
    roundId: args.round._id,
    panelId: args.panel._id,
    personId: args.operator._id,
    eventAccessSubjectId: subject._id,
    assignedCriterionIds: template.assignedCriterionIds,
    isCoordinator: false,
    status: "active" as const,
    assignedAt: args.now,
  };
  const panelMemberId = reusableSeat?._id ?? await ctx.db.insert("reviewPanelMembers", seatFields);
  if (reusableSeat) {
    await ctx.db.patch(reusableSeat._id, { ...seatFields, endedAt: undefined });
  }
  await grantPanelMemberAccess(ctx, {
    eventId: args.event._id,
    roundId: args.round._id,
    panelId: args.panel._id,
    panelMemberId,
    reviewerPersonId: args.operator._id,
    eventAccessSubjectId: subject._id,
    grantedByPersonId: args.grantedByPersonId,
    isCoordinator: false,
    reason: "Local operator seated for development",
  });
  await ctx.db.patch(args.panel._id, {
    status: "ready",
    version: args.panel.version + 1,
    updatedAt: args.now,
  });
  await appendReviewPanelVacancyReadFactById(ctx, args.panel._id, args.now);
  const membership = await ctx.db.get(panelMemberId);
  if (!membership) throw new Error("The local operator panel seat did not persist.");
  return { membership, changed: true };
}

async function prepareLivePanelReviewers(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    round: Doc<"reviewRounds">;
    members: Doc<"reviewPanelMembers">[];
    operator: Doc<"people">;
    now: number;
  },
) {
  const criteria = await ctx.db
    .query("reviewRubricCriteria")
    .withIndex("by_rubric_order", (index) =>
      index.eq("rubricVersionId", args.round.rubricVersionId),
    )
    .collect();
  const criterionKeys = criteria.map((criterion) => criterion.stableKey);
  const operatorProfile = await ctx.db
    .query("reviewerProfiles")
    .withIndex("by_event_person", (index) =>
      index.eq("eventId", args.event._id).eq("personId", args.operator._id),
    )
    .unique();
  if (operatorProfile) {
    await ctx.db.patch(operatorProfile._id, {
      criterionKeys,
      availabilityWindows: [{ startsAt: args.round.clockInOpensAt, endsAt: args.round.endsAt }],
      trainingStatus: "complete",
      status: "active",
      version: operatorProfile.version + 1,
      updatedAt: args.now,
    });
  } else {
    await ctx.db.insert("reviewerProfiles", {
      eventId: args.event._id,
      personId: args.operator._id,
      technicalDomains: [],
      productDomains: [],
      languages: ["English"],
      criterionKeys,
      availabilityWindows: [{ startsAt: args.round.clockInOpensAt, endsAt: args.round.endsAt }],
      trainingStatus: "complete",
      status: "active",
      version: 1,
      createdAt: args.now,
      updatedAt: args.now,
    });
  }

  for (const member of args.members) {
    const [profile, device, clockIn] = await Promise.all([
      ctx.db
        .query("reviewerProfiles")
        .withIndex("by_event_person", (index) =>
          index.eq("eventId", args.event._id).eq("personId", member.personId),
        )
        .unique(),
      ctx.db
        .query("reviewerDevices")
        .withIndex("by_event_person_status", (index) =>
          index
            .eq("eventId", args.event._id)
            .eq("personId", member.personId)
            .eq("status", "active"),
        )
        .unique(),
      ctx.db
        .query("reviewerClockIns")
        .withIndex("by_round_person", (index) =>
          index
            .eq("roundId", args.round._id)
            .eq("reviewerPersonId", member.personId),
        )
        .unique(),
    ]);
    if (!profile || profile.status !== "active" || profile.trainingStatus !== "complete") {
      throw new Error("A local live-review panel member is not a trained active reviewer.");
    }
    if (!device) {
      if (member.personId === args.operator._id) {
        throw new ConvexError({
          code: "LOCAL_REVIEWER_PHONE_MISSING",
          message: "Set up and register this phone in reviewer mode before starting the local live review.",
        });
      }
      throw new Error("A local live-review panel member has no active device.");
    }
    if (
      device.appBuild < args.round.minimumReviewerBuild ||
      !device.encryptedDraftReady ||
      (args.round.requiresCamera && !device.cameraReady) ||
      (args.round.requiresNotifications && device.pushTokenStatus !== "active")
    ) {
      throw new ConvexError({
        code: "LOCAL_REVIEWER_PHONE_NOT_READY",
        message: "Finish the reviewer phone checks before starting the local live review.",
      });
    }
    if (clockIn) {
      await ctx.db.patch(clockIn._id, {
        reviewerDeviceId: device._id,
        status: "present",
        unavailableReason: undefined,
        expectedReturnAt: undefined,
        clockedOutAt: undefined,
        lastHeartbeatAt: args.now,
        version: clockIn.version + 1,
      });
    } else {
      await ctx.db.insert("reviewerClockIns", {
        eventId: args.event._id,
        roundId: args.round._id,
        reviewerPersonId: member.personId,
        reviewerDeviceId: device._id,
        status: "present",
        clockedInAt: args.now,
        lastHeartbeatAt: args.now,
        version: 1,
      });
    }
  }
}

async function requireDemoTeam(
  ctx: MutationCtx,
  eventId: Id<"events">,
  teamIndex: number,
) {
  const definition = demoTeams[teamIndex];
  if (!definition) throw new Error("The demo queue names an unknown team.");
  const team = await ctx.db
    .query("teams")
    .withIndex("by_event_code", (index) =>
      index.eq("eventId", eventId).eq("publicCode", definition.publicCode),
    )
    .unique();
  if (!team) throw new Error(`The demo team ${definition.name} is missing.`);
  return team;
}

export const seedQueueStates = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const { round, panelByKey, lead } = await demoRoundContext(ctx, event);
    const placed = await ctx.db
      .query("teamRoundStates")
      .withIndex("by_round_state_priority_queued", (index) => index.eq("roundId", round._id))
      .first();
    if (placed) return null;

    const now = Date.now();
    for (const [priority, placement] of demoQueuePlacements.entries()) {
      const panel = panelByKey.get(placement.panelKey);
      if (!panel) throw new Error(`The demo panel ${placement.panelKey} is missing.`);
      const team = await requireDemoTeam(ctx, event._id, placement.teamIndex);
      const calledAt =
        placement.calledMinutesAgo === null
          ? null
          : now - placement.calledMinutesAgo * minute;
      await insertTeamRoundState(ctx, {
        eventId: event._id,
        roundId: round._id,
        teamId: team._id,
        panelId: panel._id,
        state: placement.state,
        tableLabel: demoHallLocation(placement.teamIndex),
        queuedAt: now - placement.queuedMinutesAgo * minute,
        ...(calledAt === null ? {} : { calledAt, lastCallAttemptAt: calledAt }),
        callAttemptCount: calledAt === null ? 0 : 1,
        ...(placement.completedMinutesAgo === null
          ? {}
          : { completedAt: now - placement.completedMinutesAgo * minute }),
        ...(placement.state === "held"
          ? {
              holdReason: demoHoldReason,
              stateBeforeHold: "queued" as const,
              heldAt: now - 12 * minute,
            }
          : {}),
        priority,
        version: 1,
        updatedByPersonId: lead._id,
        updatedAt: now,
      });
      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: lead._id,
        permissionKey: "queue.manage",
        grantIds: [],
        scopeType: "panel",
        scopeId: panel._id,
        action: "review.queue_state_seeded",
        targetType: "team",
        targetId: team._id,
        nextSummary: JSON.stringify({ state: placement.state, panelId: panel._id }),
        reason: demoReason,
      });
    }
    return null;
  },
});

export const seedReviewSessionBatch = internalMutation({
  args: { batchIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const batch = demoReviewSessionBatches[args.batchIndex];
    if (!batch) throw new Error("The demo review-session batch is unknown.");
    const { round, panelByKey, lead } = await demoRoundContext(ctx, event);
    const rubric = await ctx.db.get(round.rubricVersionId);
    if (!rubric) throw new Error("The demo rubric is missing.");
    const criteria = await ctx.db
      .query("reviewRubricCriteria")
      .withIndex("by_rubric_order", (index) => index.eq("rubricVersionId", rubric._id))
      .collect();

    const first = batch[0];
    if (!first) throw new Error("The demo review-session batch is empty.");
    const firstTeam = await requireDemoTeam(ctx, event._id, first.teamIndex);
    const existing = await ctx.db
      .query("reviewSessions")
      .withIndex("by_round_team_status", (index) =>
        index.eq("roundId", round._id).eq("teamId", firstTeam._id),
      )
      .first();
    if (existing) return null;

    const now = Date.now();
    for (const plan of batch) {
      const panel = panelByKey.get(plan.panelKey);
      if (!panel) throw new Error(`The demo panel ${plan.panelKey} is missing.`);
      const team = await requireDemoTeam(ctx, event._id, plan.teamIndex);
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "active"),
        )
        .collect();
      const createdAt = now - plan.createdMinutesAgo * minute;
      const evidence = await createEvidenceCheckpoint(ctx, {
        eventId: event._id,
        round,
        team,
        actorPersonId: lead._id,
        createdAt,
      });
      const startedAt =
        plan.startedMinutesAgo === null ? null : now - plan.startedMinutesAgo * minute;
      const reviewSessionId = await ctx.db.insert("reviewSessions", {
        eventId: event._id,
        roundId: round._id,
        panelId: panel._id,
        teamId: team._id,
        projectVersionId: evidence.projectVersionId,
        evidenceCheckpointSetId: evidence.checkpointId,
        rubricVersionId: rubric._id,
        panelVersion: panel.version,
        status: plan.status,
        ...(startedAt === null
          ? {}
          : {
              startedAt,
              plannedEndAt: startedAt + round.reviewDurationSeconds * 1_000,
            }),
        extensionCount: 0,
        extensionSeconds: 0,
        ...(plan.completedMinutesAgo === null
          ? { sharedNotesVersion: 0 }
          : {
              sharedFindings:
                "The build runs end to end and the team named the limits they know about.",
              sharedCommitments:
                "Ship the offline queue and write down the two failure paths before the next checkpoint.",
              sharedNotesVersion: 1,
              sharedNotesByPersonId: lead._id,
              completedAt: now - plan.completedMinutesAgo * minute,
            }),
        version: plan.completedMinutesAgo === null ? (startedAt === null ? 1 : 2) : 3,
        createdByPersonId: lead._id,
        createdAt,
        updatedAt: now,
      });

      for (const [memberIndex, member] of members.entries()) {
        const assignmentId = await ctx.db.insert("reviewAssignments", {
          eventId: event._id,
          roundId: round._id,
          panelId: panel._id,
          reviewSessionId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          assignedCriterionIds: member.assignedCriterionIds,
          isCoordinator: member.isCoordinator,
          status: "assigned",
          assignedAt: createdAt,
        });
        const scorecardId = await ctx.db.insert("scorecards", {
          eventId: event._id,
          roundId: round._id,
          reviewSessionId,
          reviewerPersonId: member.personId,
          assignmentId,
          rubricVersionId: rubric._id,
          status: "draft",
          ratings: [],
          draftVersion: 0,
          version: 1,
          createdAt,
          updatedAt: createdAt,
        });
        await grantReviewAssignmentAccess(ctx, {
          eventId: event._id,
          reviewSessionId,
          scorecardId,
          assignmentId,
          reviewerPersonId: member.personId,
          eventAccessSubjectId: member.eventAccessSubjectId,
          grantedByPersonId: lead._id,
          isCoordinator: member.isCoordinator,
        });
        if (startedAt !== null) {
          await ctx.db.insert("reviewPresence", {
            eventId: event._id,
            reviewSessionId,
            reviewerPersonId: member.personId,
            method: "qr",
            tokenVersion: 1,
            confirmedAt: startedAt - minute,
          });
        }
        if (plan.completedMinutesAgo === null) continue;
        const submittedAt = now - (plan.completedMinutesAgo + 5) * minute;
        const ratings = criteria.map((criterion, criterionIndex) => ({
          criterionId: criterion._id,
          score: 2 + ((plan.teamIndex + memberIndex * 2 + criterionIndex) % 3),
          evidenceNote: `${criterion.label}: observed during the live walkthrough.`,
        }));
        const checksum = operationFingerprint([
          scorecardId,
          rubric._id,
          1,
          JSON.stringify(ratings),
          null,
        ]);
        const scorecardVersionId = await ctx.db.insert("scorecardVersions", {
          eventId: event._id,
          roundId: round._id,
          reviewSessionId,
          scorecardId,
          reviewerPersonId: member.personId,
          version: 1,
          rubricVersionId: rubric._id,
          ratings,
          checksum,
          clientOperationId: `${demoSourceId}:${scorecardId}`,
          submittedAt,
        });
        await ctx.db.patch(scorecardId, {
          status: "submitted",
          ratings,
          submittedVersionId: scorecardVersionId,
          submittedAt,
          draftVersion: 1,
          version: 2,
          updatedAt: submittedAt,
        });
      }

      if (plan.completedMinutesAgo !== null) {
        const session = await ctx.db.get(reviewSessionId);
        if (!session) throw new Error("The demo review session did not persist.");
        const evaluation = await computeReviewEvaluation(ctx, { round, session, rubric });
        await ctx.db.insert("reviewEvaluations", {
          eventId: event._id,
          roundId: round._id,
          reviewSessionId,
          teamId: team._id,
          rubricVersionId: rubric._id,
          criterionResults: evaluation.criterionResults,
          totalPoints: evaluation.totalPoints,
          state: "complete",
          inputChecksum: evaluation.inputChecksum,
          version: 1,
          computedAt: now - plan.completedMinutesAgo * minute,
        });
      }

      await writeAuditEvent(ctx, {
        eventId: event._id,
        actorPersonId: lead._id,
        permissionKey: "review.prepare",
        grantIds: [],
        scopeType: "panel",
        scopeId: panel._id,
        action: "review.session_seeded",
        targetType: "review_session",
        targetId: reviewSessionId,
        nextSummary: JSON.stringify({
          teamId: team._id,
          status: plan.status,
          assignmentCount: members.length,
          evidenceCompleteness: evidence.completeness,
        }),
        reason: demoReason,
      });
    }
    return null;
  },
});

export const seedDemoState = action({
  args: { confirmation: v.literal("seed-code2create-demo") },
  returns: v.object({
    teams: v.number(),
    participants: v.number(),
    reviewers: v.number(),
    staff: v.number(),
    panels: v.number(),
    reviewSessions: v.number(),
  }),
  handler: async (ctx) => {
    requireLocalDeployment();
    await ctx.runMutation(internal.localDemoSeed.retimeEvent, {});
    await ctx.runMutation(internal.localDemoSeed.seedOperationsLead, {});
    for (
      let batchIndex = 0;
      batchIndex * operationsLeadPermissionsPerBatch < eventWidePermissionKeys().length;
      batchIndex += 1
    ) {
      await ctx.runMutation(internal.localDemoSeed.seedOperationsLeadGrantBatch, {
        batchIndex,
      });
    }
    for (const [staffIndex] of demoStaff.entries()) {
      await ctx.runMutation(internal.localDemoSeed.seedStaffMember, { staffIndex });
    }
    for (
      let batchIndex = 0;
      batchIndex * reviewersPerBatch < demoReviewers.length;
      batchIndex += 1
    ) {
      await ctx.runMutation(internal.localDemoSeed.seedReviewerBatch, { batchIndex });
    }
    for (
      let batchIndex = 0;
      batchIndex * teamsPerBatch < demoTeams.length;
      batchIndex += 1
    ) {
      await ctx.runMutation(internal.localDemoSeed.seedTeamBatch, { batchIndex });
    }
    await ctx.runMutation(internal.localDemoSeed.seedReviewRound, {});
    await ctx.runMutation(internal.localDemoSeed.seedQueueStates, {});
    for (const [batchIndex] of demoReviewSessionBatches.entries()) {
      await ctx.runMutation(internal.localDemoSeed.seedReviewSessionBatch, { batchIndex });
    }
    await ctx.scheduler.runAfter(0, internal.operationsHealth.refresh, {});
    return {
      teams: demoTeams.length,
      participants: demoTeams.length * 4,
      reviewers: demoReviewers.length,
      staff: demoStaff.length + 1,
      panels: demoPanels.length,
      reviewSessions: demoReviewSessionBatches.flat().length,
    };
  },
});

export const seatLocalOperatorOnPanel = mutation({
  args: { confirmation: v.literal("seat-code2create-local-operator") },
  returns: v.object({
    panelName: v.string(),
    seated: v.boolean(),
  }),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const operator = await requireLocalOperator(ctx);
    const round = await requireDemoRound(ctx, event._id);
    const panel = await requireLocalLivePanel(ctx, round._id);
    const result = await ensureLocalOperatorPanelSeat(ctx, {
      event,
      round,
      panel,
      operator,
      grantedByPersonId: panel.coordinatorPersonId,
      now: Date.now(),
    });
    return { panelName: panel.name, seated: result.changed };
  },
});

/** Starts a substitute page chain for the signed-in local operator. */
export const pageLocalOperator = mutation({
  args: { confirmation: v.literal("page-code2create-local-operator") },
  returns: v.object({
    paged: v.boolean(),
    panelName: v.string(),
    chainState: v.string(),
  }),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const operator = await requireLocalOperator(ctx);

    const round = await requireDemoRound(ctx, event._id);
    const subject = await requireDemoSubject(ctx, round.eventId, operator._id);
    const now = Date.now();

    // Seed the same profile, device, and clock-in state required of a real reserve.
    const criteria = await ctx.db
      .query("reviewRubricCriteria")
      .withIndex("by_rubric_order", (index) =>
        index.eq("rubricVersionId", round.rubricVersionId),
      )
      .collect();
    const criterionKeys = criteria.map((criterion) => criterion.stableKey);

    const profile = await ctx.db
      .query("reviewerProfiles")
      .withIndex("by_event_person", (index) =>
        index.eq("eventId", round.eventId).eq("personId", operator._id),
      )
      .unique();
    if (profile) {
      await ctx.db.patch(profile._id, {
        criterionKeys,
        availabilityWindows: [{ startsAt: round.clockInOpensAt, endsAt: round.endsAt }],
        trainingStatus: "complete",
        status: "active",
        version: profile.version + 1,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("reviewerProfiles", {
        eventId: round.eventId,
        personId: operator._id,
        technicalDomains: [],
        productDomains: [],
        languages: ["English"],
        criterionKeys,
        availabilityWindows: [{ startsAt: round.clockInOpensAt, endsAt: round.endsAt }],
        trainingStatus: "complete",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Prefer a registered device so the page reaches the signed-in operator.
    const devices = await ctx.db
      .query("reviewerDevices")
      .withIndex("by_event_person_status", (index) =>
        index.eq("eventId", round.eventId).eq("personId", operator._id).eq("status", "active"),
      )
      .collect();
    const device =
      devices.find((candidate) => candidate.pushTokenStatus === "active") ??
      devices[0] ??
      null;
    // Refresh the device fields checked by reserve eligibility.
    if (device) {
      await ctx.db.patch(device._id, {
        appBuild: round.minimumReviewerBuild,
        cameraReady: true,
        encryptedDraftReady: true,
        lastSeenAt: now,
        version: device.version + 1,
      });
    }
    const deviceId = device?._id ?? (await ctx.db.insert("reviewerDevices", {
      eventId: round.eventId,
      personId: operator._id,
      installationId: `local-operator-pager-${now}`,
      name: "Local operator phone",
      platform: "ios",
      appBuild: round.minimumReviewerBuild,
      cameraReady: true,
      encryptedDraftReady: true,
      pushTokenStatus: "not_registered",
      pushTokenUpdatedAt: now,
      status: "active",
      version: 1,
      registeredAt: now,
      lastSeenAt: now,
    }));

    const clockIn = await ctx.db
      .query("reviewerClockIns")
      .withIndex("by_round_person", (index) =>
        index.eq("roundId", round._id).eq("reviewerPersonId", operator._id),
      )
      .unique();
    if (clockIn) {
      await ctx.db.patch(clockIn._id, {
        status: "present",
        lastHeartbeatAt: now,
        // Pages target the device recorded on the current clock-in.
        reviewerDeviceId: deviceId,
        version: clockIn.version + 1,
      });
    } else {
      await ctx.db.insert("reviewerClockIns", {
        eventId: round.eventId,
        roundId: round._id,
        reviewerPersonId: operator._id,
        reviewerDeviceId: deviceId,
        status: "present",
        clockedInAt: now,
        lastHeartbeatAt: now,
        version: 1,
      });
    }

    const seats = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_round_person_status", (index) =>
        index
          .eq("roundId", round._id)
          .eq("personId", operator._id)
          .eq("status", "active"),
      )
      .collect();
    for (const seat of seats) {
      await ctx.db.patch(seat._id, { status: "removed", endedAt: now });
      await revokeSourceGrants(ctx, {
        eventId: round.eventId,
        sourceType: "panel_assignment",
        sourceId: seat._id,
        revokedByPersonId: operator._id,
        reason: "Local operator moved to the reserve pager fixture",
      });
    }

    const existingReserve = await ctx.db
      .query("reviewRoundReserves")
      .withIndex("by_round_person", (index) =>
        index.eq("roundId", round._id).eq("personId", operator._id),
      )
      .unique();
    if (existingReserve) {
      await ctx.db.patch(existingReserve._id, {
        status: "available",
        version: existingReserve.version + 1,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("reviewRoundReserves", {
        eventId: round.eventId,
        roundId: round._id,
        personId: operator._id,
        eventAccessSubjectId: subject._id,
        status: "available",
        pageCount: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    const allPanels = await ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
      .collect();
    for (const panel of allPanels) {
      const removed = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "removed"),
        )
        .collect();
      for (const seat of removed) {
        if (seat.personId === operator._id) continue;
        await ctx.db.patch(seat._id, { status: "active", endedAt: undefined });
        await grantPanelMemberAccess(ctx, {
          eventId: round.eventId,
          roundId: round._id,
          panelId: panel._id,
          panelMemberId: seat._id,
          reviewerPersonId: seat.personId,
          eventAccessSubjectId: seat.eventAccessSubjectId,
          grantedByPersonId: panel.coordinatorPersonId,
          isCoordinator: seat.isCoordinator,
          reason: "Local pager fixture restored the demo panel seat",
        });
      }
      const activeMembers = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "active"),
        )
        .collect();
      const restoredStatus = activeMembers.length === round.requiredPanelSize
        ? "ready" as const
        : "needs_reviewer" as const;
      if (panel.status !== restoredStatus) {
        await ctx.db.patch(panel._id, {
          status: restoredStatus,
          version: panel.version + 1,
          updatedAt: now,
        });
        await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
      }
      const chains = await ctx.db
        .query("reviewerPageChains")
        .withIndex("by_panel_state", (index) =>
          index.eq("panelId", panel._id).eq("state", "active"),
        )
        .collect();
      for (const chain of chains) {
        await ctx.db.patch(chain._id, {
          state: "cancelled",
          version: chain.version + 1,
          completedAt: now,
        });
        const pages = await ctx.db
          .query("reviewerPages")
          .withIndex("by_chain_state_rank", (index) => index.eq("pageChainId", chain._id))
          .collect();
        for (const page of pages) {
          if (page.state === "sent" || page.state === "opened") {
            await ctx.db.patch(page._id, {
              state: "cancelled",
              version: page.version + 1,
            });
          }
        }
      }
    }

    const panels = await ctx.db
      .query("reviewPanels")
      .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
      .collect();
    for (const panel of panels) {
      const members = await ctx.db
        .query("reviewPanelMembers")
        .withIndex("by_panel_status", (index) =>
          index.eq("panelId", panel._id).eq("status", "active"),
        )
        .collect();
      const victim = members.find((member) => member.personId !== operator._id);
      if (!victim) continue;

      await ctx.db.patch(victim._id, { status: "removed", endedAt: now });
      await revokeSourceGrants(ctx, {
        eventId: round.eventId,
        sourceType: "panel_assignment",
        sourceId: victim._id,
        revokedByPersonId: operator._id,
        reason: "Local pager fixture opened a panel seat",
      });
      await ctx.db.patch(panel._id, {
        status: "needs_reviewer",
        version: panel.version + 1,
        updatedAt: now,
      });
      await appendReviewPanelVacancyReadFactById(ctx, panel._id, now);
      const pageChainId = await ctx.db.insert("reviewerPageChains", {
        eventId: round.eventId,
        roundId: round._id,
        panelId: panel._id,
        missingPanelMemberId: victim._id,
        requiredCriterionIds: victim.assignedCriterionIds,
        reason: "Local development pager check",
        responseWindowSeconds: round.substituteResponseSeconds,
        state: "active",
        currentRank: 0,
        version: 1,
        createdByPersonId: panel.coordinatorPersonId,
        pageGrantIds: [],
        assignmentGrantIds: [],
        resolvedScopeType: "panel",
        resolvedScopeId: panel._id,
        createdAt: now,
      });
      const sent = await sendNextPage(ctx, pageChainId, now);
      const chain = await ctx.db.get(pageChainId);
      return {
        paged: sent !== null,
        panelName: panel.name,
        chainState: chain?.state ?? "gone",
      };
    }
    throw new ConvexError({
      code: "LOCAL_PAGER_PANEL_MISSING",
      message: "No demo panel had a seat to open for the pager fixture.",
    });
  },
});

export const startLiveReviewForLocalOperator = mutation({
  args: { confirmation: v.literal("start-code2create-live-review") },
  returns: v.object({
    panelName: v.string(),
    teamName: v.string(),
    alreadyLive: v.boolean(),
  }),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const operator = await requireLocalOperator(ctx);
    const context = await demoRoundContext(ctx, event);
    let round = context.round;
    const lead = context.lead;
    const rubric = await ctx.db.get(round.rubricVersionId);
    if (!rubric) throw new Error("The demo rubric is missing.");
    const now = Date.now();

    if (round.status !== "open" || round.startsAt > now || round.endsAt <= now) {
      await ctx.db.patch(round._id, {
        startsAt: now - 3_600_000,
        openedAt: now - 3_600_000,
        endsAt: now + 8 * 3_600_000,
        status: "open",
        version: round.version + 1,
      });
      const reopened = await ctx.db.get(round._id);
      if (!reopened) throw new Error("The demo review round disappeared.");
      round = reopened;
    }

    const assignments = await ctx.db
      .query("reviewAssignments")
      .withIndex("by_person_status", (index) =>
        index.eq("reviewerPersonId", operator._id).eq("status", "assigned"),
      )
      .collect();
    for (const assignment of assignments) {
      const session = await ctx.db.get(assignment.reviewSessionId);
      if (
        session &&
        session.eventId === event._id &&
        session.roundId === round._id &&
        isLiveDemoReview(session.status)
      ) {
        const existingPanel = await ctx.db.get(session.panelId);
        const team = await ctx.db.get(session.teamId);
        if (!existingPanel || !team) {
          throw new Error("The local operator's live review is incomplete.");
        }
        /* Re-time rather than merely report: a session seeded hours ago reads
           as eleven hours overdue, drowning the screen in red for no reason a
           demo cares about. The clock restarts as though the review began
           four minutes ago. */
        const restartedAt = now - 4 * minute;
        await ctx.db.patch(session._id, {
          startedAt: restartedAt,
          plannedEndAt: restartedAt + round.reviewDurationSeconds * 1_000,
          ...(session.status === "overdue" ? { status: "active" as const } : {}),
          updatedAt: now,
        });
        return {
          panelName: existingPanel.name,
          teamName: team.name,
          alreadyLive: true,
        };
      }
    }

    const targetPanel = await requireLocalLivePanel(ctx, round._id);
    await ensureLocalOperatorPanelSeat(ctx, {
      event,
      round,
      panel: targetPanel,
      operator,
      grantedByPersonId: lead._id,
      now,
    });
    const panel = await ctx.db.get(targetPanel._id);
    if (!panel || panel.status !== "ready") {
      throw new Error("The local live-review panel is not ready.");
    }
    const existingPanelSessions = await ctx.db
      .query("reviewSessions")
      .withIndex("by_panel_status", (index) => index.eq("panelId", panel._id))
      .collect();
    if (existingPanelSessions.some((session) => isLiveDemoReview(session.status))) {
      throw new ConvexError({
        code: "LOCAL_LIVE_PANEL_BUSY",
        message: "The local live-review panel already has another live team.",
      });
    }

    let team: Doc<"teams"> | null = null;
    let selectedTeamIndex: number | null = null;
    for (let teamIndex = 0; teamIndex < demoTeams.length; teamIndex += 1) {
      const candidate = await requireDemoTeam(ctx, event._id, teamIndex);
      const [existingSession, existingState] = await Promise.all([
        ctx.db
          .query("reviewSessions")
          .withIndex("by_round_team_status", (index) =>
            index.eq("roundId", round._id).eq("teamId", candidate._id),
          )
          .first(),
        ctx.db
          .query("teamRoundStates")
          .withIndex("by_round_team", (index) =>
            index.eq("roundId", round._id).eq("teamId", candidate._id),
          )
          .unique(),
      ]);
      if (!existingSession && !existingState) {
        team = candidate;
        selectedTeamIndex = teamIndex;
        break;
      }
    }
    if (!team || selectedTeamIndex === null) {
      throw new ConvexError({
        code: "LOCAL_LIVE_TEAM_MISSING",
        message: "No untouched demo team is available for a local live review.",
      });
    }

    const startedAt = now - 4 * minute;
    const plannedEndAt = startedAt + round.reviewDurationSeconds * 1_000;
    const members = await ctx.db
      .query("reviewPanelMembers")
      .withIndex("by_panel_status", (index) =>
        index.eq("panelId", panel._id).eq("status", "active"),
      )
      .collect();
    if (
      members.length !== round.requiredPanelSize ||
      !members.some((member) => member.personId === operator._id)
    ) {
      throw new Error("The local live-review panel assignment is incomplete.");
    }
    await prepareLivePanelReviewers(ctx, { event, round, members, operator, now });
    const evidence = await createEvidenceCheckpoint(ctx, {
      eventId: event._id,
      round,
      team,
      actorPersonId: lead._id,
      createdAt: startedAt,
    });
    const reviewSessionId = await ctx.db.insert("reviewSessions", {
      eventId: event._id,
      roundId: round._id,
      panelId: panel._id,
      teamId: team._id,
      projectVersionId: evidence.projectVersionId,
      evidenceCheckpointSetId: evidence.checkpointId,
      rubricVersionId: rubric._id,
      panelVersion: panel.version,
      status: "active",
      startedAt,
      plannedEndAt,
      extensionCount: 0,
      extensionSeconds: 0,
      sharedNotesVersion: 0,
      version: 2,
      createdByPersonId: lead._id,
      createdAt: startedAt,
      updatedAt: now,
    });
    await insertTeamRoundState(ctx, {
      eventId: event._id,
      roundId: round._id,
      teamId: team._id,
      panelId: panel._id,
      state: "in_review",
      tableLabel: demoHallLocation(selectedTeamIndex),
      queuedAt: startedAt - 10 * minute,
      calledAt: startedAt - 2 * minute,
      callAttemptCount: 1,
      lastCallAttemptAt: startedAt - 2 * minute,
      priority: 0,
      version: 2,
      updatedByPersonId: lead._id,
      updatedAt: now,
    });
    for (const member of members) {
      const assignmentId = await ctx.db.insert("reviewAssignments", {
        eventId: event._id,
        roundId: round._id,
        panelId: panel._id,
        reviewSessionId,
        reviewerPersonId: member.personId,
        eventAccessSubjectId: member.eventAccessSubjectId,
        assignedCriterionIds: member.assignedCriterionIds,
        isCoordinator: member.isCoordinator,
        status: "assigned",
        assignedAt: startedAt,
      });
      const scorecardId = await ctx.db.insert("scorecards", {
        eventId: event._id,
        roundId: round._id,
        reviewSessionId,
        reviewerPersonId: member.personId,
        assignmentId,
        rubricVersionId: rubric._id,
        status: "draft",
        ratings: [],
        draftVersion: 0,
        version: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      await grantReviewAssignmentAccess(ctx, {
        eventId: event._id,
        reviewSessionId,
        scorecardId,
        assignmentId,
        reviewerPersonId: member.personId,
        eventAccessSubjectId: member.eventAccessSubjectId,
        grantedByPersonId: lead._id,
        isCoordinator: member.isCoordinator,
      });
      await ctx.db.insert("reviewPresence", {
        eventId: event._id,
        reviewSessionId,
        reviewerPersonId: member.personId,
        method: "qr",
        tokenVersion: 1,
        confirmedAt: startedAt - minute,
      });
    }
    await ctx.scheduler.runAt(plannedEndAt, internal.reviewOperations.markOverdue, {
      reviewSessionId,
      expectedPlannedEndAt: plannedEndAt,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: lead._id,
      permissionKey: "review.prepare",
      grantIds: [],
      scopeType: "panel",
      scopeId: panel._id,
      action: "review.session_seeded",
      targetType: "review_session",
      targetId: reviewSessionId,
      nextSummary: JSON.stringify({
        teamId: team._id,
        status: "active",
        assignmentCount: members.length,
        evidenceCompleteness: evidence.completeness,
      }),
      reason: demoReason,
    });
    return { panelName: panel.name, teamName: team.name, alreadyLive: false };
  },
});

export const reopenDemoRound = mutation({
  args: {
    confirmation: v.literal("reopen-code2create-demo-round"),
    hours: v.optional(v.number()),
  },
  returns: v.object({
    name: v.string(),
    status: v.string(),
    endsAt: v.number(),
  }),
  handler: async (ctx, args) => {
    requireLocalDeployment();

    const event = await requireDemoEvent(ctx);
    const round = await requireDemoRound(ctx, event._id);

    const now = Date.now();
    const hours = Math.max(1, Math.min(48, Math.floor(args.hours ?? 8)));
    // Start one hour ago so the round is already under way.
    const startsAt = now - 3_600_000;
    await ctx.db.patch(round._id, {
      startsAt,
      openedAt: startsAt,
      endsAt: now + hours * 3_600_000,
      status: "open",
      version: round.version + 1,
    });

    const patched = await ctx.db.get(round._id);
    return {
      name: round.name,
      status: patched?.status ?? "open",
      endsAt: patched?.endsAt ?? 0,
    };
  },
});

/** Republishes barcode formats for an attendance plan created by an earlier seed. */
export const resetDemoBarcodeSymbologies = mutation({
  args: { confirmation: v.literal("reset-code2create-demo-symbologies") },
  returns: v.object({
    name: v.string(),
    version: v.number(),
    symbologies: v.array(v.string()),
  }),
  handler: async (ctx) => {
    requireLocalDeployment();

    const event = await requireDemoEvent(ctx);
    if (event.startsAt === undefined) {
      throw new ConvexError("The local event has no scheduled start to rebuild the plan from.");
    }
    const plan = event.publishedAttendancePlanVersionId
      ? await ctx.db.get(event.publishedAttendancePlanVersionId)
      : null;
    if (!plan) throw new ConvexError("There is no attendance plan to update.");

    // Rebuild the checksum from the same event-relative content that was published.
    const content = localAttendancePlanContent(event.startsAt);
    await ctx.db.patch(plan._id, {
      vitBarcodeSymbologies: content.vitBarcodeSymbologies,
      checksum: attendancePlanChecksum(content),
    });

    return {
      name: plan.name,
      version: plan.version,
      symbologies: [...content.vitBarcodeSymbologies],
    };
  },
});
