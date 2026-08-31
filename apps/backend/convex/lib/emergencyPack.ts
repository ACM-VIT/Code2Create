import type {
  AttendanceSessionRequirement,
  AttendanceSessionStatus,
  AttendanceStationStatus,
  EventStatus,
  ParticipantClass,
  ParticipantEligibilityStatus,
  ReviewPanelStatus,
  ReviewRoundStatus,
  TeamStatus,
  VenuePresenceState,
} from "../values";

export type EmergencyPackRosterRow = {
  participantReference: string;
  name: string;
  phone?: string;
  vitRegistrationNumber?: string;
  vitHostelResidence?: string;
  vitHostelRoomNumber?: string;
  participantClass: ParticipantClass;
  eligibilityStatus: ParticipantEligibilityStatus;
  teamName?: string;
  teamCode?: string;
  teamStatus?: TeamStatus;
  attendanceState: VenuePresenceState;
  attendanceZoneName?: string;
  attendanceUpdatedAt?: number;
  hallZoneName?: string;
  hallLocation?: string;
};

export type EmergencyPackStation = {
  id: string;
  stableKey: string;
  name: string;
  zoneId: string;
  zoneName: string;
  status: AttendanceStationStatus;
  configurationVersion: number;
  deviceName?: string;
};

export type EmergencyPackSession = {
  id: string;
  name: string;
  status: AttendanceSessionStatus;
  requirement: AttendanceSessionRequirement;
  zoneId: string;
  zoneName: string;
  startsAt: number;
  endsAt: number;
  expectationCount: number;
  version: number;
};

export type EmergencyPackCriterion = {
  id: string;
  label: string;
  question: string;
  displayOrder: number;
};

export type EmergencyPackPanel = {
  id: string;
  name: string;
  status: ReviewPanelStatus;
  version: number;
  coordinatorName: string;
  reviewerNames: string[];
};

export type EmergencyPackRound = {
  id: string;
  name: string;
  status: ReviewRoundStatus;
  startsAt: number;
  endsAt: number;
  version: number;
  rubricName: string;
  scoreMinimum: number;
  scoreMaximum: number;
  requiresSharedCommitments: boolean;
  criteria: EmergencyPackCriterion[];
  panels: EmergencyPackPanel[];
};

export type EmergencyPackSnapshot = {
  event: {
    name: string;
    slug: string;
    timezone: string;
    status: EventStatus;
    venue?: string;
    startsAt?: number;
    endsAt?: number;
    version: number;
  };
  snapshotAt: number;
  roster: EmergencyPackRosterRow[];
  stations: EmergencyPackStation[];
  sessions: EmergencyPackSession[];
  rounds: EmergencyPackRound[];
};

export type EmergencyPackBuildResult = {
  html: string;
  attendanceSheetCount: number;
  reviewSheetCount: number;
};

type AttendanceSheet = {
  serial: string;
  station?: EmergencyPackStation;
  session?: EmergencyPackSession;
};

type ReviewSheet = {
  serial: string;
  round?: EmergencyPackRound;
  panel?: EmergencyPackPanel;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function words(value: string) {
  return value.replaceAll("_", " ");
}

function formattedTime(value: number, timezone: string) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function checkedCount(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 20) {
    throw new Error(`${name} must be a whole number from zero to twenty.`);
  }
  return value;
}

export function emergencyPackSerial(
  prefix: string,
  kind: "attendance" | "review",
  sequence: number,
) {
  if (!/^[A-F0-9]{16}$/.test(prefix)) {
    throw new Error("Emergency-pack serial prefix must be sixteen uppercase hexadecimal characters.");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new Error("Emergency-pack sheet sequence must be from one to 999.");
  }
  const marker = kind === "attendance" ? "A" : "R";
  return `C2C7-${prefix}-${marker}-${String(sequence).padStart(3, "0")}`;
}

function attendanceSheets(
  snapshot: EmergencyPackSnapshot,
  serialPrefix: string,
  spareCount: number,
) {
  const assignedStations = snapshot.stations.filter(
    (station) => station.status === "active",
  );
  const sheets: AttendanceSheet[] = assignedStations.map((station, index) => {
    const session = snapshot.sessions.find(
      (candidate) => candidate.zoneId === station.zoneId,
    );
    return {
      serial: emergencyPackSerial(serialPrefix, "attendance", index + 1),
      station,
      ...(session ? { session } : {}),
    };
  });
  for (let index = 0; index < spareCount; index += 1) {
    sheets.push({
      serial: emergencyPackSerial(serialPrefix, "attendance", sheets.length + 1),
    });
  }
  if (sheets.length === 0) {
    sheets.push({ serial: emergencyPackSerial(serialPrefix, "attendance", 1) });
  }
  return sheets;
}

function reviewSheets(
  snapshot: EmergencyPackSnapshot,
  serialPrefix: string,
  spareCount: number,
) {
  const sheets: ReviewSheet[] = [];
  for (const round of snapshot.rounds) {
    for (const panel of round.panels) {
      if (panel.status === "closed") continue;
      sheets.push({
        serial: emergencyPackSerial(serialPrefix, "review", sheets.length + 1),
        round,
        panel,
      });
    }
  }
  for (let index = 0; index < spareCount; index += 1) {
    sheets.push({
      serial: emergencyPackSerial(serialPrefix, "review", sheets.length + 1),
    });
  }
  if (sheets.length === 0) {
    sheets.push({ serial: emergencyPackSerial(serialPrefix, "review", 1) });
  }
  return sheets;
}

function cell(value: string | undefined) {
  return escapeHtml(value?.trim() || "—");
}

function cover(
  snapshot: EmergencyPackSnapshot,
  purpose: string,
  expiresAt: number,
  snapshotChecksum: string,
  attendanceSheetCount: number,
  reviewSheetCount: number,
) {
  const panelCount = snapshot.rounds.reduce((sum, round) => sum + round.panels.length, 0);
  const teamCount = new Set(
    snapshot.roster.flatMap((row) => (row.teamCode === undefined ? [] : [row.teamCode])),
  ).size;
  return `
    <section class="page cover">
      <p class="kicker">Code2Create 7.0 · restricted operations copy</p>
      <h1>Emergency pack</h1>
      <p class="lede">A fixed, printable snapshot for an approved venue incident. It is not a live dashboard.</p>
      <dl class="metadata">
        <div><dt>Event</dt><dd>${cell(snapshot.event.name)}</dd></div>
        <div><dt>Venue</dt><dd>${cell(snapshot.event.venue)}</dd></div>
        <div><dt>Snapshot</dt><dd>${escapeHtml(formattedTime(snapshot.snapshotAt, snapshot.event.timezone))}</dd></div>
        <div><dt>Expires</dt><dd>${escapeHtml(formattedTime(expiresAt, snapshot.event.timezone))}</dd></div>
        <div><dt>Purpose</dt><dd>${cell(purpose)}</dd></div>
        <div><dt>Snapshot checksum</dt><dd class="mono">${escapeHtml(snapshotChecksum)}</dd></div>
      </dl>
      <div class="warning">
        <strong>Use only when the incident lead authorises the paper path.</strong>
        <p>The live system remains authoritative whenever it is available. Keep original sheets, do not reuse or photocopy serials, and reconcile every used sheet through the two-person import flow.</p>
      </div>
      <dl class="counts">
        <div><dt>Participants</dt><dd>${snapshot.roster.length}</dd></div>
        <div><dt>Teams</dt><dd>${teamCount}</dd></div>
        <div><dt>Stations</dt><dd>${snapshot.stations.length}</dd></div>
        <div><dt>Active sessions</dt><dd>${snapshot.sessions.length}</dd></div>
        <div><dt>Panel tables</dt><dd>${panelCount}</dd></div>
        <div><dt>Attendance sheets</dt><dd>${attendanceSheetCount}</dd></div>
        <div><dt>Review sheets</dt><dd>${reviewSheetCount}</dd></div>
      </dl>
      <div class="chain-of-custody">
        <p>Printed by: ____________________________________</p>
        <p>Printed at: _____________________________________</p>
        <p>Incident / drill reference: _______________________</p>
        <p>Original pack returned to: ________________________</p>
      </div>
    </section>`;
}

function operationsSummary(snapshot: EmergencyPackSnapshot) {
  const stationRows = snapshot.stations
    .map(
      (station) => `
        <tr>
          <td>${cell(station.name)}</td>
          <td>${cell(station.zoneName)}</td>
          <td>${cell(words(station.status))}</td>
          <td>${cell(station.deviceName)}</td>
          <td>${station.configurationVersion}</td>
        </tr>`,
    )
    .join("");
  const sessionRows = snapshot.sessions
    .map(
      (session) => `
        <tr>
          <td>${cell(session.name)}</td>
          <td>${cell(words(session.status))}</td>
          <td>${cell(words(session.requirement))}</td>
          <td>${cell(session.zoneName)}</td>
          <td>${escapeHtml(formattedTime(session.startsAt, snapshot.event.timezone))}</td>
          <td>${escapeHtml(formattedTime(session.endsAt, snapshot.event.timezone))}</td>
          <td>${session.expectationCount}</td>
          <td>${session.version}</td>
        </tr>`,
    )
    .join("");
  const panelRows = snapshot.rounds
    .flatMap((round) =>
      round.panels.map(
        (panel) => `
          <tr>
            <td>${cell(round.name)}</td>
            <td>${cell(words(round.status))}</td>
            <td>${cell(panel.name)}</td>
            <td>${cell(words(panel.status))}</td>
            <td>${cell(panel.coordinatorName)}</td>
            <td>${cell(panel.reviewerNames.join(", "))}</td>
          </tr>`,
      ),
    )
    .join("");
  return `
    <section class="page wide">
      <header class="section-header"><p class="kicker">Snapshot</p><h2>Sessions and stations</h2></header>
      <h3>Active sessions</h3>
      <table><thead><tr><th>Session</th><th>State</th><th>Rule</th><th>Zone</th><th>Starts</th><th>Ends</th><th>Expected</th><th>Version</th></tr></thead><tbody>${sessionRows || '<tr><td colspan="8">No ready, open, or closing sessions in this snapshot.</td></tr>'}</tbody></table>
      <h3>Published station list</h3>
      <table><thead><tr><th>Station</th><th>Zone</th><th>State</th><th>Phone</th><th>Config</th></tr></thead><tbody>${stationRows || '<tr><td colspan="5">No published stations.</td></tr>'}</tbody></table>
    </section>
    <section class="page wide">
      <header class="section-header"><p class="kicker">Snapshot</p><h2>Panel and table plan</h2></header>
      <table><thead><tr><th>Round</th><th>Round state</th><th>Panel</th><th>Panel state</th><th>Coordinator</th><th>Reviewers</th></tr></thead><tbody>${panelRows || '<tr><td colspan="6">No published, open, or closing review panels.</td></tr>'}</tbody></table>
    </section>`;
}

function roster(snapshot: EmergencyPackSnapshot) {
  const rows = snapshot.roster
    .map(
      (participant) => `
        <tr>
          <td class="mono small">${cell(participant.participantReference)}</td>
          <td>${cell(participant.name)}</td>
          <td>${cell(participant.phone)}</td>
          <td>${cell(participant.vitRegistrationNumber)}</td>
          <td>${cell(participant.vitHostelResidence)}</td>
          <td>${cell(participant.vitHostelRoomNumber)}</td>
          <td>${cell(participant.teamName)}</td>
          <td>${cell(participant.teamCode)}</td>
          <td>${cell(participant.hallZoneName)}</td>
          <td>${cell(participant.hallLocation)}</td>
          <td>${cell(words(participant.attendanceState))}</td>
          <td>${cell(participant.attendanceZoneName)}</td>
          <td>${participant.attendanceUpdatedAt === undefined ? "—" : escapeHtml(formattedTime(participant.attendanceUpdatedAt, snapshot.event.timezone))}</td>
        </tr>`,
    )
    .join("");
  return `
    <section class="page wide roster">
      <header class="section-header"><p class="kicker">Restricted identifiable roster</p><h2>Last accepted location and presence</h2></header>
      <p class="caption">Presence is the last server-accepted boundary state at the snapshot time. A blank hall location means nobody had recorded where the team was sitting.</p>
      <table><thead><tr><th>Participant ref</th><th>Name</th><th>Phone</th><th>VIT ID</th><th>Hostel</th><th>Room</th><th>Team</th><th>Code</th><th>Hall zone</th><th>Where in the hall</th><th>Presence</th><th>Presence zone</th><th>Updated</th></tr></thead><tbody>${rows || '<tr><td colspan="13">No participant memberships.</td></tr>'}</tbody></table>
    </section>`;
}

function blankAttendanceRows() {
  return Array.from({ length: 25 }, (_, index) => `
    <tr><td>${index + 1}</td><td></td><td></td><td></td><td></td><td></td></tr>`).join("");
}

function attendanceForm(sheet: AttendanceSheet, snapshot: EmergencyPackSnapshot) {
  const station = sheet.station;
  const session = sheet.session;
  return `
    <section class="paper-sheet attendance-form" data-serial="${escapeHtml(sheet.serial)}">
      <div class="form-title"><div><p class="kicker">Attendance manual recovery</p><h2>Numbered transition sheet</h2></div><strong class="serial">${escapeHtml(sheet.serial)}</strong></div>
      <div class="warning compact"><strong>One sheet, one session, one station configuration, one transition.</strong> Enter no more than 25 unique participants. A different authorised person must verify the source before import.</div>
      <dl class="form-grid">
        <div><dt>Incident</dt><dd>________________________________</dd></div>
        <div><dt>Session</dt><dd>${cell(session?.name)}</dd></div>
        <div><dt>Session ID</dt><dd class="mono">${cell(session?.id)}</dd></div>
        <div><dt>Station</dt><dd>${cell(station?.name)}</dd></div>
        <div><dt>Station ID</dt><dd class="mono">${cell(station?.id)}</dd></div>
        <div><dt>Config version</dt><dd>${station?.configurationVersion ?? "—"}</dd></div>
        <div><dt>Transition</dt><dd>□ session confirm &nbsp; □ zone entry &nbsp; □ zone exit</dd></div>
        <div><dt>Operator</dt><dd>________________________________</dd></div>
      </dl>
      <table class="entry-table"><thead><tr><th>#</th><th>Participant reference / VIT ID</th><th>Captured time</th><th>Initials</th><th>Correction note</th><th>Imported outcome</th></tr></thead><tbody>${blankAttendanceRows()}</tbody></table>
      <div class="signatures"><p>Entered by / time: __________________________________________</p><p>Verified by / time: _________________________________________</p><p>Original filed at: ___________________________________________</p></div>
      <footer>Snapshot ${escapeHtml(formattedTime(snapshot.snapshotAt, snapshot.event.timezone))} · Serial must match the digital recovery record.</footer>
    </section>`;
}

function reviewCriteriaRows(round: EmergencyPackRound | undefined) {
  const criteria = round?.criteria.length
    ? round.criteria
    : Array.from({ length: 5 }, (_, index) => ({
        id: "",
        label: `Criterion ${index + 1}`,
        question: "",
        displayOrder: index + 1,
      }));
  return criteria
    .map(
      (criterion) => `
        <tr>
          <td><strong>${cell(criterion.label)}</strong><small>${cell(criterion.question)}</small></td>
          <td></td><td></td><td></td><td></td><td></td><td></td>
        </tr>`,
    )
    .join("");
}

function reviewForm(sheet: ReviewSheet, snapshot: EmergencyPackSnapshot) {
  const round = sheet.round;
  const panel = sheet.panel;
  const scoreRange = round ? `${round.scoreMinimum}–${round.scoreMaximum}` : "published rubric range";
  return `
    <section class="paper-sheet review-form wide" data-serial="${escapeHtml(sheet.serial)}">
      <div class="form-title"><div><p class="kicker">Review manual recovery</p><h2>Serialised panel record</h2></div><strong class="serial">${escapeHtml(sheet.serial)}</strong></div>
      <div class="warning compact"><strong>Only for a review that already started before the review backend incident.</strong> Capture the complete panel record and every reviewer signature. A different authorised person verifies and imports it.</div>
      <dl class="form-grid review-meta">
        <div><dt>Incident</dt><dd>____________________________</dd></div>
        <div><dt>Round</dt><dd>${cell(round?.name)}</dd></div>
        <div><dt>Round ID / version</dt><dd class="mono">${cell(round?.id)} / ${round?.version ?? "—"}</dd></div>
        <div><dt>Panel</dt><dd>${cell(panel?.name)}</dd></div>
        <div><dt>Panel ID / version</dt><dd class="mono">${cell(panel?.id)} / ${panel?.version ?? "—"}</dd></div>
        <div><dt>Team / review ID</dt><dd>____________________________</dd></div>
        <div><dt>Team table</dt><dd>____________________________</dd></div>
        <div><dt>Started / ended</dt><dd>____________________________</dd></div>
        <div><dt>Unavailable reason</dt><dd>____________________________</dd></div>
      </dl>
      <p class="caption">Rubric: ${cell(round?.rubricName)} · score range ${escapeHtml(scoreRange)}. Reviewer names at snapshot: ${cell(panel?.reviewerNames.join(", "))}.</p>
      <table class="rating-table"><thead><tr><th>Criterion</th><th>Reviewer 1 score</th><th>Reviewer 1 evidence</th><th>Reviewer 2 score</th><th>Reviewer 2 evidence</th><th>Reviewer 3 score</th><th>Reviewer 3 evidence</th></tr></thead><tbody>${reviewCriteriaRows(round)}</tbody></table>
      <div class="reviewer-lines"><p>Reviewer 1 name / signature: ____________________________________________________</p><p>Reviewer 2 name / signature: ____________________________________________________</p><p>Reviewer 3 name / signature: ____________________________________________________</p></div>
      <div class="notes-grid"><div><strong>Private reviewer notes</strong><p></p><p></p><p></p></div><div><strong>Shared findings</strong><p></p><p></p><p></p></div><div><strong>Next-checkpoint commitments${round?.requiresSharedCommitments ? " (required)" : ""}</strong><p></p><p></p><p></p></div></div>
      <div class="signatures"><p>Entered by / time: __________________________________________</p><p>Verified by / time: _________________________________________</p><p>Original filed at: ___________________________________________</p></div>
      <footer>Snapshot ${escapeHtml(formattedTime(snapshot.snapshotAt, snapshot.event.timezone))} · Serial must match the digital recovery record.</footer>
    </section>`;
}

const documentStyles = `
  :root { color: #171717; background: white; font-family: Arial, Helvetica, sans-serif; font-size: 10px; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  h1 { margin: 12mm 0 4mm; font-size: 34px; letter-spacing: -.04em; }
  h2 { margin: 0; font-size: 22px; letter-spacing: -.025em; }
  h3 { margin: 8mm 0 3mm; font-size: 13px; }
  p { line-height: 1.45; }
  .page, .paper-sheet { break-before: page; padding: 4mm 0; }
  .cover { break-before: auto; }
  .kicker { margin: 0; color: #555; font-size: 9px; font-weight: 700; letter-spacing: .03em; }
  .lede { max-width: 135mm; color: #444; font-size: 15px; }
  .metadata, .counts, .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-top: 1px solid #222; border-left: 1px solid #222; }
  .metadata div, .counts div, .form-grid div { min-height: 13mm; padding: 3mm; border-right: 1px solid #222; border-bottom: 1px solid #222; }
  dt { margin-bottom: 1.5mm; color: #555; font-size: 8px; font-weight: 700; letter-spacing: .02em; }
  dd { margin: 0; line-height: 1.4; }
  .counts { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 8mm; }
  .counts dd { font-size: 22px; font-weight: 700; }
  .warning { margin: 8mm 0; padding: 5mm; border: 2px solid #222; }
  .warning p { margin: 2mm 0 0; }
  .warning.compact { margin: 4mm 0; padding: 3mm; font-size: 9px; }
  .chain-of-custody { margin-top: 12mm; font-size: 12px; }
  .section-header { display: flex; align-items: end; justify-content: space-between; gap: 10mm; margin-bottom: 5mm; padding-bottom: 3mm; border-bottom: 2px solid #222; }
  .caption { margin: 2mm 0 4mm; color: #555; font-size: 9px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  th, td { padding: 2mm; border: 1px solid #555; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #eee; font-size: 8px; letter-spacing: .01em; }
  td { font-size: 8.5px; }
  td small { display: block; margin-top: 1mm; color: #555; font-weight: 400; }
  .mono { font-family: "Courier New", monospace; }
  .small { font-size: 7px; }
  .form-title { display: flex; align-items: start; justify-content: space-between; gap: 8mm; padding-bottom: 3mm; border-bottom: 2px solid #222; }
  .serial { padding: 2.5mm; border: 2px solid #222; font-family: "Courier New", monospace; font-size: 14px; }
  .form-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .form-grid div { min-height: 11mm; }
  .entry-table { margin-top: 4mm; }
  .entry-table td { height: 7mm; }
  .entry-table th:nth-child(1), .entry-table td:nth-child(1) { width: 7mm; }
  .entry-table th:nth-child(2) { width: 48mm; }
  .entry-table th:nth-child(3) { width: 28mm; }
  .entry-table th:nth-child(4) { width: 17mm; }
  .signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; margin-top: 5mm; }
  footer { margin-top: 4mm; padding-top: 2mm; border-top: 1px solid #777; color: #555; font-size: 8px; }
  .rating-table td { height: 14mm; }
  .rating-table th:first-child { width: 36mm; }
  .reviewer-lines { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5mm; font-size: 9px; }
  .notes-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
  .notes-grid > div { min-height: 30mm; padding: 3mm; border: 1px solid #555; }
  .notes-grid p { height: 6mm; margin: 1mm 0; border-bottom: 1px solid #aaa; }
  @page { size: A4 portrait; margin: 11mm; }
  @page wide { size: A4 landscape; margin: 10mm; }
  .wide { page: wide; }
  @media screen { body { max-width: 297mm; margin: 0 auto; padding: 10mm; } .page, .paper-sheet { margin-bottom: 10mm; border-bottom: 1px solid #bbb; } }
`;

export function buildEmergencyPackHtml(args: {
  snapshot: EmergencyPackSnapshot;
  purpose: string;
  expiresAt: number;
  snapshotChecksum: string;
  serialPrefix: string;
  spareAttendanceSheetCount: number;
  spareReviewSheetCount: number;
}): EmergencyPackBuildResult {
  const spareAttendanceSheetCount = checkedCount(
    args.spareAttendanceSheetCount,
    "Spare attendance-sheet count",
  );
  const spareReviewSheetCount = checkedCount(
    args.spareReviewSheetCount,
    "Spare review-sheet count",
  );
  const attendance = attendanceSheets(
    args.snapshot,
    args.serialPrefix,
    spareAttendanceSheetCount,
  );
  const reviews = reviewSheets(args.snapshot, args.serialPrefix, spareReviewSheetCount);
  const title = `${args.snapshot.event.name} emergency pack`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <style>${documentStyles}</style>
</head>
<body>
  ${cover(args.snapshot, args.purpose, args.expiresAt, args.snapshotChecksum, attendance.length, reviews.length)}
  ${operationsSummary(args.snapshot)}
  ${roster(args.snapshot)}
  ${attendance.map((sheet) => attendanceForm(sheet, args.snapshot)).join("")}
  ${reviews.map((sheet) => reviewForm(sheet, args.snapshot)).join("")}
</body>
</html>`;
  return {
    html,
    attendanceSheetCount: attendance.length,
    reviewSheetCount: reviews.length,
  };
}
