# Reliability and audit

## 1. Failure model

The event must expect:

- crowded venue Wi-Fi and intermittent mobile data;
- reviewer/scanner phones with low battery, denied permissions, unsupported NFC, or old builds;
- delayed or dropped push notifications;
- stale dashboards opened on several staff laptops;
- duplicate taps and lost network responses;
- wrong table, wrong session/station, expired QR, unreadable/forgotten VIT ID, copied external badge, or late reviewer;
- missed entry/exit scans, simultaneous VIT-card/QR scans, and an offline replay that conflicts with newer presence;
- OpenAI, GitHub, Figma, Google, Expo, or Convex service trouble;
- human mistakes during a fast round transition.

The system protects judging records and emergency-accountability data first. If it cannot safely confirm attendance or start/finish a review, operations redirects scanning, marks presence uncertain, or pauses the affected session, panel, or round. It never invents acceptance to keep a queue moving.

## 2. Venue network

Code2Create is online-first. Bluetooth and peer-to-peer relay are not part of the release.

Before the final rehearsal, the event team must:

- survey the actual review floor under expected crowd conditions;
- provide a staff/reviewer network separate from the public participant network where possible;
- test each panel zone, stairwell, and overflow area;
- arrange backup cellular routers or managed hotspots;
- provide charging points, power banks, and a labelled spare-device pool;
- record the network owner and escalation contact;
- repeat VIT-card/QR attendance bursts, scanner replay, review QR, score-save, and queue tests on the venue network.

The application should work on ordinary HTTPS/WebSocket access. It cannot assume access to local routers, static device IPs, or custom ports.

## 3. Accepted state

Convex stores the accepted event state.

A client may show an optimistic control for low-risk actions such as a Synesthesia vote. It may not show these as accepted before a server response:

- reviewer clock-in or page acceptance;
- participant venue/session presence and VIT-card/external-badge binding changes;
- team ready;
- table or panel assignment;
- reviewer presence;
- fresh-project attestation, confirmed track, and project submission;
- review start or extension;
- scorecard submission;
- correction;
- round close or reopen.

High-impact writes include a stable client operation ID. If the response is lost, the client asks the server whether that operation was accepted before creating another.

Writes that edit an existing object include its expected version. A stale write returns a conflict and current state.

## 4. Reviewer draft recovery

The mobile app keeps one encrypted local draft for the active review.

- Score and checkbox changes go to the server immediately when connected.
- Text notes save after a short pause and when the field loses focus.
- Local and server draft versions are visible in diagnostics.
- Pending edits keep their original operation IDs.
- Final submission needs a server confirmation.
- A reviewer with an unsynced submission cannot begin another review.

If the phone fails, operations first tries to recover the active draft on that phone. If it cannot, the reviewer moves to a spare device and re-enters the scorecard from memory/notes under an incident record. The backend never invents a missing score.

## 5. Push failure

Expo push wakes a reviewer. It does not hold event state.

For each critical page, the system records:

- page creation;
- push request and provider ticket;
- app opened time, when known;
- reviewer acceptance/decline;
- expiry;
- fallback owner.

If the reviewer does not acknowledge before the page deadline, the dashboard pages the next candidate and tells operations to call or send a runner. A provider delivery receipt does not suppress this fallback.

## 6. Device and application failure

### Old build

Clock-in blocks builds below the configured minimum. The reviewer installs the current EAS build or uses a prepared spare.

### Camera unavailable

Use the QR fallback code. Presence still requires server validation.

### NFC unavailable

The station switches to portal/event-badge QR without changing the attendance session or participant record. VIT ID scanning is enabled only on a provisioned phone/card-batch combination that passed the rehearsal.

### Scanner connection loss

The attendance scanner may collect a bounded encrypted pending queue. It shows **Pending**, not **Accepted**. On reconnect, each operation keeps its device sequence and operation ID; the server returns accepted, duplicate, rejected, or needs-review state. A queue beyond its age/size limit closes the station and directs participants to an online station or the incident procedure.

### Forgotten, replaced, or misused card

A VIT student without a readable VIT ID uses the authenticated portal QR or staffed exception. If VIT replaces the card, attendance staff visually verify the participant, suspend the prior event binding, tap/read the replacement twice, and bind its event-scoped fingerprint. Conflicting presentation of one card at different stations creates an anomaly; it does not open two intervals.

A lost external event badge is revoked and reprinted. The old QR fails on the next online scan.

### Notification permission denied

Clock-in warns the reviewer and operations. Event policy decides whether a reviewer may work with in-app polling plus runner/call fallback.

### Battery or hardware failure

Revoke the old device, register a spare, resolve any active draft, then resume or replace the reviewer.

### App crash

On restart, the app restores the current session, fetches `reviewer.now`, opens the encrypted active draft, and resolves pending operation IDs.

## 7. External service failure

| Service | Effect | Event response |
| --- | --- | --- |
| Google/Better Auth | New sign-ins or fresh-session checks fail | Existing valid sessions continue; support moves signed-in staff/reviewer work to prepared devices where allowed |
| Convex | Core reads/writes fail | Pause authoritative attendance acceptance and new reviews; scanner events remain visibly pending within limits; current reviewer drafts stay local; start incident procedure |
| OpenAI | Intake interpretation is slow, refused, invalid, rate-limited, or unavailable | Keep the committed answer, follow the published deterministic question edge, and allow brief confirmation/submission without model output |
| Expo Push | Background pages may not arrive | Dashboard, call, and runner fallback |
| GitHub | Push delivery or one repository reconciliation fails | Keep every other repository current, retain the failed repository’s last verified checkpoint, show partial completeness, and accept live/manual evidence |
| Figma | Metadata, full content, comments, or previews cannot refresh | Keep the last complete checkpoint, show each freshness time and missing part, accept live/manual evidence |
| Vercel | Participant/dashboard web and dynamic attendance QR may fail | Enrolled VIT ID cards, issued external badge QR, and the Expo app may continue if Convex is healthy; operations uses prepared access route and incident pack |
| Sentry | Crash reports delayed | Event functions continue; use Convex/operations logs |

GitHub or Figma downtime does not block a review. The reviewer sees that evidence is stale and records what was demonstrated.

## 8. Core-backend incident

When the core backend cannot confirm state:

1. operations posts an incident banner if the dashboard is available;
2. the round controller pauses new review starts;
3. active reviewers keep current drafts open and stop after the current team;
4. the named incident commander, assigned from Supreme or Board for this incident, checks provider status, venue network, and a second connection;
5. attendance operations stop or redirect affected stations, preserve pending status, and record the last confirmed zone snapshot;
6. operations records affected panels and last confirmed server times;
7. the named incident commander chooses recovery, relocation to backup connectivity, or manual mode.

No staff member starts an unofficial spreadsheet while normal service may recover.

### Manual mode

Manual mode requires the named incident commander and a second Supreme or Board member. One person cannot supply both approvals.

Use numbered paper sheets from the printed incident pack.

An attendance sheet records:

- event, attendance session, zone, station/direction, and serial number;
- participant event/registration or external badge reference;
- entry, exit, or session-confirmation transition;
- local time and operator initials;
- replacement/correction reason where applicable.

A review sheet records:

- event, round, team, panel, table, and serial number;
- all present reviewers and signatures;
- start/end time;
- rubric version;
- evidence, criteria, raw ratings, and commitments;
- reason normal service was unavailable.

After recovery, two staff members enter and verify each sheet. Attendance imports create linked compensating/reconciled events rather than backdating silent state changes. The application stores a scan of the source, both staff identities, and `manual_import` status. The original sheet goes into the event audit packet.

Manual records never look like normal app submissions.

## 9. Backups and round exports

Production uses a Convex plan with periodic daily backups including file storage.

Required actions:

- take and download a manual backup before event check-in opens;
- generate, upload, and checksum-verify the application export while each round is `closing`;
- copy the round export to encrypted storage outside the Convex deployment;
- record file size and SHA-256 checksum;
- have a second staff member open and verify participant-presence, attendance-session, team, review-session, and scorecard counts;
- take and download a final backup after the event;
- rehearse a restore into staging before launch.

Convex backups contain table data and stored files, but not deployed code, environment variables, or pending scheduled functions. Source control and the secret inventory cover those separately.

A production restore is destructive. The incident commander takes a new backup first when possible, records the chosen restore point, and follows the rehearsed runbook. Supreme approves the restore; if Supreme is unavailable, two Board members may approve the documented emergency path.

## 10. Monitoring

### Technical

- Convex function failures and latency;
- failed auth callbacks and roster claims by reason;
- intake answer-save latency; intake Workpool depth/age; model success, refusal, invalid, question-policy rejection, timeout, rate-limit, stale, and fallback rates by configuration version;
- web/reviewer crashes by release;
- subscription reconnect rate;
- attendance scan acceptance/duplicate/rejection latency, station heartbeat, pending queue age, replay result, and per-station throughput;
- unexpected anti-passback transitions, repeated credential use across zones, and counter/projection drift;
- GitHub signature failures, Figma passcode failures, duplicate deliveries, and oldest unprocessed provider event;
- separate GitHub, Figma, push, and export Workpool depth, running count, retry count, and oldest-job age;
- external API errors, provider rate-limit budget, and stored retry time;
- missing GitHub topics, repository-set count drift, installation/repository access loss, and per-repository webhook silence;
- Figma metadata age, full-content age, `content_dirty` age, webhook state, and reauthorization count;
- backup/export completion.

### Event operation

- unfilled panel seats;
- attendance sessions with unknown participants, unsafe zone occupancy, long-away flags, or confirmation backlog;
- offline/stale scan stations and pending operations near their recovery limit;
- stale reviewer heartbeat;
- unacknowledged pages;
- long ready/queue waits;
- overdue reviews;
- unsynced reviewer drafts;
- missing scorecards and criterion coverage;
- open corrections and manual records.

Alerts must identify an owner and next action. A metric that nobody watches during the event stays in post-event reporting rather than paging staff.

## 11. Audit records

Audit these actions:

- role and roster changes;
- application assignment, published admission decision, offer, expiry, and waitlist promotion;
- event/rubric/panel-plan publication;
- attendance-plan publication and attendance-session open/extend/close/cancel;
- scan-station assignment/reconfiguration, VIT card enrolment/suspension/rebinding, and external badge issue/replacement/revocation;
- attendance exception, manual reconciliation, emergency roll call, and identifiable attendance export;
- track-catalog, intake-flow, intake-model-config publication and active-session migration;
- after-freeze table changes;
- manual routing or queue priority;
- substitute acceptance or operator assignment;
- presence waiver;
- review extension beyond ordinary allowance;
- scorecard correction or void;
- round close/reopen;
- identifiable export;
- identity repair;
- manual incident import.

Each record stores actor, event, action, target type/ID, server time, previous and new summary, reason, and related incident/support ID.

Routine accepted attendance scans live in the immutable presence ledger rather than the privileged audit log. Routine reads, timer ticks, and draft autosaves are not audit events. Submitted scorecard versions provide their own history.

## 12. NFC, QR, and webhook safety

- Team review QR tokens are opaque, short-lived, round-bound, and revocable.
- Dynamic attendance QR tokens are participant/session-bound, short-lived, single-use, and invalid after credential replacement or session close.
- A phone-read VIT card identifier is sent only to the protected backend, converted to an event-scoped keyed fingerprint, and discarded. It is not the Google/person identity and never appears in logs or exports.
- One VIT card fingerprint maps to one active event membership. Enrolment/rebinding requires a supervised visible card/account match.
- External event-badge QR is a high-entropy revocable bearer credential containing no participant data. The server stores only its hash.
- VIT card and external QR media are treated as presentable/copyable evidence rather than cryptographic identity; supervised stations, anti-passback, rapid suspension/revocation, and anomaly review are required.
- Station direction and zone come from an authenticated versioned station assignment, not the scanned payload.
- Codes use enough entropy to prevent venue guessing and are rate-limited by user/device.
- GitHub webhooks validate `X-Hub-Signature-256` against the raw request body.
- GitHub `X-GitHub-Delivery` values are deduplicated before enrichment is queued.
- Figma webhooks validate the encrypted per-webhook passcode, expected webhook ID, context/file key, and event type. Figma does not provide a GitHub-style HMAC signature.
- Figma deliveries are deduplicated from the webhook, event, file, and provider timestamp fields before a job is queued.
- Webhook endpoints acknowledge accepted envelopes quickly; provider API reads and snapshot work run in bounded Workpools.
- Figma OAuth callbacks and Google auth intents use server-validated state.
- Return URLs are same-origin allowlisted routes.

## 13. Data protection

- Request only provider scopes named in the integration specification.
- Store provider tokens only server-side and encrypt refresh/access tokens with an application key.
- Store one Figma authorization per Figma App/user grant and reference it from team-owned file bindings; never copy refresh tokens into team records.
- Keep auth secrets, Google client secrets, GitHub private key, webhook secrets, Figma secret, Expo credentials, and backup credentials out of client bundles and source control.
- Do not put project text, scores, phone numbers, or provider tokens in push payloads or error logs.
- Do not put attendance bearer values, hashes, exact movement history, or sensitive exception reasons in logs, crash reports, analytics, push payloads, or ordinary exports.
- Do not put intake answer text, generated brief text, OpenAI request content, or system instructions in job metadata, Sentry, or operational metrics.
- Send only project text and published routing definitions required for interpretation; exclude identity, contact, auth, admission, provider-credential, reviewer, and score data.
- Set OpenAI Responses requests to `store: false` and disclose the effective abuse-monitoring/data-retention policy; do not describe it as Zero Data Retention unless that control is approved and enabled.
- Redact auth headers and cookies before Sentry or structured logging.
- Store compressed Figma files, previews, and temporary GitHub source blobs in the private artifact bucket. Reviewers receive short-lived URLs only after assignment and snapshot checks.
- Raw provider payloads and source/design artifacts follow explicit evidence-retention periods; derived judging records keep only the approved manifest and facts.
- Exports containing personal data use restricted storage and an expiry date.
- Presence collection is limited to configured venue-zone boundary and session-confirmation events. GPS, Bluetooth, Wi-Fi, and background participant-phone tracking are excluded.
- Exact attendance events use a shorter approved operational/incident window; longer-lived aggregates contain only fields approved by event policy.
- Data-retention and deletion periods require Board approval before registration.

## 14. Launch gates

- Venue network and backup connectivity tested at every review and attendance station under session-opening load.
- All reviewer/scanner devices pass sign-in, station assignment, push where required, camera, NFC where enabled, secure storage, minimum-build, battery, and pending-replay checks.
- Representative current VIT ID cards from applicable campuses/batches and the Android scanner fleet pass card-technology detection, repeated-read, duplicate, rebinding, wrong-session, conflicting-use, and offline-replay tests; QR remains a complete fallback.
- Two full-population hacking-session transitions are rehearsed with multiple entry, exit, and roving stations, including temporary exits and an emergency roll call.
- Duplicate-submit, stale-write, lost-response, and app-restart tests pass.
- Manual-mode sheets and two-person reconciliation are rehearsed.
- Convex backup download and staging restore are proven.
- Multiple GitHub installations, repository kinds, add/archive/reorder, topic present/missing, duplicate/out-of-order push, fork overlap, partial access loss, and stale per-repository reconciliation are tested.
- Figma PKCE, passcode webhook, view-only fallback, metadata/content divergence, rate-limit backoff, reauthorization, and artifact access are tested.
- Intake publication, generated-question bounds and wording policy, source attribution, prompt-injection fixtures, track changes, stale model output, timeout/refusal/invalid output, disabled-model fallback, and no-model submission are tested.
- A provider-event burst cannot exhaust review writes or the scheduler; Workpool limits and alert thresholds are verified at event scale.
- Operations can pause starts, page a substitute, move a table, handle a wrong QR, and close a round in the rehearsal.
- Attendance operations can redirect an offline station, enrol/rebind a VIT ID, replace a lost external badge, handle a forgotten/unreadable card through QR, reconcile a missed exit, extend/cancel a session, and produce a zone roll call without rewriting scan history.
- No known path can edit another reviewer’s submitted score or grant itself a staff role.

## References

- [Convex transaction behaviour](https://docs.convex.dev/database/advanced/occ)
- [Convex backup and restore](https://docs.convex.dev/database/backup-restore)
- [Expo push notifications](https://docs.expo.dev/push-notifications/overview/)
- [Expo development builds and native libraries](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android NFC overview](https://developer.android.com/develop/connectivity/nfc)
- [Apple Core NFC](https://developer.apple.com/documentation/CoreNFC)
