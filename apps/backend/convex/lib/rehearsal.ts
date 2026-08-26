import type {
  RehearsalScenarioState,
  RehearsalWorkstream,
} from "../values";

export const releaseRehearsalTemplateVersion = "code2create-7.0-release-5";

export type RehearsalTemplateScenario = {
  stableKey: string;
  sequence: number;
  workstream: RehearsalWorkstream;
  title: string;
  expectedState: string;
  recoveryAction: string;
};

function scenario(
  sequence: number,
  workstream: RehearsalWorkstream,
  title: string,
  expectedState: string,
  recoveryAction: string,
): RehearsalTemplateScenario {
  return {
    stableKey: `r${sequence.toString().padStart(2, "0")}`,
    sequence,
    workstream,
    title,
    expectedState,
    recoveryAction,
  };
}

export const releaseRehearsalTemplate = [
  scenario(
    1,
    "auth_access",
    "VIT participant uses the wrong Google account",
    "The portal refuses VIT classification and shows the correct-account recovery path without creating participant state.",
    "Sign out and authenticate with the participant's VIT Google account; do not override the hosted-domain check.",
  ),
  scenario(
    2,
    "auth_access",
    "Reviewer is absent from the approved roster",
    "Authentication succeeds but no reviewer data, role, or protected route is returned.",
    "Verify the roster source and issue a corrected, audited roster row or exact invitation and grants.",
  ),
  scenario(
    3,
    "reviewer_app",
    "Reviewer responds after a page expires",
    "The expired page cannot be accepted and operations still sees the unresolved staffing gap.",
    "Issue a new page or assign another eligible reviewer from the operations board.",
  ),
  scenario(
    4,
    "review_operations",
    "One planned panel member is absent",
    "The panel is visibly short, review start remains blocked, and substitute ranking is available.",
    "Page and assign a qualified reserve or record a separately authorised presence waiver.",
  ),
  scenario(
    5,
    "reviewer_app",
    "Reviewer phone loses power during an active draft",
    "The accepted server draft remains intact and the review stays assigned without a false submission.",
    "Move the reviewer to a charged spare, sign in, restore the encrypted draft, and continue from server state.",
  ),
  scenario(
    6,
    "reliability",
    "Venue Wi-Fi drops during one active review",
    "The reviewer app shows offline state, preserves the local draft, and other reviews continue normally.",
    "Move that reviewer phone to backup connectivity and reconcile pending writes before review completion.",
  ),
  scenario(
    7,
    "reviewer_app",
    "APNs or FCM push is delayed",
    "Delivery is not treated as acknowledgement and the staffing gap remains visible in operations.",
    "Use the in-app assignment, direct floor contact, or page another reserve after the configured timeout.",
  ),
  scenario(
    8,
    "review_operations",
    "A panel scans the wrong team's review code",
    "The presented team code is rejected for the wrong panel and no presence or review state changes.",
    "Use the hall map to reach the assigned team, or complete an audited panel assignment change before scanning again.",
  ),
  scenario(
    9,
    "review_operations",
    "Team review code is expired or belongs to another round",
    "The scan fails without confirming reviewer presence or starting a review.",
    "Have the team mint the current short-lived code from its portal and let the assigned panel rescan while standing with the team.",
  ),
  scenario(
    10,
    "floor",
    "Two operators move the same team concurrently",
    "One versioned location change commits and the stale operator receives the current location.",
    "Refresh the map, confirm where the team is actually sitting, and apply one reasoned correction if still needed.",
  ),
  scenario(
    11,
    "reviewer_app",
    "Scorecard submission response is lost",
    "Retrying the same operation returns the accepted scorecard without creating another submission.",
    "Reconnect and retry the unchanged submission operation; never recreate ratings under a new operation ID.",
  ),
  scenario(
    12,
    "review_operations",
    "A rubric criterion lacks minimum coverage",
    "Review or round completion is blocked with the exact missing criterion and reviewer context.",
    "Collect the missing independent rating or apply an authorised reviewer substitution before closing.",
  ),
  scenario(
    13,
    "integrations",
    "GitHub or Figma checkpoint is stale",
    "Reviewer context labels the evidence stale or incomplete without inventing progress or a score.",
    "Reauthorise or refresh within provider limits, then capture a new checkpoint before review start.",
  ),
  scenario(
    14,
    "integrations",
    "Required GitHub topic is missing",
    "The repository is flagged as missing the event's published required topic; the read-only App does not claim to repair it.",
    "Ask the team to add the exact topic shown in its portal, then run provider verification again.",
  ),
  scenario(
    15,
    "integrations",
    "One repository loses access in a multi-repository project",
    "Only that binding becomes inaccessible while other repositories remain current and ordered.",
    "Restore the relevant App installation access or keep the failed binding explicitly incomplete.",
  ),
  scenario(
    16,
    "integrations",
    "Repository is archived after Review 1",
    "Review 1 still opens its immutable original repository set and later checkpoints omit the archived binding.",
    "Use the checkpoint selector; never rebuild an old review from the team's current repository list.",
  ),
  scenario(
    17,
    "integrations",
    "Figma authorizer is revoked and replaced",
    "Earlier snapshots remain readable while current capture waits for a valid team authorizer.",
    "Have an authorised team lead reconnect Figma, then resume capture without rewriting old evidence.",
  ),
  scenario(
    18,
    "integrations",
    "Figma plan permits metadata but defers full content",
    "Metadata freshness advances independently and full capture shows its rate-limit gate.",
    "Wait until the recorded provider retry time or use the next explicit checkpoint budget.",
  ),
  scenario(
    19,
    "reliability",
    "Convex becomes unavailable during judging",
    "Operations opens an incident and pauses new calls/starts while active drafts remain recoverable.",
    "Use approved incident procedures, backup connectivity, and two-person paper mode only after its threshold.",
  ),
  scenario(
    20,
    "reliability",
    "An already-started review loses backend service",
    "Two approvals activate review paper mode; one entrant and a different verifier create one immutable import.",
    "Use a numbered emergency-pack original, preserve signatures, and reconcile through the verified import path.",
  ),
  scenario(
    21,
    "intake_admissions",
    "OpenAI embeddings and interpretation time out after the opening answer",
    "The novelty signal becomes unavailable, the saved answer remains, and the deterministic follow-up route reaches a submittable brief.",
    "Continue with the published fallback question; do not resubmit the answer or block on either late provider response.",
  ),
  scenario(
    22,
    "intake_admissions",
    "Late novelty and interpretation results follow participant edits",
    "The old novelty result cannot attach after an idea change, and the stale interpretation cannot replace the team's current question.",
    "Keep the current text and route; a later request must use the latest idea and pinned configuration versions.",
  ),
  scenario(
    23,
    "intake_admissions",
    "Model returns invalid or prompt-injected intake output",
    "Schema and wording validation reject it without changing accepted answers or the question sequence.",
    "Serve the pinned deterministic fallback and retain the provider failure only as bounded diagnostics.",
  ),
  scenario(
    24,
    "intake_admissions",
    "Configuration is published while a team is mid-intake",
    "The active session stays pinned to its original versions and new sessions use the publication.",
    "Use the explicit migration preview only if organisers intend to move active sessions.",
  ),
  scenario(
    25,
    "reliability",
    "Round close, reopen, backup, and staging restore",
    "Independent verification closes immutable exports; restore runs only on the confirmed staging target and reproduces inventory.",
    "Retry failed storage work with the same snapshot, or stop launch if the restore receipt does not match.",
  ),
  scenario(
    26,
    "attendance",
    "Participant stays inside across hacking sessions",
    "The next session still shows confirmation due until its own accepted scan.",
    "Scan the VIT ID or participant QR for the new session; do not copy prior-session credit.",
  ),
  scenario(
    27,
    "attendance",
    "Participant exits and returns three times",
    "Each boundary creates a separate interval and current present/away totals remain consistent.",
    "Reconcile only a genuinely missing latest boundary through the audited correction path.",
  ),
  scenario(
    28,
    "attendance",
    "VIT ID and portal QR are scanned simultaneously",
    "One transition is accepted and the other resolves as a duplicate without another interval.",
    "Use the authoritative returned state; do not manually add a second transition.",
  ),
  scenario(
    29,
    "attendance",
    "VIT ID replacement and lost external badge",
    "The suspended old barcode and revoked badge fail while their replacements resolve to the correct participants.",
    "Complete staffed rebind or badge replacement after identity matching, then retry the new credential.",
  ),
  scenario(
    30,
    "attendance",
    "Offline exit replay conflicts with newer online evidence",
    "The replay becomes needs-review evidence and cannot overwrite the newer projection.",
    "Inspect both events and add an authorised compensating transition only when the evidence supports it.",
  ),
  scenario(
    31,
    "attendance",
    "Session is extended and another is cancelled",
    "Accepted history remains immutable and results use the accepted actual session bounds.",
    "Publish the reasoned session change and let the resumable finalisation recompute derived results.",
  ),
  scenario(
    32,
    "attendance",
    "Emergency roll call starts during live movement",
    "The starting checksum stays fixed while ordinary scans update only the live roll-call counters until close.",
    "Reconcile unknown people through normal scanning and close the roll call with separate authority.",
  ),
  scenario(
    33,
    "attendance",
    "Accessibility confirmation and disputed missing exit",
    "Both cases use private, audited support/remedy paths and neither changes judging data.",
    "Apply the configured accessible confirmation or reviewed attendance correction with participant-facing notes.",
  ),
  scenario(
    34,
    "intake_admissions",
    "Member joins after final preview opens",
    "Final submission rejects the stale roster and shows the current team before locking anything.",
    "Regenerate the confirmation preview and obtain explicit confirmation for the current member set.",
  ),
  scenario(
    35,
    "intake_admissions",
    "Leadership acceptance races final submission",
    "One transaction wins and the team ends with one lead and one lock snapshot.",
    "Refresh the team state and repeat only the command still valid under the new version.",
  ),
  scenario(
    36,
    "intake_admissions",
    "Year-adjusted admission fixtures are compared",
    "Each recommendation uses its published experience band and neither AI result can publish a decision.",
    "Inspect the policy/source versions and route any malformed analysis to human-only review.",
  ),
  scenario(
    37,
    "intake_admissions",
    "Team revises a proposal after review work starts",
    "The new immutable proposal version makes earlier AI and human review output stale before a decision can publish.",
    "Route the current version for fresh review and keep the earlier work as audited history.",
  ),
  scenario(
    38,
    "communications",
    "Accepted-team email is delayed or bounces",
    "The portal still shows authoritative next steps and operations sees transport state without treating it as acknowledgement.",
    "Confirm the verified destination, use the portal/Discord support route, and retry only a definite failure.",
  ),
  scenario(
    39,
    "communications",
    "Cloudflare Email send response is lost",
    "The original delivery becomes unknown and no second provider request is issued; any lifecycle events remain deduplicated evidence for investigation.",
    "Reconcile the message in Cloudflare Email logs and use the portal/support route; never create a blind duplicate send.",
  ),
  scenario(
    40,
    "communications",
    "Manual email retry races destination disablement",
    "Version checks produce at most one new attempt and an in-flight request is not reported as cancelled.",
    "Refresh delivery state, then retry or disable only from the latest definitive transport outcome.",
  ),
  scenario(
    41,
    "attendance",
    "Attendance export runs while scans continue",
    "Every row shares one snapshot time, selected columns only, safe CSV cells, and no URL after grant revocation.",
    "Request a new bounded export if the permission or expiry check changes before download.",
  ),
  scenario(
    42,
    "auth_access",
    "Roster CSV has malformed, duplicate, or unsupported rows",
    "Preview rejects the whole import and creates no roster row or permission grant.",
    "Correct the source CSV, preview it again, and confirm only the matching checksum.",
  ),
  scenario(
    43,
    "attendance",
    "Idle scanner remains open without receiving cards",
    "Authenticated heartbeats keep it healthy; closing the camera surface makes it stale after the configured threshold.",
    "Reopen the assigned scanner surface or move the station assignment to another provisioned phone.",
  ),
  scenario(
    44,
    "communications",
    "Failed participant email is manually retried",
    "The source attempt becomes superseded and only the new pending attempt is current.",
    "Use the exact-recipient retry command after verifying the latest attempt is definitively failed.",
  ),
  scenario(
    45,
    "reliability",
    "Aggregate health reader has no drill-down grants",
    "It sees bounded counts, age, owner, and next action but no identity, provider detail, or judging value.",
    "Grant the separate exact-domain read permission only to the operator who needs the protected record.",
  ),
  scenario(
    46,
    "reliability",
    "Maximum emergency pack is prepared and used",
    "The exact-version pack is separately readable/printable, expires in four hours, and paper import still needs two-person approval.",
    "Preserve the numbered original under chain of custody and reject expired, copied, or reused sheets.",
  ),
  scenario(
    47,
    "auth_access",
    "Roster confirmation races claim, revoke, or replacement",
    "Exactly one row transition commits and a stale confirmation cannot overwrite the winner.",
    "Refresh the immutable preview and continue from the accepted row state.",
  ),
  scenario(
    48,
    "auth_access",
    "Claimed roster identity appears in a later import",
    "The preview marks it already claimed and confirmation leaves existing role and grants unchanged.",
    "Use explicit account, role, or grant controls for a genuine post-claim change.",
  ),
  scenario(
    49,
    "synesthesia",
    "Two participants request and vote for the same track",
    "One request and one vote per participant remain with matching live counts.",
    "Use the existing request returned by duplicate resolution and retry the same vote operation if needed.",
  ),
  scenario(
    50,
    "synesthesia",
    "Playback start races pause or close",
    "Only one request becomes playing and pause/close cannot strand an unacknowledged item.",
    "Refresh the window and acknowledge the actual licensed-player state before the next command.",
  ),
  scenario(
    51,
    "synesthesia",
    "Queue reader lacks moderation and report grants",
    "Internal notes and report reasons are absent, and an exact-request moderator cannot act on another request.",
    "Issue only the exact additional permission required for the assigned moderation work.",
  ),
  scenario(
    52,
    "synesthesia",
    "Participant music access is suspended during a vote",
    "One transaction wins, the retried vote is rejected, and all non-Synesthesia access remains unchanged.",
    "Resolve the music-only restriction through its exact person-scoped restore command.",
  ),
  scenario(
    53,
    "synesthesia",
    "Licensed player or Synesthesia backend is unavailable",
    "Registration, attendance, reviews, scoring, and round close remain healthy and independent.",
    "Follow the published manual playback/support instruction or pause the ambience window.",
  ),
  scenario(
    54,
    "review_operations",
    "Team call or review start races a round pause",
    "One mutation wins and retries observe either the accepted call/start or the active pause without duplication.",
    "Follow the authoritative round state and resume only through the independent permission.",
  ),
  scenario(
    55,
    "review_operations",
    "Queued and active work continues under round pause",
    "Queue positions stay fixed, active review completion works, and new calls, starts, incident resolution, and close remain blocked.",
    "Resolve the incident cause and use an independently authorised resume before normal operations continue.",
  ),
  scenario(
    56,
    "support",
    "Participant opens support while operations is live",
    "Both surfaces update without refresh, public replies reach the reporter, and internal notes never do.",
    "Use the case timeline and public reply; keep protected operational details in internal notes.",
  ),
  scenario(
    57,
    "reliability",
    "Needs-attention command response is lost",
    "Retrying the saved pickup or dismissal returns the first accepted version without another audit event or cross-row reuse.",
    "Reconnect and retry the unchanged command; refresh before changing the row, version, action, reason, or operation ID.",
  ),
  scenario(
    58,
    "support",
    "Concurrent support updates and reporter reply",
    "Each accepted version creates one ordered action, stale writes change nothing, and retries add no duplicate.",
    "Refresh the case version and resubmit the intended update with its unchanged operation payload.",
  ),
  scenario(
    59,
    "support",
    "Support case owner lacks case permission",
    "Assignment succeeds only as routing metadata and exposes no case or command to the ungranted owner.",
    "Grant exact-case read/manage separately, or assign a different operator who already has the required scope.",
  ),
  scenario(
    60,
    "attendance",
    "Venue check-in is reversed after a venue-entry scan",
    "The staffed-arrival record and team milestone change, while venue presence, session attendance, and their ledgers remain untouched.",
    "Correct presence separately only when its own evidence is wrong, then use a fresh portal QR at a venue-entry station to record the valid arrival again.",
  ),
  scenario(
    61,
    "attendance",
    "Credential setup is attempted without its claimed participant resolution",
    "The server rejects a missing, expired, mismatched, or reused credential slot; one valid begin and matching second scan stay bound to the same operator, phone, station, member, action, and pending credential.",
    "Ask the participant for a fresh portal QR, restart the intended credential workflow on the assigned phone, and do not reuse the abandoned pending setup.",
  ),
  scenario(
    62,
    "review_operations",
    "A review call races participant movement below the published minimum",
    "The ordinary call leaves the team queued and creates no review records; a valid fresh-authenticated exact-team exception creates one review and one immutable waiver, and start later accepts only current presence or that same review's waiver.",
    "Ask the team to regroup or have an independently authorised operator record the reasoned exception; never change attendance, queue time, or judging state to force the call.",
  ),
] satisfies readonly RehearsalTemplateScenario[];

export function canTransitionRehearsalScenario(
  previous: RehearsalScenarioState,
  next: RehearsalScenarioState,
) {
  if (previous === next) return false;
  if (previous === "pending") {
    return next === "running" || next === "passed" || next === "failed" || next === "blocked";
  }
  if (previous === "running") {
    return next === "passed" || next === "failed" || next === "blocked";
  }
  return next === "running";
}

export function canCompleteRehearsal(
  states: readonly RehearsalScenarioState[],
) {
  return (
    states.length === releaseRehearsalTemplate.length &&
    states.every((state) => state === "passed")
  );
}

export function rehearsalTemplateWorkstreams() {
  return [...new Set(releaseRehearsalTemplate.map((item) => item.workstream))];
}
