# Event follow-up plan

Updated 5 September 2026 after reviewing `main` at `1e3f0a32`. This is the current work list. [Event review readiness](15-event-review-readiness.md) describes implemented behavior; this file records what remains and the evidence needed to close it.

The event is tomorrow. Roster import, policy publication, device registration, and opening reviews are planned operational tasks. An empty live event configuration today is not a missing software feature. This review did not change live configuration or send notifications/calls.

## Agreed simplification

Assess reviewer resumes and metadata once with the event owner in the planning conversation. Use the existing app to run the resulting plan. Do not build a resume crawler, resume-analysis service, recurring reviewer reassessment, or a new bulk-profile editor.

The owner supplies the metadata CSV and resumes matched by email, plus available GitHub/portfolio references. Preparation produces:

- a deduplicated reviewer list with the approved email correction;
- evidence-backed technical/product domains, suitable criterion keys, lead suitability and assessed strength;
- source references and uncertainty for qualifications that need confirmation;
- provisional six- and seven-panel alternatives using Board preference, eligible SC lead fallback, two SC seats and two JC seats;
- replacement candidates that preserve composition and criterion coverage.

The existing CSV importer accepts `email,name,role` or the original reviewer survey columns. It imports identities/roster access and survey references, not an arbitrary assessed-profile or panel CSV. Apply prepared profiles with `reviewConfiguration.saveProfile` and the reviewed panel plan with `reviewConfiguration.publishRound` through existing authorized ops workflows. Resolve imported emails to the actual event accounts and keep real training completion separate from resume assessment.

The mistaken form hours remain discarded. The app owns availability confirmations, clock-in, accepted pages, arrival, conflict checks, all-seat replacement and fair JC rotation. Initial panels stay provisional until these checks pass. Continuous analysis remains appropriate for team projects because their evidence changes during the event.

## Implementation status

| ID | Status | Behavior | Completion evidence |
| --- | --- | --- | --- |
| E-01 | Implemented locally | Ops configures the reminder lead time from 0–3600 seconds (default 300; 0 disables) and whether to also call. Push and calls share that lead time. The reviewer app has one consent setting for shift reminders and substitute calls. | Lifecycle tests cover timing changes, one call per shift, late consent after push delivery, clock-in, changed hours, revoked consent/access, disabled calls, closed rounds and expired reminders. A queued call moved to a later reminder time does not consume an attempt early. |
| E-02 | Implemented locally | Ops can enable visual inspection of captured Figma screens. All captured accessible renders enter the existing resumable pipeline, one image per inspection batch, with exact frame/checksum references. | Lifecycle tests cover newly ready renders, preserved earlier snapshots, changed-byte rejection and disabling visual analysis. The signed service attaches actual PNGs and rejects missing/mismatched images and models without image support. Model questions remain ungraded. |

Project preparation covers submitted ideas, answers and progress updates, connected GitHub repositories, and Figma files. Teams will not be asked for project documents, PDFs or slide decks; no ingestion pipeline for those materials is planned. Reviewer resumes remain part of the separate one-time assessment above.

Do not replace the existing question pipeline or reintroduce file sampling. It already inventories all eligible repository text and stored Figma nodes, processes resumable batches, tracks coverage, reuses unchanged work and synthesizes source-linked questions. Figma visual analysis extends that existing path. Captured renders have the existing preview capture limits, which remain visible through coverage; inspecting those renders does not claim complete visual coverage of every possible screen or prove runtime behavior.

## Preparation and event-day operation

| ID | When | Work | Completion evidence |
| --- | --- | --- | --- |
| P-01 | After the owner supplies the material | Prepare reviewer assessments, provisional panels and replacements as described above. | Every proposed qualification/lead choice has a basis; unknowns are visible; composition and independent criterion coverage are valid. |
| P-02 | Event setup, as planned | Import the pool, apply assessed profiles, record training, select panels/reserves, publish the exact round windows and app-confirmation opening. | Every intended reviewer is included as a seat or reserve and can confirm the hours they can actually cover. No form hour becomes assumed availability. |
| P-03 | Event setup, as planned | Configure attendance plan/stations, register phones, set minimum participant presence, queue routing/call-up, replacement windows and JC rotation. | Staff can identify the next legal action and see a clear blocker when a panel or team is unready. |
| P-04 | Before judging opens | Publish the requested 0–4 rubric presets, fixed questions, criterion weights, seven-minute limit, mandatory final comments and 30%/70% aggregation policy. | One sample result independently reproduces both round totals and the combined total; missing rounds remain incomplete. |
| P-05 | Before using automated preparation/calls | Enable preparation for the published rounds, connect team evidence, collect phone consent, and select the dedicated published conversational venue agent in ops. | Ops shows current source/job coverage and consent/delivery state. Agent selection alone does not count as a successful spoken-response test. |

Reviewer profiles and reserves are not promises of attendance. Every assignment must have current confirmed coverage for a complete review. Fair rotation prioritizes eligible JCs with fewer completed reviews; actual availability and event capacity determine whether every JC can participate.

## Verification work

| ID | Priority | Work | Completion evidence |
| --- | --- | --- | --- |
| V-01 | Before using the flow live | Exercise one complete staging journey with a team, five reviewers and a reserve: entry, staff placement, next-team heads-up, review QR, start, deadline, five comments/scorecards, completion and the next team. Extend browser coverage around the real participant and ops surfaces. | Accepted state agrees across clients; one completed review and one next-team call-up exist. Current Playwright tests check entry and signed-in screens, not this entire journey. |
| V-02 | Before using the flow live | Use physical Android/iOS phones for locked-screen pages, acceptance/no-show, replacement arrival timeout, JC rotation, active-review locks, app restart and offline score recovery. | Each failure converges to one accepted state, with no lost score, duplicate seat, silent replacement or unacknowledged page treated as attendance. |
| V-03 | Before conversational absence handling | Test the dedicated venue agent with available, unavailable, unclear, no-answer and help-needed responses, including a response during active/scoring review. | Ops receives the explicit answer, timestamp and transcript; only a current confirmed absence between reviews can end duty and request substitution. The earlier audible Sarvam announcement did not establish two-way response capture. |
| V-04 | Before relying on evidence questions | Run preparation on a representative multi-repository/Figma project, change its evidence, and inspect the new brief and active-review pinning. Include provider failure and recovery. | Coverage accounts for every eligible source, questions cite actual evidence, updated work produces a new version, and fixed questions remain usable while preparation is unavailable. |
| V-05 | Before final judging | Rehearse score-entry delay, a correction, an export retry and independent export verification. Check concurrent panel call-up load against actual provider capacity. | Late score entry remains possible without extending discussion, results reproduce from immutable inputs, and delayed calls expire instead of reaching people after their task has passed. |

No live rehearsal should create synthetic production judging records. Use staging for the multi-account exercise; physical event setup can be completed at the planned time.

## Project review coverage

This review covered the workspace manifests, mounted participant/reviewer/ops paths, backend owners and jobs, shared contracts, service entry points, existing tests and the relevant handbook requirements. It is a repository-wide readiness review, not a claim that every line or every live provider/device combination has been proven correct.

| Area | Current path checked | Remaining focus |
| --- | --- | --- |
| Participant intake, teams and admission | `apps/web`, backend intake/admission/team lifecycles | Preserve the simple current journey; include multi-account behavior in V-01. |
| Participant dashboard | `DashboardLive` → `ReviewTile`, relevance/layout and live-time helpers | Queue rank, heads-up, table, review code and ETA are on the current dashboard. Deleted legacy panels are not missing features. Participant score publication was deliberately removed in the latest merged change. |
| Native reviewer and scanner app | `apps/reviewer`, attendance/presence/duty/review boundaries | V-01 and V-02; native tests and typechecks cannot establish physical behavior. |
| Ops, roster and panel setup | `apps/ops`, roster parser, profile and publication commands | P-01 through P-04, with no new resume/import subsystem. |
| Staffing, queue and timing | Backend staffing, substitutions, confirmations, queue automation and lifecycle tests | Arrival/no-show/rotation rehearsal; configurable shift calls are implemented. |
| Judging and aggregation | Rubric presets, score governance, review aggregation and round exports | P-04 and V-05; retain independent reviewers, required comments and exact weights. |
| GitHub/Figma evidence | Bindings, refresh jobs, captured evidence, question batches and reviewer browsing | V-04; captured-render inspection is implemented. No arbitrary four-file sampling. |
| Intelligence | `apps/intelligence` signed routes, six agent surfaces, callback boundaries and deterministic tests | Live preparation quality/coverage in V-04; reviewer assessment stays outside the Worker. |
| Voice and GPS | `apps/voice`, venue responses, native venue state and backend escalation | V-03. Audible delivery and recorded confirmation are separate outcomes. |
| Support and Discord | Shared support cases, Discord permissions/bridge, backend and bot tests | Include actual operator/support handling in rehearsal; reuse the current service. |
| Email | `apps/email` lifecycle bridge and backend notifications | Provider delivery is distinct from participant acknowledgment. No new event flow needed here. |
| Incidents, recovery, health and metrics | Backend/ops incident, attention, rehearsal, export and recovery paths | V-02/V-05 and named event operators; keep queues and existing scores intact during incidents. |
| Music and other service queues | Synesthesia and outing-permission paths | Keep independent of judging; operational setup and rehearsal as applicable. |
| App updates | `apps/updates`, signing/runtime contracts and tests | Physical update/restart checks in V-02; no new distribution system. |
| Shared packages | `domain`, `web-auth`, `web-forms`, `client-observability` | Shared tests/typechecks; no new abstraction identified as necessary for this event. |
| Public landing and trailer | `apps/landing`, `apps/trailer`, package entry points/typechecks | Presentation surfaces; no new review-operation work assigned. |
| Browser verification and local checks | `apps/e2e`, root scripts and backend test inventory | V-01. The inventory now follows scripts reachable from the main backend test command. |

## Follow-up implementation

The reviewer call notice now explicitly includes shift reminders. Existing substitute-only consent does not authorize the expanded notice; reviewers confirm the updated notice once in the app. GPS confirmation consent remains separate.

No new resume service, document ingestion, agent-controlled scores, or participant controls were added. The backend and intelligence service use review-question protocol v2 for image attachments and must be released together. These follow-up changes have not been deployed during this work.

## Changes made during this review

- Recorded the one-time reviewer-assessment decision and existing-command handoff.
- Separated implementation gaps from tomorrow's setup and provider/device rehearsal.
- Removed stale handbook claims about a separate handbook application, future-only participant calls, repository sampling and fixed 30-second escalation/90-second page deadlines.
- Documented the current sixth intelligence surface and its review-question route.
- Aligned the participant entry and decision register with the existing external email-code sign-in; VIT and privileged operations still require Google identity.
- Fixed the README's broken reliability-spec link and completed its workspace map.
- Included the three existing intake-AI release tests in the ordinary backend intake target. The inventory previously counted tests mentioned in any optional script, so a test could be omitted from `pnpm test` without failing the check; it now follows the main script's actual dependencies.

## Check record

After the follow-up implementation, the full `pnpm test` run passed 1,373 tests across all 13 packages with ordinary test targets. Root lint and all 16 package typechecks passed. Ops and intelligence production builds passed, and the reviewer app exported both iOS and Android bundles. pnpm regenerated the lockfile from the manifests when the existing model-provider dependency moved into runtime dependencies; no lockfile was edited by hand.

New checks cover reminder timing, rescheduling and stale dispatch; Figma snapshot refresh and pinned images; every captured render entering its own analysis batch; private PNG size/checksum validation; native image attachment dispatch; and rejection of mismatched images or unsupported models. Existing staffing, active-review locks, late score entry, required comments, queue progression, exports and offline behavior remain covered by the regression suite.

A live `gpt-5.6-terra` check inspected one synthetic static queue screen using the production evidence-analysis instructions. It cited only the supplied frame, identified the competing “review is next”/“queue paused” states, and distinguished the visible design from working application behavior. This used 1,656 tokens. It validates a synthetic image-analysis case, not the complete Figma capture/Worker callback path or quality on real team projects.

Local results are under ignored `outputs/event-flow/follow-up-*`, with the synthetic frame and result in `synthetic-review-frame.png` and `visual-model-check.json`. No authenticated multi-account staging journey, physical device exercise, additional phone call, or event-day setup was performed. The configured environment does not contain the saved participant/ops browser states required by the staging browser suite. Those checks remain V-01 through V-05, at the planned time. These follow-up changes have not been deployed.
