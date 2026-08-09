import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, type MutationCtx } from "./_generated/server";
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
import { operationFingerprint } from "./lib/operations";
import { isPermissionKey, permissionCatalog, type PermissionKey } from "./lib/permissionCatalog";
import { addEventSubjectSelfGrants, insertPermissionGrant } from "./lib/permissions";
import {
  loadPublishedPhaseSchedule,
  normalizePhaseSchedule,
  phaseScheduleChecksum,
  phaseWindowInput,
} from "./lib/phaseSchedule";
import { grantPanelMemberAccess, grantReviewAssignmentAccess } from "./lib/reviewAccess";
import { computeReviewEvaluation } from "./lib/reviewScores";
import { fingerprintText } from "./lib/strings";
import { localAttendancePlanContent, localIntegrationPolicy } from "./localDevelopment";
import { createEvidenceCheckpoint } from "./reviewOperations";
import { addTeamMemberGrants } from "./teams";

const minute = 60 * 1_000;
const hour = 60 * minute;
const demoEventSlug = "code2create-7";
const demoSourceId = "local-demo-seed";
const demoReason = "Local demo fixture";
const teamsPerBatch = 4;

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

/**
 * The admissions workspace groups applications by stage. Seeding every team as
 * `confirmed` left the review form, the decision form and the recommendation
 * panel unreachable in a running local stack, because all of them are hidden
 * once an application reaches its terminal state.
 *
 * These four stages need no rows outside `applications`. The remaining stages
 * the workspace groups by do: `needs_information` wants an information request
 * and `offer_sent` / `offer_expired` want an offer, so they are not seeded here.
 */
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
    trackKey: "open_innovation",
    participantClass: "vit_student",
    initialIdea:
      "Residents photograph road damage on their commute and follow the repair until the ward closes it.",
    members: ["Aarav Kulkarni", "Sneha Iyer", "Rohan Das", "Ananya Bose"],
  },
  {
    publicCode: "DEMOT002",
    name: "Clinic Compass",
    trackKey: "health_wellbeing",
    participantClass: "vit_student",
    initialIdea:
      "Carers find the nearest clinic that is actually open, staffed, and reachable without a car.",
    members: ["Devika Rao", "Karthik Menon", "Meera Pillai", "Arjun Varma"],
  },
  {
    publicCode: "DEMOT003",
    name: "Study Circle",
    trackKey: "future_learning",
    participantClass: "vit_student",
    initialIdea:
      "Learners form four-person study groups around one topic, a shared hour, and a concrete goal.",
    members: ["Ishita Ghosh", "Nikhil Reddy", "Tara Sharma", "Vikram Joshi"],
  },
  {
    publicCode: "DEMOT004",
    name: "Grid Sense",
    trackKey: "sustainable_systems",
    participantClass: "vit_student",
    initialIdea:
      "Hostel blocks see which appliances drive their evening peak and what shifting them would save.",
    members: ["Farhan Qureshi", "Lakshmi Nair", "Aditya Sinha", "Riya Chawla"],
  },
  {
    publicCode: "DEMOT005",
    name: "Caption Craft",
    trackKey: "ai_for_people",
    participantClass: "vit_student",
    initialIdea:
      "Lecture recordings get accurate captions and a glossary for the terms the course actually uses.",
    members: ["Neha Kapoor", "Sameer Bhatt", "Pooja Rane", "Yash Malhotra"],
  },
  {
    publicCode: "DEMOT006",
    name: "Transit Tally",
    trackKey: "open_innovation",
    participantClass: "vit_student",
    initialIdea:
      "Riders report which shared shuttles actually arrived so the next rider plans on real timings.",
    members: ["Harsh Vora", "Divya Prasad", "Manav Shetty", "Kavya Nambiar"],
  },
  {
    publicCode: "DEMOT007",
    name: "Calm Hours",
    trackKey: "health_wellbeing",
    participantClass: "external_participant",
    initialIdea:
      "Shift workers plan sleep around rosters that change weekly instead of a fixed daily routine.",
    members: ["Ritu Deshpande", "Omkar Patil", "Sara Fernandes", "Imran Sheikh"],
  },
  {
    publicCode: "DEMOT008",
    name: "Lab Ledger",
    trackKey: "future_learning",
    participantClass: "vit_student",
    initialIdea:
      "Lab groups record what they actually changed between attempts so results can be reproduced.",
    members: ["Gaurav Mehta", "Anjali Saxena", "Prateek Jain", "Shreya Kulkarni"],
  },
  {
    publicCode: "DEMOT009",
    name: "Water Watch",
    trackKey: "sustainable_systems",
    participantClass: "vit_student",
    initialIdea:
      "Apartment committees spot a leak from the overnight tank curve before the bill tells them.",
    members: ["Naveen Kumar", "Bhavna Agarwal", "Rahul Pandey", "Swati Mishra"],
  },
  {
    publicCode: "DEMOT010",
    name: "Voice Bridge",
    trackKey: "ai_for_people",
    participantClass: "external_participant",
    initialIdea:
      "Frontline staff take a spoken note in their own language and file it in the form the office needs.",
    members: ["Zoya Ansari", "Tanmay Gupta", "Preeti Yadav", "Aman Bhatia"],
  },
  {
    publicCode: "DEMOT011",
    name: "Repair Radar",
    trackKey: "open_innovation",
    participantClass: "vit_student",
    initialIdea:
      "Owners of a broken appliance find the nearest person who has fixed that exact model before.",
    members: ["Siddharth Naik", "Ira Chatterjee", "Vivek Raghavan", "Nandini Rao"],
  },
  {
    publicCode: "DEMOT012",
    name: "Shelf Share",
    trackKey: "sustainable_systems",
    participantClass: "external_participant",
    initialIdea:
      "Canteens publish safe surplus at closing time and nearby collection groups claim it in one tap.",
    members: ["Aisha Khan", "Rudra Sengupta", "Maitri Shah", "Dev Anand"],
  },
  {
    publicCode: "DEMOT013",
    name: "Ledger Lantern",
    trackKey: "open_innovation",
    participantClass: "vit_student",
    initialIdea:
      "Hostel mess committees publish what they spent each week so residents can question it before the next cycle.",
    members: ["Devika Rao", "Imran Sheikh", "Tara Nambiar"],
    admission: { state: "submitted" },
  },
  {
    publicCode: "DEMOT014",
    name: "Signal Shed",
    trackKey: "health_wellbeing",
    participantClass: "external_participant",
    initialIdea:
      "Rural clinics log which medicines ran out and when, so the district can see the pattern rather than the excuse.",
    members: ["Joseph Mathew", "Lakshmi Pillai", "Farid Ansari", "Nisha Verma"],
    admission: { state: "under_review" },
  },
  {
    publicCode: "DEMOT015",
    name: "Kiln Watch",
    trackKey: "open_innovation",
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
    trackKey: "open_innovation",
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

export const seedStaffAndReviewers = internalMutation({
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
    await grantEventWide(ctx, {
      eventId: event._id,
      personId: lead.personId,
      eventAccessSubjectId: lead.subjectId,
      permissionKeys: eventWidePermissionKeys(),
      grantedByPersonId: lead.personId,
      reason: "Local demo operations lead",
      now,
    });

    for (const staff of demoStaff) {
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
        assignedByPersonId: lead.personId,
        now,
      });
      await grantEventWide(ctx, {
        eventId: event._id,
        personId: account.personId,
        eventAccessSubjectId: account.subjectId,
        permissionKeys: assertPermissionKeys(staff.permissionKeys),
        grantedByPersonId: lead.personId,
        reason: `Local demo ${staff.key.replaceAll("-", " ")}`,
        now,
      });
    }

    const criterionKeys = demoRubricCriteria.map((criterion) => criterion.stableKey);
    for (const [index, reviewer] of demoReviewers.entries()) {
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
        assignedByPersonId: lead.personId,
        now,
      });
      await ctx.db.insert("reviewerProfiles", {
        eventId: event._id,
        personId: account.personId,
        technicalDomains: index % 2 === 0 ? ["backend", "data"] : ["frontend", "mobile"],
        productDomains: index % 3 === 0 ? ["civic"] : ["education", "health"],
        languages: ["English", index % 2 === 0 ? "Hindi" : "Tamil"],
        criterionKeys,
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
    trackVersionId: Id<"trackVersions">;
    participantPolicyVersionId: Id<"participantPolicyVersions">;
    trackCatalogVersionId: Id<"trackCatalogVersions">;
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
    membershipLocked: true,
    trackLocked: true,
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

  await ctx.db.insert("projectDrafts", {
    eventId: event._id,
    teamId,
    trackCatalogVersionId: args.trackCatalogVersionId,
    intakePolicyVersionId: args.intakePolicyVersionId,
    stage: "submitted",
    initialIdea: definition.initialIdea,
    chosenCoreTrackVersionId: args.trackVersionId,
    chosenSponsorTrackVersionIds: [],
    recommendationState: "not_requested",
    freshnessAttestedByMembershipId: leadMembership._id,
    freshnessAttestedAt: now - 30 * hour,
    version: 2,
    lastEditedByMembershipId: leadMembership._id,
    updatedAt: now - 29 * hour,
  });
  const projectVersionId = await ctx.db.insert("projectVersions", {
    eventId: event._id,
    teamId,
    version: 1,
    initialIdea: definition.initialIdea,
    intakePolicyVersionId: args.intakePolicyVersionId,
    intakeResponses: [],
    coreTrackVersionId: args.trackVersionId,
    sponsorTrackVersionIds: [],
    lockedTeamMemberIds: teamMemberIds,
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
      previewedTrackVersionId: args.trackVersionId,
      previewedSponsorTrackVersionIds: [],
      confirmedByMembershipId: leadMembership._id,
      confirmedAt: now - 29 * hour,
    },
    participantPolicyVersionId: args.participantPolicyVersionId,
    admissionPolicyVersionId: args.admissionPolicyVersionId,
    sourceDraftVersion: 2,
    submittedByMembershipId: leadMembership._id,
    submittedAt: now - 29 * hour,
  });
  // Most teams are confirmed because the review round needs teams to judge.
  // The few carrying an `admission` stage stop earlier, so the admissions
  // workspace has something in each group it renders.
  const admission: DemoAdmission =
    "admission" in definition ? definition.admission : confirmedAdmission;
  const decided = "decision" in admission;
  await ctx.db.insert("applications", {
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
  await ctx.db.patch(teamId, {
    lockedProjectVersionId: projectVersionId,
    lockedAt: now - 29 * hour,
    lockParticipantPolicyVersionId: args.participantPolicyVersionId,
    version: team.version + 1,
    updatedAt: now,
  });
  // Every team carries an availability projection, including one that has not
  // taken a place: readers treat a missing projection as a broken invariant,
  // not as "nobody has arrived". Arrival is what actually differs below.
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
  // A team the review desk cannot call is the interesting case, so one team is
  // left short of the round's minimum while the rest are in the hall.
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
    if (existing) return null;

    const participantPolicyVersionId = event.publishedParticipantPolicyId;
    const trackCatalogVersionId = event.publishedTrackCatalogId;
    const intakePolicyVersionId = event.publishedIntakePolicyId;
    const admissionPolicyVersionId = event.publishedAdmissionPolicyId;
    if (
      !participantPolicyVersionId ||
      !trackCatalogVersionId ||
      !intakePolicyVersionId ||
      !admissionPolicyVersionId
    ) {
      throw new Error("The local event is missing a published policy the demo teams need.");
    }
    const tracks = await ctx.db
      .query("trackVersions")
      .withIndex("by_catalog_type_order", (index) =>
        index.eq("catalogVersionId", trackCatalogVersionId).eq("type", "core"),
      )
      .collect();
    const trackByKey = new Map(tracks.map((track) => [track.stableKey, track._id]));
    const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);

    const now = Date.now();
    for (const [offset, definition] of batch.entries()) {
      const trackVersionId = trackByKey.get(definition.trackKey);
      if (!trackVersionId) throw new Error(`The demo track ${definition.trackKey} is missing.`);
      await createDemoTeam(ctx, {
        event,
        definition,
        teamIndex: args.batchIndex * teamsPerBatch + offset,
        leadPersonId: lead._id,
        trackVersionId,
        participantPolicyVersionId,
        trackCatalogVersionId,
        intakePolicyVersionId,
        admissionPolicyVersionId,
        now,
      });
    }
    return null;
  },
});

export const seedReviewRound = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    requireLocalDeployment();
    const event = await requireDemoEvent(ctx);
    const existing = await ctx.db
      .query("reviewRounds")
      .withIndex("by_event_key", (index) =>
        index.eq("eventId", event._id).eq("stableKey", "demo_final"),
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
    };
    const roundId = await ctx.db.insert("reviewRounds", {
      eventId: event._id,
      rubricVersionId,
      stableKey: "demo_final",
      ...roundConfiguration,
      status: "open",
      startsAt: now - 3 * hour,
      endsAt: now + 6 * hour,
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

async function demoRoundContext(ctx: MutationCtx, event: Doc<"events">) {
  const round = await ctx.db
    .query("reviewRounds")
    .withIndex("by_event_key", (index) =>
      index.eq("eventId", event._id).eq("stableKey", "demo_final"),
    )
    .unique();
  if (!round) throw new Error("The demo review round is missing.");
  const panels = await ctx.db
    .query("reviewPanels")
    .withIndex("by_round_status", (index) => index.eq("roundId", round._id))
    .collect();
  const panelByKey = new Map(panels.map((panel) => [panel.stableKey, panel]));
  const lead = await requireDemoPerson(ctx, demoOperationsLead.displayName);
  return { round, panelByKey, lead };
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
      await ctx.db.insert("teamRoundStates", {
        eventId: event._id,
        roundId: round._id,
        teamId: team._id,
        panelId: panel._id,
        state: placement.state,
        tableLabel: `Table ${placement.teamIndex + 1}`,
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
    await ctx.runMutation(internal.localDemoSeed.seedStaffAndReviewers, {});
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
