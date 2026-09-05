import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const requireBackend = createRequire(new URL("apps/backend/package.json", root));
const { ConvexHttpClient } = requireBackend("convex/browser");
const { makeFunctionReference } = requireBackend("convex/server");
const environment = parseEnv(readFileSync(new URL("apps/backend/.env.local", root), "utf8"));
if (!/^(local|anonymous):/.test(environment.CONVEX_DEPLOYMENT ?? "") || environment.CONVEX_URL !== "http://127.0.0.1:3210") {
  throw new Error("This seed command requires the local backend on port 3210.");
}
const local = JSON.parse(readFileSync(new URL("apps/backend/.convex/local/default/config.json", root), "utf8"));
if (local.ports.cloud !== 3210 || typeof local.adminKey !== "string") throw new Error("Unexpected local backend configuration.");
const admin = new ConvexHttpClient("http://127.0.0.1:3210");
admin.setAdminAuth(local.adminKey);
const reference = (name) => makeFunctionReference(name);
const query = (name, args = {}) => admin.query(reference(name), args);
const mutate = (name, args = {}) => admin.mutation(reference(name), args);
const account = async (key, name, email) => ({ key, name, email, ...await mutate("developmentSeed:createAccount", { key, name, email }) });
const owner = await account("local-ops", "Local Operator", "local.ops@example.test");
const asOwner = new ConvexHttpClient("http://127.0.0.1:3210");
asOwner.setAdminAuth(local.adminKey, {
  subject: owner.authUserId, sessionId: owner.sessionId,
  issuer: "http://localhost:3211", tokenIdentifier: `http://localhost:3211|${owner.authUserId}`,
});
const shell = await query("system:getPublicShellState", { eventSlug: "code2create-7" });
if (!shell.event) await asOwner.mutation(reference("system:bootstrapEvent"), await query("developmentSeed:bootstrapConfiguration"));
const event = (await query("system:getPublicShellState", { eventSlug: "code2create-7" })).event;
if (!event) throw new Error("Local event was not created.");
const reviewers = [];
for (let panel = 1; panel <= 6; panel += 1) {
  for (let seat = 0; seat < 5; seat += 1) {
    const role = seat === 0 ? "board" : seat < 3 ? "sc" : "jc";
    const key = panel === 1 && seat === 0 ? "local-reviewer" : `local-panel${panel}-seat${seat + 1}`;
    const person = await account(key, `Panel ${panel} · ${role.toUpperCase()} ${seat + 1}`, `${key}@example.test`);
    await mutate("developmentSeed:addReviewer", { eventId: event.id, personId: person.personId, ownerPersonId: owner.personId, role });
    reviewers.push({ ...person, panel, seat, role });
  }
}
for (const [index, role] of ["board", "sc", "jc", "jc"].entries()) {
  const key = `local-reserve-${index + 1}`;
  const person = await account(key, `Reserve ${role.toUpperCase()} ${index + 1}`, `${key}@example.test`);
  await mutate("developmentSeed:addReviewer", { eventId: event.id, personId: person.personId, ownerPersonId: owner.personId, role });
  reviewers.push({ ...person, panel: null, seat: null, role });
}
const participants = [];
for (let team = 1; team <= 8; team += 1) {
  for (let member = 1; member <= 3; member += 1) {
    const key = team === 1 && member === 1 ? "local-participant" : `local-team${team}-member${member}`;
    participants.push({ ...await account(key, `Team ${team} Participant ${member}`, `${key}@example.test`), team, member });
  }
}
const directory = new URL("outputs/dev/", root);
mkdirSync(directory, { recursive: true });
const receipt = new URL("accounts.json", directory);
const previousReceipt = existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : null;
console.log(`Prepared ${reviewers.length} reviewers/reserves and ${participants.length} participants.`);

const { reviewRubricPresets } = await import("../apps/ops/src/lib/reviewRubricPresets.ts");
const ownerMutation = (name, args) => asOwner.mutation(reference(name), args);
const ownerQuery = (name, args) => asOwner.query(reference(name), args);
const teamIdeas = [
  ["QueueCraft", "A live event review queue that gives teams a reliable ETA, routes them to an available panel and preserves a clear audit of reviews."],
  ["LoopLearn", "A peer learning app that matches students with short practice sessions and adapts exercises to what they have actually understood."],
  ["CampusWay", "Accessible campus navigation with step-free route choices, building entrances and student-reported temporary obstacles."],
  ["MediBridge", "A clinic intake workspace that gathers a patient's own symptom notes and makes them easier for a clinician to review."],
  ["GreenRoute", "A commute planner that compares walking, public transport and shared rides using travel time and transparent emissions estimates."],
  ["MuseMap", "A local discovery map for student art, music and exhibitions, with accessible venue details and contributor-owned listings."],
  ["PaperTrail", "A research reading workspace that keeps claims next to their original citations and highlights unanswered research questions."],
  ["StudyLoop", "A study planner that helps students break a large syllabus into small sessions and adjust the plan when work is missed."],
];
const teams = [];
for (const [index, [name, idea]] of teamIdeas.entries()) {
  const stage = index === 7 ? "draft" : index === 6 ? "submitted" : "live";
  const teamId = await mutate("developmentSeed:populateTeam", {
    eventId: event.id, ownerPersonId: owner.personId, number: index + 1, name, idea, stage, inside: index < 5,
    people: participants.filter(person => person.team === index + 1).map(person => person.personId),
  });
  teams.push({ teamId, name, stage });
}
await mutate("developmentSeed:openPlayground", { eventId: event.id, ownerPersonId: owner.personId });
const checkpoints = await ownerQuery("checkpointConfiguration:current", { eventSlug: "code2create-7" });
if (!checkpoints.publishedPlan) {
  const draft = await ownerMutation("checkpointConfiguration:createDraft", {
    eventSlug: "code2create-7", expectedEventVersion: checkpoints.eventVersion,
    definitions: [
      { checkpointKey: "ideation", phaseKey: "ideation", displayName: "Ideation update",
        prompt: "What changed about your idea after exploring it?", followUpQuestion: "What are you building first, and why?", graceMinutes: 240 },
      { checkpointKey: "intermediate_update", phaseKey: "intermediate_update", displayName: "Intermediate update",
        prompt: "What has your team built or learned since the last update?", followUpQuestion: "What is the next concrete thing your team will finish?", graceMinutes: 120 },
      { checkpointKey: "final_update", phaseKey: "final_update", displayName: "Final update",
        prompt: "What did your team finish?", followUpQuestion: "What should someone try or look at first?", graceMinutes: 60 },
    ], reason: "Local project progress prompts", clientOperationId: crypto.randomUUID(),
  });
  const latest = await ownerQuery("checkpointConfiguration:current", { eventSlug: "code2create-7" });
  await ownerMutation("checkpointConfiguration:publish", {
    eventSlug: "code2create-7", draftPlanId: draft.planVersionId, expectedDraftChecksum: draft.checksum,
    expectedEventVersion: latest.eventVersion, reason: "Open local project updates", clientOperationId: crypto.randomUUID(),
  });
}
const criteria = reviewRubricPresets.round1.criteria.map(({ id: _id, weight, ...criterion }, displayOrder) => ({ ...criterion, weight: Number(weight), displayOrder }));
for (const person of reviewers) {
  const profile = await ownerQuery("reviewConfiguration:profile", { eventSlug: "code2create-7", personId: person.personId });
  if (profile) continue;
  await ownerMutation("reviewConfiguration:saveProfile", {
    eventSlug: "code2create-7", personId: person.personId, seniority: person.role,
    strength: person.role === "board" ? 4 : person.role === "sc" ? 3 : 2,
    technicalDomains: ["web", "backend", "mobile"], productDomains: ["education", "operations", "accessibility"], languages: ["english"],
    criterionKeys: criteria.map(criterion => criterion.stableKey), trainingStatus: "complete", status: "active",
    expectedVersion: 0, reason: "Local development fixture", clientOperationId: crypto.randomUUID(),
  });
}
const current = await ownerQuery("reviewConfiguration:current", { eventSlug: "code2create-7" });
let roundId = current.rounds.find(round => round.stableKey === "local_review")?.id;
if (!roundId) {
  const now = Date.now();
  const result = await ownerMutation("reviewConfiguration:publishRound", {
    eventSlug: "code2create-7", confirmationOpensAt: now - 3_600_000,
    rubric: { name: reviewRubricPresets.round1.name, spreadThreshold: 2, criteria },
    round: {
      stableKey: "local_review", name: "Local review · Round 1", sequence: 1,
      startsAt: now - 60_000, endsAt: now + 24 * 3_600_000,
      clockInOpensAt: now - 1_800_000, reviewerReportAt: now - 600_000, noShowGraceSeconds: 60,
      correctionRequestsCloseAt: now + 24 * 3_600_000, reviewDurationSeconds: 420,
      ordinaryExtensionSeconds: 0, maximumOrdinaryExtensions: 0, missedCallGraceSeconds: 120,
      requiredCallAttempts: 2, substituteResponseSeconds: 60, missedReentryPolicy: "preserve_queue_time",
      staffing: { seniorSeats: 2, juniorSeats: 2, allowSeniorLeadFallback: true, automaticReplacement: false,
        juniorRotationReviews: 1, reviewerArrivalSeconds: 90, assignmentReminderSeconds: 300, assignmentReminderCalls: false },
      requiredPanelSize: 5, minimumScorersPerCriterion: 2, minimumPresentParticipants: 1,
      requiresSharedCommitments: true, requiresFinalComment: true, minimumReviewerBuild: 1,
      requiresCamera: false, requiresNotifications: false,
    },
    panels: Array.from({ length: 6 }, (_, index) => ({
      stableKey: `local_panel_${index + 1}`, name: `Panel ${index + 1}`,
      members: reviewers.filter(person => person.panel === index + 1).map(person => ({
        personId: person.personId, criterionKeys: criteria.map(criterion => criterion.stableKey), isCoordinator: person.seat === 0,
      })),
    })),
    reservePersonIds: reviewers.filter(person => person.panel === null).map(person => person.personId),
    reason: "Local six-panel review playground", clientOperationId: crypto.randomUUID(),
  });
  roundId = result.roundId;
  await ownerMutation("reviewOperations:openRound", { eventSlug: "code2create-7", roundId, expectedVersion: 1, reason: "Open local reviews", clientOperationId: crypto.randomUUID() });
}
const reviewerDevices = [];
for (const person of reviewers) {
  const client = new ConvexHttpClient("http://127.0.0.1:3210");
  client.setAdminAuth(local.adminKey, {
    subject: person.authUserId, sessionId: person.sessionId,
    issuer: "http://localhost:3211", tokenIdentifier: `http://localhost:3211|${person.authUserId}`,
  });
  const confirmations = await client.query(reference("reviewConfirmations:mine"), { eventSlug: "code2create-7" });
  const confirmation = confirmations.find(row => row.roundId === roundId);
  if (confirmation?.response.status === "pending") await client.mutation(reference("reviewConfirmations:respond"), {
    eventSlug: "code2create-7", roundId, windows: [{ startsAt: confirmation.startsAt, endsAt: confirmation.endsAt }],
    expectedVersion: confirmation.response.version, clientOperationId: crypto.randomUUID(),
  });
  const existingDevice = previousReceipt?.reviewerDevices?.find(device => device.personId === person.personId);
  // Let the actual simulator own its installation and foreground heartbeat.
  if (person.key === "local-reviewer") {
    if (existingDevice) reviewerDevices.push(existingDevice);
    continue;
  }
  const installationId = existingDevice?.installationId ?? crypto.randomUUID();
  const duty = await client.query(reference("reviewer:dutyStatus"), { eventSlug: "code2create-7", installationId });
  if (!duty.deviceRegistered) await client.mutation(reference("reviewer:registerDevice"), {
    eventSlug: "code2create-7", installationId, name: "Local simulated reviewer", platform: "ios", appBuild: 1,
    cameraReady: false, encryptedDraftReady: true, expectedVersion: 0, clientOperationId: crypto.randomUUID(),
  });
  if (duty.clockInStatus === null) await client.mutation(reference("reviewer:clockIn"), {
    eventSlug: "code2create-7", roundId, installationId, expectedVersion: 0, clientOperationId: crypto.randomUUID(),
  });
  reviewerDevices.push({ personId: person.personId, installationId });
}
const board = await ownerQuery("reviewOperations:roundBoard", { eventSlug: "code2create-7", roundId });
const queued = await ownerQuery("reviewOperations:roundTeams", { eventSlug: "code2create-7", roundId, paginationOpts: { cursor: null, numItems: 50 } });
for (const [index, team] of teams.slice(0, 5).entries()) {
  if (queued.page.some(row => row.teamId === team.teamId && row.state !== "unassigned")) continue;
  await ownerMutation("reviewOperations:queueTeam", {
    eventSlug: "code2create-7", roundId, teamId: team.teamId, panelId: board.panels[index < 3 ? 0 : index - 2].id,
    expectedTeamRoundVersion: 0, reason: "Local review queue fixture", clientOperationId: crypto.randomUUID(),
  });
}
let attendance = await ownerQuery("attendanceConfiguration:current", { eventSlug: "code2create-7" });
if (!attendance.publishedPlan) {
  const draft = await ownerMutation("attendanceConfiguration:createDraft", {
    eventSlug: "code2create-7", name: "Local event entry", vitBarcodeSymbologies: ["code128"],
    vitBarcodeNormalizationVersion: "trim-v1", offlineQueueMaxScans: 25, offlineQueueMaxAgeSeconds: 600,
    zones: [{ stableKey: "local_hall", name: "Local event hall", safeCapacity: 1000 }],
    sessions: [{ stableKey: "local_build", name: "Build session", kind: "hacking", requirement: "optional",
      expectedCohort: { kind: "all_admitted" }, zoneKey: "local_hall", startsAt: Date.now() - 60_000,
      endsAt: board.round.endsAt, checkInOpensAt: Date.now() - 120_000, checkInClosesAt: board.round.endsAt }],
    stations: [
      { stableKey: "local_entry", name: "Event entrance", zoneKey: "local_hall", mode: "venue_entry", allowedCredentialKinds: ["badge_qr", "external_pass"] },
      { stableKey: "local_exit", name: "Event exit", zoneKey: "local_hall", mode: "venue_exit", allowedCredentialKinds: ["badge_qr", "external_pass"] },
    ], expectedEventVersion: attendance.eventVersion, reason: "Local entry and exit fixtures", clientOperationId: crypto.randomUUID(),
  });
  await ownerMutation("attendanceConfiguration:publish", {
    eventSlug: "code2create-7", planVersionId: draft.planVersionId, expectedEventVersion: draft.eventVersion,
    reason: "Open local entry and exit", clientOperationId: crypto.randomUUID(),
  });
  attendance = await ownerQuery("attendanceConfiguration:current", { eventSlug: "code2create-7" });
}
await mutate("developmentSeed:seedArrivalHistory", { eventId: event.id, ownerPersonId: owner.personId });
writeFileSync(receipt, JSON.stringify({ eventId: event.id, roundId, owner, reviewers, participants, teams, reviewerDevices }, null, 2), { mode: 0o600 });
console.log(`Local playground ready: ${teams.length} teams, six panels of five reviewers, four reserves and the seven-minute rubric.`);
console.log(`Private local login receipt: ${fileURLToPath(receipt)}`);
