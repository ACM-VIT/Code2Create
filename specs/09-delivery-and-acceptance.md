# Delivery and acceptance

## 1. Build order

Build vertical event flows. Do not spend the first phase creating every table, role, and dashboard without a reviewer completing a real scorecard.

## 2. Slice 0: decisions and technical proof

Deliver:

- event configuration for team size, profile fields, final team/track lock, attendance sessions/cohorts/zones/methods, rounds, rubric, timer, correction windows, queue policy, track catalog, event phases, one-to-two-question intake policy/fallbacks, live novelty corpus/thresholds, year-adjusted admissions, and participant communications;
- pnpm workspace with the three web surfaces, reviewer app, Convex backend, update Worker, intelligence Worker, and focused shared packages;
- separate development, staging, and production projects;
- Better Auth running on Convex with Google only;
- web and Expo Google callback flows;
- proof that the server can read and validate Google `sub`, verified email, and `hd`;
- participant class and roster-claim prototypes;
- code-owned atomic permission catalog, role-default bundles, exact resource scopes, and a permission manager with separate per-user grant and revoke authority;
- one authorized Convex query and mutation from both clients;
- one authorized event-state read and change, with independent permissions and a visible readiness blocker;
- repeated scans of representative current VIT ID barcodes plus one QR scan from the signed Expo build on proposed staff phones;
- a native-1,536-dimension `text-embedding-3-small`/Convex-vector-search spike plus separate OpenAI Responses/Structured Outputs spikes for intake and admission analysis, all with complete no-model human paths;
- release IDs and basic error reporting.

Exit when:

- VIT and personal Google test accounts produce the expected participant classes;
- a rostered External Judge signs in on a real device;
- an unrostered account receives no reviewer data;
- a role label with no grants receives no protected data;
- one participant or JC receives a single manually granted permission outside the role default, uses it only for the named resource/time window, and loses it on immediate revocation;
- one explicitly invited role-less account receives exactly one permission, while the same authenticated account before event linking receives no event data;
- grant-only authority cannot revoke, revoke-only authority cannot grant, and both are event-scoped;
- a scoped delegator cannot grant or revoke beyond its one permission key, resource scope, target-person boundary, or expiry ceiling;
- a bundle reader cannot edit or apply it, a bundle publisher cannot apply it without separate bundle-and-target authority, and an applier cannot target a different person or substitute a foreign resource binding;
- publishing creates an immutable current version without changing existing people, while one confirmed application atomically materializes every source-attributed grant against the previewed target access version;
- a migration operator can select at most five exact applications from one retired version, resolve any destination bindings, review every add/replace/remove/preserved-exception action, and move all selected people to the current published version atomically without touching manual or other bundle sources;
- revoking an old or already-applied destination-version grant keeps that permission off through migration, while a matching independent grant continues to authorize normally;
- person lookup, grant inspection, role assignment, roster import, bundle publication/application/migration, grant, and revoke controls each disappear and fail server-side when their own permission is absent;
- a scoped permission revoked in the dashboard fails on the person’s next protected read/write while unrelated grants remain usable;
- a future roster grant remains scheduled before its start, activates at server time, expires without relying on a client, and refreshes the person’s access version at each materialized transition;
- revocation racing an activation job or repair sweep always leaves the grant revoked, and a source teardown also revokes future grants from that source;
- a multi-row panel assignment advances the reviewer’s access version once, while an exact source retry creates no row and advances no version;
- the same accepted mutation appears on web and mobile;
- two operators who try the same event-state version produce one winner, while an exact retry returns the first result;
- closing applications immediately rejects new profile, team, intake, track, and submission writes, preserves saved work, and allows a committed operation retry; reopening restores only work that was not locked by final submission;
- a saved answer survives OpenAI timeout, refusal, or invalid output and still reaches a submittable brief through configured prompts;
- a debounced novelty preview returns only for the newest text, and a missing provider, stale result, sensitive input, or vector-search failure leaves the same idea save/submission path usable.

If the Google hosted-domain claim cannot be captured through the selected Better Auth flow, stop and fix the auth design before participant registration work.

Current milestone:

- A fresh deployment now has an authenticated first-run path instead of an event-not-found dashboard failure. Only the configured initial owner can create the event. One mutation creates a coherent draft baseline and the owner's exact grants; applications remain closed.
- Event state has independent read/manage grants and one explicit setup, application, live-event, and completion path.
- Opening and starting expose concrete configuration blockers; completion refuses active attendance or judging work.
- Lifecycle changes are fresh-authenticated, optimistic, idempotent, audited, and realtime.
- Closing applications blocks new unlocked participant profile, team, intake, track, and final-submission writes without breaking replay of a command that already committed.
- Stable bundle identities, revision-checked drafts, immutable publication, and exact-bundle visibility are implemented.
- Server-resolved application previews and atomic exact-person application are implemented.
- Bounded atomic migration of old bundle-sourced grants is implemented.
- Previewed roster import and exact-email claim are implemented.
- Grant and revoke administration can be unrestricted or bounded by key, resource, target, and expiry.
- Scheduled grant activation and expiry are race-safe and use indexed repair.

## 3. Slice 1: participant registration

Deliver:

- class-aware participant profile with name, permitted contact, institution, and year/current role;
- live team create/join/invite/accepted-lead-transfer area available throughout onboarding;
- the exact **Hello.** then **What is your project about?** opening with one prompt and text box at a time;
- a small debounced live novelty counter over a versioned curated past-project corpus, with an approved nearest theme/reflection prompt and no application/admission/judging output;
- immediate complete track selection after the opening save, an optional single AI recommendation, required `fresh_for_event` attestation, five core-track positions, optional sponsor entries, and track/phase generation guidance;
- source-linked OpenAI interpretation with strict Structured Outputs and participant confirmation;
- a deterministic fallback for every intake branch;
- an explicit final team/track/project preview and atomic submit-and-lock command;
- immutable answer, brief, catalog, flow, intake/admission-model-schema, and submitted project versions;
- separately granted configuration validation/simulation, publication/rollback, and safe active-session pinning;
- a published welcoming year-adjusted admissions rubric, structured AI admission recommendation, application-review assignment, independent human recommendation, and human use/clear/override decision controls;
- shortlist, waitlist, offer, confirmation, and capacity state;
- accepted-team venue/date/next steps, locked summary, Discord handoff, and participant notification delivery;
- registration support codes;
- event configuration checks.

Exit when both a VIT participant and an external participant complete the correct profile. Each participant must be able to form a valid mixed or same-class team under the chosen policy. The team must be able to transfer leadership. The participant must receive a live novelty signal while describing a fresh project and see all tracks immediately. The participant must receive one or two short follow-ups. With OpenAI enabled or disabled, the participant must explicitly submit and lock the previewed team, track, and brief. The participant must receive a human-reviewed admission decision with or without valid AI analysis. The participant must be able to open the selected next steps and Discord, receive a status notification, and confirm an offer. After a refresh on another device, the participant must see the same server state. A novelty failure must not alter that outcome. A text change during a novelty request must not alter that outcome.

Current admissions-routing milestone:

- An exact-application assignment accepts one active event-account email.
- The assignment creates a separate routing row and only `application.review.read` and `application.review` source grants.
- The assignment appears in the assignee's active/completed realtime queue.
- A submitted current-content review completes the routing row and increments the application completion projection once.
- A replacement does not increment the projection again.
- Concurrent reviewers can both commit reviews of unchanged content.
- Reasoned cancellation uses optimistic versioning and revokes only assignment-sourced grants.
- Profile/year context and AI recommendation reads have separate exact-application or event keys.
- The review dossier redacts each context when its key is absent.

Current participant-policy milestone:

- One immutable published version owns the class-aware profile fields, team-size bounds, and mixed-class eligibility.
- The same version owns participant notices, the privacy link, the fixed fresh-project acknowledgment, and the final lock warning.
- Read, complete-draft replacement, validation, and publication use independent event grants.
- Publication is optimistic, idempotent, reasoned, audited, and fresh-authenticated.
- Publication atomically changes the event pointer.
- Publication edits no profile or submitted project.
- Open portals derive completeness against the current version.
- Create, join, and final submission recheck the version inside their transactions.
- Submission pins the exact policy ID.
- Focused tests cover permission separation, competing drafts, fixed acknowledgment text, mixed-team rules, publication, and explicit reacceptance.

Current admission-configuration milestone:

- One immutable release owns the year-adjusted criteria and five complete experience-band explanations.
- The release also owns the minimum human reviews, human decision-reason coverage, and overall participant capacity.
- The release specifies either an exact model release or explicit human-only mode.
- Four event grants independently control read, complete draft replacement, validation, and publication.
- Publication is optimistic, idempotent, reasoned, audited, and fresh-authenticated.
- Publication atomically swaps the policy and model pointers and creates the empty capacity bucket.
- The first application closes later draft and publication writes.
- Focused tests cover permission separation, incomplete bands and reasons, model bounds, competing drafts, atomic publication, human-only publication, frozen writes, and publication racing the first submission.

Current track-configuration milestone:

- Each project draft stores its immutable track-catalog version.
- Participant reads, core choice, sponsor opt-in, final preview, and submission use that pin.
- Both sides of an in-flight AI interpretation also use that pin.
- Sponsor selection is a canonical complete-set mutation with the exact draft version and an idempotent operation identity.
- Final confirmation includes the exact selected IDs.
- Submission freezes those IDs on the immutable project.
- Admission detail and active reviewer context show the selection as non-scoring context.
- The JSON round export preserves the exact track snapshots.
- Operations has a minimal track editor with independent read, draft, validation, and publication grants.
- The editor supports complete draft replacement, structural validation, and a participant-visible diff.
- The editor shows active pinned-draft counts and uses optimistic IDs, checksums, and versions.
- Writes are idempotent. Reasons are audited. Publication requires fresh authentication.
- Publishing changes only the event default for project drafts created afterward.
- Focused tests cover competing saves, stale publication, old-draft pinning, an AI completion that crosses publication, and sponsor-set validation and order.

Current novelty milestone:

- The participant text box debounces against a separately permissioned, immutable past-project corpus.
- The text box accepts only the newest result.
- The backend uses `text-embedding-3-small` without a dimensions override.
- The backend validates all 1,536 floats and searches a corpus-version-filtered Convex index.
- The request row does not store a second copy of the idea.
- The backend attaches a signal only while the saved input, corpus, and team remain current and unlocked.
- Corpus read, draft, entry replacement, and publication use four independent event grants.
- Import validates the complete set and commits every vector atomically.
- Publication checks the exact revision, checksum, event version, and fresh session.
- Focused tests cover policy and corpus safety, native width, score bands, concurrent duplicate requests, idempotent replay, sensitive-input suppression, stale attachment, exact-team permission, team rate limits, transactional corpus import, and completed-operation replay.

Current event-phase milestone:

- The fixed introduction, ideation, build, intermediate-update, and final-update keys have one complete versioned schedule.
- Read, draft, validation, and publication use independent grants.
- The operations editor uses the event timezone.
- The editor validates exact membership and order, durations, span, and overlap.
- Publication is optimistic, idempotent, reasoned, audited, fresh-authenticated, and checked against server time.
- Publication cannot rewrite a completed phase.
- Publication cannot rewrite the identity, wording, start, or order of a phase that is already underway.
- The participant portal receives the published rows in realtime.
- The portal shows only the current or next phase.
- Focused tests cover incomplete or overlapping input, competing saves, replaced-draft publication, completed-history protection, and a valid active-end/future-window revision.

Current project-checkpoint milestone:

- Operations publishes one immutable three-row plan for ideation, intermediate, and final updates.
- Four independent configuration grants control the plan.
- Timing comes from the current published phase schedule.
- Each row has a bounded grace period.
- Confirmed teams use a realtime shared draft with optimistic versions and idempotent commands.
- Teams answer two short prompts, review the answers, and explicitly submit one immutable snapshot.
- Any active member may submit and prevent a lead-availability bottleneck.
- The system retains every actor.
- Submission never changes the queue or review state.
- Event-wide or exact-team `project.checkpoint.read` exposes progress independently from participant write authority.
- Starting a review freezes the latest submitted team checkpoint beside provider evidence.
- The reviewer query and verified JSON export follow that exact relation.
- Focused tests cover plan completeness and phase semantics, grace boundaries, permission scopes, missing-schedule publication, competing drafts, and old-plan pinning.
- Adaptive generated later-phase questions, simulation, explicit session migration, rollback, sponsor evidence verification, sponsor capacity, and award policy remain open work.

Current admissions milestone:

- The final project transaction pins the event's frozen admission release.
- Organizer **Needs information** creates one or two version-pinned questions.
- An exact-team current-lead response appends a cumulative immutable project/content version.
- The response supersedes old reviews, rebinds active assignments, and starts fresh optional AI analysis.
- The response does not unlock the roster or tracks.
- Exact-application offer send and revoke are implemented.
- Exact-team locked-lead confirm and decline are also implemented.
- Sending reserves the immutable roster against overall and optional track capacity.
- Confirmation is the only transition that unlocks attendance, hall mapping, and review queues.
- Decline, expiry, and revocation release capacity once.
- Scheduled expiry is version-safe.
- Participant and operations views react to the same records.
- Focused state-machine tests cover stale or duplicate response, non-lead denial, replaced requests, late AI completion, review and assignment rebinding, and offer race boundaries.
- Waitlist promotion remains blocked on the published O-023 ordering policy. The system does not invent an order.

Current accepted-team communications milestone:

- One immutable `communicationsPolicyVersions` release owns the venue, address, map, and operational date snapshot.
- The release also owns the ordered next steps, official Discord invite, and generic Cloudflare Email subject and introduction.
- Read, complete-draft replacement, validation, and publication use four independent event grants.
- Publication is optimistic, idempotent, audited, reasoned, and fresh-authenticated.
- Publication atomically swaps the event pointer.
- An authenticated exact-team query returns the current publication only for accepted, offer-stage, or confirmed teams.
- The public event response contains none of these fields.
- Each notification attempt pins its rendering policy.
- A manual retry preserves that pin.
- Cloudflare Email Sending owns outbound transport.
- An event-scoped Queue and event Worker own lifecycle delivery.
- Cloudflare Email Routing owns the approved inbound support alias.
- Focused tests cover policy safety, permission separation, competing drafts, eligible projection changes, queued-email stability across publication, ambiguous-send termination, expired-lease termination, signed event convergence, and hard-versus-soft bounce handling.
- Production sender/domain verification, final copy, reply-to and routing aliases, forwarding destination, retention and redaction, and support handling remain blocked on O-034 approval. They must not appear as unenforced configuration.

## 4. Slice 2: venue and session attendance

Use at least 30 synthetic participants, three scanner devices, two zones, and two consecutive hacking sessions before scaling the rehearsal.

Deliver:

- published attendance-plan version and frozen per-session expectation sets;
- staffed VIT ID barcode enrollment/repeat-scan verification, plus bounded anonymous external-badge generation and two-scan issue;
- online staffed arrival from a fresh participant QR, class-appropriate ID check, independently authorized no-ID exception and versioned reversal, with a separate sharded count;
- participant portal current state, next session, recent scans, and short-lived dynamic QR;
- provisioned station modes for entry, exit, session confirmation, and roving table sweep;
- exact-station operations controls that atomically revoke a phone and its assignment grants, then make the checked station available only for fresh provisioning;
- one server scanner command for enrolled VIT ID barcodes, external-badge QR, and portal QR, plus a separately authorized staff reconciliation command for a missing or incorrect transition;
- append-only scan outcomes, presence intervals, current projection, sharded counts, and team availability;
- repeated temporary exit/return;
- VIT ID barcode suspension/rebinding, external-badge revocation/replacement, and anti-passback handling;
- encrypted bounded pending queue with explicit pending/replay results;
- attendance operations board, credential support, correction, and emergency roll call;
- atomic roll-call starting snapshot/checksum, one-active-per-zone rule, sharded live counts updated by ordinary venue scans, paginated expected-cohort roster, and frozen close result;
- participant self-service finalized-result history/request and exact-session staff open/decide remedy controls;
- resumable expectation-build and closing/finalization batches for event-scale cohorts;
- privacy/access controls and separate raw-event/aggregate retention.

Exit when all of these checks pass:

- Every synthetic participant completes staffed arrival.
- Every synthetic participant confirms two sessions through mixed enrolled-VIT-barcode and QR methods.
- An optional session overlaps one hacking block.
- Some participants stay in the venue across the boundary.
- Some participants leave and return more than once.
- One arrival is reversed and recorded again without changing presence or session facts.
- A generated external-badge batch survives print and read-back without exposing a bearer as text.
- One badge is issued.
- One badge is atomically replaced.
- One active badge and its unfinished replacement are revoked.
- One active VIT ID and its unfinished replacement are suspended.
- The scheduled expiry cannot alter the canceled successor.
- The old barcode fails attendance.
- A different card is rebound from the suspended state.
- Two scans race.
- One station loses connectivity.
- Another station is disabled, rejects its old heartbeat and replay, and is freshly provisioned.
- A replacement plan is blocked during live work and retires every old phone assignment when it is safe.
- The second session is extended.
- A finalization worker restarts.
- One participant and one staff member open finalized-result reviews.
- An independently authorized operator approves one review and declines one review.
- Every participant, operations, and roll-call view converges without a duplicate interval, partial close, stale remedy overwrite, or edited event.

Current attendance lifecycle milestone:

- Phone registration and authenticated heartbeat are implemented.
- Exact-plan scan enforcement is implemented.
- Operations disable and make-available controls are implemented.
- Device-secret revocation, source-grant teardown, access-version invalidation, and fresh local reprovisioning are implemented.
- Publication of a replacement plan refuses preparing, open, or closing sessions.
- The publication transaction retires the prior plan's station assignments.
- Exact-session prepare, open, extend, close, and cancel controls are versioned and idempotent.
- A late close is capped at the accepted end.
- First confirmation and exit or return use their proper windows.
- Pending paper sheets block close and cancel.
- Cancellation finishes through a no-absence batch without editing scan history.
- Before transmission, the event app persists each attendance attempt in a device-keyed SQLCipher queue.
- The published plan bounds the queue.
- Authenticated heartbeats report the pending count and oldest capture.
- Replay uses the original operation ID and device order.
- The app never labels local work as accepted.
- Known-offline work accepts only physical VIT-ID or event-badge scans.
- Portal QR requires an online station.
- The backend rejects expired replay.
- The backend preserves newer accepted projections by recording an older conflicting replay as needs review.
- Aggregate operations health exposes phones that await replay without exposing credential data.
- The participant portal reports the applicable VIT ID or external-badge state.
- The portal does not show every participant a VIT-only flag.
- The portal mints one current 60-second attendance QR at a time.
- The portal provides an explicit refresh.
- The first scanner receipt or staffed-participant resolution of a code consumes that successfully resolved code.
- The venue-entry phone uses the same fresh resolution to record an online staffed arrival.
- Staff first check a VIT ID or external photo ID.
- Independently granted exception and reversal paths require recent Google authentication and a reason.
- Arrival has its own sharded operations count and participant receipt.
- Arrival does not change presence, sessions, or roll calls.
- **Credential setup** on the assigned phone supports initial VIT enrollment.
- It also supports independently permitted exact-person VIT suspension and rebinding.
- It supports exact-person external-badge issue, replacement, and revocation.
- Both physical methods start with a fresh participant portal QR and a visible identity check.
- The server gives venue and credential actions independent one-use slots.
- A credential begin or single-step change claims its slot while the slot is fresh.
- A second scan must match the exact action, pending credential, operator, phone, station, and member.
- VIT suspension and rebinding require a recent Google session.
- Every external-badge command also requires a recent Google session.
- Changes use current credential versions and reasons where applicable.
- Suspension is one-way and atomically cancels an unfinished successor.
- Suspension leaves portal QR available.
- A different card must complete rebind to recover.
- Badge generation uses a bounded fail-if-present pnpm command.
- Badge bearers never appear as text or stored data.
- Issue or replacement activates only after the same card is scanned twice.
- The prior physical credential stays active until an atomic replacement.
- Abandoned pending attempts expire after five minutes.
- Badge revocation cancels any pending successor in the same transaction.

## 5. Slice 3: one complete review

Use one team, one panel, and three reviewer devices.

Deliver:

- Supreme/Board/SC/JC and External Judge role labels, default bundle materialization, and atomic scoped permission grants;
- reviewer profile and panel plan;
- clock-in;
- panel-table assignment;
- review-presence team QR and fallback code;
- waiting-for-desk, queued, called, and at-table states;
- reviewer presence;
- server timer and extension;
- rubric/criterion assignment;
- draft save and independent submission;
- review completion;
- minimal operations views.

Exit when staff route the team from waiting-for-desk through queued, called, at-table, in-review, and complete with all required scorecards; no participant readiness command exists, one reviewer briefly loses connection, and every accepted state survives app/browser restart.

Current review-availability milestone:

- Offer confirmation creates one availability projection from the locked roster.
- Accepted venue entry and exit move the inside count with the participant projection.
- The round board reads one indexed row per team.
- The board shows the current inside/active count and the published minimum.
- Call and start re-read that same row transactionally.
- A normal below-minimum call leaves the team queued and creates no review records.
- A below-minimum start changes nothing.
- `review.participant_availability.waive` can be granted independently for the exact team or pending review.
- The waiver requires a Google session created within 15 minutes and a reason.
- The waiver creates one immutable review-specific row with observed and required counts and authorizing grants.
- The call path can create that row atomically with the review.
- The post-call path checks and increments the pending review version.
- The exception never changes attendance or judging state.
- The exception cannot carry into a replacement review.

## 6. Slice 4: floor operations

Deliver:

- published zone/spot hall plan from bounded CSV;
- participant-dashboard hall-location QR and fallback code, with no physical table QR;
- zone-scoped floor mapper mode in the event app;
- realtime operations map, mapped/unmapped counts, and participant location;
- complete-map freeze and reasoned post-freeze override;
- multi-panel routing;
- queue ordering and participant estimate;
- missing-reviewer detection;
- substitute ranking, push, acknowledgment, and fallback;
- panel/table moves;
- holds and missed-team states;
- active-review board;
- participant/reviewer self support creation, list, detail, and reply;
- bounded operations support queue with exact-case/event read, separate manage authority, append-only public/internal timeline, optimistic state changes, and owner routing that grants no authority;
- protected overrides and audit.

Exit when two concurrent attempts cannot map two teams to one spot. The attempts must not overwrite a changed team location. Both sides must enforce cross-zone authority. Freeze must reject an unmapped accepted team. A used or expired code must not map again. The participant, mapper, and operations map must converge without refresh. The queue estimate must use the configured pace until enough valid panel samples exist.

Exit after a dry run with at least five panels where staff handle a no-show, stale push, wrong table, expired QR, overrun, and simultaneous operator conflict.

Current support milestone:

- The Convex case/action schema is implemented.
- Participant and roster self grants are implemented.
- The exact `support_case` scope resolver is implemented.
- The participant portal, event-app surface, and operations desk are implemented.
- Invitation-only event subjects remain grantless.
- Creation and replies retain one operation payload across ambiguous retries.
- Staff changes also check the exact case version and an audit reason.
- Reporter timelines omit internal actions.
- Ownership changes no grant.
- Case context cannot change or authorize the linked domain record.

## 7. Slice 5: progress evidence

Deliver:

- team-owned integration setup/replacement and provider-resource uniqueness;
- several GitHub repositories per team across App installations, required kind/purpose, add/reorder/archive flows, and an immutable checkpoint set;
- per-repository `code2create-7-0` verification, signed push handling, reconciliation, materialized statistics, and snapshot-SHA repository browser;
- Figma OAuth with PKCE, several team-owned file bindings up to a published cap, full document checkpoints, frame previews, version/comment context, a file webhook when allowed, and metadata heartbeat fallback;
- bounded provider Workpools, rate-limit state, deduplication, and integration diagnostics;
- disclosure, late baseline, incomplete, stale, revoked, and reauthorization states;
- Review 1 commitments and Review 2 context.

Exit when two team members see the same ordered repository set and Figma file set. A lead must be able to classify, reorder, and archive repositories. A lead must also be able to archive Figma files and replace a Figma authorizer. An assigned reviewer must be able to compare two pinned checkpoint sets without receiving a provider credential or generated score. The reviewer must be able to switch through every included private repository at its captured SHA. The reviewer must also be able to inspect pages, layers, frames, components, prototypes, comments, and freshness in every captured Figma file.

Current Figma milestone:

- Team-scoped Figma OAuth and several file bindings are implemented.
- Full raw snapshots and bounded named-version and comment facts are implemented.
- Webhooks, bounded metadata-heartbeat scheduling, reconciliation, and operations health are implemented.
- Every accepted connection, file, metadata, full-sync, preview, and webhook transition rebuilds one indexed Figma team summary in its owning transaction.
- The participant card and collapsed operations board subscribe to that row.
- File, snapshot, and preview detail loads only for the team that an operator expands.
- Lightweight Tier 3 checks and Tier 1/2 capture paths have separate freshness, leases, errors, versions, and rate-limit gates.
- A late provider response cannot regress a newer observation.
- No request retries its affected tier before `Retry-After`.
- Each new raw snapshot atomically creates its activity facts and bounded render set.
- A leased worker batches selected nodes against the exact provider version.
- The worker validates and privately stores successful PNGs.
- The worker records partial, rate-limited, or failed state without discarding raw evidence.
- An assigned reviewer can open exact-version frames and filter new or changed screens.
- The reviewer can page through the full immutable layer tree and inspect captured version and comment context.
- The reviewer can compare stored renders against the same file in the previous judging checkpoint.
- The comparison never substitutes an intervening provider refresh.
- The comparison labels absence as uncertain when either bounded frame set is incomplete.
- Focused tests cover two-file aggregation, degraded partial evidence, and provider-webhook projection updates.

Current GitHub set milestone:

- The participant surface supports repositories from several App installations.
- Each repository has the required kind, purpose, branch, and root.
- The surface supports archive, refresh, and an ordered shared list.
- Reordering sends the complete ID and version set.
- The backend verifies every current non-archived binding in one transaction before it commits the reorder.
- A stale tab cannot partially overwrite an add, archive, refresh, or another reorder.
- Focused tests cover complete-set, stale-version, and duplicate-entry rejection.

Current GitHub statistics milestone:

- Every accepted connection, repository, sync, and webhook transition transactionally rebuilds one indexed team summary.
- The summary combines repository, topic, and kind health.
- It also combines pushes, languages, additions and deletions, changed files, and exact observed commit-SHA overlap across repositories.
- A bounded comparison or project-root binding makes unique commit coverage an explicit lower bound.
- The same condition marks the team as partial.
- Focused tests cover cross-fork deduplication and degraded or incomplete inputs.

## 8. Slice 6: scoring and round close

Deliver:

- score-spread flags;
- correction and void workflows;
- criterion completeness;
- configured aggregation;
- finalist/award view behind approved policy;
- participant feedback release;
- protected CSV/JSON round export to exact-versioned private objects;
- independently permissioned start, read, retry, verify/close, and reopen controls.

Exit when the export reproduces every team total and input checksum from raw immutable scorecards and the saved rubric formula. A missing criterion must block close. One person must not both start and verify. A failed export must leave the round visibly frozen and retryable. Reopen must preserve the verified revision before another close.

Current round-close and export milestone:

- The round-close and export portion is implemented end to end.
- It freezes normalized result, exclusion, and withdrawal entries.
- The bounded worker generates JSON and spreadsheet-safe CSV.
- The worker stores both files in KMS-encrypted, versioned Mumbai S3.
- The worker reads back and hashes the exact object versions.
- A different exact-round reader/verifier must close the round.
- The workflow supports a permissioned retry.
- An ordinary reopen supersedes a verified export. It does not overwrite the export.
- Logical backup and staging restore use the separate Slice 7 operator tooling.

## 9. Slice 7: reliability and rehearsal

Deliver:

- venue network results;
- reviewer device inventory;
- minimum-build enforcement;
- spare-device handover;
- backup download and staging restore;
- incident banners and round pause;
- printed manual-mode pack;
- two-person manual-record import;
- monitoring and on-call ownership;
- production support runbook.

Exit after the full rehearsal completes without unowned exceptions or unreconciled scorecards.

Current reliability milestone:

- Scoped active-incident banners and incident-linked round pause and resume are implemented across Convex, operations, the participant queue, and reviewer mobile.
- Pause and resume use separate exact-round permissions.
- Each command checks fresh authentication, the expected version, a reason, and idempotency.
- A pause blocks new calls, starts, linked-incident resolution, and round close.
- A pause preserves queue positions and active review completion.
- Privacy-filtered Sentry boundaries cover the Vite surfaces and Expo app.
- Scanner liveness uses an authenticated heartbeat.
- The operations dashboard has an event-scoped bounded health projection.
- The projection spans current intake and admission jobs, participant delivery, attendance, reviews, exports, integrations, incidents, and Synesthesia.
- The repository has typed pnpm commands for production logical-backup export and immutable KMS/versioned S3 storage.
- The commands also support staging-only destructive import, a pre-restore safeguard backup, full re-export comparison, and a versioned pass/fail receipt.

The release-rehearsal record and operations workspace are implemented. Creating a run copies the current 61-scenario server template. Read, manage, execute, and final-completion authority use separate exact-run or event grants. Every workstream needs an active owner before start. Ownership grants no access. Scenario outcomes use optimistic versions and append-only actions. A terminal outcome must be rerun before it can change. Final sign-off requires a recent Google session. All 61 scenarios must pass in one transaction read set.

The printable emergency pack is implemented as a separate minimal operations workspace and bounded worker. The worker freezes one accepted-participant/contact/presence/hall-location, station/session, and round/panel/rubric snapshot. It stores the exact snapshot and document checksums with one KMS-encrypted versioned S3 object. The pack expires after four hours. The worker emits collision-checked, numbered attendance and review originals. Prepare, metadata read, and print-open use independent event-scoped permissions. Preparation requires fresh authentication. Each print link also requires fresh authentication and lasts at most 60 seconds. The system audits print opening. Print opening does not enable incident paper mode.

Launch still requires a production-shaped backup and restore run with approval. It requires a printed-pack chain-of-custody and two-person recovery drill. Production Sentry and Convex alerts need routing and owners. The team must run and approve the full rehearsal with production-like identities, devices, provider accounts, and venue conditions.

## 10. Slice 8: Synesthesia

Deliver:

- event-owned catalog metadata with active/disabled state and bounded participant search;
- draft, publish, pause/resume, and close controls for non-overlapping ambience windows;
- eligible-participant requests, duplicate resolution, per-window request/vote limits, voting, and reporting;
- independently scoped catalog, window, queue, moderation, scheduling, playback, report, and participant-access permissions;
- live participant and operations projections from the same request records;
- normal, pinned, and deferred operator scheduling;
- one-playing-request enforcement and append-only start/played/skipped acknowledgements;
- Synesthesia-only participant access suspension;
- explicit failure isolation from every admission, attendance, review, score, and round-close path.

Exit when request, voting, moderation, playback acknowledgment, and failure isolation work without granting access to review data.

Current milestone: the first operator-driven release is implemented in Convex, the participant portal, and the operations dashboard. The repository-wide lint, typecheck, generated-API check, and production builds pass. Production exit still requires the Board-approved licensed catalog/account, named operators and moderators, scoped production grants, representative multi-client staging tests, and the venue rehearsal below.

## 11. Slice 9: bounded intelligence

Deliver:

- a separate Flue/Vite Cloudflare Worker with one Durable Object agent instance per accepted job identity;
- different environment-specific HMAC secrets for bounded Convex dispatch and callback, strict schemas, request-age limits, and content-free tracing;
- purpose-built frozen Convex projections rather than a database credential, general chat route, or raw table access;
- independently scoped permissions for reading an intelligence result and requesting it;
- one operator-requested operations brief with no more than three source-cited priorities and no executable tool;
- one immutable operations-intelligence policy with separately scoped read, draft, validation, and publication permissions;
- one-minute due-state evaluation from the bounded health projection, with a committed signal/outbox, semantic deduplication, cooldown, event-local daily limit, recovery cycle, relevance expiry, and accountable owner;
- one shared proposal contract for later participant, admissions, reviewer, support, integration, floor, attendance, review, incident, and release explanations;
- a human action seam that returns any proposal to the existing UI and ordinary permissioned Convex command.

Exit the requested slice when an authorized operator can request a brief from the aggregate health view. A duplicate dispatch must create one model submission. Every displayed priority must pass source, severity, owner, and action validation. A stale or competing callback must change nothing. Loss of the Worker or model must leave ordinary operations unaffected.

Exit the proactive slice when an authorized publisher can replace and enable a policy. Two evaluations of one due state must create one signal and one brief. Unchanged health must stay quiet. Recovery must re-arm one later recurrence. Cooldown and the event-local daily limit must prevent extra provider work. The displayed automatic brief must include origin, owner, and relevance. The Worker must have no participant, application, attendance, queue, review, score, access, incident, or Synesthesia command.

Current operations-intelligence milestone:

- The separate Worker and signed protocol are implemented.
- The create-only durable identity, frozen health snapshot, and bounded callback are implemented.
- The first-settlement and timeout state machine is implemented.
- Independent read and generate permissions are implemented.
- The minimal operations UI, immutable automation policy, due scheduler, and signal/outbox are implemented.
- Cooldown, recovery cycle, local-day limit, and relevance handling are implemented.
- Focused domain, Worker, and Convex tests are implemented.
- The root local-development command configures matching localhost-only HMAC values and callback URLs. A permissioned local browser request has completed through the real remote Workers AI binding and signed callback.
- An isolated staging Convex deployment and staging Worker use separate ingress and callback secrets.
- The public health check succeeds.
- Unsigned work receives `401`.
- A permissioned staging browser request remains release work.
- Staging Workers AI completion through the signed callback remains release work.
- Production policy approval, alert routing, retention approval, and load rehearsal remain release work.
- Other intelligence surfaces remain follow-on slices.

## 12. Environments

| Environment | Use |
| --- | --- |
| Development | Local work, synthetic identities, disposable data |
| Staging | Production-like Google clients, real device builds, rehearsals, load tests |
| Production | Registered participants and event operation |

Each environment has separate:

- Convex deployment and data;
- Better Auth secret and Google OAuth clients;
- two required Cloudflare web applications with fixed participant and operations domains;
- one optional Cloudflare handbook integration domain for Google identity and `handbook.read` tests;
- native app identifiers, app scheme, build number, and update endpoint;
- one update Worker route, private R2 bucket, and admin token;
- one intelligence Worker, Workers AI binding, signed Convex callback URL, and two service HMAC secrets;
- GitHub App or webhook configuration;
- Figma OAuth redirect;
- Cloudflare Email Sending entitlement and least-privilege API token, verified sending domain/identity, reply-to policy, event subscription/Queue/DLQ, HMAC bridge, and Email Routing alias with a verified forwarding destination;
- Android keystore, Firebase service account, and `google-services.json`;
- Apple signing/provisioning material, APNs key, key ID, team ID, topic, and selected APNs environment;
- locally held Expo Updates signing key and the matching certificate embedded in the binary;
- Sentry environment;
- backup/export destination.

Production data is never copied into development. A staging seed uses generated teams and reviewers.

The repository contains local signed-build commands for staging and production. Expo prebuild generates a fresh native project. Gradle signs the staging APK or production AAB from environment-held keystore values. Xcode archives and exports the staging or production IPA with automatic provisioning. The build refuses missing platform identifiers, signing inputs, or Firebase configuration. It also refuses an APNs environment that does not match the selected iOS export method. Checked-in commands are not evidence of a signed build. Release exit still requires the real credentials and representative phones. Release exit also requires recorded camera, native-push, update, and deep-link results.

Each staging and production reviewer binary contains its environment's HTTPS `/manifest` endpoint. Each binary also contains the public update-signing certificate. The private key remains on the controlled release machine. The publisher exports from a clean committed tree. The publisher signs both platform manifests and the no-update/rollback directive. The publisher uploads immutable hash-addressed assets and registers an immutable release. The publisher advances the runtime pointer with a conditional write. A concurrent publisher receives a conflict and cannot silently replace the new pointer. The first binary for a runtime is distributed only after its environment has a valid signed rollback-to-embedded pointer.

## 13. Automated tests

### Domain/unit

- participant classification;
- team membership, accepted leadership transfer, preview, and atomic member/core/sponsor-track lock rules;
- reviewer eligibility and conflicts;
- panel criterion coverage;
- routing rank and tie-break;
- queue transitions;
- timer/extension policy;
- rubric aggregation;
- score completeness;
- atomic permission-key, exact-scope, validity, delegation-ceiling, and assignment/state checks;
- attendance-plan/session interpretation, expectation snapshot, anti-passback, duration/checkpoint result, and excused/unknown rules;
- presence transition and interval calculation across repeated exits/returns and changed actual session bounds;
- intake completion, the one-to-two introduction-question bound, immediate track-selection reachability, and deterministic fallback termination;
- novelty policy/corpus normalization, native vector width, similarity-to-signal boundaries, participant-safe theme/prompt projection, and the rule that no novelty field enters a submitted project/application;
- complete event-phase membership/order, window overlap/duration/span, competing draft saves, stale publication, and completed/active temporal boundaries;
- deterministic year/study-band derivation and admission recommendation validation;
- track/phase/sponsor guidance precedence and deterministic fallback selection;
- emergency-pack HTML escaping, deterministic form counts, and attendance/review serial-format compatibility;
- recovery snapshot path safety, JSONL order-independent inventory, changed-record detection, and exact staging-target refusal.
- release-template completeness, stable ordering/keys, scenario transition rules, and all-pass completion.
- strict Expo Updates request/release contracts, missing-asset rejection, signature headers, platform selection, no-update/rollback responses, immutable asset caching, admin authentication, and one-winner conditional release activation.
- native push-token provider/platform pairing, APNs environment pairing, token replacement/invalidation, bounded provider retries, and the rule that provider acceptance is not reviewer acknowledgment.
- service-body HMAC signing/verification, signature-context separation, strict operations-intelligence schemas, and bounded health-signal/priority enums.

### Convex

- unauthorized reads and writes;
- unique active session/scorecard constraints;
- stale expected-version rejection;
- duplicate operation ID resolution;
- round-close blockers;
- incident-linked pause/resume permission boundaries, one-active-pause enforcement, stale versions, and pause races against call/start/close/incident resolution;
- audit records for protected commands;
- VIT ID barcode fingerprint uniqueness/rebinding, external badge replacement, fresh staffed-resolution credential-slot claim and exact second-scan binding, QR expiry/use, scan idempotency, one open interval, projection/counter transition, and compensating reconciliation;
- staffed-arrival exact-person record/exception/reversal boundaries, fresh operator/phone/station/member resolution binding and one-action claim, one-current-row invariant, versioned retry/reversal, credential snapshot, sharded-count balance, whole-team milestone transition, and unchanged presence/session/roll-call records;
- resumable expectation/finalization cursor, overlap isolation, closing-state visibility, and checksum-gated completion;
- one-open-case finalized-result review, frozen session/result/evidence snapshot, participant-self and exact-session read/open/decide boundaries, stale-decision rejection, idempotent retry, derived-counter update, and immutable scan/interval history;
- exact-session roll-call read/start/close boundaries, fresh start/close, simultaneous start rejection, scan-versus-start/close serialization, sharded count invariants, and unchanged closed snapshot/final counts after later scans;
- emergency-pack accepted-cohort selection, prepare/read/print permission separation, stable operation retry, serial-prefix collision rejection, four-hour expiry, exact-version manifest completion, fresh-authenticated audited print opening, and failure/stall health signals;
- webhook deduplication;
- stale interpretation rejection and answer/session optimistic concurrency;
- novelty exact-team authorization, concurrent request deduplication, same-input cache, team rate limit, sensitive-input suppression, stale-result non-attachment, corpus import settlement/replay, and publication pinning;
- track-catalog/intake/model-config publication validation;
- stale admission-analysis rejection and final-submission-versus-team/track race;
- exact-account review assignment, exact-scope grant materialization, manual-grant independence, stale assignment/cancellation rejection, assignment-versus-review serialization, same-review replacement, and two-reviewer concurrent completion;
- independent profile/year and AI-recommendation read boundaries, peer-recommendation hiding before the caller submits, and AI-unavailable decision handling when the actor cannot read the AI record;
- one participant decision delivery per locked member, known-nonacceptance retry bounds, terminal ambiguous/expired sends, exact-person read/manage boundaries, current-email checks, and append-only manual retry only from the latest definitively failed attempt;
- Cloudflare Queue event normalization, signed callback verification, duplicate event-ID conflict detection, event-before-send-response handling, deterministic provider-time/event-ID ordering, hard-versus-soft bounce destination handling, DLQ visibility, and no retry path for an unknown send outcome.
- support-case state transitions, stable operation retries, stale-version rejection, reporter/internal timeline filtering, and exact-case versus event-wide permission resolution.
- rehearsal exact-run versus event-wide permission boundaries, owner-without-authority behavior, all-owner start gate, one-active-run invariant, stale run/scenario rejection, stable operation retries, append-only action history, terminal-rerun rule, and all-pass final sign-off race.
- operations-intelligence read/generate permission separation, idempotent request, frozen source checksum, out-of-snapshot citation rejection, first terminal settlement, timeout race, and late callback handling;
- operations-intelligence policy normalization, read/draft/validate/publish permission separation, concurrent draft publication state, due-evaluation race, canonical trigger fingerprint, unchanged suppression, cooldown, recovery re-arm, event-local daily limit, linked callback settlement, and expiry.

### Web

Playwright covers:

- participant classification and profile;
- live team join and accepted lead transfer;
- the minimal sequential intake;
- debounced newest-only novelty success, unavailable, and sensitive-input states;
- the distinction between immediate track choice and recommendation;
- fresh-project attestation;
- generated-question skip;
- editing an earlier answer and replacing its dependent question;
- pre-submit track change;
- verbatim project-summary review with no novelty field;
- explicit final lock warning;
- stale-preview rejection;
- model-success and no-model submission;
- exact-account application-review routing and personal work queue;
- profile, AI-context, and novelty redaction;
- peer-review hiding before own submission;
- independent application review;
- structured AI recommendation use, clear, override, and unavailable paths;
- human decision;
- accepted next steps, Discord, and notification state;
- admission offer;
- novelty-corpus permission splits, import, and publication;
- own staffed-arrival, attendance, session, and QR state;
- own finalized-result review request;
- staff-managed queue and generic pause status;
- own support creation, reply, and internal-action exclusion;
- scoped support-desk list, detail, assignment, state, and note controls;
- rehearsal creation, ownership, start, outcomes, rerun, and sign-off boundaries;
- roster CSV validation, preview, and confirmation;
- exact-email claim;
- pending-row revocation;
- event versus exact-row visibility;
- attendance operations;
- exact-station disable and make-available controls;
- replacement-plan guard and teardown;
- live correction;
- post-session remedy approval and decline;
- emergency-pack preparation, history, and print boundaries;
- two-approver attendance paper recovery;
- two-approver signed review recovery with a different verifier;
- incident-linked round pause and resume;
- round close.

Current browser-release milestone: the repository has a staging-only Playwright project and a manually triggered protected workflow. The first slice checks the public and authenticated participant and operations shells. It verifies the exact signed-in email and the operations health/rehearsal navigation. A read-only internal Convex prerequisite check rejects the wrong deployment, shared accounts, incomplete participant profile/team state, a broad participant team grant in place of the fixture team's exact grant, and role-only operations access. The full flow list above still requires controlled fixture implementation and a successful staging run before release approval.

### Mobile

Maestro and real-device tests cover:

- Google sign-in;
- reviewer clock-in;
- page open;
- review QR;
- fresh-QR staffed arrival, exception, and reversal;
- repeated VIT ID barcode and attendance QR scanning;
- wrong station or session;
- barcode rebinding;
- external badge replacement;
- camera and portal-QR fallback;
- scanner pending queue and replay;
- server-side station disable;
- rejection of the old secret and queued replay;
- clearing the revoked local setup;
- fresh phone reprovisioning;
- reviewer support creation, list, and reply;
- round-pause start suppression with active-draft continuity;
- background timer;
- offline draft;
- reconnect;
- submit-time response loss;
- restart;
- reviewer-device revocation.

### Integration

OpenAI embedding fixtures cover native 1,536-dimension corpus and query responses. They also cover wrong width, a missing or extra batch entry, request timeout or rate limit, an empty vector index, and newest-input settlement without production participant text.

OpenAI intake fixtures cover a valid single track recommendation and one or two questions. They cover common-idea supportive reflection, `nextQuestion: null`, refusal, and an incomplete or content-filtered response. They cover unknown track, field, or pattern IDs and stale source IDs. They also cover invalid schema, overlong, compound, repeated, or prohibited questions, timeout, rate limit, prompt injection, late completion, provider disablement, and input redaction for contact, registration, or credential patterns.

Admission fixtures cover every published experience band, mixed or external derivation, and sparse or common ideas. They cover source-linked criterion assessments and a team that chooses against the intake recommendation. They also cover prohibited numeric, judging, or prestige language, stale versions, refusal, invalid output, timeout, and human use, clear, override, or unavailable paths.

Intelligence fixtures cover signed dispatch and callback, duplicate create-only agent identity, and zero, one, or three priorities. They also cover invalid citations, severity, owner, or action, model non-publication, timeout, and callback races.

Signed and verified fixture payloads cover repositories from several GitHub installations. They cover add, classify, reorder, archive, push, install, uninstall, and repository removal. They also cover topic present or missing per repository, fork overlap, force push, partial access loss, duplicate or out-of-order delivery, and comparison truncation.

Figma fixtures cover OAuth state, PKCE, token refresh, passcode `PING` and `FILE_UPDATE`, duplicate delivery, and view-only webhook failure. They cover full-file parsing, balanced 48-node selection, and exact-version image requests. They also cover null, invalid, oversized, download, or upload render failure, partial completion, lease expiry or stale completion, metadata/content divergence, and `429 Retry-After`.

Cloudflare Email fixtures cover delivered, queued, and permanent-bounce send responses. They cover structured retryable and definite API errors, ambiguous timeout or invalid response, expired claim, and event-before-response. They also cover duplicate, out-of-order, or equal-time signed callbacks, hard and soft bounce, rejection, suppression, complaint, an unexpected sending domain, invalid HMAC, Queue retry and DLQ behavior, and inbound forwarding configuration.

Provider test accounts cover the live happy paths.

## 14. Load test

The provisional test envelope is:

- 1,200 active live connections;
- 300 reconnects over two minutes near round open;
- 1,000 session confirmations over ten minutes with a peak of 60 mixed VIT-barcode/QR attempts per second, duplicate bursts, exits/returns, and 20 scanner subscriptions;
- expectation materialization and finalization for 1,000 participants, including a worker restart, while unrelated scans and review writes continue;
- 330 near-simultaneous opening-answer saves and intake jobs, with the model pool saturated while deterministic next steps remain fast;
- 330 teams settling debounced novelty previews together, including duplicate client IDs, rapid text replacement, cache hits, sensitive-input suppression, team-rate limits, and one unavailable embedding provider while idea saves remain fast;
- 60 simultaneous active reviews;
- 150 state-changing operations per minute;
- 200 simultaneous support-case creates/replies/updates split across participant, reviewer, exact-case staff, and event-wide staff grants;
- one 200-row roster import followed by a burst of exact-email claims, including duplicate operations and claim/revoke/reimport races;
- dashboard subscriptions for all panels, queues, pages, and active sessions;
- 1,000 active GitHub repository bindings spread across 330 teams and several App installations;
- 500 GitHub push deliveries over two minutes with duplicates and out-of-order events;
- metadata heartbeat across 330 Figma bindings plus 50 coalesced full-content jobs;
- provider Workpool backlog while review mutations continue at the target latency;
- intake Workpool backlog while participant answer saves and review mutations continue at the target latency;
- admission-analysis backlog and a participant-email scheduler retry burst while human review/decision and portal reads remain fast;
- one round export while normal reads continue;
- one attendance export and active emergency roll-call subscription while scans continue;
- one maximum accepted-cohort emergency-pack generation while ordinary attendance and review writes continue.
- bounded requested and proactive operations briefs across separate events, including due-state backlogs, duplicate evaluation/dispatch, cooldown and local-day limit boundaries, recovery, expiry, and callback bursts, while ordinary Convex health reads and review mutations continue.

The core load script stubs external APIs and uses production Workpool/concurrency logic. A separately budgeted staging test samples the live OpenAI embedding, intake, and admission paths with synthetic project text only. The test records server function latency, client update delay, failures, reconnect behavior, novelty newest-result latency, deterministic-fallback latency, and duplicate/missing state.

Cloud-only results do not replace a venue rehearsal.

## 15. Rehearsal scenarios

The operations workspace creates this exact 61-scenario set from a server-owned versioned template. Each run keeps its copied title, workstream, expected state, and recovery action. Every workstream has one accountable active event person before start. That routing assignment grants no access. Operators record pass, fail, block, start, and rerun actions against current scenario versions. A different permission controls final sign-off. Final sign-off succeeds only while all 61 scenarios remain passed.

The final rehearsal includes:

1. VIT participant signs in with the wrong Google account.
2. Reviewer is not on the roster.
3. Reviewer accepts a page after it expired.
4. One panel member is absent.
5. Reviewer phone loses battery during an active draft.
6. Venue Wi-Fi drops for one table.
7. APNs or FCM push is delayed.
8. Team arrives at the wrong table.
9. QR is expired or belongs to another round.
10. Two operators move the same team.
11. Reviewer submits but the response is lost.
12. A score criterion lacks the minimum coverage.
13. GitHub/Figma checkpoint is stale.
14. GitHub topic is missing and the read-only App cannot add it.
15. A team adds frontend, backend, and model repositories from two installations; one loses access while the other two remain current.
16. A repository is archived after Review 1, and Review 1 still opens its original three-repository checkpoint set.
17. Figma authorizer is revoked, another lead reconnects, and earlier snapshots remain.
18. A Figma View/Collab rate limit permits metadata but defers full content.
19. Convex becomes unavailable and the round pauses.
20. One already-started review loses backend service. Two people approve review paper mode; one copies every signed scorecard and uploads the source, a different person verifies it, and one import transaction creates the reviewer-attributed versions and result. A concurrent digital save and round close both fail while the record is pending.
21. OpenAI embeddings and interpretation time out after the opening answer; the novelty counter becomes unavailable, the answer stays saved, and the team completes the deterministic route.
22. A late novelty result arrives after the team changes its idea and cannot attach; a late interpretation after the team changes its core track is also rejected as stale.
23. A model returns an unknown track ID, a compound or overlong question, or follows participant prompt-injection text; the server rejects it and serves the pinned fallback without changing accepted answers.
24. A caller with `configuration.publish` publishes a new track/flow version while a team is active; the team stays on its pinned version.
25. One person starts round close. A different exact-round reader/verifier opens both files and closes the round. Reopen supersedes that immutable revision. The next close produces a higher revision. The recovery operator exports Convex with file storage and uploads the exact backup and manifest. The operator takes a pre-restore staging backup. The operator restores only to the twice-confirmed staging target, re-exports the target, and gets an exact inventory match. The operator also restores one integration artifact and opens it from its recorded object version.
26. A participant remains inside between hacking sessions but does not receive session credit until the new confirmation scan.
27. One participant exits and returns three times; present/away totals and current state remain correct.
28. An enrolled VIT ID and portal QR are scanned nearly simultaneously for one participant; one transition is accepted.
29. A VIT student presents a replacement ID after the prior binding is suspended, while a lost external badge’s old QR is tried at another station.
30. An exit scanner queues events offline while an online roving scanner confirms a newer state; replay creates a visible review case rather than overwriting it.
31. An extension races close and only one current version wins; a deliberately late close stops at the accepted end. Another session is canceled during preparation or while open, any expectation work stops, its no-absence batch closes derived intervals, and scan history remains unchanged.
32. An emergency roll call begins while people continue entering and leaving; the starting snapshot and live view remain distinct.
33. A participant needs an accessibility/manual confirmation and another disputes a missing exit; both paths preserve privacy and audit history.
34. A member joins or another team device changes the sponsor-track set after the lead opened final confirmation; submission rejects the stale preview and shows the new roster and pinned-catalog track set before any lock.
35. Two members race to accept leadership transfer/final submission; the team finishes with one lead and one lock snapshot.
36. A first-year and later-year fixture with equivalent evidence receive criterion language from their published bands; neither AI result can publish the decision.
37. A team chooses a track other than the intake recommendation; the admission request omits that mismatch and the dashboard exposes no penalty control.
38. An accepted-team email is delayed or bounces; the portal still shows authoritative next steps and operations sees the delivery state without treating it as acknowledgment.
39. A Cloudflare Email Sending response is lost after possible provider acceptance; the delivery becomes `unknown` immediately and no automatic or manual blind retry is exposed. Later duplicate and out-of-order lifecycle events converge if their provider message ID can be reconciled, while operations retains the unknown record for explicit provider-log handling.
40. A manual retry races another operator and a destination disable; expected versions and the root retry index produce at most one new delivery, and a request already in flight is not reported as canceled.
41. An attendance export is requested while scans continue. Every row shares one snapshot time. Formula-like participant text is neutralized. Only the selected columns appear. The object key never reaches the UI. Permission revocation before the final download check prevents return of the at-most-60-second URL.
42. A roster CSV contains a malformed row, duplicate normalized email, or unsupported role; preview rejects the whole file and creates no row.
43. A provisioned scanner receives no cards for several minutes but stays healthy through authenticated heartbeats. Closing the scanner makes only its expected live station stale after two minutes. Operations then disables the scanner. The old heartbeat, scan, and replay fail. The assignment grants disappear once. Making the station available still requires a fresh phone secret and assignment.
44. A failed participant-email attempt is manually retried; the source becomes superseded in the same transaction, the new pending attempt is the only current attempt, and the health overview does not preserve a false permanent failure.
45. A caller holding only `operations.health.read` sees aggregate counts, age, owner, and next action but cannot recover an incident summary, participant destination, team/resource name, provider error code, or judging value. A source with more than the bounded sample produces a visible coverage warning.
46. An authorized operator prepares a maximum-cohort emergency pack while scans continue. A separate reader sees metadata but no roster. A separate freshly authenticated printer opens the exact version. Operations holds the printed original under chain of custody. Staff use one attendance sheet and one already-active review sheet only after two-person paper-mode approval. A different verifier reconciles each sheet. The system rejects an expired pack or reused serial. The verifier refuses a photocopy under the original-paper procedure.
47. One operator confirms a preview while the matching person claims, another operator revokes, or a new import replaces the same pending row; exactly one row transition wins and the stale confirmation cannot overwrite it.
48. A claimed roster email appears in a later import with a different name, role, window, or bundle set; the preview marks it already claimed and confirmation leaves the linked role and grants unchanged.
49. Two participants request the same track and vote at nearly the same time; one request and one vote per participant remain, with matching live counts in both portals.
50. Two operators start different requests while another pauses or closes the window; one start wins and pause/close cannot strand a playing item.
51. A queue reader without moderation/report grants sees no internal note or report reason; an exact-request moderator cannot act on another request.
52. A participant is suspended from Synesthesia while submitting a vote; one transaction wins, the retried action is rejected, and event/team/attendance/review access remains unchanged.
53. The licensed playback application or Synesthesia backend is unavailable; operations follows the manual playback/support instruction while registration, attendance, reviews, scoring, and round close continue.
54. A team call or review start races an incident-linked round pause; one mutation wins, and the retried command observes either the accepted call/start or the active pause without creating duplicate review state.
55. While a round is paused, a queued team keeps its position, an active review finishes, participant and reviewer clients show only the generic pause, and incident resolution plus round close fail until an independently authorized resume succeeds.
56. A participant creates a support case while operations is open; both surfaces receive the accepted case without refresh, a public reply reaches the participant, and an internal note never does.
57. Two staff members update one support version while the reporter replies. Each accepted mutation creates one ordered timeline, stale writes change nothing, and retrying a lost response adds no duplicate action.
58. A case is assigned to a staff member who lacks case read/manage authority; assignment succeeds as routing metadata but still exposes no case or command until a separate exact-case grant is made. Revoking that grant removes access without changing ownership.
59. A participant’s staffed venue check-in is reversed after a valid venue-entry scan. The arrival row and coarse team milestone change, but presence/session ledgers and projections do not. A later valid staffed arrival creates a new row after another fresh participant QR.
60. A credential begin, verification, or single-step change is attempted with no staffed resolution, a different member/operator/phone/station/action/credential, an expired unclaimed resolution, or an already claimed credential slot. Each invalid command changes nothing. One valid begin plus matching second scan completes, and the independent venue slot remains available for a legitimate arrival action.
61. A team is queued while participant movement takes it below the round's published minimum. An ordinary call leaves the queue and every review table unchanged. A freshly authenticated exact-team holder records a reasoned exception in the call. The holder gets one review and one immutable waiver. A later movement/start race sees either the current count or that same review's waiver. Another waiver cannot duplicate it.

Every scenario has an owner, expected screen state, recovery action, and pass/fail result.

## 16. Training

### External judges

- sign-in and device check;
- page acknowledgment;
- conflict reporting;
- QR presence;
- evidence versus score;
- independent scoring;
- offline indicator and submission confirmation;
- spare-device procedure.

### Typical SC/JC operational bundles

- attendance session open/extend/close/cancel and expectation impact;
- station setup, direction, scanner result language, VIT-barcode/QR fallback, and queue redirection;
- VIT ID barcode enrollment/suspension/rebinding, external badge issue/replacement, duplicate/anti-passback result, pending replay, missing-scan reconciliation, and emergency roll call;
- finalized-result review intake, immutable evidence boundary, independently scoped approval/decline, participant-facing resolution note, and stale-case handling;
- identifiable attendance-export purpose/column/expiry selection, fresh-auth request and download, checksum handoff, and restricted-file disposal;
- emergency-pack purpose/spares, separate prepare/read/print grants, four-hour rotation, checksum/chain-of-custody check, and the fact that printing does not enable paper mode;
- privacy, accessibility, excused absence, and the ban on attendance-as-score;
- track, atomic intake-policy, event-phase, and checkpoint-plan complete-draft validation and publication;
- active-pin review and the rule that publication never migrates an in-progress participant draft;
- table freeze;
- panel gap and substitute flow;
- queue holds/moves;
- active-review exceptions;
- stale command conflicts;
- pause and incident mode;
- support case ownership.

### Typical Board/Supreme governance bundles

- year-adjusted admissions policy/model publication, AI recommendation use/clear/override, human decision, and locked-snapshot correction;
- accepted-team next steps, Discord, and participant-notification publication;
- rubric publication;
- correction/void;
- score visibility;
- close blockers;
- presence and overrun overrides;
- exports and manual-record verification.

## 17. Freeze and launch

- Product policy freezes before the final rehearsal.
- Core/sponsor track definitions, event phases, one-to-two-question policy, novelty corpus/model/dimensions/thresholds, common-idea patterns, intake/admission-model configuration, year-band rubric, final-lock wording, consent, communications, and deterministic fallbacks freeze before applications open.
- Schema and auth changes freeze after the final rehearsal except for a launch-blocking defect.
- Mobile camera dependency, verified VIT ID barcode compatibility matrix, scanner hardware list, external badge format, and station configuration freeze before production event-app installation.
- A signed self-hosted update may ship a JavaScript-only fix on the same application-version runtime only after staging verification and release-owner approval. Native dependency or configuration changes require a new locally signed binary.
- Production seed/configuration is exported and reviewed before check-in.
- Event owners name a release owner, auth owner, reviewer-app owner, backend owner, floor-operations owner, and incident commander for each window. Each assignment materializes the exact scoped permissions it needs and may be given to any event-linked person regardless of role.

## 18. Definition of done

A feature is done when:

- server permissions and state checks exist;
- participant/reviewer/staff error states are written;
- live updates reach every affected surface;
- duplicate, stale, offline, and restart behavior is tested where relevant;
- protected actions create the required history;
- support and operations can diagnose failure;
- staging and production configuration is documented;
- the event owner has approved any policy the feature applies.
