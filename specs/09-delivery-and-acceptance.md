# Delivery and acceptance

## 1. Build order

Build vertical event flows. Do not spend the first phase creating every table, role, and dashboard without a reviewer completing a real scorecard.

## 2. Slice 0: decisions and technical proof

Deliver:

- event configuration for team size, rounds, rubric, timer, correction windows, and queue policy;
- pnpm workspace with web, reviewer, Convex, and shared domain package;
- separate development, staging, and production projects;
- Better Auth running on Convex with Google only;
- web and Expo Google callback flows;
- proof that the server can read and validate Google `sub`, verified email, and `hd`;
- participant class and roster-claim prototypes;
- one authorised Convex query and mutation from both clients;
- release IDs and basic error reporting.

Exit when:

- VIT and personal Google test accounts produce the expected participant classes;
- a rostered reviewer signs in on a real device;
- an unrostered account receives no reviewer data;
- a role revoked in the dashboard fails on the reviewer’s next protected write;
- the same accepted mutation appears on web and mobile.

If the Google hosted-domain claim cannot be captured through the selected Better Auth flow, stop and fix the auth design before participant registration work.

## 3. Slice 1: participant registration

Deliver:

- participant profile;
- team create/join/lead transfer;
- guided project questions;
- draft save and submitted project versions;
- application-review assignment and independent recommendation;
- shortlist, waitlist, offer, confirmation, and capacity state;
- registration support codes;
- event configuration checks.

Exit when a VIT participant and an external participant can form a valid mixed or same-class team under the chosen policy, submit a project, receive a reviewed admission decision, confirm an offer, refresh on another device, and see the same server state.

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

- GitHub App installation and signed push webhook;
- repository snapshots;
- Figma OAuth and file selection;
- metadata/version snapshots at checkpoints;
- disclosure and stale-integration states;
- Review 1 commitments and Review 2 context.

Exit when a reviewer can compare two checkpoints without receiving repository secrets, full Figma document content, or a generated score.

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
- role capability checks.

### Convex

- unauthorised reads and writes;
- unique active session/scorecard constraints;
- stale expected-version rejection;
- duplicate operation ID resolution;
- round-close blockers;
- audit records for protected commands;
- webhook deduplication.

### Web

Playwright covers participant registration, team/project submission, independent application review, admission offer, ready/queue, roster administration, floor operations, correction, and round close.

### Mobile

Maestro and device tests cover Google sign-in, clock-in, page open, QR scan, background timer, offline draft, reconnect, submit-time response loss, restart, and device revocation.

### Integration

Signed fixture payloads cover GitHub push/install/uninstall and Figma OAuth/token refresh/API errors. Provider sandboxes or test accounts cover the live happy path.

## 12. Load test

The provisional test envelope is:

- 1,200 active live connections;
- 300 reconnects over two minutes near round open;
- 60 simultaneous active reviews;
- 150 state-changing operations per minute;
- dashboard subscriptions for all panels, queues, pages, and active sessions;
- one round export while normal reads continue.

The script uses registered counts once available. It records server function latency, client update delay, failures, reconnect behaviour, and any duplicate/missing state.

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
14. Convex becomes unavailable and the round pauses.
15. One manual paper review is entered and verified.
16. Round export is checked and restored into staging.

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
