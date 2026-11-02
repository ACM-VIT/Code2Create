# Event review readiness

This is the status of the local event-flow implementation. It does not certify the live event configuration, physical devices, or provider delivery.

Reviewer assessment and provisional panels are prepared once with the event owner from supplied resumes/metadata, then applied through existing roster, profile and panel commands. A resume-analysis service is outside the agreed scope. Event-day configuration is planned setup, not missing implementation.

## Flow implemented

| Step                    | Current behavior                                                                                                                                                                                                                                     | Operations controls                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry                   | Staff scan VIT ID barcodes or approved participant QR/badges in the event app. Attendance updates the team's current in-hall availability. Review-presence QR is separate.                                                                           | Attendance plan, stations, participant minimum and reasoned exceptions.                                                                          |
| Reviewer pool           | Original form CSV/TSV or ordinary roster CSV imports the latest response per email. The mistaken form hours are ignored; skills, domain, seniority, resume and GitHub references are preserved.                                                      | Preview/import, account access, assessed profile strength, domain/criterion qualifications and active status.                                         |
| Confirm availability    | Each selected panel member and reserve confirms the whole round, selected hours, or unavailability in the app. Confirmation is distinct from arrival.                                                                                   | Opening and closing time; 22:00–23:00 IST the preceding evening for this event; live responses and explicit reopening.                                             |
| Plan panels             | Provisional panels balance domains and strength, prefer Board leads, and use the strongest eligible SC when allowed.                                                                                                                                 | Panel count, composition, lead fallback, assigned criteria and reserves. Event plan: 7 panels, 1 lead + 2 SC + 2 JC.                               |
| Staff panels            | Confirmed full-review coverage is checked at paging, joining, call-up and actual start. No-show members and accepted substitutes who do not arrive are replaced from the desk before review. All seats are replaceable.                              | Report/no-show grace, page response window, arrival window and JC rotation frequency.                                                            |
| Fair JC rotation        | Available, qualified JCs with fewer completed reviews are offered seats first; longest waiting since the last review breaks ties. Pages and declines do not count as review participation. Rotation only happens when a replacement is eligible.     | Participation roster, confirmed hours, rotation after a configurable number of reviews, manual substitutions.                                    |
| Walk-up review queue    | Staff place the team. Automatic selection filters staffed, confirmed, qualified, authorized, conflict-free panels, then respects the prepared primary/backup panel, or matches domains and ranks by wait when neither is eligible. Queue order follows priority and time. | Skills-first or shortest-wait routing, explicit panel selection, hold/resume/move, manual call and missed-team handling.                         |
| Next team               | Optional automatic call-up waits for the preceding review to complete and staffing to become ready. A heads-up appears before the current discussion ends; a second notice calls the team when ready.                                                | Automatic call-up switch, heads-up lead time, score-entry allowance for ETA and opt-in voice calls. Per-panel blockers are visible.              |
| Project evidence        | GitHub ingestion continues. Teams supply a Figma link for human reviewers. Call-up captures preparation context; actual start captures the context used by the review. That review retains its exact idea/progress/provider versions.                                                | Integration policies, provider status, exact-source browsing and explicit recovery procedures.                                                   |
| Suggested questions     | A separate agent prepares optional source-linked verbal questions across the submitted idea, answers, updates, every connected repository only. Figma contents are not analyzed. Changed captured repository/project evidence creates a new job; actual start pins the matching question set.  | Enable/disable, refresh interval, model, instructions, question count, batch size/concurrency, step timeouts, retries and per-team coverage.     |
| Seven-minute discussion | A server deadline ends discussion and changes the session to `scoring`. Reviewers can finish score entry afterwards. Scores are not automatically submitted.                                                                                         | Discussion duration and extension policy; default 7 minutes and no extensions. Separate score-entry allowance controls ETA and attention timing. |
| Comments and scoring    | Every assigned reviewer must submit their own final comment when the requirement is enabled. Optional private notes and shared coordinator commitments are separate. Comments survive offline drafts, corrections, paper recovery and exports.       | Rubric, fixed questions, 0–4 anchors, criterion weights, independent coverage, final-comment and shared-commitment requirements.                 |
| Results                 | Published Round 1 and Round 2 presets have the requested weights. A separately versioned aggregation policy combines closed-round results at 30%/70%. Missing/excluded rounds remain explicit and do not become zero scores.                         | Round weights, validation/publication, score governance, independently verified round exports and result access.                                 |

A reviewer cannot rotate, change availability or be substituted while an active review or its score entry is unfinished. This is enforced by the backend, not just a hidden button. A team is not restarted to permit a routine seat change.

Reviewers do not clock in or out, and the app does not report whether they are at the venue. Ops manages replacement seats from the panel board with manual no-show and substitute paging.

The reviewer app keeps its existing components and visual style. Availability opens in a sheet; custom hours are shown only on request. Optional questions sit behind quiet actions. Operational policy and staffing tables remain in ops.

## What “freezing evidence” means

It saves the exact project, update and GitHub commit being used when the review starts, plus the Figma link selected at that moment. A saved Figma URL does not freeze the design file itself. Teams can continue working and ingestion can continue updating. The reviewers' context and questions for that particular review stay attached to the saved versions, so a later push does not rewrite what they reviewed. It does not lock the team's repository or Figma file.

## Agent limits

The question agent cannot grade, rank or change event state. Its results are evidence analysis and bounded, ungraded questions referencing the supplied criterion keys and source IDs. Signed requests, strict parsing, current authorization, expiring attempts, create-only identities and immutable settlement keep retries or late results from replacing other work. Disabling preparation stops further dispatch and acceptance of pending results; already completed review context remains available.

Repository analysis inventories every file at the captured commit and reads all eligible text files in resumable batches. There is no four-file, directory-depth or extension allowlist. Large files are split without discarding source text, truncated GitHub trees are traversed explicitly, and unchanged analyses can be reused. Pairwise synthesis combines all completed batches before preparing the final review brief. Coverage tracks captured, excluded, unavailable and analysed items; final questions cannot publish before collection and analysis are complete.

Generated dependencies, actual credential files and binary assets are explicitly excluded and accounted for. This does not execute a team's code. Figma is a single editable file link with the existing icon action. There is no OAuth connection, provider fetch, image capture or agent inspection of that file. Notes and links are included as submitted text. Teams will not be asked for project documents, PDFs or slide decks, so ingestion of those materials is outside the agreed scope. Changing only a Figma link does not regenerate agent questions. Reviewers open it themselves and request access from the team where needed. Reviewer resumes belong to the separate one-time preparation workflow. Credentials stay in the backend and source text is redacted before model dispatch. The brief defaults to at most three optional questions, and may contain none when the fixed rubric is enough. Fixed questions remain usable while evidence preparation runs or if a source fails.

Reviewer shift reminders are retired (decision P-044). One reviewer call setting covers substitute calls, with explicit confirmation of the notice. Team call-ups and substitute-page voice escalation remain available.

## Use the operations dashboard

1. Prepare assessments and provisional panels with the event owner. Preview/import the cleaned reviewer pool, then apply assessed profiles and the plan through existing ops commands. The roster CSV is not a bulk import for arbitrary profile or panel fields.
2. Select a rubric preset, review its fixed questions and anchors, and publish provisional panels with everyone else as reserves. Verify the confirmation date and actual round hours.
3. Reviewers register phones and enable notifications. At the configured time they confirm their actual hours. Check the pending/confirmed/unavailable roster before opening reviews.
4. Set live staffing, JC rotation and response/arrival windows. Keep the publishing operator's required staffing grants active; ops reports when automation has lost its authority.
5. Set queue routing and call-up, enable question preparation, and inspect source/job status. Voice calls require existing provider configuration plus separate consent from the recipient; team leads opt in from the participant portal's More screen.
6. Open the round, scan real arrivals and let staff place walk-up teams. Reviewers scan the team's review QR. The coordinator starts discussion after presence is complete. Any assigned reviewer finishes the review after all active reviewers' cards/comments and required shared notes are submitted; the queue then calls the next team.
7. Close and independently verify each round's export. Publish/check the aggregation policy before using cumulative results.

Structural settings such as rubric and seat composition are chosen in setup and fixed by publication. Live operational settings are versioned; changing them cannot silently rewrite an existing score or review context.

The round board opens on **Live desk**, with panels and team queues first. **People & planning** holds the reviewer pool, confirmations and project allocations. **Settings & results** holds timing, staffing automation, questions and progression. Switching workspaces preserves unsaved form entries.

Published round rosters remain editable by active Board members and the Supreme event owner with panel assignment permission. SC and JC accounts cannot edit rosters, even if an old assignment grant remains. **Edit reviewers** replaces a seat from reserves, swaps two people across panels, or moves a reviewer into a vacancy. Removing a reviewer returns them to this round’s reserves. **Reviewer pool** adds an existing active reviewer profile to a round or removes a reserve from it; profiles, seniority, skills and active status are managed from Review setup. Removing a reserve ends their duty, revokes the round’s reserve permissions and excludes them from confirmation counts, while preserving their response history.

Before a published round starts, ops can plan seats while confirmations are still pending. Actual duty requires an active profile and confirmed hours. Replacement choices are searchable across reserves and other panels. Seniority and scoring-assessment mismatches show warnings and an explicit “anyway” action instead of hiding the candidate. The replacement inherits the seat’s scoring responsibilities; both sides of a swap are checked and warnings are recorded in the audit trail. Unavailable candidates remain visible with the reason they cannot be selected. A short reason menu and a specific action button replace the generic confirmation checkbox; custom reasons remain available. Locked panels explain what must finish first. Every seat change enforces active profiles, confirmed hours when duty is live, overlapping-panel limits and conflicts with teams planned or queued for both affected panels. Transfers are atomic and require access to both panels. A missing fifth reviewer blocks the panel until its seat is filled. The coordinator must be replaced in the same action. Panels with pending presence, active discussion, unfinished scoring or an outstanding substitute page cannot be edited. Each change requires a reason and detects stale edits.

Team assignments are managed separately in **Project planning** (primary and backup panels) and the live queue (move, skip and restore). Roster editing does not silently redistribute teams or rewrite past scores.

Before a published round has been used, Board-authorized recovery can restore a complete historical roster and postpone its start in one audited transaction. Every panel version must still match. The restore preserves original membership history, scoring duties, leads and availability responses; it updates the public timetable and moves the no-show deadline to the new start. Existing reviews or active substitute pages block recovery.

Roster import, confirmation timing, round publication and phone registration are event setup tasks for the planned time. Their absence before that setup is not an implementation gap.

## Staffing capacity

The supplied form has 81 responses, 80 unique people, 23 SC, 57 JC and no Board rows. The approved Kaashvi email correction is in the separately cleaned CSV; personal roster rows are not checked into source.

Six panels with SC leads need 18 SC and 12 JC, leaving 5 SC and 45 JC outside the initial seats. Seven need 21 SC and 14 JC, leaving only 2 SC and 43 JC. Board leads reduce SC demand. These headcounts do not guarantee simultaneous availability or technical coverage. Fair rotation prioritizes eligible JCs; the available event hours still limit how many can review.

## PR #122: reviewer venue presence

[Track reviewer venue presence and escalate unreported departures](https://github.com/ACM-VIT/Code2Create/pull/122) was integrated into staging in `761d839` and retired on 2026-09-08 together with reviewer clock-in and app heartbeats (decision P-044). Venue configuration, foreground/background location checks, departure reporting, venue reminders, confirmation calls and their consents are gone. The reviewer app reports nothing about a reviewer's location, and staffing is desk-driven. Reserve paging uses confirmed availability alone; page expiry and the explicit accept action still govern assigning a substitute.

## Validation boundary

Local lifecycle tests cover confirmation and paging retries, active-review locks, rotation, priority/order and call deduplication, routing eligibility, question source/version isolation and settlement, mandatory comments, scoring and exports.

A physical rehearsal remains necessary for actual ID/QR scanning, a full five-phone panel, consented voice delivery, loss/recovery of connectivity and the real provider evidence. Local tests and bundle generation do not prove those physical behaviors.

The earlier Figma image-analysis feature has been removed in favor of a link for human review.

## Competition eligibility and skipped reviews

- Ops → Review rounds → Competition eligibility separates OC teams from admitted competitors. A team is OC when marked by ops; this does not alter admission, RSVP, event access, or members’ reviewer duties.
- OC teams are excluded from competitive routing, participant review cards, question preparation, and combined rankings. Marking OC cancels any pending review sessions and removes queued assignments transactionally. An active, scored, or closed review must be resolved through its existing review governance flow before reclassification.
- Round managers can use **Skip this review** on a team row after a round is published, including after panel assignment or call-up, until discussion starts. A reason is required and audited. Pending reviewer assignments, draft scorecards, and team QR tokens are cancelled; stale review calls cannot dispatch.
- **Restore review** returns a skipped competitor to the desk for a new panel assignment. Changing OC back to competitor does not automatically restore earlier skips.
- Skips are explicit non-scoring outcomes in round closure and JSON/CSV exports, counted among exclusions. They never become a zero or a completed review, and leave combined results incomplete.

## Project planning, timing and progression

Ops has a project-planning workspace containing accepted non-OC submissions, including those awaiting RSVP. Each structured brief accounts for every intake answer, cites its sources and distinguishes proposed work from demonstrated evidence. A versioned primary/backup assignment records the expertise rationale. Planning does not queue a team, assume availability. Own-team membership and declared conflicts block both planning and live routing. Staff can skip/restore an accepted planned team directly from this workspace, including before it reaches the live queue.

The review end can be extended from ops with a reason and current-version check. Extension preserves ongoing discussion/scoring, extends correction time, and reopens confirmation when necessary. Previously confirmed personal hours are unchanged. Seven-minute discussions retain their separate deadline; the default two-minute scoring allowance affects ETA and attention timing.

The Who advances stepper configures a round as non-eliminatory or eliminatory. After closing and verifying results, ops selects every competitive team's outcome, reviews both groups, and applies the decisions with reasons. A proposed top-N cutoff stops on ties and leaves unscored teams for an explicit choice. The last weighted round uses the configured combined human score when all contributing rounds are finalized. Changed weights or score snapshots invalidate publication. Later actual review activity prevents changing earlier progression; an unstarted planned skip does not.

Eliminated teams cannot enter subsequent reviews or appear as eligible in combined results. A round cannot close while an eligible planned team has no recorded outcome. Progression does not change admission/RSVP or send participant messages. No actual elimination decisions are part of preparation.

The [reviewer flow](../docs/reviewer-briefing.md) has no manual training checkpoint or separate tutorial. Reviewers learn through the real availability, phone setup, presence and scoring steps. Every rating shows its rubric anchor, and final submission shows all scores and the required comment.

Potential pre-event project work is an ungraded agent-suggested question, grounded in the specific submitted statement or dated artifact. The source context includes official event start, submission time, capture time and available provider commit time. Reviewers ask and record the explanation; the agent does not declare a violation, deduct marks or choose eligibility. Missing pre-event implementation is not a weakness.
