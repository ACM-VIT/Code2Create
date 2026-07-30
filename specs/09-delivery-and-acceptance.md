# Delivery and acceptance

## 1. Build order

Build vertical event flows. Do not spend the first phase creating every table, role, and dashboard without a reviewer completing a real scorecard.

## 2. Slice 0: decisions and technical proof

Deliver:

- event configuration for team size, rounds, rubric, timer, correction windows, queue policy, track catalog, project maturity, and intake graph;
- pnpm workspace with web, reviewer, Convex, and shared domain package;
- separate development, staging, and production projects;
- Better Auth running on Convex with Google only;
- web and Expo Google callback flows;
- proof that the server can read and validate Google `sub`, verified email, and `hd`;
- participant class and roster-claim prototypes;
- one authorised Convex query and mutation from both clients;
- one OpenAI Responses/Structured Outputs contract spike plus a complete deterministic no-model path;
- release IDs and basic error reporting.

Exit when:

- VIT and personal Google test accounts produce the expected participant classes;
- a rostered reviewer signs in on a real device;
- an unrostered account receives no reviewer data;
- a role revoked in the dashboard fails on the reviewer’s next protected write;
- the same accepted mutation appears on web and mobile;
- a saved answer survives OpenAI timeout, refusal, or invalid output and still reaches a submittable brief through configured prompts.

If the Google hosted-domain claim cannot be captured through the selected Better Auth flow, stop and fix the auth design before participant registration work.

## 3. Slice 1: participant registration

Deliver:

- participant profile;
- team create/join/lead transfer;
- the exact **Hello.** then **What is your project about?** opening with one prompt and text box at a time;
- configurable maturity/origin confirmation, five core-track positions, optional sponsor entries, and track/maturity question bindings;
- source-linked OpenAI interpretation with strict Structured Outputs and participant confirmation;
- a deterministic fallback for every intake branch;
- immutable answer, brief, catalog, flow, model-schema, and submitted project versions;
- administrator validation, simulation, publication, rollback, and safe active-session pinning;
- application-review assignment and independent recommendation;
- shortlist, waitlist, offer, confirmation, and capacity state;
- registration support codes;
- event configuration checks.

Exit when a VIT participant and an external participant can form a valid mixed or same-class team under the chosen policy, complete different maturity/track paths, submit the same confirmed brief with OpenAI enabled or disabled, receive a reviewed admission decision, confirm an offer, refresh on another device, and see the same server state.

## 4. Slice 2: one complete review

Use one team, one panel, and three reviewer devices.

Deliver:

- staff roster and role grants;
- reviewer profile and panel plan;
- clock-in;
- table assignment;
- team QR and fallback code;
- ready/call/at-table states;
- reviewer presence;
- server timer and extension;
- rubric/criterion assignment;
- draft save and independent submission;
- review completion;
- minimal operations views.

Exit when the team travels from ready to complete with all required scorecards, one reviewer briefly loses connection, and every accepted state survives app/browser restart.

## 5. Slice 3: floor operations

Deliver:

- multi-panel routing;
- queue ordering and participant estimate;
- missing-reviewer detection;
- substitute ranking, push, acknowledgement, and fallback;
- panel/table moves;
- holds and missed-team states;
- active-review board;
- support cases;
- protected overrides and audit.

Exit after a dry run with at least five panels where staff handle a no-show, stale push, wrong table, expired QR, overrun, and simultaneous operator conflict.

## 6. Slice 4: progress evidence

Deliver:

- team-owned integration setup/replacement and provider-resource uniqueness;
- several GitHub repositories per team across App installations, required kind/purpose, add/reorder/archive flows, and an immutable checkpoint set;
- per-repository `code2create-7-0` verification, signed push handling, reconciliation, materialised statistics, and snapshot-SHA repository browser;
- Figma OAuth with PKCE, file selection, full document checkpoints, frame previews, version/comment context, file webhook when allowed, and metadata heartbeat fallback;
- bounded provider Workpools, rate-limit state, deduplication, and integration diagnostics;
- disclosure, late baseline, incomplete, stale, revoked, and reauthorization states;
- Review 1 commitments and Review 2 context.

Exit when two team members see the same ordered repository set and Figma connection, a lead can classify/reorder/archive repositories and replace the Figma authorizer, and an assigned reviewer can compare two pinned checkpoint sets without receiving a provider credential or generated score. The reviewer can switch through every included private repository at its captured SHA and inspect captured Figma pages, layers, frames, components, prototypes, comments, and freshness.

## 7. Slice 5: scoring and round close

Deliver:

- score-spread flags;
- correction and void workflows;
- criterion completeness;
- configured aggregation;
- finalist/award view behind approved policy;
- participant feedback release;
- CSV/JSON round export;
- round close/reopen controls.

Exit when the export reproduces every team total from raw scorecards and the saved rubric version, and a missing criterion blocks round close.

## 8. Slice 6: reliability and rehearsal

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

## 9. Slice 7: Synesthesia

Build Synesthesia after the core review flow passes its rehearsal.

Exit when request, voting, moderation, playback acknowledgement, and failure isolation work without granting access to review data.

## 10. Environments

| Environment | Use |
| --- | --- |
| Development | Local work, synthetic identities, disposable data |
| Staging | Production-like Google clients, real device builds, rehearsals, load tests |
| Production | Registered participants and event operation |

Each environment has separate:

- Convex deployment and data;
- Better Auth secret and Google OAuth clients;
- Vercel project/environment;
- EAS channel and app scheme;
- GitHub App or webhook configuration;
- Figma OAuth redirect;
- Expo credentials;
- Sentry environment;
- backup/export destination.

Production data is never copied into development. A staging seed uses generated teams and reviewers.

## 11. Automated tests

### Domain/unit

- participant classification;
- team membership and lock rules;
- reviewer eligibility and conflicts;
- panel criterion coverage;
- routing rank and tie-break;
- queue transitions;
- timer/extension policy;
- rubric aggregation;
- score completeness;
- role capability checks;
- intake-graph reachability, termination, and maximum path length;
- track/maturity/sponsor binding precedence and deterministic fallback selection.

### Convex

- unauthorised reads and writes;
- unique active session/scorecard constraints;
- stale expected-version rejection;
- duplicate operation ID resolution;
- round-close blockers;
- audit records for protected commands;
- webhook deduplication;
- stale interpretation rejection and answer/session optimistic concurrency;
- track-catalog/intake/model-config publication validation.

### Web

Playwright covers participant registration, the minimal sequential intake, maturity/track confirmation and change, source-linked brief review, model-success/no-model submission, team/project submission, independent application review, admission offer, ready/queue, roster administration, floor operations, correction, and round close.

### Mobile

Maestro and device tests cover Google sign-in, clock-in, page open, QR scan, background timer, offline draft, reconnect, submit-time response loss, restart, and device revocation.

### Integration

OpenAI fixtures cover valid structured output, refusal, incomplete/content-filtered response, unknown IDs, stale source IDs, invalid schema, timeout, rate limit, prompt injection, late completion, provider disablement, and input redaction for contact/registration/credential patterns. Signed/verified fixture payloads cover repositories from several GitHub installations, add/classify/reorder/archive, push/install/uninstall/repository removal, topic present/missing per repository, fork overlap, force push, partial access loss, duplicate/out-of-order delivery, and comparison truncation. Figma fixtures cover OAuth state/PKCE/token refresh, passcode `PING`/`FILE_UPDATE`, duplicate delivery, view-only webhook failure, full-file parsing, render failure, metadata/content divergence, and `429 Retry-After`. Provider test accounts cover the live happy paths.

## 12. Load test

The provisional test envelope is:

- 1,200 active live connections;
- 300 reconnects over two minutes near round open;
- 330 near-simultaneous opening-answer saves and intake jobs, with the model pool saturated while deterministic next steps remain fast;
- 60 simultaneous active reviews;
- 150 state-changing operations per minute;
- dashboard subscriptions for all panels, queues, pages, and active sessions;
- 1,000 active GitHub repository bindings spread across 330 teams and several App installations;
- 500 GitHub push deliveries over two minutes with duplicates and out-of-order events;
- metadata heartbeat across 330 Figma bindings plus 50 coalesced full-content jobs;
- provider Workpool backlog while review mutations continue at the target latency;
- intake Workpool backlog while participant answer saves and review mutations continue at the target latency;
- one round export while normal reads continue.

The core load script stubs external APIs and uses production Workpool/concurrency logic. A separately budgeted staging test samples the live OpenAI path without sending production participant text. The test records server function latency, client update delay, failures, reconnect behaviour, deterministic-fallback latency, and duplicate/missing state.

Cloud-only results do not replace a venue rehearsal.

## 13. Rehearsal scenarios

The final rehearsal includes:

1. VIT participant signs in with the wrong Google account.
2. Reviewer is not on the roster.
3. Reviewer accepts a page after it expired.
4. One panel member is absent.
5. Reviewer phone loses battery during an active draft.
6. Venue Wi-Fi drops for one table.
7. Expo push is delayed.
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
20. One manual paper review is entered and verified.
21. OpenAI times out after the opening answer; the answer stays saved and the team completes the deterministic route.
22. A late interpretation arrives after the team changes its core track and is rejected as stale.
23. A model returns an unknown track/question key or follows participant prompt-injection text; the server rejects it without changing the session.
24. An administrator publishes a new track/flow version while a team is active; the team stays on its pinned version.
25. Round export and integration artifact are checked and restored into staging.

Every scenario has an owner, expected screen state, recovery action, and pass/fail result.

## 14. Training

### Reviewers

- sign-in and device check;
- page acknowledgement;
- conflict reporting;
- QR presence;
- evidence versus score;
- independent scoring;
- offline indicator and submission confirmation;
- spare-device procedure.

### Operations

- track, maturity, intake graph, and model-config validation, simulation, publication, and rollback;
- active-session migration preview and per-session result;
- table freeze;
- panel gap and substitute flow;
- queue holds/moves;
- active-review exceptions;
- stale command conflicts;
- pause and incident mode;
- support case ownership.

### Review administrators and board

- rubric publication;
- correction/void;
- score visibility;
- close blockers;
- presence and overrun overrides;
- exports and manual-record verification.

## 15. Freeze and launch

- Product policy freezes before the final rehearsal.
- Core/sponsor track definitions, maturity wording, intake graph, model configuration, consent, and deterministic fallbacks freeze before applications open.
- Schema and auth changes freeze after the final rehearsal except for a launch-blocking defect.
- Mobile native dependencies freeze before production reviewer installation.
- EAS Update may ship a compatible JavaScript fix only after staging verification and release-owner approval.
- Production seed/configuration is exported and reviewed before check-in.
- A named release owner, incident commander, auth owner, reviewer-app owner, backend owner, and floor-operations owner are present for event windows.

## 16. Definition of done

A feature is done when:

- server permissions and state checks exist;
- participant/reviewer/staff error states are written;
- live updates reach every affected surface;
- duplicate, stale, offline, and restart behaviour is tested where relevant;
- protected actions create the required history;
- support and operations can diagnose failure;
- staging and production configuration is documented;
- the event owner has approved any policy the feature applies.
