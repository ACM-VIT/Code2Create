# Operations dashboard

## 1. Purpose

The dashboard is the work application for organizers. It must help each person answer two questions: **What needs my attention now?** and **Where do I do that work?** It supports these jobs:

- Which rounds are open?
- Which attendance session is active, and who is present, temporarily out, late, excused, or unresolved?
- Which entry/exit station is offline, overloaded, or replaying pending scans?
- Which teams are waiting for the desk, queued, called, held, or overdue?
- Which panels are complete and which seats are empty?
- Where is every active review?
- Which scorecards or criteria are missing?
- Which release-rehearsal scenarios have passed, failed, or remain blocked, and who owns each workstream?
- Which exception needs a human decision now?
- Which participant-intake and phase configuration is currently published?

Charts are secondary. The product must lead with current work, not system terminology, internal states, or a list of every feature.

## 2. Access

Every route, query, and command checks a stable permission key against current person-specific grants. Role labels provide organizational context, while role assignment may materialize a code-owned permission template as ordinary grants. A user whose role-template grant is absent or revoked is denied; a JC, participant, or External Judge with the exact grant is allowed within its scope.

The dashboard is assembled from independent read/action permissions. Examples:

- `application.read` for an admissions dossier, or `application.review.read` for one assigned/manually granted review dossier;
- `attendance.station.read` and `attendance.scan.execute` for one station;
- `queue.manage` for one panel;
- `score.completeness.read` without `score.values.read`;
- `operations.health.read` for the aggregate event health view, independently from team-scoped `integration.read`;
- `event.lifecycle.read` and `event.lifecycle.manage` as independent event-wide permissions for seeing and changing the event state;
- `operations.intelligence.read` and `operations.intelligence.generate` as independent event-wide brief permissions;
- `configuration.intelligence.read`, `.draft.create`, `.validate`, and `.publish` as four independent event-wide autonomy-policy permissions;
- `configuration.communications.read`, `.draft.create`, `.validate`, and `.publish` as four independent event-wide accepted-team policy permissions;
- `rehearsal.read`, `rehearsal.manage`, `rehearsal.execute`, and `rehearsal.complete` as four independent exact-run or event grants;
- `round.export.read` for one exact judging round and validity window.

There is no generic shared “admin mode,” role bypass, or wildcard permission.

### Product navigation

The shell shows only destinations that the current person can open. It groups them by the work they support:

- **Now:** Overview, Event monitor, Operations agent, and Help desk.
- **Applications:** Review applications.
- **Event day:** Check-in, Hall, and Music desk.
- **Judging:** Review rounds, Results, Team updates, and Code and design.
- **Manage:** Event setup, People and permissions, Test run, and Recovery.

These are participant-facing or operator-facing product names. Internal names such as health projection, admissions dossier, Synesthesia, integration evidence, and rehearsal can remain in code and audit records, but they must not be the primary navigation labels.

A permission can remove one item or a complete group. The shell must not show a disabled destination that the person can never use. A direct URL still performs the same server permission check.

The event state decides which destinations lead. The stage-specific work stays visible. Other permitted destinations remain under the closed **All workspaces** disclosure. It opens automatically while the current route belongs inside it. Permission, not stage, removes a destination.

| Stage | What it is for | Leads with |
| --- | --- | --- |
| Setting up | Decide how teams apply, then open applications | Event setup, People and permissions, Test run |
| Applications open | Review applications as they arrive and answer questions | Review applications, Help desk, Event setup |
| Applications closed | Finish decisions and offers, then ready the venue | Review applications, Event setup, Test run |
| Event running | Keep people checked in, teams routed, and reviews moving | Overview, Check-in, Hall, Review rounds, Help desk |
| Event finished | Verify and close each round, then publish results | Results, Overview |

### Permission manager

A user with `access.permissions.read` can inspect only the people covered by that grant. The deployed directory is paginated, and an event-wide reader may also look up one exact verified email. Event-scoped `access.permissions.grant_any` exposes every legal catalog/scope control. A matching `access.permissions.grant_scoped` exposes only its one permission, exact resource, covered target, and remaining expiry ceiling. Revoke controls independently use unrestricted or matching scoped revoke authority.

A user with event-scoped `access.subjects.invite` gets a separate exact-email invitation control even when they cannot read the account directory. They choose the Google email, a five-minute-to-30-day claim expiry, and a reason. A current invitation can be revoked through the same narrowly bounded invitation authority. Create and revoke require a current scoped authorization. The recipient claims after Google sign-in; claim creates or reuses the event account but grants no role or permission.

The deployed page lets the user:

1. choose one active event-linked person from the directory or exact-email result;
2. choose one atomic permission from the server-owned catalog;
3. choose one exact event-owned resource through a paginated labeled picker, or paste its exact ID for server validation;
4. set an optional expiry and required reason;
5. grant immediately against the target account's current access version;
6. inspect resolved resource labels, source, reason, scheduled/active state, start/expiry times, and history through the capped paginated grant ledger;
7. revoke one exact grant with a reason, leaving any independently sourced matching grant intact.

The page shows the optional role label but never uses it to disable an otherwise legal grant. The backend resolves `self` to the target participant membership for participant permissions and to the target event-access subject for reviewer-device registration. Page and reviewer-owned scorecard grants cannot be attached to a different person. Every other scope is loaded and checked against the event rather than trusting a client-supplied parent ID.

A separate role control appears only when the operator holds `access.roles.assign` for that exact person or the event. It can set Supreme, Board, SC, JC, External Judge, or no role. It requires the target's current access version, a reason, and a fresh current authorization. Before submission, the control disables a templated role change that exceeds the operator's grant or revoke ceiling; the backend independently expands and validates every template permission. The saved transaction changes the role row and only that row's source-attributed template grants.

The exact-email lookup also resolves a suspended or closed event account; the ordinary directory remains active-only. An active target shows **Suspend event account** only to an operator with matching `access.subjects.suspend`. A suspended target shows **Reactivate event account** only with matching `access.subjects.reactivate`. Each confirmation shows the number of currently effective permission types, requires the current access version, current scoped authorization, and reason, and changes the subject boundary without editing grant rows. Self-suspension is rejected.

The deployed roster workspace accepts the exact `email,name,role` CSV shape. The file can contain at most 200 logical rows and 256 KB. The request includes a source, one event-bounded validity window, an audited reason, and up to eight optional compatible published bundle versions. The workspace shows a server-resolved no-write preview with new, replacement, unchanged, and already-claimed counts and rows. Confirmation requires a fresh current authorization; an import containing Supreme also requires event-wide `access.permissions.grant_any` because claim will materialize that role's complete template under the importer's recorded authority. Confirmation atomically records the import, supersedes only previewed pending rows, and schedules exact activation and expiry of the pending rows' materialized validity. The realtime history is paginated for event-wide readers. An exact-row reader receives only the row covered by the reader's grants. An authorized operator can revoke only a current pending row with its version, current authorization, and a reason.

The roster screen never assigns a panel, station, round, team, or other resource. Bundles that need such a binding are visibly unavailable and must be followed by the resource's own assignment flow. A claimed row is historical evidence, not an editable account form; later CSV uploads report it as already claimed and leave it unchanged.

The direct permission editor can add or remove several exact grants in one change. Its batch form accepts two to twenty rows, one target, one reason, and one optional common expiry. Each add row has its own permission and exact resource scope. Each remove row names one current active or scheduled grant. The server checks every row, every delegated ceiling, the target's current access version, and the fresh-session boundary before it writes anything. It then writes the complete change or nothing, advances the target access version once, stores one idempotent operation result, and records one audit event that lists every affected grant. A stale version or one illegal row rejects the complete batch.

Constrained delegation is deployed. Grant and revoke ceilings are separate, and the editor shows every exact ceiling when the same permission has several. One batch cannot mix unrestricted and delegated authority. Target-owned scopes require an exact person. Delegated grants are time-bounded. Administration keys cannot be delegated through the scoped path or bundles. The UI displays scheduled grant start times before activation. Exact start/end jobs and a bounded repair sweep materialize lifecycle state and refresh access versions. Versioned bundle drafting, publication, preview, exact-person application, roster application, and bounded migration are deployed.

Sensitive web commands enforce freshness on the server. When the Google session is too old, the current page opens a small Google verification prompt. The prompt uses the hosted OAuth popup flow. After the popup closes, the dashboard waits until an authenticated Convex query confirms the new session is fresh. It then retries the same immutable command with the same operation ID once. Cancellation writes nothing and leaves the form on screen.

The permission-bundle workspace can migrate one to five exact prior applications from a retired version to the current published version. It suggests compatible old resource bindings but requires an explicit choice for every unresolved destination binding. The preview lists adds, replacements, removals, grants already present from the destination source, and revoked exceptions that will stay off. Confirmation preserves the old application expiry within the event end, updates all selected people atomically, and supersedes only grants attributed to the selected source applications. Direct grants and other bundle sources remain independent.

Roles, rosters, and bundles are separate tools. `access.roles.assign`, `access.roster.import`, `access.permission_bundles.read`, `access.permission_bundles.publish`, `access.permission_bundles.apply`, and `access.permission_bundles.migrate` do not imply one another or direct grant/revoke authority. Assigning a templated role additionally requires authority for every grant it creates and every prior role-template grant it revokes. Bundle apply can be limited to one bundle, exact targets, scopes, and validity.

The UI labels delegation separately from execution. Being allowed to grant an action never lights up that action’s button unless the user also holds the action permission.

### Event state

**Event setup** starts with the current product state and next legal action. The ordinary path is **Setup → Applications open → Applications closed → Event live → Event complete**. Server time and the two published class deadlines drive the application stages. The event remains in **Applications open** while either class can still write. A later deadline publication can return the stage to **Applications open**. No manual state action can accept a participant write outside the deadline for that participant class.

Seeing this control requires event-scoped `event.lifecycle.read`. Changing it requires the independent `event.lifecycle.manage` grant, current scoped authorization, the current event version, a reason, and an idempotent operation ID. The mutation writes one audit event. Two operators acting on the same event version cannot both win.

Opening applications requires published event dates, external and VIT application deadlines, participant policy, intake policy, and admission policy. The external deadline must be no later than the VIT deadline, and the VIT deadline must be no later than the event start. Starting the event requires accepted-team details, event phases, team updates, check-in plan, hall plan, integration policy, and at least one published judging round. Finishing the event is blocked while an attendance session or judging round is active. The dashboard names these blockers next to the attempted transition.

At `externalApplicationsCloseAt`, the server stops profile, team, intake, proposal-revision, and final-submission writes for external participants. It applies the same stop to VIT students at `applicationsCloseAt`. Saved drafts remain readable. Submitted applications remain available to admissions. The current lead can still answer a specific admission-information request after the team's deadline. An idempotent retry of a command that committed before the applicable deadline returns its first result. Extending a deadline reopens the same participant commands for that class; it does not rewrite a prior application snapshot.

### Overview

The first route for a caller with event-scoped `operations.health.read` is **Overview**. It is a dispatch page, not a report. It contains only:

1. the event and current stage, when the caller can read lifecycle state;
2. the next lifecycle action and at most three current blockers; and
3. the three highest-priority named items the caller can work on now.

The system-health state is one compact link to **Event monitor**. The Overview does not show the complete attention ledger, system checks, charts, an operations brief, configuration status, or explanatory guide text. It shows **Nothing needs action** when the named list is empty.

Each lifecycle blocker links to the workspace that resolves it only when the caller can open that workspace. A blocker stays readable as plain text when the caller has lifecycle read access but lacks the focused workspace permission. An unblocked transition links to Event setup only when that route is available.

The **Now** rows are not counts. Each row names the blocked panel, team, reviewer, or station, states the problem, and links to the work screen. The footer shows how many other rows remain and opens **Event monitor**.

A row exists only when the caller can open the workspace it links to, which follows from composing projections that already filter by grant. Holding the command as well is a second, finer distinction: a caller who may look but not act sees the row and an open link rather than the command verb.

Picking up or dismissing a row requires event-scoped `operations.attention.manage` and the same focused visibility grant that made the row readable. Both commands require the row's current version and an idempotent client operation ID. Dismissal also requires a reason. A retry after an uncertain response returns the first stored result and does not repeat the transition, read-fact update, or audit event. The web dashboard and reviewer app keep the original command available as **Confirm pickup** or **Confirm dismissal** until the response is definite or realtime state shows that the row changed.

The current rows cover empty panel seats, overdue reviews, incomplete reviewer presence, teams below the round's participant minimum, held teams, expired calls, and long waits.

### Event monitor

**Event monitor** contains the 20 highest-priority permitted named-attention rows and the aggregate system checks. It states when more rows remain; the queue refills in realtime as current work clears. Named rows come first. Aggregate checks cover faults without one named subject, such as provider limits, webhook state, and delivery ambiguity. A system check is omitted when a named row already reports the same problem. The operations brief may use these aggregate signals, but it is not rendered on this page.

The overview permission returns aggregate operational state only. It does not imply incident, participant, application, team, repository, Figma file, round, score, or music-detail access. A signal links to a focused workspace only when the person can open that workspace. The corrective command remains inside that focused workspace and performs its own permission check.

The current projection covers:

- open critical and non-critical incidents plus active review-round pauses;
- stalled or failed intake interpretation and admission-analysis work, plus stalled or recently unavailable novelty previews, with failure counts limited to the recent operating window;
- current attendance preparation/finalization jobs, authenticated scanner liveness, and phones reporting encrypted scans awaiting replay during the live event;
- panels needing a reviewer, stale reviewer heartbeats on open rounds, overdue reviews, and expired substitute pages;
- the latest participant-email attempt, distinguishing terminal delivery failure, unknown provider outcome, and processing stall;
- current GitHub/Figma access, sync lease, rate-limit, required-topic, and webhook state;
- the active closing round's current export rather than superseded export history; and
- the active Synesthesia window's open reports, paused playback, overdue acknowledgment, and impossible multiple-playing invariant.

Signals contain only severity, area, count, oldest observed time, accountable owner, and a short next action. They never return incident text, participant identity or destination, team/project text, provider error codes, resource names, tokens, object keys, or judging values. A separately granted focused workspace is required to inspect or act on the affected records.

Every source query uses an event/status index and a fixed bound. A source that reaches the bound adds a visible coverage warning instead of pretending the aggregate is complete. One server-owned action computes the event snapshot every 30 seconds and writes it through one indexed, idempotent upsert. Clients subscribe only to that materialized row; they never send time buckets or rerun the source queries per identity. A missing or more-than-90-second-old snapshot is shown as starting or delayed, with no live-computation fallback. Zero-count rows are omitted and the remaining rows sort critical, needs-attention, then watch.

Health is based on current ownership, not an ever-growing error log. A manual participant-email retry marks its failed source attempt `superseded` in the same transaction that creates the new attempt. Attendance and round-export checks follow the IDs held by the currently preparing/closing parent. Integration checks exclude revoked/archived bindings, model fallback counts age out of the recent window, and Synesthesia checks only the active published window.

### Bounded operations brief

The bounded operations brief lives in the **Summary** view of **Operations agent**. It is not part of Overview or Event monitor. It is requested explicitly by an operator. A caller with `operations.intelligence.read` sees the latest validated brief and its frozen source time. A caller with `operations.intelligence.generate` sees **Create brief** or **Refresh brief**. The two permissions are independent. A user allowed to create a brief but not read it can start the job and receives no result.

One request freezes the current materialized redacted health snapshot in Convex before external work begins. A request is rejected while the snapshot is missing or stale; it never launches a private live recomputation. A signed, timestamp-bounded service request creates exactly one Flue Durable Object instance whose identity is the brief ID. A retry receives the existing-instance result instead of starting another model run. The Worker can call one tool: publish one bounded callback. It has no Convex session, database proxy, or domain command.

A successful brief contains a short headline, one summary, and at most three non-overlapping priorities. Every priority must cite one to six signal keys from the frozen snapshot. Convex rejects these conditions:

- an uncited or foreign signal;
- a changed source checksum;
- severity inflation or downgrade;
- an owner and next-action pair not copied together from one cited signal;
- more than one priority that uses the same signal;
- invalid length; or
- a callback after the first terminal settlement.

The stored result records the agent version, model, source time, completion time, and failure category. It does not expose the frozen private record set because the input contains aggregate signals only.

The section displays queued, dispatching, running, ready, and failed states plainly. It never renders a control implied by the brief. The operator opens the existing separately authorized workspace to investigate or act. Dispatch failure, provider failure, invalid callback, or the ten-minute deadline leaves a visible failed record and does not affect the health view or any event state.

Manual brief lifecycle history is cursor-paginated newest first. **Load older manual briefs** retrieves the next page; no fixed latest-run sample is described as the complete history.

### Live intelligence console

The live console shows an operations brief, the current operator's private copilot conversation, or one autonomous operations run without copying the private transcript into Convex. The Flue Durable Object is the canonical execution stream, while its public sanitizer exposes cursor-paginated lifecycle history plus resumable updates. On reconnect, the client can recover older sanitized pages before resuming from the returned offset; repeated positions render once. Convex run/checkpoint state, not Flue stream settlement, is authoritative for an autonomous run's phase and terminal result.

Opening a stream requires event-scoped `operations.intelligence.read`. Convex mints a read-only capability that expires within 60 seconds and is bound to the exact event, agent, and Durable Object instance. Brief, copilot, and autonomous-run capabilities use different signature contexts. Each public history or update response is bounded, but opaque cursors make the complete sanitized history reachable. Long polling is supported; an indefinitely open SSE connection whose authorization would outlive its ticket is rejected. The browser never receives the service signing secret, cannot submit directly to the Worker, and refreshes the capability through Convex when needed.

Copilot turns take a stable turn ID and enter only through `operationsIntelligenceActions.submitCopilotTurn`, which independently requires `operations.intelligence.generate`. A lost or ambiguous admission response keeps the same turn ID and message for a safe retry; only a validated conflict is definitive. Stream access does not imply generation, and generation does not imply stream access.

The console may show visible user and assistant text plus fixed, sanitized tool and investigator lifecycle labels. Its five autonomous labels are **Plan operations review**, **Read approved event data**, **Investigate event area**, **Check evidence and conclusions**, and **Record recommendation proposal**. Autonomous labels come from the Worker's schema-validated `autonomy-lifecycle` data part; the private agent tool itself is never rendered. The console never renders hidden instructions, reasoning, other data/file parts, metadata, raw tool arguments or results, or provider error text. Recommendations appear as separate human-review cards with their exact arguments, target versions, reasons, and citations. Approval, rejection, and revision remain ordinary Convex commands that recheck the human's current exact grant and target version.

### Autonomous operations policy

The autonomous operations policy is a complete immutable version. It selects `observe` or `recommend`, health severities and areas, cadence, escalation severity, one accountable active event account, a closed set of redacted read tools, and the typed recommendation kinds that may be recorded for human review. The exact read registry covers operations health and attention, review rounds and exceptions, attendance counts and operations, floor-mapping progress, support load, intake jobs, admission jobs, participant deliveries, integration jobs, round-export jobs, Synesthesia operations, and incident readiness. It places no product quota on reasoning turns, read traversal, tool calls, investigator work, runtime, or proposal count. Technical endpoints still stream or paginate bounded chunks so one request cannot exhaust a Worker or Convex transaction, but a durable agent may continue through every page and checkpoint until its analysis is complete. `observe` requires an empty recommendation allowlist. `recommend` allows only the selected typed proposal kinds. The first release has no execute mode, generic action tool, or machine permission to perform a domain command.

The current policy response always includes its exact selected owner, including a truthful indication when that account has since lost required access. Eligible replacement owners use a separate indexed, searchable, cursor-paginated picker. Large staff populations never make the configuration or kill-switch screen unavailable, and an empty filtered page does not imply that later eligible accounts do not exist.

Drafting, validating, publishing, and using the kill switch retain their independent exact permissions. Publication requires the current event version, exact draft checksum, reason, idempotent operation ID, and a current scoped authorization. An enabled publication atomically supersedes the prior policy/scheduler and starts one versioned state; a disabled publication stays fail-closed. The kill switch immediately cancels the claimed run in Convex, terminalizes its checkpoint, releases the scheduler, and sends one signed idempotent abort to its exact Worker instance. Re-enabling requires publishing a new policy.

The run card exposes the exact Worker-shutdown state: **not required**, **authority revoked; Worker abort pending**, or **Worker abort recorded**. **Not required** means there is no Worker abort obligation for that run; it is not an inferred success receipt. A pending abort is already effect-safe because every signed boundary is revoked, while the durable abort outbox continues retrying. Flue's abort receipt proves that durable abort intent was recorded; it does not prove that the asynchronous submission settlement has already appeared, so the dashboard never calls that receipt physical shutdown confirmation.

The scheduler enqueues autonomous work from an explicit operator request, every due schedule slot, or every qualifying changed signal. It reads only due indexed states and uses the same ready materialized health snapshot as the dashboard. Missing health defers work; it never starts a private event-wide scan. Policy version, policy checksum, normalized allowlists, trigger snapshot/checksum, trigger provenance, and the source high-watermark of every allowed temporal-fact read freeze on the inbox item before dispatch. The portion of that vector belonging to the currently qualifying policy areas is part of a signal's semantic fingerprint, so an underlying change in an enabled trigger area remains distinct even when aggregate health count, severity, and oldest time happen to stay equal. That trigger snapshot explains why work started; it is not a knowledge deadline. Each later materialized run reads the exact source episode frozen for its queued item, while additional authorized refreshes use their own exact read receipts. Concurrent evaluations leave one deterministic operation key for the same semantic trigger, while distinct slots, source versions, and signal episodes remain separate durable inbox items even when another run is active.

Each run is one immutable Flue instance reached through a dispatch whose idempotency key is the run ID. An identical retry returns the original admission receipt and a changed payload conflicts. Trusted orchestration may plan, reread, investigate, reconsider, and critique as many times as it needs. Code, not the model, owns the work closure: it traverses every policy-allowed read to `isDone`; the planner may order work and choose additional focus, but it cannot omit an allowed source. Investigators receive only redacted results for their assigned event area and may follow pagination cursors without truncating the investigation. Bounded summaries are indexes into an append-only lossless finding and candidate catalog, not replacements for evidence. Durable synthesis pages through that catalog until every finding has been considered, so a provider output bound cannot silently discard an early fact needed by a later page. The critic must reject unsupported, duplicated, stale, out-of-range, or policy-disallowed candidates before any proposal crosses the Worker boundary. Prompts treat every event field as untrusted data, require source keys for claims, state uncertainty until relevant pagination is complete, consider a counter-hypothesis, and prohibit participant ranking, judging, or invented evidence.

Convex authorizes every model, investigator, read, proposal, and lifecycle boundary. Stable durable operation IDs make a lost receipt replay return the original sequence and response without duplicating an effect; a reused ID with different content is rejected. A transient failure can re-enter one provider turn, so this is not a claim of physical provider exactly-once delivery. Transport requests retain finite body and execution limits, and Flue retains an explicit recovery-attempt ceiling, but these do not terminate the analysis: the durable controller checkpoints and continues in another slice. Every boundary rechecks the live event, current published checksum, active scheduler claim, accountable owner's exact permissions, and kill state. Provider/tool/policy failures are typed and recoverable or terminal according to their actual cause. Revoking authority, ending the live event, using the kill switch, or superseding policy aborts provider work rather than merely hiding its eventual callback. Initial and continuation admission signatures expire after the one shared 30-second acceptance window. Convex retains an ambiguous outbound-attempt marker beyond that window and cannot acknowledge abort while it remains open; a late accepted receipt requeues abort instead of resurrecting authority.

An autonomous run can publish observations and, in `recommend`, exact typed proposals. It cannot acknowledge an alert, hold a team, page a reviewer, create a support case, dismiss an item, or impersonate the accountable owner. Derived evidence records name one to four exact parents, creating a bounded-fan-in support DAG rather than flattening all support into one provider response. Before publication, the Worker durably walks the selected candidate's complete source-leaf closure and uploads canonical leaves in signed pages of at most four. Convex grounds every leaf against the exact completed read operation and snapshot, extends one ordered hash chain, and atomically seals the set. The proposal names that seal and the exact target leaf identity; it does not truncate an arbitrarily large support set to fit one request.

The recommendation card cursor-pages every sealed leaf and shows its run, statement, reasoning, model, agent version, observation time, leaf count, and root hash. When another run reaches the same still-open semantic effect, the event keeps one actionable human decision but appends that run's independently sealed observation instead of discarding its reasoning or replacing the original provenance. A human must review the exact target version and relevant evidence before invoking the ordinary versioned mutation with their own current permission. The run, latest compact checkpoint, idempotent operation receipts, durable work inbox, evidence chain, observations, and recommendation records are machine provenance; no fake human audit actor is created for schedule or signal triggers.

### Intelligence surfaces and action boundary

The selected intelligence layer grows through narrow projections rather than one general database chat. Later slices may add:

- a participant explanation of that participant's own current state and next required step;
- admissions completeness and published-policy explanations, never an admit/decline action;
- a reviewer evidence brief and missing-evidence checklist, never a score or score recommendation;
- support classification, duplicate hints, ownership suggestions, and reply drafts;
- GitHub/Figma freshness and provider-anomaly explanations;
- attendance, hall, queue, panel, reviewer-presence, and round-risk summaries for the operator's permitted scope; and
- rehearsal, release, and incident handover briefs from fixed operational projections.

Each output is one of three classes: observation, proposed action, or executed command. Observations may publish after strict source/version validation. A proposed action must name its source facts, exact target, current target version, reason, required permission, and expiry. Execution is never an agent tool: a human opens the normal product confirmation and the ordinary Convex mutation rechecks that human's current exact grant and scope, current authorization where required, current state/version, reason, and operation ID. The mutation records the human as actor. An agent cannot impersonate them or turn a stale proposal into a command.

Autonomous runs exist only under the current enabled published policy and claimed scheduler state. They use the closed read/proposal contracts above and can publish no event command. Convex authorizes every model, read, investigator, proposal, and lifecycle boundary, while the durable agent may continue reasoning and traversing resumable pages until it finishes, is explicitly stopped, loses authority, or the event leaves its live operating state. Transport page sizes, request timeouts, and transaction limits are implementation slices, never cognitive quotas.

## 3. Applications

Before the event, the applications workspace groups records by the next real action or stable outcome:

- Needs review.
- Review in progress.
- Waiting for team.
- Accepted, offer not sent.
- Waiting for confirmation.
- Confirmed teams.
- Not selected.
- Offer expired or declined.

The list row shows enough information to choose the next application. It does not expose model state, policy versions, delivery telemetry, or other implementation details as primary columns.

Grouping only reads if the size of each group is visible. Every stage shows its count, an empty stage is visibly empty rather than merely unselected, and the workspace opens on the first stage that has anything in it. Filtering to one stage and defaulting to a stage that happens to be empty leaves an operator unable to tell whether nothing has been submitted or everything has already moved on.

The application detail starts with the current state and next action. It then shows the current immutable team and proposal snapshot. The **Admission review** record contains the published policy guidance, structured AI recommendation, human reviews, and reviewer assignments. It is open while review work is active and collapsed after the application reaches a stable state.

The workspace also provides these authorized facts and controls when needed:

- submitted/unassigned/in-review applications;
- missing application-review coverage;
- reviewer workload;
- eligibility blockers;
- the current team roster and lead, current immutable proposal version, prior application versions, and application completeness;
- participant class and published year/study-band context only when the caller has the matching profile-data permission;
- independent human recommendations after each reviewer submits;
- the structured AI admission recommendation, its source coverage, limitations, policy/model versions, and stale/unavailable state;
- accepted, waitlisted, declined, and information-requested counts;
- the current information-request questions/state and every immutable prior response in application-content order;
- offered and confirmed participant counts against venue capacity;
- expiring offers and waitlist promotions;
- one verified-email destination and latest decision-delivery state for each member of the deadline-frozen application roster covered by the caller's exact-person communications-read grants.

Application dossier read, assigned-review read, human review write, review assignment, profile/year context, AI-recommendation read, failed-analysis retry, human decision, information response, and offer management are separate permission boundaries. The deployed keys are `application.read`, `application.review.read`, `application.review`, `application.assign`, `application.profile_context.read`, `application.ai_recommendation.read`, `application.ai_recommendation.run`, `application.decide`, exact-team `application.information.respond`, and `application.offer.manage`. Every published decision keeps the application version, admission-policy and AI-policy versions, human reviewer recommendations, AI recommendation ID when visible to the actor, AI disposition `used | cleared | overridden | unavailable`, human reason, actor, permission grant, and time. The information-response permission is part of the current lead grant source and transfers atomically with leadership; it does not let a participant create, replace, or choose the questions. Waitlist promotion remains unavailable until O-023 defines its ordering rule and a separately protected command ships.

The review-routing block accepts one exact active event-account email. Assignment atomically creates the routing row and only the exact-application review read/write grants. The assignee's role is not checked. Active and completed work appears in the assignee's personal realtime queue. Canceling pending work requires current application and assignment versions plus a reason, changes only that routing row, and revokes only its source grants. Saving a current-content human review completes an active routing row; replacing the same review does not inflate the completed count. Independent direct grants remain valid without a routing record.

The decision panel labels its actions **Accept**, **Waitlist**, **Decline**, and **Needs information**. **Needs information** opens one or two short question fields. The server rejects empty, duplicate, or overlong questions. An operator can copy the AI recommendation into the pending human choice. The operator can also clear the recommendation or choose another outcome. These UI actions do not publish a decision. An authorized human must confirm the decision for the current proposal version.

While applications remain open, the page continues to accept assigned human reviews but shows **Waiting for the application deadline** instead of the decision form. The server rejects every decision command before `applicationsCloseAt`. At the deadline, the same realtime page exposes the form if review coverage and permission are complete.

If the current AI analysis has a definite failed or stale state, the application detail shows **Run analysis again** only to a holder of `application.ai_recommendation.run`. The operator enters a short reason. The control is absent for pending, running, successful, disabled, superseded, or decided work. A run-only operator sees that a retry is available but does not receive the old analysis. A read-only operator can inspect the old analysis but cannot retry it. The new run appears through the existing realtime application subscription. The failed record remains in history, and human review never waits for the retry.

After the current lead responds, the same detail screen shows the cumulative question/answer snapshots in the Project section. Active reviewer assignments remain routed and point to the incremented content version. Old human reviews are visibly historical/superseded. Current completion returns to zero. Any fresh AI analysis can cite stable `requested_information_<request>_<answer>` sources. Operators never edit the participant's response in place.

After a human **Accept**, the offer block is the only capacity-changing control. An exact-application offer manager enters the approved deadline and sends the offer. The server atomically reserves the deadline-frozen roster against overall capacity. The block then shows the live offer state, reserved count, and deadline. The same manager may revoke only an open offer with a reason. Only the current lead responds from the participant portal under exact-team `application.offer.respond`. Expiry is scheduled and version-checked. Confirmation keeps capacity reserved. Decline, expiry, or revocation releases it once.

Notifications are a separate disclosure below a published decision. When every permitted recipient record is healthy, the disclosure stays closed and summarizes the result, such as **2 of 2 delivered**. A delayed, bounced, failed, suppressed, or unknown result opens the disclosure and states the required action. Normal provider progress must not dominate the application page.

`communications.delivery.read` at exact-person or event scope controls whether each recipient row is returned; application access alone does not expose an email address or delivery telemetry. A row shows the verified destination, destination status, latest append-only attempt, provider state, retry number, timestamps, and a non-sensitive error category. `communications.delivery.manage` is checked separately for that same person before controls appear or a command can run. A definitively failed latest attempt may be retried; an `unknown` outcome directs the operator to reconcile it in Cloudflare Email logs and has no retry control. Disabling an active destination suppresses pending/retry-wait work, while a request already in flight remains visibly capable of completing. Both commands require current versions, a reason, a current scoped authorization, an idempotent client operation ID, and an audit event.

Final submission creates the first immutable application snapshot. Until the applicable class deadline, participants can still change a valid team and the current lead can revise proposal content. Each accepted team or proposal change creates a new immutable snapshot and invalidates stale AI and human review output. The application detail updates in realtime to the new roster, lead, and content version. After the deadline, a separately scoped member-correction command shows the deadline-frozen snapshot and downstream impact. It requires a reason and returns the application to review.

The venue judging rubric, score views, judging recommendations, rankings, and winner language do not appear in this workspace. The published admission rubric is year-adjusted and explicitly separate from hackathon judging.

## 4. Configuration

The configuration area is permission-gated and stays out of live floor controls. Each resource has independent event-scoped read, complete-draft replacement, validation, and publication grants, so a person may prepare a version without being able to publish it.

Before an event exists, the authenticated operations surface has one different state. An email listed in the deployment's `INITIAL_SUPREME_EMAILS` sees **Create the event** only for the slug pinned by `INITIAL_EVENT_SLUG`. The form asks only for the event window, venue, Discord invite, VIT email domain, team bounds, participant capacity, and initial integration policy. The server creates the draft event, baseline participant, intake, admission, communications, and integration policies, the initial owner account, the Supreme label, and explicit owner grants in one mutation. Another signed-in account sees no setup form. A competing creation has one winner. The new event remains in **Setup** until an authorized person passes readiness checks and opens applications.

**Event setup** opens on a realtime overview. It groups settings by the participant journey and shows one row for each setting the caller can read. A row shows the current useful fact and state. It links to the focused editor. It does not show inaccessible settings. The editor tabs are Participant form, Idea questions, Idea comparison, Admissions, Accepted teams, Schedule, Team updates, and Operations brief. Direct editor URLs enforce the same read grant.

The current release has eight editors:

1. **Participant policy:** the two application deadlines, class-aware profile fields, team bounds, participant notices, fresh-project acknowledgment, and final-submission warning. VIT and external teams stay separate.
2. **Admission policy:** year-adjusted criteria, minimum human reviews, human decision reasons, and overall participant capacity. The platform owns the model release.
3. **Intake policy:** the fixed opening, help and answer limits, two required questions, zero-to-two generated-question bound, allowed purposes, blocked wording, and optional reviewed common-idea guidance. The platform owns generation.
4. **Novelty corpus:** debounce and rate limits, a fixed embedding contract, and a curated set of non-identifying past-project summaries.
5. **Event phases:** schedule-assigned `introduction`, `ideation`, `build`, `intermediate_update`, and `final_update` display definitions and windows.
6. **Project checkpoints:** the separate ideation, intermediate-update, and final-update question definitions and grace periods.
7. **Operations intelligence:** observe or recommend mode, selected health triggers, cadence, closed redacted-read and typed-proposal sets, accountable owner, effect boundary, and enabled state.
8. **Accepted-team communications:** operational event window, venue, ordered next steps, Discord invite, and generic verified-email wording.

The opening preview must show only **Hello.**, followed by **What is your project about?** and one text box. A preview that renders a long form, chat transcript, assistant persona, or PPT upload cannot publish.

### Draft and publication

- Published versions are immutable. Saving a changed complete draft retires the prior draft instead of patching it in place.
- Each validator checks only the invariants owned by its resource. Intake validation checks the exact opening, answer bounds, fixed-question coverage, generated-question bound, question wording, purpose set, blocked terms, and pattern keys.
- The diff lists participant-visible changes plus the number of active drafts pinned to the published version.
- Publication requires the exact current draft ID and checksum, current event version, recent Google session, and a reason.
- Session-pinned participant configuration updates only the default for later sessions and never migrates active participant drafts. The product has no bulk **Use latest** action or rollback that rewrites participant state.
- Admission configuration is stricter: the first submitted application closes ordinary publication for the event so every application uses one rubric and capacity release.

The intake editor uses `configuration.intake.read`, `.draft.create`, `.validate`, and `.publish`. It replaces the whole participant-facing question policy, shows the fixed opening as read-only, and exposes only values the backend validates. It has no AI on/off, model, or prompt controls. With an OpenAI key, the service evaluates the code-owned generated-question release after both fixed answers; without a valid result, intake proceeds to review. The call uses `store: false`, no tools, a strict output schema, source-answer references, and server-side grounding validation. Publishing a new policy leaves every active draft, question, answer, and in-flight interpretation pinned to the old version.

The novelty editor uses four independent event grants: `configuration.novelty.read`, `.draft.create`, `.entries.write`, and `.publish`. Draft creation fixes `text-embedding-3-small` and native dimension `1,536`. Operators can change only the minimum idea length, debounce, per-team rate, and score mapping. Entry replacement accepts one complete `5–300` JSON array. It normalizes and privacy-validates the array. It rejects a source year later than the current server year. It creates each embedding as one bounded provider operation. It commits all new entries or none. A failed provider call leaves a retryable failed draft and does not change the published corpus.

The screen shows published/draft version, revision, entry count, provider readiness, import state, and checksum. The screen never shows participant preview requests or current-team idea text. Publication revalidates the exact entry projection/checksum, current draft revision, event version, recent Google session, and reason. It then atomically supersedes the old corpus and updates the event pointer. Existing project drafts stay pinned to the superseded corpus. No operator control migrates their signal. Changing the embedding model or width requires code review and a newly embedded corpus/index contract.

The participant-policy editor uses independent `configuration.participant.read`, `.draft.create`, `.validate`, and `.publish` event grants. It edits the external and VIT deadlines and one complete immutable policy version: class-aware field modes, team minimum/maximum, profile/project-text notices, privacy link, fixed fresh-project acknowledgment, and final-submission warning. Team-class separation is fixed and has no operator control. The external deadline must be no later than the VIT deadline. Both must remain in the future when changed, and the VIT deadline must be no later than the event start. The team bounds are positive whole numbers chosen by operations. The maximum cannot exceed the currently published admission participant capacity. Saving replaces the one current draft under an optimistic draft ID. Publication requires the exact draft/checksum/event version, a reason, and current scoped authorization. A higher minimum or lower maximum also transactionally checks every non-withdrawn event team and fails with the first incompatible roster, so it cannot commit concurrently with a join or strand existing members. A valid publication supersedes the prior policy and swaps the event pointer atomically. Open participant portals update through their existing query. Existing records are not migrated; participants explicitly accept the new version on their event membership before saving a profile, creating or joining a team, or submitting the project. Team formation may continue before profile completion after that acceptance.

The admission-policy editor uses independent `configuration.admission.read`, `.draft.create`, `.validate`, and `.publish` event grants. It replaces the year-adjusted criteria, all five band explanations, minimum human-review count, decision-reason matrix, and participant capacity. The platform attaches the code-owned model release; organizers cannot disable or replace it. Human review and decision paths remain usable when the provider fails. Validation requires these values:

- one through twelve uniquely keyed criteria;
- complete guidance for every band;
- four through twenty uniquely keyed reasons that cover every human disposition;
- one through five human reviews;
- a positive whole-number participant capacity chosen by operations.

Publication shows the exact change summary and requires the draft policy/model IDs and checksums, event version, reason, idempotent operation ID, and current scoped authorization. One transaction supersedes the previous policy and model, publishes the exact pair, creates the empty overall capacity bucket, and swaps both event pointers. Draft replacement and publication are unavailable as soon as any submission attempt is validating or finalizing, or any application exists. If publication races submission start, Convex serializes the indexed reads and writes: the attempt either pins the newly published policy or publication loses and returns the frozen-policy error. A model release can never point to another rubric.

The accepted-team communications editor uses independent `configuration.communications.read`, `.draft.create`, `.validate`, and `.publish` event grants. One complete immutable version owns the participant-facing venue name/address/map, exact event start/end snapshot, one-to-eight ordered next steps, Discord invite/label, and the generic Cloudflare Email subject/introduction. The dates must equal the operational event window, external links must be credential-free HTTPS, Discord must use an official invite host, stable step keys must be unique, and email wording cannot disclose accepted/declined/waitlist/offer state. Draft replacement is optimistic and retires the previous draft. Publication requires the exact draft/checksum/event version, reason, and current scoped authorization, then supersedes the prior policy and swaps the event pointer atomically.

Only `accepted | offer_sent | confirmed` applications receive the current published portal projection, after exact-team `team.read`. The unauthenticated event query contains none of the venue, next-step, or Discord fields. New publications update eligible portals in realtime. Notification delivery rows pin the policy version present when they are enqueued; automatic and manual retries keep that pin, so queued wording remains reproducible after publication.

The event-phase schedule is also implemented, under its own `configuration.phase.read`, `configuration.phase.draft.create`, `configuration.phase.validate`, and `configuration.phase.publish` event grants. It replaces the complete five-phase draft rather than patching individual rows. Validation enforces one instance of every fixed semantic key, canonical order, valid one-minute-to-fourteen-day windows, no overlap, and a maximum sixty-day schedule span. Gaps are allowed. Publication rechecks the exact current draft ID and checksum, event version, recent Google session, reason, and current server time in one transaction. A completed phase is immutable; an active phase keeps its key, wording, start, and order and may change only its future end; a future phase cannot be moved into the past. The participant portal subscribes to the published schedule and shows the current or next phase.

The project-checkpoint editor is implemented under independent `configuration.checkpoint.read`, `configuration.checkpoint.draft.create`, `configuration.checkpoint.validate`, and `configuration.checkpoint.publish` event grants. One immutable plan defines the ideation, intermediate-update, and final-update name, first question, short reflection, and zero-to-1,440-minute grace period. Each checkpoint is bound to its matching semantic phase; timing comes from the current published schedule. Publication requires that schedule, the exact current draft/checksum/event version, a reason, and a current scoped authorization. Replacing a plan changes the default only for teams that have not started that checkpoint; an existing shared team draft keeps its pinned wording.

The operations-intelligence editor is implemented under independent `configuration.intelligence.read`, `configuration.intelligence.draft.create`, `configuration.intelligence.validate`, and `configuration.intelligence.publish` event grants. It prevents empty trigger/read sets, derives every numeric bound from the shared server contract, shows the current scheduler and event-local run count, uses a bounded friendly accountable-owner selector, validates a complete replacement draft, and requires a second explicit publication step. The same surface exposes the reasoned kill switch to publishers. It never exposes a model prompt, generic tool, execute mode, or automatic-action setting.

A separate project-updates workspace requires event-wide `project.checkpoint.read`. It shows current state, saved answers, submission timing, and immutable submitted content in paginated team rows. The same key can instead be granted for one exact team. Neither read scope carries write, queue, review-start, score, or configuration authority. Participant writes continue to use exact-team `team.project.write`.

The adaptive later-phase question policy, phase guidance, simulation, migration, and rollback editors remain later slices.

### Planned intake diagnostics

The later detailed intake-diagnostics workspace will show:

- answer-save latency and save failures;
- active/complete/abandoned sessions by checkpoint, generated-question purpose, and fallback key;
- sessions by pinned flow and model version;
- intake Workpool depth and oldest job;
- model success, refusal, invalid-schema, question-policy rejection, timeout, rate-limit, stale-result, and deterministic-fallback rates;
- median and tail latency and bounded token usage by configuration version;
- aggregate question length, duplicate, compound-question, and easy-answer evaluation rates by policy version.

Diagnostics never show participant answer text, generated brief text, contact information, system instructions, provider payloads, or API keys. Support can open a participant-authorized project record through the ordinary scoped route when content inspection is required.

## 5. Header

The shell shows the product name, current event stage, stage-specific navigation, account identity, and sign-out control. A page adds only the state needed for its job. Release IDs, policy versions, connection diagnostics, permission scopes, and aggregate exception counts belong in focused setup, monitoring, or recovery screens, not every header.

An active incident banner appears only for a caller with `incident.read`. If a live subscription is stale, affected command controls disable and the page shows the last server update time.

## 6. Round control

The round lifecycle is:

`draft → published → open → closing → closed`

A round-wide incident pause is a separate active/resolved record attached to an open round. Keeping it outside the lifecycle preserves the real round state, keeps active reviews finishable, and gives each pause its own incident, actor, reason, timestamps, and version.

The control page shows:

- configured clock-in opening, reviewer report time, no-show grace, round start/end, and correction-request deadline;
- panel-plan version;
- rubric version;
- timer policy;
- expected and completed teams;
- unresolved routing, review, score, and correction blockers.

Commands:

- open check-in;
- publish panel plan;
- open routing and queues;
- pause or resume new review calls and starts through independently granted exact-round commands;
- begin closing and generate the frozen round export;
- download the protected JSON and CSV under an independent read grant;
- retry a failed export;
- independently verify the export and close the round;
- reopen with `round.reopen`.

Opening a round validates all required configuration. Closing validates review and score completeness. A generic confirmation dialog is not enough; the page lists the exact blockers or consequences.

Round publication also validates every assigned and reserve reviewer against that person's explicit availability. One canonical availability interval must cover the full staffing window from clock-in opening through round end. The published staffing times, no-show grace, and correction-request deadline are immutable round policy and are included in the configuration checksum.

`closing` freezes judging writes and generates the round export. The page shows the frozen team dispositions, selected-review counts, generation state, revision, failure, file sizes, and short checksums. A failed export leaves a visible blocker and an independently permissioned retry action.

The starter and verifier must be different people. The verifier needs both file-read and verify authority, opens the two protected downloads, attests that the displayed counts match, and gives a reason. The backend checks the exact stored object versions again before closing. The direct `open → closed` control does not exist. Reopen stays hidden unless its independent exact-round grant is effective and is blocked after participant feedback or downstream round activity.

Review-round check-in is not a participant hacking-session check-in. The attendance schedule and the judging round schedule may overlap but keep separate records and policy.

## 7. Attendance and presence

The attendance workspace opens on the active session, not a historical chart.

Attendance-plan setup shows and enforces the production bounds of 32 areas, 64 sessions, and 128 scanner stations. It rejects a draft or publication when one participant could match more than four simultaneous sessions or more than one simultaneous required session. The add controls stop at the same server-owned limits, while the backend remains authoritative.

Summary cards show:

- expected and confirmed participants;
- currently present, temporarily out, departed, excused, and needs-review counts;
- participants whose confirmation window is closing;
- team review-call availability and blockers;
- zone occupancy and configured safe capacity;
- online, stale, offline, and replaying stations, including each reported pending count and oldest capture time;
- accepted, duplicate, rejected, and pending throughput.

The live participant table can be filtered by session, zone, team, participant class, state, or support flag. A row shows preferred name, VIT registration or external event-badge reference where permitted, team, current state, latest accepted server time, station, and coarse exception state. Raw VIT ID barcode values, fingerprints, and sensitive reason details never appear.

The session panel shows:

- published attendance-plan version and expected-cohort snapshot;
- expectation-build or closing/finalization progress, processed count, needs-review count, and checksum state;
- scheduled and accepted actual start/end;
- check-in opening, grace, late-arrival, and away-alert settings;
- tracked zones and enabled scan methods;
- required, optional, or information-only status;
- minimum-duration/checkpoint rule when configured;
- session version and last protected change.

Operators can:

- open, extend, close, or cancel a session;
- activate, reconfigure, or disable a station;
- record a staffed venue arrival, use a separately authorized identity exception, or reverse the exact current arrival;
- enrol, suspend, or rebind a VIT ID barcode after a staffed identity check;
- issue, revoke, or replace an external QR badge;
- record an excused/accessibility exception;
- add a live compensating event for a missed transition, mark an ambiguity for review, or void the latest incorrect accepted scanner transition while the session is open;
- open or decide a review against one participant’s finalized result after the session is closed;
- place or clear a short team review-call hold;
- open an emergency roll call;
- request a purpose-limited export.

External-badge stock is generated before check-in with `pnpm attendance:badges --count <n> --output <new-file.html>`. The command creates a new print-only HTML file atomically and never emits a bearer manifest. Each card contains an anonymous high-entropy QR plus a short printed reference. Unused cards and the HTML are physical credentials and remain with attendance operations.

At a `venue_entry` station, the participant-first surface is **Arrival desk**. Scanning one fresh portal QR consumes it and resolves only that confirmed participant, team, class, credential state, and latest staffed-arrival state. The server returns a two-minute resolution bound to that operator, assigned phone, station, and person; independent one-action venue and credential slots allow one legitimate action in each domain. Staff explicitly record arrival after matching the visible class-appropriate ID. The command uses `attendance.venue_check_in.record` for the exact person or an explicit event-wide grant. A no-ID recovery is not a checkbox on the same authority: it needs `attendance.venue_check_in.override_identity`, a bounded reason, and a current scoped authorization. Reversal similarly needs `.reverse`, a newly scanned resolution, the exact current row/version, reason, and current authorization. Every physical-credential begin/single-step command claims the credential slot, and a second scan must match that exact action and pending credential from the same operator/phone/station/member. Each action is online-only and changes no entry/exit or hacking-session record. Event-wide `.read` exposes the realtime sharded checked-in count on the operations board; exact-person read remains available without exposing another participant.

The same participant-first screen exposes credential controls only when their independent grants exist. For an external participant, staff scan one unused badge, compare the returned reference with the printed reference, and scan the same badge again. Issue or replacement becomes active only after that second scan. A replacement keeps the old badge active until the atomic swap; revocation immediately retires the active badge and cancels any unfinished replacement. Issue, replacement, and revocation require a current scoped authorization. The UI never shows the QR bearer.

For a VIT student, the same participant-first screen resolves both an active and a suspended current binding. `attendance.credential.suspend` immediately changes an active binding to `suspended` and cancels an unfinished successor in one transaction. It never resumes a card. Recovery requires independently granted `attendance.credential.rebind` and two scans of a different VIT ID; when the prior binding is already suspended, it remains unusable until the atomic replacement completes. Both commands require the current credential version, visible identity confirmation, a reason, an assigned current-plan phone with station-read access, and a current scoped authorization.

The minimal command surface shows **Extend**, **Close session**, and **Cancel session** only to a holder of `attendance.session.manage` for that row. Extension accepts whole minutes plus a reason and is available only before the accepted end. Close and cancel preview their effect, fix one server cutoff, and remain visibly in progress while the indexed result batch runs. Cancel is also available before open and never creates an absence. Draft or submitted paper sheets block both close and cancel. A stale version or concurrent session command writes nothing.

The scan ledger is never edited from this screen. Opening **Correct** loads the participant's current state, open interval, and recent session events. The operator chooses the compensating transition and effective time, sees whether it opens, closes, preserves, or voids the current interval, and enters a reason. The command requires the current session and participant versions plus a current scoped authorization. Session close wins the transaction boundary: after closing starts, a different reviewed post-session remedy must be used rather than changing a final result through the live control.

After finalization completes, **Review result** loads the exact closed-session result, duration, confirmation/late state, recent immutable presence events, and prior review cases. `attendance.remedy.read` controls that evidence view. `attendance.remedy.open` and `attendance.remedy.decide` are checked independently for the same attendance session; neither action permission implies read access. A participant may also open one case against their own result through the self-scoped portal route. Only one case may be open for a participant/session at a time.

Opening captures the session version and the participant result/version, duration, confirmation time, late flag, and latest evidence event. A stale case cannot be decided. Approval records the reviewed replacement result and supporting duration/confirmation facts, updates only the derived participant result and its counter shard, and preserves every scanner event and interval. Decline keeps the current result. Both outcomes preserve the before/after case, internal decision reason, actor, authorizing grants, and a separate note shown to the participant. Staff open and decision commands require a current scoped authorization and an idempotent operation ID.

An emergency roll call must name an incident or drill and select one prepared attendance session. That session supplies the already-frozen expected cohort and exact zone; a stale closed, unprepared, or canceled session cannot start one. `attendance.roll_call.read`, `.start`, and `.close` are independent exact-session permissions, and start/close require a current scoped authorization. One zone can have only one active roll call.

Start atomically stores the session version, expected count, server time, checksum, and starting counts, then initializes fixed sharded live counters. Accepted venue scans move the same participant between **inside**, **temporarily out**, **not arrived**, **departed**, **elsewhere**, and **unknown** in the same mutation as normal venue presence. The paginated roster resolves those states from the original session cohort rather than copying another participant directory. Close freezes final counts; later scans continue ordinary attendance but cannot rewrite the closed roll call or its starting snapshot.

The board does not rank participants by hours or label an ordinary temporary exit as misconduct. Long-away and missing-scan conditions are operational prompts until an authorized person applies the approved attendance policy.

Overlapping sessions are separate rows and per-participant states. A workshop confirmation cannot replace the broader hacking-session confirmation. The dashboard blocks open until expectation materialization completes and keeps close visibly in progress until every resumable finalization batch and count check succeeds.

## 8. Hall map

The hall view is a live projection of the published floor plan. Each venue zone is drawn as one rectangle at the proportions of the real room, with its published landmarks marked and every recorded team position drawn on it at once. A panel has no place of its own: panels walk to whichever team they are reviewing, so where the team is sitting is the only place a review happens.

Each zone shows:

- the rectangle, its size in paced metres, and its landmarks;
- a dot per team at the position floor staff recorded, with the team name;
- how many teams are in each of the zone's nine parts, so a crowded corner is visible before anyone walks into it;
- mapped team, mapper, and last mapped time when authorized;
- whether a team is queued, called, in review, or held when the caller also has the relevant queue read.

Staff can:

- create a bounded draft plan by pasting checked zone/landmark CSV rows;
- publish the plan before mapping begins;
- see placed, confirmed-team, and unlocated counts and the busiest part of the hall update live;
- map a team in the event app after scanning the QR on that team's dashboard;
- freeze only after every currently eligible team is mapped;
- make a reasoned, separately authorized correction after freeze.

There are no table QR stickers and no participant location-write button. `floor.plan.create`, `.publish`, `.freeze`, `floor.location.read`, `.map`, and `.override` are independent permissions. Plan commands use event or exact-plan scope. Location commands use event or exact `floor_zone` scope; a cross-zone move requires authority over origin and destination.

Moving a panel does not move the team's recorded hall location, and correcting a hall location does not silently reroute or call the team. After floor freeze, an accepted correction updates participant, event-app, routing, and operations projections from the same append-and-supersede transaction.

## 9. Reviewer and panel board

The panel board shows one row per panel:

- table/zone;
- lead;
- planned and current reviewers;
- criterion coverage;
- clock-in and last-seen state;
- current page;
- active team and timer;
- queue length;
- next available estimate;
- conflict or device warning.

Empty seats and coverage gaps appear first.

Available actions:

- inspect eligible substitutes and ranking factors;
- page the next candidate;
- cancel a page;
- mark temporary unavailability or confirmed no-show;
- accept an operator-confirmed phone/runner response only under the approved fallback policy;
- move a reviewer between panels;
- pause or retire a panel.

The UI never claims a substitute is assigned because a push was delivered.

Clock-in opens at the published boundary according to server time and is rejected outside the reviewer's declared availability. A no-show action is unavailable until `reviewerReportAt + noShowGraceSeconds`, or the corresponding return boundary for a temporarily unavailable reviewer. A present reviewer cannot be marked no-show. Clock-in and no-show re-read the same versioned presence and panel records in one transaction, so a boundary race has one coherent winner.

## 10. Queue board

The queue board has columns for:

- unassigned;
- queued by panel;
- called;
- at table;
- in review;
- held;
- missed;
- completed.

Each team card shows queue time when assigned, table, project domain, assigned panel, teams ahead, wait age, and blocker.

Staff can:

- place an eligible unassigned team directly into a panel queue;
- accept or change a proposed panel;
- call the next team;
- hold, resume, or move a team;
- mark missed under policy;
- correct an operations error.

Dragging a card is a request to the server, not a local reorder. The server rechecks current queue and returns the accepted position or a conflict.

Manual priority requires a reason code and remains visible on the card until the team completes the review.

## 11. Active reviews

The active-review view sorts by:

1. overdue;
2. missing reviewer presence;
3. disconnected reviewer with unsaved draft;
4. near end;
5. normal.

Each session shows:

- team, panel, table, and round;
- start, planned end, extension, and elapsed time;
- reviewer presence;
- current participant availability, published minimum, and whether one scoped exception is recorded;
- project and checkpoint versions;
- scorecard draft/submitted state;
- criterion coverage;
- conflict/correction state;
- operations actions already taken.

Protected actions:

- issue an allowed extension;
- correct table or panel metadata;
- add a missing-presence waiver with `review.presence.waive` for that review;
- record a participant-availability exception with `review.participant_availability.waive` for that exact team or pending review;
- pause the panel after the current review;
- force-close only under the approved policy;
- open a replacement-review case.

The dashboard does not expose live peer score values to floor operations.

## 12. Integration evidence and health

The integration view is team-scoped. Its collapsed row shows provider counts, aggregate health, completeness, freshness, and the next useful check. Expanding one team loads:

- provider, active GitHub repository and Figma file counts, aggregate state, and binding owner team;
- one GitHub child row per repository with kind, purpose, topic, tracked branch/root, baseline/head SHA, last push, last reconciliation, and completeness;
- one Figma child row per file with provider-last-touched, webhook-observed, metadata-checked, full-content-captured time, and rendered/selected frame count plus preview-set state;
- current checkpoint-set IDs attached to each review;
- installation, webhook, authorization, access, rate-limit, and Workpool state;
- duplicate, out-of-order, truncated, stale, `content_dirty`, preview partial/failure/rate-limit, or reauthorization warnings.

Participant, reviewer, and operations screens read the same materialized status records. The dashboard does not calculate cards by scanning raw provider events or by loading every file and snapshot on the event board.

The event list reads one indexed `githubTeamMetrics` row and one indexed `figmaTeamMetrics` row per visible team. Opening a team loads its ordered repositories and current Figma files, snapshots, and preview state through one exact-team query. Raw Figma artifact access remains a separate permissioned action inside that detail. This avoids repository/file/snapshot fan-out across the event board while preserving resource-level failures and partial coverage in drill-down.

Reconciliation, full-checkpoint request, artifact read, reauthorization prompt, binding disablement, and shared-resource override use separate integration permission keys at event/team/integration scope. Artifact read creates a short-lived signed URL, then delivers it only after one transactional recheck confirms the exact permission, latest snapshot, artifact manifest, checksum, and unexpired link and records the access in the audit log. It never exposes the bucket key or provider token. Derived preview work is visible but does not replace or mutate the pinned raw snapshot. No command changes captured evidence for an active review or bypasses provider backoff. Every manual retry and binding replacement keeps its actor, permission grant, and reason.

## 13. Synesthesia console

The Synesthesia route appears when the account has at least one Synesthesia grant. The screen still returns only the catalog, windows, requests, report counts, and controls covered by the caller's exact grants. It loads report reasons only after the operator opens one request's reports.

The console has three plain sections:

- **Ambience windows** creates and edits drafts, publishes non-overlapping policy, pauses/resumes playback, and closes a published window.
- **Live queue** shows one selected readable window and its bounded request list. Opening a reported request pages every open report for that request. Each row exposes only the separately granted moderation, scheduling, playback, report, and requester-access commands.
- **Approved catalog** adds or corrects provider metadata and disables tracks without deleting historical request snapshots.

Every write asks for an audit reason. Rejection and hiding also require participant-facing text. Internal notes and report reasons remain absent unless the caller holds the narrower read permission. The playback control records the operator's action in Convex after the same track is started or stopped in the licensed application; the dashboard never claims to control or stream provider audio.

## 14. Scoring completeness

A separate scoring-governance view requires `score.completeness.read`; opening numeric values additionally requires `score.values.read`. It contains:

- expected scorecards by team and reviewer;
- criteria covered and missing;
- submitted time;
- score-spread flags;
- conflicts;
- correction requests;
- invalidated or replacement reviews;
- round total only when complete.

The default view shows completeness, not a winner leaderboard during active reviews.

The round list reads only round metadata, export state, release state, and capability flags. Opening
one round subscribes to a compact exact blocker summary plus bounded pages of review sessions. The
operator explicitly loads later pages; the summary never mistakes the loaded page for round-wide
truth. Numeric values are a separate, explicit view whose criteria and completed-review rows load in
bounded pages only after the operator opens them.

`scorecard.correction.open`, `scorecard.void`, and `score.release` are independent grants. None permits typing over a submitted score.

## 15. Support desk

Support cases come from the participant portal, the reviewer/staff event app, or the operations desk. The operations screen is a compact live list beside the selected timeline; it is not a generic CRM or another incident system. Active, resolved, closed, and all-case filters use indexed bounded queries.

A case contains:

- a collision-checked public support code;
- reporter, verified contact route, and `participant | reviewer | staff` origin;
- optional validated subject, team, round, review-session, and attendance-session references;
- one category and plain description;
- optional owner, optimistic version, `open | investigating | waiting | resolved | closed` state, and timestamps;
- an append-only timeline of opening, reporter reply, public note, internal note, state change, and owner change actions.

Categories include identity, team, proposal, configuration, attendance credential, missing scan, scanner device, table, integration, queue, reviewer device, scorecard, accessibility, and safety.

Participant provisioning and approved roster claim create independently revocable self-scoped `support.case.create`, `support.case.read`, and `support.case.reply` grants. Those grants expose only cases reported by that same person. An exact-email access invitation still creates a grantless account; a grant administrator must explicitly add any support capability it needs. Staff list/detail access requires `support.case.read` for the exact `support_case` or event; updating requires the separate `support.case.manage` grant for that same case or event. Logging a walk-up issue for operations requires event-scoped `support.case.create`.

Assignment is routing metadata, not authorization. An owner must be an active event account, but assignment creates no grant and an ungranted owner still cannot open or change the case. A role string cannot substitute for the exact grant; any grant created by a role template is evaluated through the same permission path.

Reporter-visible actions exclude internal notes and owner history. Staff readers receive the internal timeline only when their case read grant covers that record. A public reply is visible to the reporter; an internal note never is. A reporter reply changes `waiting` or `resolved` back to `open`. A closed case accepts no reporter reply; staff may reopen it to `open`, or the reporter creates a new case.

Every write uses one actor-scoped operation ID. Staff updates compare the case version, accept only a valid state transition, and require a separate audit reason. A stale write changes nothing. A support case may link to domain records for diagnosis, but the link grants no extra permission and no support mutation edits attendance, queue, team, admission, integration evidence, review, score, or access state.

## 16. Rehearsal workspace

The release owner creates one run from the server-owned 62-scenario template. Creation stores the exact template version and copies each scenario's stable key, workstream, expected state, and recovery action into the run. Later code changes cannot rewrite a run already in progress.

The screen shows the run state, five outcome counts, every workstream assignment, a filtered scenario list, the selected scenario's expected and recovery text, and its append-only history. The workstreams are sign-in/access, intake/admissions, communications, attendance, hall operations, reviewer app, review operations, integrations, reliability, Synesthesia, and support.

`rehearsal.read`, `rehearsal.manage`, `rehearsal.execute`, and `rehearsal.complete` are independent. Each accepts an exact `rehearsal_run` grant or an explicit event-wide grant. Management creates a run, assigns owners, starts it, or cancels it. Execute records scenario outcomes. Complete performs final sign-off. Read alone exposes no command.

Every workstream must have an active event account before a draft can start, and only one run may be active for the event. Ownership is routing metadata. It does not create a permission grant and does not let an otherwise ungranted owner read or update the run. Starting and canceling require management authority, a current run version, an operation ID, an audit reason, and a current scoped authorization.

A scenario can move from pending to running or directly to passed, failed, or blocked. A running scenario can finish as passed, failed, or blocked. A terminal outcome cannot be overwritten: the operator records a reasoned rerun, which moves it back to running before another outcome. Every outcome compares the scenario version and writes the new state, result, append-only action, operation result, and audit event in one transaction.

Final sign-off uses the separate `rehearsal.complete` permission and a recent Google session. The transaction reads every scenario and accepts only an active current-version run with all 62 in `passed`. This read set makes a concurrent rerun or outcome change conflict with sign-off. The completed summary, signer, time, and run version remain immutable.

## 17. Protected command rules

| Command | Required permission | Extra check |
| --- | --- | --- |
| Create or revoke event invitation | `access.subjects.invite` | exact event/email, five-minute-to-30-day claim window, current scoped authorization, current invitation version, and reason |
| Claim event invitation | matching verified Google identity; no permission grant | exact event/email, pending state, current version, server-time expiry; creates/reuses one active subject and grants no role/access |
| Suspend event access subject | `access.subjects.suspend` | exact target person (or explicit event scope), current access version, effective-grant impact, current scoped authorization, reason, and no self-suspension |
| Reactivate event access subject | `access.subjects.reactivate` | independently granted exact target person (or event scope), suspended state, current access version, current scoped authorization, and reason; grant rows are untouched |
| Assign, replace, or clear a role | `access.roles.assign` plus grant/revoke authority for every affected role-template permission | exact target person (or explicit event scope), current access version, fresh current authorization, and reason; changes only source-attributed role-template grants |
| Create own support case | self-scoped `support.case.create` | exact event subject, validated optional self-owned review/attendance context, 10–2,000-character description, and idempotent operation ID |
| Read/reply to own support case | self-scoped `support.case.read` / `support.case.reply` | reporter must be current person; internal actions remain hidden; closed cases reject replies |
| Read support desk | `support.case.read` | exact support case or explicit event scope; bounded indexed list and append-only timeline only |
| Log a walk-up support case | event-scoped `support.case.create` | every linked context record is loaded and checked against the event; linking grants no read authority |
| Update support case | `support.case.manage` | exact support case or explicit event scope, current version, valid transition, active event owner if changed, idempotent operation ID, and audit reason |
| Create rehearsal run | event-scoped `rehearsal.manage` | server-owned current 62-scenario template, optional future schedule, idempotent operation ID, and audit reason |
| Assign rehearsal workstream owner | `rehearsal.manage` | exact run or event scope, current draft/active run version, active event account, known template workstream, idempotent operation ID, and reason; assignment grants no access |
| Start or cancel rehearsal | `rehearsal.manage` | exact run or event scope, current run version, current scoped authorization, idempotent operation ID, and reason; start also requires every workstream owner active and no other active run |
| Record rehearsal scenario outcome | `rehearsal.execute` | exact run or event scope, active run, current scenario version, valid transition, result/rerun note where required, and idempotent operation ID |
| Sign off rehearsal | `rehearsal.complete` | exact active run or event scope, current run version, all 62 scenarios passed, current scoped authorization, completion summary, and idempotent operation ID |
| Read roster | `access.roster.read` | exact pending/history row or event scope; event-wide results are paginated and contain no raw Google subject, auth user ID, or grant contents |
| Import roster | event-scoped `access.roster.import` plus exact readable/applicable selected bundles | exact CSV/event, no more than 200 rows/eight bundles, event-bounded validity, current published compatible versions, unchanged/claimed preservation, matching preview checksum, current authorization, idempotency key, and importer reason |
| Claim roster row | matching verified Google identity; no pre-existing permission grant | exact active-validity event/email/version row and pinned bundle checksums; atomically links identity, role, role-template grants when applicable, bundle grant batches, and claimed row |
| Revoke pending roster row | `access.roster.revoke` | exact row or event scope, pending state/version, unexpired window, current authorization, idempotency key, and reason; claimed rows use separate account/role/grant controls |
| Publish permission bundle | `access.permission_bundles.read` + `access.permission_bundles.publish` | exact bundle/event scope; optimistic draft revision, catalog validation, diff, current authorization, and reason |
| Apply permission bundle | `access.permissions.read` + exact-bundle and exact-person `access.permission_bundles.apply` + bundle read | separately resolved bundle and target scopes; current target access version, resource bindings/expiry, atomic-grant preview, current authorization, and reason |
| Migrate bundle-sourced grants | exact-bundle `access.permission_bundles.read` + exact-bundle and exact-person `access.permission_bundles.migrate` + exact-person `access.permissions.read` | one retired source version and one-to-five exact completed application batches; current published destination, explicit bindings, source expiry clamped to event end, full source/destination diff, preserved revocation exceptions, target access versions, preview checksum, current authorization, idempotency key, and reason; all selected targets commit or none do |
| Grant one permission | `access.permissions.grant_any` or matching `access.permissions.grant_scoped` | exact target, catalog key, resource scope, constraints, validity, preview, current authorization, and reason |
| Revoke permission grant(s) | `access.permissions.revoke_any` or matching `access.permissions.revoke_scoped` | exact target/grant scope, source impact, access version, current authorization, and reason |
| Submit an application | `application.submit` | exact team only; current lead, accepted current participant policy, complete current roster profiles, current draft/team versions, explicit final confirmation, and stable operation ID |
| Revise a submitted proposal | `application.submit` | exact team only; current lead, server time before the applicable class deadline, current application/proposal versions, stale-output invalidation, and stable operation ID |
| Publish application decision | `application.decide` | exact application or explicit event scope; current proposal version, admission policy, human review coverage, explicit outcome/reason, and AI used/cleared/overridden/unavailable disposition; this does not reserve capacity |
| Send or revoke team offer | `application.offer.manage` | exact application or explicit event scope; accepted application, deadline-frozen roster, current versions, approved future deadline, current authorization, overall capacity, stable operation ID; revocation also requires a reason |
| Confirm or decline team offer | `application.offer.respond` | exact team only; current lead, current application/offer versions, stable operation ID, server-owned deadline; confirmation preserves capacity and decline releases it |
| Retry failed or stale AI admission analysis | `application.ai_recommendation.run` | exact application or explicit event scope; active human-review state, current terminal failed/stale recommendation, expected application version and recommendation ID, reason, stable operation ID, immutable prior record, and no decision side effect |
| Correct team membership after the deadline | `admissions.application.correct_locked_snapshot` | application/team scope; deadline-frozen snapshot, impact preview, current authorization, reason, stale-output invalidation, and return to review |
| Read selected-team communications policy | `configuration.communications.read` | exact event; published version, current draft, checksum, and independent capability flags; no participant or delivery rows |
| Create or replace selected-team communications draft | `configuration.communications.draft.create` | exact event; complete normalized venue/date/next-step/Discord/email policy, current event and draft versions, idempotent operation ID, and reason |
| Validate selected-team communications draft | `configuration.communications.validate` | exact event and current draft; checksum and participant-visible diff only |
| Publish selected-team communications policy | `configuration.communications.publish` | exact event/draft/checksum/event version; operational-window match, current authorization, idempotent operation ID, and reason |
| Create or replace novelty-corpus draft | `configuration.novelty.draft.create` | exact event; current event version, current draft ID or absence, validated policy, idempotent operation ID, and reason; any prior draft is retired |
| Replace novelty-corpus entries | `configuration.novelty.entries.write` | exact event/draft/revision; complete privacy-reviewed `5–300` entry set, one active import operation, native 1,536-dimension embeddings, idempotent operation ID, and reason; all entries settle atomically |
| Publish novelty corpus | `configuration.novelty.publish` | exact event/draft/revision/checksum and current event version; ready import, recomputed projection checksum, idempotent operation ID, and reason |
| Retry participant decision email | `communications.delivery.manage` | exact recipient; latest append-only attempt must be definitively `failed`, delivery/destination/application versions and verified email must still match, current scoped authorization, idempotent operation ID, and reason; `unknown` is never retried blindly |
| Disable participant verified-email destination | `communications.delivery.manage` | exact recipient; active destination and current version, current scoped authorization, idempotent operation ID, and reason; queued attempts become suppressed while an in-flight provider request is not misreported as canceled |
| Add or update catalog track | `synesthesia.catalog.manage` | exact event; normalized provider/track metadata, 500-track event bound, current version for update, idempotent operation ID, and reason |
| Create or edit ambience window | `synesthesia.window.manage` | event scope for create or exact window for edit; draft state, current version, valid time/limits/content policy, 64-window event bound, idempotent operation ID, and reason |
| Publish ambience window | `synesthesia.window.publish` | exact window or event; current draft version, future end, event schedule when configured, no published overlap, idempotent operation ID, and reason |
| Pause/resume or close ambience window | `synesthesia.playback.pause` or `synesthesia.window.manage` | exact published window, current version, no playing request for pause/close, idempotent operation ID, and reason |
| Moderate song request | `synesthesia.request.moderate` | exact request; current version and valid state transition; participant-facing reason for reject/hide; idempotent operation ID and audit reason |
| Schedule song request | `synesthesia.queue.schedule` | exact approved/queued request, current version, published parent window, valid future in-window deferral, idempotent operation ID, and reason |
| Acknowledge playback | `synesthesia.playback.acknowledge` | exact request; current version, published active/unpaused parent window, no other playing request, valid transition, idempotent operation ID, and reason |
| Resolve song-request report | `synesthesia.report.resolve` | exact request/report; open report and current version, public resolution, optional internal resolution, idempotent operation ID, and reason |
| Suspend or restore participant music access | `synesthesia.access.suspend` or `synesthesia.access.restore` | exact requester person, current music-access version, idempotent operation ID, and reason; event access/grants remain untouched |
| Publish intake or model configuration | `configuration.publish` | configuration/event scope; validation/evaluation pass, current authorization, diff, and reason |
| Migrate active intake sessions | `configuration.active_session.migrate` | configuration/event scope; dry-run mapping, affected-session list, current authorization, and reason |
| Publish attendance plan | `attendance.plan.publish` | event scope; validation, impact preview, current authorization, and reason |
| Open/extend/close/cancel attendance session | `attendance.session.manage` | exact attendance-session scope; current version and consequence preview |
| Reconfigure active scan station | `attendance.station.manage` | exact station scope; registered device, affected queue, and reason |
| Read venue check-in | `attendance.venue_check_in.read` | exact person for one participant, or explicit event scope for the aggregate/list workspace; credential values and reversal reason remain absent from the ordinary view |
| Record venue check-in | `attendance.venue_check_in.record` | exact person or explicit event scope, plus assigned current-plan `venue_entry` station read; fresh portal QR, confirmed team/member, visible class-appropriate ID match, and idempotent operation ID; creates no presence/session fact |
| Use venue identity exception | `attendance.venue_check_in.override_identity` | independent exact person or explicit event scope, assigned venue-entry station, fresh portal QR and Google session, visible participant confirmation, reason, and idempotent operation ID |
| Reverse venue check-in | `attendance.venue_check_in.reverse` | independent exact person or explicit event scope, assigned venue-entry station, active check-in/current version, current scoped authorization, reason, and idempotent operation ID; preserves history and changes no presence/session fact |
| Enrol VIT ID barcode | `attendance.credential.enrol` | event/station scope; VIT membership, visible card/account match, uniqueness, and repeat scan |
| Suspend VIT ID barcode | `attendance.credential.suspend` | exact person or explicit event scope, plus an assigned current-plan station with `attendance.station.read`; active credential/version, fresh portal QR and Google session, visible identity match, and reason; unfinished replacement is canceled atomically |
| Rebind VIT ID barcode | `attendance.credential.rebind` | exact person or explicit event scope, plus an assigned current-plan station with `attendance.station.read`; current binding/version, current scoped authorization, visible identity match, reason, and two matching scans before one atomic replacement |
| Issue external QR badge | `attendance.badge.issue` | exact person or explicit event scope, plus an assigned current-plan station with `attendance.station.read`; accepted external membership, fresh portal QR, current scoped authorization, visible identity match, unused printed badge, printed-reference check, and two matching scans |
| Replace external QR badge | `attendance.badge.replace` | exact person or explicit event scope, plus an assigned current-plan station with `attendance.station.read`; active credential/version, fresh portal QR and Google session, visible identity match, reason, unused printed badge, and an atomic old-active/new-active swap after two matching scans |
| Revoke external QR badge | `attendance.badge.revoke` | exact person or explicit event scope, plus an assigned current-plan station with `attendance.station.read`; active credential/version, fresh portal QR and Google session, visible identity match, and reason; unfinished replacement is canceled in the same transaction |
| Reconcile participant presence | `attendance.presence.reconcile` | exact attendance-session scope and target membership; open session, current session/participant versions, 15-minute sign-in, linked source event or projection version, preview, and reason |
| Open finalized attendance-result review | `attendance.remedy.open` | exact attendance-session scope and target membership; closed and fully finalized session, no open case, frozen session/result versions, 15-minute sign-in, idempotent operation ID, and participant-safe description |
| Decide finalized attendance-result review | `attendance.remedy.decide` | independently granted exact attendance-session scope; open case, unchanged frozen session/result/evidence snapshot, valid replacement facts or explicit decline, 15-minute sign-in, idempotent operation ID, internal reason, and participant-facing note |
| Start emergency roll call | `attendance.roll_call.start` | exact prepared attendance-session scope; ready/open/closing session, complete frozen cohort, no active roll call for its zone, 15-minute sign-in, incident/drill name, reason, current session version, atomic snapshot/checksum, and idempotent operation ID |
| Close emergency roll call | `attendance.roll_call.close` | independently granted exact attendance-session scope; active roll-call version, consistent expected/sharded counts, 15-minute sign-in, reason, and idempotent operation ID |
| Export identifiable attendance | `attendance.export.identifiable` | exact prepared attendance-session scope or explicit event-wide grant; current session version, one atomic cohort snapshot of at most 1,200 rows, selected allowlisted fields, 15-minute sign-in, purpose, 15-minute-to-seven-day expiry, idempotent operation ID, private S3 manifest, and audited signed download bounded to the earlier of 60 seconds or export expiry |
| Prepare emergency pack | event-scoped `emergency_pack.prepare` | 15-minute sign-in, purpose of 10–240 characters, zero-to-20 spare attendance sheets, zero-to-20 spare review sheets, stable operation ID, four-hour pack expiry, and one collision-checked serial prefix |
| Read emergency-pack history | event-scoped `emergency_pack.read` | returns at most the ten newest records with requester, purpose, state, expiry, counts, and checksums; no roster rows, storage coordinates, or print URL |
| Open printable emergency pack | event-scoped `emergency_pack.print` | ready and unexpired record, 15-minute sign-in, exact pack/object version and checksums, audited access, and an inline signed URL lasting no more than 60 seconds and never beyond pack expiry |
| Create attendance- or review-backend incident | `incident.create` | event scope; explicit affected service, 15-minute sign-in, severity, bounded title/summary, and idempotent operation ID |
| Approve paper mode | `incident.manual_mode.approve` | exact incident scope or explicit event-wide grant; current incident version, 15-minute sign-in, reason, idempotent operation ID, and a second distinct approver before activation |
| Pause new review calls and starts | `review.round.pause` plus readable active incident | exact open round, active review-backend incident, current round version, 15-minute sign-in, reason, and idempotent operation ID; queue positions and active reviews remain usable |
| Resume new review calls and starts | `review.round.resume` | exact round, current active-pause and round versions, open round, 15-minute sign-in, reason, and idempotent operation ID |
| Enter and submit numbered attendance sheet | `attendance.manual_sheet.enter` | exact open attendance-session scope; approved incident, compatible session station/configuration, unique serial revision, 1–25 frozen-cohort rows, 15-minute sign-in, and one private JPEG source manifest under 900 KB |
| Read protected paper source | `attendance.manual_sheet.source.read` | exact attendance-session scope; returns authorized bytes for the immutable source, never a reusable public URL |
| Verify or reject attendance sheet | `attendance.manual_sheet.verify` plus `attendance.manual_sheet.source.read` | exact attendance-session scope; person different from entrant, submitted source checksum, unchanged open session/sheet versions, 15-minute sign-in, reason, original-paper filing attestation for import, and idempotent operation ID |
| Resolve attendance-backend incident | `incident.resolve` | exact incident scope or explicit event-wide grant; current version, 15-minute sign-in, reason, no linked draft/submitted sheet, and no active linked round pause |
| Read paper review record | `review.manual_record.read` | exact review scope or explicit event-wide grant; exposes copied ratings, notes, provenance, and record state but not source bytes |
| Enter and submit signed paper review | `review.manual_record.enter` | exact already-active review scope or explicit event-wide grant; approved review-backend incident, unchanged round/review/panel/rubric/evidence/scorecard versions, complete signed panel ratings and required shared notes, 15-minute sign-in, unique serial revision, and one private JPEG under 900 KB |
| Read signed review source | `review.manual_record.source.read` | exact review scope or explicit event-wide grant; returns authorized bytes for the immutable source, never a public file URL |
| Verify/import or reject paper review | `review.manual_record.verify` plus `review.manual_record.source.read` | exact review scope or explicit event-wide grants; different person from entrant, matching source manifest, unchanged pinned context, 15-minute sign-in, reason, original-paper filing attestation for import, and idempotent operation ID |
| Resolve review-backend incident | `incident.resolve` | exact incident scope or explicit event-wide grant; current version, 15-minute sign-in, reason, no linked draft/submitted paper review, and no active linked round pause |
| Change table after freeze | `venue.table.move_after_freeze` | team/round scope; reason |
| Move queued team | `review.queue.move` | team/round/panel scope; reason and current queue version |
| Assign substitute manually | `review.substitute.assign` | panel/round scope; eligibility and conflict check |
| Waive participant availability | `review.participant_availability.waive` | exact team before call or exact pending review after call, or explicit event scope; live observed/required counts, current queue/review version, 15-minute sign-in, reason, immutable exception, and idempotent operation ID |
| Waive judge presence | `review.presence.waive` | review scope; fresh sign-in and reason |
| Extend beyond ordinary allowance | `review.timer.extend_exception` | review scope; fresh sign-in and reason |
| Open score correction | `scorecard.correction.open` | scorecard/review scope; correction window and reason |
| Void scorecard | `scorecard.void` | scorecard/review scope; evidence and replacement decision |
| Start round close/export | `round.close` | exact round scope; current open version, fresh sign-in, reason, one explicit result/exclusion/withdrawal per team, and no active pause, live review, pending paper record, or correction |
| Read/download round export | `round.export.read` | exact round scope; fresh sign-in for each 60-second signed download; final export-version, object-version, manifest, checksum, and expiry recheck; audited file access |
| Retry failed round export | `round.export.retry` | exact round scope; current failed export and closing-round versions, fresh sign-in, and reason |
| Verify export and close round | `round.export.verify` plus `round.export.read` | exact round scope; person different from starter, current uploaded export/round versions, both-file and count attestations, fresh sign-in, reason, and exact S3 version/checksum verification |
| Reopen closed round | `round.reopen` | exact round scope; current verified export/round versions, no participant release or later active round, fresh sign-in, and reason; verified files are superseded, not deleted |

High-impact commands show the current value, proposed value, affected records, and reason before submission.

## 18. Live updates and conflicts

Dashboard panels subscribe to small, indexed Convex queries. Attendance rows subscribe to individual projections and sharded counts rather than the raw scan ledger. Offer confirmation creates one team-availability row from the deadline-frozen roster. A venue scan updates that row with the participant, zone, and active roll-call projections in the same accepted mutation, so the review board reads one indexed count per team rather than every member record. A panel row updates when its reviewer, queue, page, review, or exception records change.

The client may show an action as pending. It shows accepted only after the mutation returns.

Commands that can collide include a current record version. If another operator changed the target first, the server rejects the stale command and returns the new state. The UI asks the operator to review it rather than replaying the old action. Simultaneous VIT ID and portal-QR scans for one participant return one accepted transition and one duplicate result.

High-impact commands also carry a client operation ID. Repeating the same request after a timeout returns the first accepted result.

## 19. Incident mode

A named incident commander is an assignment, not a role boundary. Any event-linked person may receive event- or incident-scoped `incident.read`, `incident.create`, `incident.manual_mode.approve`, and `incident.resolve`, plus exact-round `review.round.pause` or `review.round.resume`. The role string never substitutes for those grants; a role-template grant, when present, is checked like any other source.

The operations shell subscribes to active incidents and renders only incidents covered by the caller’s current `incident.read` grants. Each visible entry contains:

- title and affected service;
- severity;
- internal summary;
- time opened;
- manual-mode state.

The live round board can bind one open review round to one active review-backend incident. The pause blocks new team calls, new review starts, incident resolution, and round close. It leaves queue placement, reviewer presence, active drafts, score submission, and completion available. Participant and reviewer clients receive only a generic pause bit; the incident text remains behind `incident.read`. Attendance incident mode can disable a station, redirect traffic, begin a roll call, and mark offline scans for later reconciliation. The attendance recovery panel collects two approvals, enters and uploads numbered sheets, protects the source, and records the second person’s import or rejection.

The live round workspace handles an already-started review in the same incident model. It copies the whole signed panel sheet, freezes ordinary scorecard writes, protects the source behind a separate permission, and lets a different person import or reject it. Import creates the reviewer-attributed scorecard versions, evaluation, completed review, and completed team state together. Pending paper records block incident resolution and round close.

The dedicated emergency-pack workspace creates one fixed print document before a drill or when incident readiness needs a fresh copy. Preparation reads one consistent backend snapshot. The snapshot contains:

- the accepted participant roster;
- permitted phone and VIT reference fields;
- each participant's active team and recorded hall location;
- the last accepted venue state;
- the full published station list;
- every `ready | open | closing` attendance session; and
- every `published | open | closing` review round with its rubric and panel/table plan.

The workspace rejects a roster above 1,200 participants. It also rejects more than 400 represented teams, more than 100 stations, more than ten current rounds, or more than 400 current panels. It does not silently truncate the pack.

Generation runs in the bounded export worker. The self-contained print-first HTML and its source snapshot each receive a SHA-256 checksum. The HTML is written to private KMS-encrypted, versioned S3, read back by exact object version, and becomes `ready` only when byte count and digest match. The record expires four hours after request. Its history projection exposes counts and checksums but never participant rows or storage coordinates.

Each pack uses collision-checked serials of the form `C2C7-<16 hex>-A-001` or `C2C7-<16 hex>-R-001`. It contains one prefilled attendance sheet for every active station assigned to a current attendance session. It contains one prefilled review sheet for every non-closed panel in a current round. It also contains the requested spare sheets and at least one blank sheet of each kind. The cover states the purpose, snapshot time, expiry, checksum, and chain-of-custody fields. Every print open requires its own current authorization and `emergency_pack.print` check. The system writes an audit event before the browser receives the short-lived document.

Preparing or printing this pack never opens an incident, pauses a round, or approves paper mode. Staff use a numbered original only after the existing two-person incident approval, then reconcile it through the ordinary attendance-sheet or paper-review entry and independent verification paths. Photocopies and serial reuse are not valid recovery records.

Manual incident records are reconciled after recovery under the reliability procedure.

## 20. Privacy

- Floor views use preferred names and event identifiers, not eligibility documents.
- Phone numbers appear only to support/operations users who need to contact the person.
- Participant registration numbers do not appear on panel boards.
- Attendance views contain boundary events only; they do not show GPS, Bluetooth, Wi-Fi, or background location.
- An ordinary temporary exit stores no reason. Sensitive attendance exceptions stay in restricted support records.
- Team leads receive a regrouping summary, not another member’s movement timeline.
- Exact presence history requires `attendance.history.read` at the relevant person/session scope; identifiable exports require a separate export grant and purpose.
- Attendance events never appear in project evidence, reviewer context, score calculations, or engagement leaderboards.
- Score values require `score.values.read` at the relevant round/review scope.
- Raw provider tokens and session details never appear in the dashboard.
- Identifiable attendance exports are requester-owned, purpose-labeled, time-limited, and logged at request and download. A download rechecks the exact grant, requester, current scoped authorization, export version, checksum, and expiry immediately before returning an S3 URL bounded to the earlier of 60 seconds or export expiry.
- Emergency packs deliberately contain a restricted accepted-participant contact/presence roster. Their metadata view omits those rows and every storage coordinate; preparation and print require separate event grants, recent Google authentication, purpose, expiry, exact-version/checksum checks, and audit.

## 21. Acceptance checks

- Two dashboards receive the same panel/queue change without refresh.
- VIT ID barcode and QR scans update two attendance dashboards, the participant portal, and the relevant team/zone summary without refresh.
- A duplicate or simultaneous scan creates one presence transition and stable counters.
- Extension, close, and cancellation race on the current session version; an extension cannot be retroactive, a late close is capped at the accepted end, and cancellation produces no absence while preserving scan history.
- A session with 1,000 expected people opens/closes through resumable indexed batches and never claims completion from a partial job.
- A live attendance correction cannot edit or delete the original event; it fails after close begins or without current versions, exact-session authority, a 15-minute session, linked evidence, and a reason.
- An emergency roll call keeps its opening snapshot while displaying later live changes.
- An identifiable attendance export takes one logical snapshot while scans continue, contains only its selected allowlisted columns, neutralizes spreadsheet formulas, and rejects a download after expiry, permission revocation, version/checksum change, or stale Google authentication.
- Emergency-pack preparation excludes unaccepted applicants, freezes one bounded logical snapshot, and exposes no roster row or private-storage coordinate through its history query.
- Repeating one emergency-pack operation ID returns the first pack. Concurrent requests cannot claim the same serial prefix, and every generated attendance/review serial is accepted by its corresponding manual-import validator.
- Prepare, read, and print grants fail independently. An expired pack, revoked print grant, stale authentication, changed version, or checksum mismatch cannot mint a new print URL.
- Opening a print document is audited and does not activate manual mode; importing any used original still requires the matching approved incident and a different verifier.
- A person with floor-summary or scan permission cannot read detailed attendance history or export attendance without the separate scoped grants.
- Event-health read, brief read, and brief generation remain three independent permissions. A generator without brief read receives only the request receipt, and a brief reader gains no drill-down or corrective command.
- Overview renders at most three named priorities and no system-check or brief section. Its remaining-work link opens Event monitor, where the bounded priority queue and aggregate checks remain available.
- A repeated dispatch for one brief creates one durable agent instance; a late callback, retry, timeout, or competing callback produces one terminal stored result.
- Every displayed priority cites only its frozen aggregate signal keys and preserves their highest severity, one cited owner, and one cited next action. A changed checksum, uncited key, invented owner/action, or repeated signal is rejected.
- Autonomy-policy read, draft, validation, publication, and kill-switch commands fail independently. Two writers from the same observed draft state leave one current draft; publication supersedes policy/scheduler state atomically and aborts a claimed prior-policy run.
- Two evaluations of the same due scheduler version create one deterministic run. An unchanged signal stays suppressed, a cleared condition starts a new cycle, and a later return may create one new signal-triggered run.
- Cadence, the active-agent claim, policy/owner/event authority, operation receipts, and kill state are enforced from committed server state. They do not rely on a browser timer, Worker memory, or model response.
- Every provider boundary, read, recommendation, and callback has a stable operation ID and an authoritative effect receipt. Crash recovery, a lost response, an older operation replayed after a newer one, and a conflicting reuse never duplicate a proposal or silently skip work.
- Planner, investigator, and critic outputs reject unknown fields, duplicate or out-of-range references, unallowed reads/kinds, uncited claims, stale versions, prompt injection, invented identities or evidence, and incomplete-window claims.
- The intelligence Worker cannot call a participant, application, attendance, queue, review, score, incident, access, or Synesthesia mutation. Acting on a recommendation still requires the normal human confirmation and exact scoped command permission.
- The kill switch cancels the authoritative run/checkpoint and aborts the matching Durable Object/provider signal; a late read, proposal, or callback remains rejected.
- Every simulated intake path finishes when model output succeeds, times out, refuses, is invalid, or is disabled.
- Every published intake policy supplies two fixed questions, generates no more than two additional introduction questions, respects the separate bound for later phases, and rejects ungrounded, unsafe, or burdensome wording.
- Novelty configuration read, draft creation, entry replacement, and publication fail independently; no role label implies any of them.
- Corpus import rejects duplicate keys, unsafe/private text, discouraging or decision language, wrong vector width, stale revision, and a competing import. A provider failure changes no published pointer.
- Live novelty preview stores no second copy of participant text, reuses only the same team/corpus/input fingerprint, respects the published team rate, and cannot attach after the idea changes.
- No novelty number, nearest-project identity, or similarity value enters application review, admissions, queue routing, reviewer context, judging, exports, or awards.
- Final submission atomically validates the previewed roster and materializes the first immutable member snapshot before creating the application. A stale preview cannot start.
- Before the applicable class deadline, a valid team or proposal change creates a new immutable application snapshot and invalidates stale human and AI outputs in the same accepted transaction.
- At the applicable class deadline, the latest accepted team and proposal snapshot becomes final for admission and offer work.
- Publishing a new flow does not change an active session, and migration cannot run without an exact preview.
- Intake diagnostics expose operational counts and versions without participant/model text.
- `application.assign` for one application cannot route another application. A successful assignment creates only exact-application `application.review.read` and `application.review`; role, profile context, AI analysis, decision, offer, and judging access do not follow.
- Canceling a pending assignment revokes only its source grants, rejects stale application/assignment versions, and cannot race a review submission. Independent manual grants survive.
- `application.review.read` for one application cannot read another application or a peer recommendation before the caller submits a current-content review. Two simultaneous reviewers on unchanged content leave two completions rather than a lost increment.
- Round-board access alone exposes no admissions record ID or link. A team row links to its application only when `application.read` or `application.review.read` covers that exact application.
- Judging-setup access may list every published round, but it links into a live board only when `round.read` covers that exact round.
- Lifecycle blockers remain visible to a lifecycle reader, but each becomes a setup link only when that account can open the matching workspace. A blocker never links into a route that will reject or redirect the operator.
- Profile/year fields and band-specific policy guidance require `application.profile_context.read`; the AI record requires `application.ai_recommendation.read`. A decider without AI-read authority records it as unavailable to that decision instead of receiving hidden analysis.
- `application.ai_recommendation.run` does not reveal an AI result. It can replace only the current definite failed or stale analysis during active human review. The retry checks current IDs and versions, keeps the prior row, and is idempotent and audited.
- A published admission decision points to the reviewed project and admission-policy versions, human actor/reason, and whether a structured AI recommendation was used, cleared, overridden, or unavailable.
- Publishing that decision atomically creates one generic verified-email delivery per locked team member, while provider sending remains asynchronous and cannot roll back portal state.
- `communications.delivery.read` for one person exposes no other recipient. `communications.delivery.manage` without a matching read grant does not silently expand the delivery query, and neither permission follows from application access or role.
- A retry creates a new linked delivery only from the latest definitively failed attempt. Duplicate operations return that attempt; stale versions, disabled/changed email, superseded decisions, and `unknown` outcomes fail without another send.
- Duplicate and out-of-order Cloudflare Email lifecycle events converge without treating provider delivery as participant acknowledgment.
- AI failure cannot block a human admission decision, and no AI recommendation can publish, sort silently, or expose judging scores.
- Rehearsal ownership alone exposes no run. Read, manage, execute, and complete grants fail independently at exact-run and event scope.
- A draft cannot start with an unassigned or inactive workstream owner, and two active runs cannot coexist for one event.
- A terminal scenario outcome cannot be replaced without a reasoned rerun. Concurrent outcome writes accept one current scenario version, and an exact retry adds no duplicate history action.
- Final sign-off fails until all 62 scenarios pass and conflicts with a concurrent rerun or outcome change.
- A stale dashboard cannot overwrite a newer table or queue update.
- An operator without `incident.read` sees no incident title or summary in the shell or round board.
- A round pause and a concurrent call, start, close, resume, or linked-incident resolution cannot both cross the same version boundary.
- Pausing a round preserves queue positions and allows an already-active review to save, submit, and complete.
- Participant and reviewer surfaces show the pause without receiving the incident title, summary, or operator reason.
- Floor operations can see missing scorecards without seeing score values.
- A delivered push never appears as substitute acceptance.
- Round close lists exact blocking sessions, criteria, and corrections.
- Starting close freezes writes and shows export progress; it cannot display the round as closed before a different authorized person verifies both protected files.
- File read, retry, verify, and reopen controls each disappear and fail server-side when their own exact-round grant is absent.
- Reopen keeps the prior verified revision visible as superseded and cannot run after feedback release or a later round starts.
- An override permission fails outside its exact scope or without its required current authorization and reason.
- Synesthesia catalog read, window read/manage/publish, queue read, moderation, scheduling, playback, report read/resolve, and requester-access commands fail independently when their own grant is absent.
- Two operators cannot start different requests in the same window; a stale request/window/report/access version changes nothing.
- Queue read alone exposes no internal moderation note or report reason. Exact-request report read pages every open reason without loading report text into the live queue. Participant music suspension changes no event-account grant.
- A role label with no grants opens no protected dashboard route.
- Assigning, replacing, or clearing a templated role validates the complete grant/revoke ceiling, changes only that role row's source grants, and retains the ended role as history.
- An invite-only administrator can create and revoke exact-email invitations without reading the event account directory.
- If an invited email is already linked, the control says so without exposing an account ID or an inaccessible account link.
- Claiming an invitation exposes no operations route until a separate permission grant exists.
- An invitation claim racing revocation or expiry has one atomic winner; retries return the original result.
- Suspension blocks every protected call on the next server check while preserving the grant and role history; reactivation makes only still-active grants effective.
- A suspended account remains available through exact-email lookup for an authorized reactivator but is absent from the active directory.
- A manually granted permission works for any event-linked user regardless of role and exposes only its selected resource scope.
- Revoking that grant closes the route on the next server query/write even if the browser still displays a cached navigation item.
- Applying a convenience bundle displays and creates every underlying atomic grant; changing the bundle is not retroactive.
- Bundle publication and application use independent exact-resource grants. Losing access to the bundle or target between preview and confirmation fails the command; a concurrent target access change invalidates the preview checksum.
- Granting and revoking require separate permissions; holding either cannot perform the other operation.
- Grant authority does not unlock the underlying protected action.
- A scoped grant/revoke delegator cannot act outside its one permission key, resource-scope ceiling, target-person boundary, or expiry ceiling.
- Every after-freeze table move, manual queue priority, presence waiver, correction, and reopen appears in audit history.
- A disconnected or stale dashboard cannot submit commands.
- Participant, reviewer, and operations views agree on a team’s current integration snapshot and freshness.
- A manual provider retry is deduplicated, respects stored backoff, and cannot alter an active review’s evidence.
- No operations response or screen contains a GitHub installation token, Figma OAuth token, webhook secret, raw VIT ID barcode value/fingerprint, or raw QR credential.
