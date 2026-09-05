export function bindingName(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

const grantSourceNames: Readonly<Record<string, string>> = {
  production_seed: "Initial event owner",
  participant_membership: "Participant account",
  team_membership: "Team membership",
  team_lead: "Team lead",
  role_template: "Role",
  bundle: "Reusable access",
  application_assignment: "Application assignment",
  panel_assignment: "Panel assignment",
  reserve_assignment: "Reserve assignment",
  page_assignment: "Reviewer page",
  station_assignment: "Check-in station",
  event_subject: "Event account",
  manual: "Added by hand",
  delegated: "Passed on by someone",
};

export function grantSourceName(value: string) {
  return grantSourceNames[value] ?? bindingName(value);
}

export type PermissionArea =
  | "applications"
  | "attendance"
  | "event_setup"
  | "help"
  | "integrations"
  | "judging"
  | "music"
  | "operations"
  | "participants"
  | "people";

export const permissionAreas: ReadonlyArray<{ value: PermissionArea; label: string }> = [
  { value: "applications", label: "Applications" },
  { value: "participants", label: "Participants and teams" },
  { value: "attendance", label: "Check-in and presence" },
  { value: "judging", label: "Judging" },
  { value: "integrations", label: "Code and design" },
  { value: "music", label: "Music desk" },
  { value: "help", label: "Help desk and notifications" },
  { value: "event_setup", label: "Event setup" },
  { value: "people", label: "People and permissions" },
  { value: "operations", label: "Operations and recovery" },
];

const exactPermissionNames: Readonly<Record<string, string>> = {
  "benefit.read": "View benefits",
  "benefit.manage": "Create and hand out benefits",
  "access.permissions.grant_any": "Grant any permission",
  "access.permissions.revoke_any": "Revoke any permission",
  "access.permissions.grant_scoped": "Let someone grant one scoped permission",
  "access.permissions.revoke_scoped": "Let someone revoke one scoped permission",
  "application.assign": "Assign application reviews",
  "application.ai_recommendation.read": "View admission recommendation",
  "application.ai_recommendation.run": "Retry admission analysis",
  "application.profile_context.read": "View an applicant’s year and course",
  "communications.call_consent.manage": "Manage own phone-call consent",
  "attendance.export.identifiable": "Export named attendance records",
  "attendance.external_pass.read": "View own external event pass",
  "event.lifecycle.manage": "Change the event state",
  "event.lifecycle.read": "View the event state",
  "review.substitute.page": "Use a reviewer substitute page",
  "review.team_qr.mint": "Show team judging QR",
  "reviewer.clock_in": "Check in as a reviewer",
  "team.roster.read": "View participant team import",
  "team.roster.import": "Import participant teams",
  "team.roster.revoke": "Revoke a participant team assignment",
};

const permissionActionNames: Readonly<Record<string, string>> = {
  acknowledge: "Acknowledge",
  accept: "Accept",
  apply: "Apply",
  approve: "Approve",
  assign: "Assign",
  close: "Close",
  complete: "Complete",
  confirm: "Confirm",
  create: "Create",
  decide: "Decide",
  enrol: "Enrol",
  enter: "Enter",
  execute: "Use",
  extend: "Extend",
  freeze: "Freeze",
  generate: "Generate",
  hold: "Hold",
  import: "Import",
  issue: "Issue",
  invite: "Invite",
  join: "Join",
  leave: "Leave",
  manage: "Manage",
  map: "Map",
  migrate: "Update",
  mint: "Generate",
  miss: "Mark missed",
  moderate: "Moderate",
  move: "Move",
  open: "Open",
  override: "Override",
  override_identity: "Override identity check for",
  pause: "Pause",
  prepare: "Prepare",
  print: "Print",
  publish: "Publish",
  read: "View",
  rebind: "Reassign",
  reconcile: "Correct",
  record: "Record",
  register: "Register",
  release: "Release",
  reopen: "Reopen",
  replace: "Replace",
  report: "Report",
  request: "Request",
  resolve: "Resolve",
  respond: "Respond to",
  review: "Review",
  restore: "Restore",
  resume: "Resume",
  retry: "Retry",
  revoke: "Revoke",
  schedule: "Schedule",
  start: "Start",
  submit: "Submit",
  suspend: "Suspend",
  transfer: "Transfer",
  validate: "Validate",
  verify: "Verify",
  void: "Void",
  waive: "Waive",
  write: "Edit",
};

const permissionSubjectNames: Readonly<Record<string, string>> = {
  "access permission bundles": "reusable access",
  "access permissions": "permissions",
  "access roles": "role labels",
  "access roster": "event team",
  "access subjects": "event accounts",
  "application offer": "admission offer",
  "attendance badge": "external participant badge",
  "attendance credential": "physical ID credential",
  "attendance history": "attendance history",
  "attendance manual sheet": "paper check-in sheet",
  "attendance manual sheet source": "paper check-in sheet image",
  "attendance plan": "check-in plan",
  "attendance presence": "who is present",
  "attendance remedy": "attendance correction",
  "attendance remedy self": "own attendance correction",
  "attendance roll call": "emergency roll call",
  "attendance scan": "check-in scan",
  "attendance self": "own attendance",
  "attendance session": "hacking session",
  "attendance station": "check-in phone",
  "attendance venue check in": "venue check-in",
  "communications delivery": "email delivery",
  "communications delivery self": "own email delivery",
  configuration: "event setup",
  "configuration admission": "admission policy",
  "configuration admission draft": "admission policy draft",
  "configuration checkpoint": "team update setup",
  "configuration checkpoint draft": "team update setup draft",
  "configuration communications": "accepted-team details",
  "configuration communications draft": "accepted-team details draft",
  "configuration draft": "event setup draft",
  "configuration intake": "idea questions setup",
  "configuration intake draft": "idea questions setup draft",
  "configuration intelligence": "operations brief setup",
  "configuration intelligence draft": "operations brief setup draft",
  "configuration integration": "code and design policy",
  "configuration integration draft": "code and design policy draft",
  "configuration novelty": "idea originality setup",
  "configuration novelty draft": "idea originality setup draft",
  "configuration novelty entries": "past-project comparison set",
  "configuration participant": "participant form",
  "configuration participant draft": "participant form draft",
  "configuration phase": "event schedule",
  "configuration phase draft": "event schedule draft",
  "emergency pack": "paper backup",
  "integration artifact": "code and design evidence",
  "integration figma": "Figma connection",
  "integration github": "GitHub connection",
  "operations intelligence": "operations briefs",
  "project checkpoint": "team update",
  "review configuration": "judging setup",
  "review manual record": "paper review",
  "review manual record source": "paper review image",
  "review participant availability": "team availability for judging",
  "review shared notes": "shared review notes",
  "review team qr": "team judging QR",
  "review timer": "review timer",
  "reviewer device": "reviewer phone",
  "reviewer profile": "reviewer profile",
  "round export": "results export",
  "score completeness": "missing scores",
  "score feedback": "team feedback",
  "score values": "score values",
  "support case": "help case",
  "synesthesia access": "music access",
  "synesthesia catalog": "music catalog",
  "synesthesia playback": "music playback",
  "synesthesia queue": "music queue",
  "synesthesia report": "music report",
  "synesthesia request": "music request",
  "synesthesia window": "music request window",
  "team lead": "team leadership",
  "team members": "team members",
  "team project": "team project",
  rehearsal: "test run",
};

export function permissionName(value: string) {
  const exact = exactPermissionNames[value];
  if (exact !== undefined && exact.length > 0) return exact;
  const parts = value.split(".").map((part) => part.replaceAll("_", " "));
  const action = parts.at(-1);
  const actionName =
    action !== undefined && action.length > 0 ? permissionActionNames[action] : undefined;
  if (
    action === undefined ||
    action.length === 0 ||
    actionName === undefined ||
    actionName.length === 0
  ) {
    return sentenceName(parts.join(" "));
  }
  const rawSubject = parts.slice(0, -1).join(" ");
  return `${actionName} ${permissionSubjectNames[rawSubject] ?? rawSubject}`;
}

export function areaForPermission(value: string): PermissionArea {
  if (value.startsWith("application.")) return "applications";
  if (value.startsWith("attendance.")) return "attendance";
  if (value.startsWith("configuration.") || value.startsWith("event.")) return "event_setup";
  if (value.startsWith("support.") || value.startsWith("communications.")) return "help";
  if (value.startsWith("integration.")) return "integrations";
  if (
    value.startsWith("review.") ||
    value.startsWith("reviewer.") ||
    value.startsWith("round.") ||
    value.startsWith("panel.") ||
    value.startsWith("queue.") ||
    value.startsWith("score.") ||
    value.startsWith("scorecard.")
  ) {
    return "judging";
  }
  if (value.startsWith("benefit.")) return "participants";
  if (value.startsWith("synesthesia.")) return "music";
  if (value.startsWith("access.")) return "people";
  if (
    value.startsWith("participant.") ||
    value.startsWith("team.") ||
    value.startsWith("project.")
  ) {
    return "participants";
  }
  return "operations";
}

export function availablePermissionAreas(definitions: ReadonlyArray<{ area: string }>) {
  return permissionAreas.filter((area) =>
    definitions.some((definition) => definition.area === area.value),
  );
}

export function readPermissionArea(value: string): PermissionArea {
  return permissionAreas.find((area) => area.value === value)?.value ?? "operations";
}

export function scopeName(value: string, permissionKey?: string) {
  if (value === "event") return "Entire event";
  if (value === "self") {
    return permissionKey === "reviewer.device.register" ||
      permissionKey === "communications.call_consent.manage"
      ? "Own event account"
      : "Own participant membership";
  }
  const names: Readonly<Record<string, string>> = {
    application: "One application",
    attendance_plan: "One attendance plan",
    attendance_session: "One hacking session",
    evidence_checkpoint: "One team update",
    incident: "One incident",
    page: "One reviewer page",
    panel: "One judging panel",
    permission_bundle: "One permission set",
    person: "One person",
    rehearsal_run: "One test run",
    review: "One review",
    roster_entry: "One roster entry",
    round: "One judging round",
    scorecard: "One scorecard",
    song_request: "One song request",
    station: "One check-in phone",
    support_case: "One help case",
    synesthesia_window: "One music window",
    team: "One team",
  };
  return names[value] ?? sentenceName(value.replaceAll("_", " "));
}

function sentenceName(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
