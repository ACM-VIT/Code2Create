# Event review readiness

This is the status of the local event-flow implementation. It does not certify the live event configuration, physical devices, or provider delivery.

## Flow implemented

| Step                    | Current behavior                                                                                                                                                                                                                                     | Operations controls                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry                   | Staff scan VIT ID barcodes or approved participant QR/badges in the event app. Attendance updates the team's current in-hall availability. Review-presence QR is separate.                                                                           | Attendance plan, stations, participant minimum and reasoned exceptions.                                                                          |
| Reviewer pool           | Original form CSV/TSV or ordinary roster CSV imports the latest response per email. The mistaken form hours are ignored; skills, domain, seniority, resume and GitHub references are preserved.                                                      | Preview/import, account access, assessed profile strength, domain/criterion qualifications and training.                                         |
| Confirm availability    | Each selected panel member and reserve confirms the whole round, selected hours, or unavailability in the app. Confirmation is distinct from clock-in and arrival.                                                                                   | Confirmation opening time, normally 23:00 IST the preceding day; rescheduling; live response roster.                                             |
| Plan panels             | Provisional panels balance domains and strength, prefer Board leads, and use the strongest eligible SC when allowed.                                                                                                                                 | Panel count, composition, lead fallback, assigned criteria and reserves. Defaults: 6 panels, 1 lead + 2 SC + 2 JC.                               |
| Staff panels            | Confirmed full-review coverage is checked at clock-in, paging, joining, call-up and actual start. Off-duty/unavailable/no-show members and accepted substitutes who do not arrive are replaced before review. All seats are replaceable.             | Automatic replacement, report/no-show grace, page response window, arrival window, five-minute shift reminder and JC rotation frequency.         |
| Fair JC rotation        | Available, qualified JCs with fewer completed reviews are offered seats first; longest waiting since the last review breaks ties. Pages and declines do not count as review participation. Rotation only happens when a replacement is eligible.     | Participation roster, confirmed hours, rotation after a configurable number of reviews, manual substitutions.                                    |
| Walk-up review queue    | Staff place the team. Automatic selection filters staffed, confirmed, qualified, authorized, conflict-free panels, then matches declared domains against project text/repository languages and ranks by wait. Queue order follows priority and time. | Skills-first or shortest-wait routing, explicit panel selection, hold/resume/move, manual call and missed-team handling.                         |
| Next team               | Optional automatic call-up waits for the preceding review to complete and staffing to become ready. A heads-up appears before the current discussion ends; a second notice calls the team when ready.                                                | Automatic call-up switch, heads-up lead time, score-entry allowance for ETA and opt-in voice calls. Per-panel blockers are visible.              |
| Project evidence        | Existing GitHub/Figma ingestion continues. Call-up captures preparation context; actual start captures the context used by the review. That review retains its exact idea/progress/provider versions.                                                | Integration policies, provider status, exact-source browsing and explicit recovery procedures.                                                   |
| Suggested questions     | A separate agent prepares optional source-linked verbal questions across the submitted idea, answers, updates, every connected repository and Figma file. Changed captured evidence creates a new job; actual start pins the matching question set.  | Enable/disable, refresh interval, model, instructions, question count, batch size/concurrency, step timeouts, retries and per-team coverage.     |
| Seven-minute discussion | A server deadline ends discussion and changes the session to `scoring`. Reviewers can finish score entry afterwards. Scores are not automatically submitted.                                                                                         | Discussion duration and extension policy; default 7 minutes and no extensions. Separate score-entry allowance controls ETA and attention timing. |
| Comments and scoring    | Every assigned reviewer must submit their own final comment when the requirement is enabled. Optional private notes and shared coordinator commitments are separate. Comments survive offline drafts, corrections, paper recovery and exports.       | Rubric, fixed questions, 0–4 anchors, criterion weights, independent coverage, final-comment and shared-commitment requirements.                 |
| Results                 | Published Round 1 and Round 2 presets have the requested weights. A separately versioned aggregation policy combines closed-round results at 30%/70%. Missing/excluded rounds remain explicit and do not become zero scores.                         | Round weights, validation/publication, score governance, independently verified round exports and result access.                                 |

A reviewer cannot leave, rotate, change availability or be substituted while an active review or its score entry is unfinished. This is enforced by the backend, not just a hidden button. A team is not restarted to permit a routine seat change.

The reviewer app keeps its existing components and visual style. Availability opens in a sheet; custom hours are shown only on request. Optional questions and duty changes sit behind quiet actions. Operational policy and staffing tables remain in ops.

## What “freezing evidence” means

It saves the exact project, update, GitHub commit and Figma version being used when the review starts. Teams can continue working and ingestion can continue updating. The reviewers' context and questions for that particular review stay attached to the saved versions, so a later push does not rewrite what they reviewed. It does not lock the team's repository or Figma file.

## Agent limits

The question agent cannot grade, rank or change event state. Its results are evidence analysis and bounded, ungraded questions referencing the supplied criterion keys and source IDs. Signed requests, strict parsing, current authorization, expiring attempts, create-only identities and immutable settlement keep retries or late results from replacing other work. Disabling preparation stops further dispatch and acceptance of pending results; already completed review context remains available.

Repository analysis inventories every file at the captured commit and reads all eligible text files in resumable batches. There is no four-file, directory-depth or extension allowlist. Large files are split without discarding source text, truncated GitHub trees are traversed explicitly, and unchanged analyses can be reused. Figma analysis includes every node in the stored file structure, full text and available interaction/layout/style properties. Pairwise synthesis combines all completed batches before preparing the final review brief. Coverage tracks captured, excluded, unavailable and analysed items; final questions cannot publish before collection and analysis are complete.

Generated dependencies, actual credential files and binary assets are explicitly excluded and accounted for. This does not execute a team's code or visually inspect rendered Figma screens. Notes and links are included as submitted text; arbitrary external documents and reviewer resumes are not automatically downloaded. Credentials stay in the backend and source text is redacted before model dispatch. The brief defaults to at most three optional questions, and may contain none when the fixed rubric is enough. Fixed questions remain usable while evidence preparation runs or if a source fails.

## Use the operations dashboard

1. Preview/import the cleaned reviewer pool and finish account/profile/training setup. No resume declaration automatically grants a qualification.
2. Select a rubric preset, review its fixed questions and anchors, and publish provisional panels with everyone else as reserves. Verify the confirmation date and actual round hours.
3. Reviewers register phones and enable notifications. At the configured time they confirm their actual hours. Check the pending/confirmed/unavailable roster before opening reviews.
4. Set live staffing, JC rotation, response/arrival windows and reminder timing. Keep the publishing operator's required staffing grants active; ops reports when automation has lost its authority.
5. Set queue routing and call-up, enable question preparation, and inspect source/job status. Voice calls require existing provider configuration plus separate consent from the recipient; team leads opt in from the participant portal's More screen.
6. Open the round, scan real arrivals and let staff place walk-up teams. Reviewers scan the team's review QR. The coordinator starts discussion after presence is complete, finishes the review after all cards/comments are submitted, and the queue calls the next team.
7. Close and independently verify each round's export. Publish/check the aggregation policy before using cumulative results.

Structural settings such as rubric and seat composition are chosen in setup and fixed by publication. Live operational settings are versioned; changing them cannot silently rewrite an existing score or review context.

Code alone does not schedule tonight's live confirmation or import the roster. No live roster import, round publication, notifications or calls were performed in this task.

## Staffing capacity

The supplied form has 81 responses, 80 unique people, 23 SC, 57 JC and no Board rows. The approved Kaashvi email correction is in the separately cleaned CSV; personal roster rows are not checked into source.

Six panels with SC leads need 18 SC and 12 JC, leaving 5 SC and 45 JC outside the initial seats. Seven need 21 SC and 14 JC, leaving only 2 SC and 43 JC. Board leads reduce SC demand. These headcounts do not guarantee simultaneous availability or technical coverage. Fair rotation prioritizes eligible JCs; the available event hours still limit how many can review.

## PR #122: reviewer venue presence

[Track reviewer venue presence and escalate unreported departures](https://github.com/ACM-VIT/Code2Create/pull/122) was reviewed at `0c03ff6fadd90c6d3f4c1000e8ad85f214f5252d`. It adds venue configuration, opt-in foreground/background location checks, explicit departure reporting, ops visibility, native reminders and consented calls. It fits the availability portion of this flow, but it is separate from panel duty in that PR.

The PR's feature work was integrated into staging in `761d839`. Declared departures share the active/scoring review lock and end duty between reviews. Native and backend checks reject location samples captured before the current tracking generation. GPS is advisory and never changes staffing by itself. The separate confirm-return mutation and duty-home venue shortcut were removed: the reviewer returns through normal clock-in, which also cancels an older unresolved call check.

A sustained outside reading triggers an app reminder, then an opt-in conversational call using the agent/version selected in ops. The agent asks about current presence, availability and return time, clarifies, and requests agreement to a read-back. Ops sees the recorded answer, timestamp, transcript, call delivery status and resulting staffing action. A current, explicit unavailable response ends duty and requests substitution between reviews. Available, unclear, help requested and no answer remain distinct. Active/scoring review never permits automatic departure or replacement. Expired calls, revoked consent, changed tracking/policy and resolved departures cannot apply a late answer.

The concrete [voice-agent setup](../apps/voice/agents/venue-confirmation.md) is ready for publication and rehearsal. The implementation stores answers/transcripts and does not enable or download audio recordings. Selecting an agent is optional; without it, GPS/app/ops checks continue and no conversational calls dispatch.

The follow-up preserves a departure without creating a terminal call record while venue-call consent is missing, so consent granted later can still trigger one call if the departure remains current. Native opt-out stops local uploads immediately and persists an owner-scoped, idempotent server-disable request for foreground retry. Obsolete requests cannot disable a replacement tracking generation. Venue reminders use the shared native push sender and retire invalid tokens only when the failed token still matches the device registration.

The detailed initial PR review is in `outputs/event-flow/pr-122-review.md`. These changes do not replace physical GPS, notification and voice rehearsal.

## Validation boundary

Local lifecycle tests cover confirmation and paging retries, active-review locks, rotation, priority/order and call deduplication, routing eligibility, question source/version isolation and settlement, mandatory comments, scoring and exports. The current local check record is `outputs/event-flow/final-validation.md`: 687 backend Vitest tests, 112 backend utility tests, all client/voice suites, seven package type checks, root lint, four builds and both native JavaScript exports passed. A final 90-test affected-flow rerun also passed after the call-response and live-board changes.

A physical rehearsal remains necessary for actual ID/QR scanning, a full five-phone panel, background/foreground reminders, consented voice delivery, loss/recovery of connectivity and the real provider evidence. PR #122 additionally needs real GPS and locked-screen testing. Local tests and bundle generation do not prove those physical behaviors.
