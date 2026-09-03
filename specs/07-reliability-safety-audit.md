# Reliability and audit

## 1. Failure model

The event must expect:

- crowded venue Wi-Fi and intermittent mobile data;
- reviewer/scanner phones with low battery, denied camera permission, poor focus, or old builds;
- delayed, dropped, or bounced reviewer/participant notifications;
- stale dashboards opened on several staff laptops;
- duplicate scans and lost network responses;
- wrong table, wrong session/station, expired QR, unreadable/forgotten VIT ID, copied external badge, or late reviewer;
- missed entry/exit scans, simultaneous VIT-barcode/QR scans, and an offline replay that conflicts with newer presence;
- OpenAI/Flue, GitHub, Figma, Google, Expo, or Convex service trouble;
- human mistakes during a fast round transition.

The system protects judging records and emergency-accountability data first. If the system cannot safely confirm attendance, operations redirects scanning or marks presence uncertain. If the system cannot safely start or finish a review, operations pauses the affected session, panel, or round. The system never invents acceptance to keep a queue moving.

## 2. Venue network

Code2Create is online-first. Bluetooth and peer-to-peer relay are not part of the release.

Before the final rehearsal, the event team must:

- survey the actual review floor under expected crowd conditions;
- provide a staff/reviewer network separate from the public participant network where possible;
- test each panel zone, stairwell, and overflow area;
- arrange backup cellular routers or managed hotspots;
- provide charging points, power banks, and a labeled spare-device pool;
- record the network owner and escalation contact;
- repeat VIT-barcode/QR attendance bursts, scanner replay, review QR, score-save, and queue tests on the venue network.

The application must work through ordinary HTTPS/WebSocket access. The application cannot assume access to local routers, static device IPs, or custom ports.

Attendance phones use an encrypted, plan-bounded queue only for short recovery. Each scan becomes durable locally before transmission. The scan remains **Pending** until the server returns a receipt. A replay uses the same operation ID and device sequence. The scanner refuses a known-offline portal QR because it cannot prove the one-current token state locally. VIT-ID and event-badge payloads can wait only inside SQLCipher under a device-only key. The payloads expire at the plan limit. Heartbeats expose queue pressure without a credential payload. The aggregate health view identifies phones that await replay. An older replay that conflicts with newer accepted evidence becomes an append-only review item. The older replay cannot rewind a projection.

## 3. Accepted state

Convex stores the accepted event state.

A client may show an optimistic control for a low-risk action such as a Synesthesia vote. A client must not show these actions as accepted before a server response:

- reviewer clock-in or page acceptance;
- participant venue/session presence and VIT-barcode/external-badge binding changes;
- staff queue placement;
- table or panel assignment;
- reviewer presence;
- fresh-project attestation, application submission, post-submission team changes, and proposal revision;
- review start or extension;
- scorecard submission;
- correction;
- round close or reopen.

Each high-impact write includes a stable client operation ID. If the response is lost, the client asks the server whether the server accepted that operation. The client does this check before it creates another operation.

While a command is uncertain, the client shows only the retry for that command. A live state change does not enable the opposite command until the first receipt resolves.

A write that edits an existing object includes the expected version. A stale write returns a conflict and the current state.

## 4. Reviewer draft recovery

The mobile app keeps one encrypted local draft for the active review.

- Score and checkbox changes go to the server immediately when connected.
- Text notes save after a short pause and when the field loses focus.
- Local and server draft versions are visible in diagnostics.
- Pending edits keep their original operation IDs.
- Final submission needs a server confirmation.
- A reviewer with an unsynced submission cannot begin another review.

If the phone fails, operations first tries to recover the active draft on that phone. If recovery fails, the reviewer moves to a spare device. The reviewer re-enters the scorecard from memory or notes under an incident record. The backend never invents a missing score.

## 5. Reviewer page delivery failure

APNs or FCM wakes a reviewer. Push does not hold event state. The system sends push before it starts phone escalation.

For each critical page, the system records:

- page creation;
- push request and provider message identifier when one is returned;
- call-consent version and current consent state;
- outbound-call purpose, script version, dispatch, and provider call identifier;
- provider call events and terminal category;
- app opened time, when known;
- reviewer acceptance/decline;
- expiry;
- fallback owner.

If the reviewer does not acknowledge by the first 30-second repage, the reusable outbound-calling service can place one synthesized call. It can call at once when push has no usable address. The service requires current consent and the page chain's exact `review.substitute.page` grant. It uses the published reviewer-page script. It does not disclose project, score, or participant data. An in-app acknowledgement prevents any later claim. A call already claimed may still proceed, but provider acceptance never becomes reviewer acknowledgement.

If the reviewer does not acknowledge before the page deadline, the dashboard pages the next candidate and tells operations to send a runner. A push or call provider acceptance never suppresses this fallback.

## 6. Device and application failure

### Old build

Clock-in blocks builds below the configured minimum. The reviewer installs the current signed fleet build or uses a prepared spare.

### Camera unavailable

Use the QR fallback code. Presence still requires server validation.

### VIT ID barcode unreadable

The station switches to portal QR or staffed lookup. This switch does not change the attendance session or participant record. Staff enable VIT ID barcode scanning only for card formats that passed the rehearsal.

### Scanner connection loss

The attendance scanner may collect a bounded encrypted pending queue. The scanner shows **Pending**, not **Accepted**. On reconnect, each operation keeps its device sequence and operation ID. The server returns an accepted, duplicate, rejected, or needs-review state. A queue beyond its age or size limit closes the station. The station then directs participants to an online station or the incident procedure.

### Forgotten, replaced, or misused card

A VIT student without a readable VIT ID uses the authenticated portal QR or a staffed exception. Staff immediately suspend a reported lost card under independent exact-person authority. The same transaction cancels any unfinished replacement. Suspension has no resume command. If VIT replaces the card, attendance staff visually verify the participant. Staff scan a different replacement barcode twice under the separate rebind permission. A suspended prior binding remains unusable until the second scan atomically activates the replacement. Presentation of one card at different stations creates an anomaly. It does not open two intervals.

Staff revoke a lost external event badge against its current credential version after a fresh portal-QR identity check. The same transaction cancels any unfinished replacement. Staff then bind a different unused preprinted badge through the normal two-scan issue flow. The old QR fails on the next online scan. Staff never reactivate the old QR.

### Notification permission denied

Clock-in warns the reviewer and operations. Event policy decides whether a reviewer may work with in-app polling plus runner/call fallback.

### Battery or hardware failure

Revoke the old device, register a spare, resolve any active draft, then resume or replace the reviewer.

### App crash

On restart, the app restores the current session. The app fetches `reviewer.now` and opens the encrypted active draft. The app then resolves pending operation IDs.

## 7. External service failure

| Service                                      | Effect                                                                                                               | Event response                                                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google/Better Auth                           | New sign-ins or fresh-session checks fail.                                                                           | Existing valid sessions continue. Support moves signed-in staff or reviewer work to prepared devices where allowed.                                                                                                                                |
| Convex                                       | Core reads or writes fail.                                                                                           | Pause authoritative attendance acceptance and new reviews. Scanner events remain visibly pending within limits. Current reviewer drafts stay local. Start the incident procedure.                                                                  |
| OpenAI embeddings or Convex vector search    | A live novelty preview is slow, rate-limited, invalid, stale, or unavailable.                                        | Keep the idea editable and submittable. Show a quiet unavailable state. Never reuse or attach a result if its team, corpus, or normalized input fingerprint changed.                                                                               |
| OpenAI intake                                | Interpretation is slow, refused, invalid, rate-limited, or unavailable.                                              | Keep the committed answer. Follow the published deterministic question edge. Allow proposal confirmation and submission without model output.                                                                                                      |
| OpenAI admissions                            | Structured analysis is slow, stale, refused, invalid, rate-limited, or unavailable.                                  | Mark the recommendation unavailable or stale. Continue the complete human review and decision path. Never reuse output for a different application version.                                                                                        |
| Cloudflare intelligence Worker or OpenAI     | Signed dispatch fails, the agent does not publish, the callback is invalid, or work exceeds ten minutes.             | Mark that brief failed. Retain the ordinary realtime health view. Let every operational workflow continue. Never infer or execute a corrective command.                                                                                            |
| APNs or FCM                                  | Background pages may not arrive or a native token may expire.                                                        | Invalidate only the rejected token. Retain the in-app page. Use consented call escalation and the runner fallback.                                                                                                                                 |
| Outbound call provider                       | A call is rejected, delayed, duplicated, or has an ambiguous result.                                                 | Keep the in-app page authoritative. Deduplicate provider events. Do not redial an unknown result without the configured rule. Use the next candidate or runner fallback.                                                                           |
| Cloudflare Email Service                     | A decision-delivery request is delayed, rejected, ambiguous, bounced, or suppressed. The Queue relay is unavailable. | Keep the portal authoritative. Expose transport state only under exact-person communications permission. Never retry an unknown outcome blindly. Retain Queue events through the configured DLQ. Use the approved Email Routing support alias.     |
| GitHub                                       | Push delivery or one repository reconciliation fails.                                                                | Keep every other repository current. Retain the failed repository's last verified checkpoint. Show partial completeness. Accept live or manual evidence.                                                                                           |
| Synesthesia or licensed playback application | Requests, queue state, or operator playback is unavailable.                                                          | Stop promising or accepting music actions. Keep the licensed application's manual controls with the named operator. Leave every core event flow running.                                                                                           |
| Figma                                        | Metadata, full content, comments, or previews cannot refresh.                                                        | Keep the committed raw checkpoint. Show render state, counts, and each freshness time. Obey the provider retry time. Accept live or manual evidence.                                                                                               |
| Cloudflare web delivery                      | The participant, operations, or handbook frontend fails. Dynamic attendance QR presentation may also fail.           | Enrolled VIT ID barcodes, issued external badge QR codes, and the Expo app can continue if Convex is healthy. Operations uses its prepared incident pack and alternate connectivity. The repository Markdown remains the handbook source of truth. |
| Private S3                                   | A new emergency pack, protected export, or evidence preview cannot be stored or opened.                              | Keep current live Convex state authoritative. Do not claim that the artifact is ready. Use only an already printed, unexpired pack under incident policy. Escalate storage recovery.                                                               |
| PostHog                                      | Analytics and crash reports are delayed.                                                                             | Event functions continue. Use Convex and operations logs.                                                                                                                                                                                          |

GitHub or Figma downtime does not block a review. The reviewer sees that evidence is stale and records what was demonstrated.

### Participant email failure

The decision mutation commits the application before any Cloudflare network call. The same mutation commits one pending delivery per locked team member. The scheduled action claims one record for 30 seconds. The action calls the Email Sending REST API for exactly one verified recipient. A structured Cloudflare error that proves non-acceptance may cause a retry after five seconds and after 30 seconds. The limit is three total claims. Cloudflare documents no send idempotency key. Therefore, a timeout, invalid success response, recipient-outcome mismatch, or expired claim immediately becomes terminal `unknown`. The action never reclaims an `unknown` delivery. This rule prevents an accidental duplicate send.

Cloudflare Email Sending lifecycle events enter an event-scoped Queue. The email Worker validates the schema version and sending domain. The Worker removes subject, SMTP, and content fields. The Worker maps `delivered`, `deferred`, `bounced`, `failed`, `rejected`, and `complained` into the bounded internal contract. The Worker HMAC-signs the exact callback body and millisecond timestamp. Convex verifies the signature and age before it parses the body. Convex stores the Cloudflare event ID and payload hash. Convex accepts events that arrive before the send response. Convex orders events with the same time by event ID. A hard bounce, provider suppression, or complaint disables only that exact verified-email destination. A soft exhausted bounce does not disable the destination. The Queue consumer retries callback transport failures. The consumer sends exhausted messages to its DLQ. The consumed contract does not contain open or click events. Therefore, these events cannot become acknowledgment telemetry.

An operator may create one new append-only attempt only from a definitive `failed` state. The source must still be the latest retry for its decision/member root. The mutation rechecks the human decision and application version. It also rechecks the active destination, current Google-verified email, and exact-person `communications.delivery.manage`. The mutation requires a current scoped authorization. It also requires the expected delivery version, reason, and client operation ID. Records in `unknown`, bounced, suppressed, pending, sending, delivered, or superseded state cannot use this path.

## 8. Core-backend incident

When the core backend cannot confirm state:

1. operations opens an attendance- or review-backend incident; every staff dashboard with `incident.read` for it receives the live banner;
2. an operator with exact-round `review.round.pause` and read access to that review incident pauses new team calls and review starts;
3. teams keep their queue positions, while active reviewers keep current drafts open and finish the current team;
4. the named incident commander, whose assignment materializes incident-scoped permissions regardless of role, checks provider status, venue network, and a second connection;
5. attendance operations stop or redirect affected stations, preserve pending status, and record the last confirmed zone snapshot;
6. operations records affected panels and last confirmed server times;
7. the named incident commander chooses recovery, relocation to backup connectivity, or manual mode.

No staff member starts an unofficial spreadsheet while normal service may recover.

The active pause has its own record. It is not a `paused` round status. Pause and resume require a current scoped authorization, current versions, a reason, and a stable operation ID. Both commands update the round version in the same transaction. New-call, start-review, round-close, and incident-resolution mutations read the pause record. Therefore, a concurrent command either commits before the pause or retries and rejects. Participants and reviewers receive only the generic pause state. Incident text remains restricted to `incident.read`.

### Manual mode

Creation of an attendance- or review-backend incident requires event-scoped `incident.create`. The command requires an explicit affected service and a current scoped authorization. Manual mode then requires approvals from two different people. Each person must hold `incident.manual_mode.approve` for that exact incident. Each approval is versioned, reasoned, authorized, and idempotent. One person cannot supply both approvals. A role label cannot substitute for the grant.

Use numbered original paper sheets from the printed incident pack. An authorized operator prepares and prints a current pack during each planned readiness window. The backend and private artifact store must be healthy during preparation. Do not generate the pack for the first time after both services become unavailable. The cover states its purpose, logical snapshot time, four-hour expiry, source checksum, and chain-of-custody fields. Operations retains one controlled original. Operations destroys expired unused copies under policy. Operations never photocopies a sheet or reuses a serial.

Pack preparation, history, and print opening use independent event-scoped permissions. Preparation requires a current scoped authorization. Every print open has the same requirement. The stored HTML is a private exact-version S3 object. The snapshot and bytes have separate SHA-256 checksums. Each print link lasts no more than 60 seconds or the remaining pack life, whichever is shorter. The system audits printing. Printing does not open an incident, approve manual mode, or authorize an import.

One attendance sheet binds to one approved incident and one open attendance session. It also binds to one session zone, one compatible session station and station-configuration version, one serial/revision, and one transition. The sheet contains 1–25 numbered rows. Each row records:

- the exact event-membership ID, VIT registration number, or active external-badge reference used to resolve one accepted participant in the frozen session cohort;
- local time and operator initials;
- an optional replacement/correction reason.

The first operator needs `attendance.manual_sheet.enter` for that exact session. The operator creates the immutable draft rows. The operator attaches one browser-compressed JPEG under 900 KB. The storage manifest records the private storage ID, content type, byte count, and SHA-256 digest. The image is available only through an authorized byte-returning action. The system never exposes the image through a reusable public file URL.

Use a review sheet only for a review that reached `active | overdue` before service failed. The sheet records:

- event, round, team, panel, table, and serial number;
- all present reviewers and signatures;
- start/end time;
- rubric version;
- the pinned evidence-checkpoint set, criteria, raw ratings, private notes when written, shared findings, and commitments;
- reason normal service was unavailable.

Attendance and review sheets have separate access boundaries. An attendance verifier needs `attendance.manual_sheet.verify` and `attendance.manual_sheet.source.read` for the exact attendance session. A review verifier needs `review.manual_record.verify` and `review.manual_record.source.read` for the exact review. Each verifier needs a current scoped authorization. The verifier must differ from the entrant. Before import, the verifier must attest that the numbered original is filed.

The entrant hashes and validates the JPEG before storage. A retry checks the operation ID and stable source manifest before another upload. Concurrent copies of the same operation converge on the first committed storage object and delete the extra object. A different checksum, byte count, normalized file name, target, or expected draft version is not accepted as the completed upload.

An accepted import creates append-only `manual_import` presence events with sheet and line provenance. The import uses the same session-transition and projection logic as an online scan. A paper time that is not later than current evidence creates a linked `needs_review` event. The newer projection remains unchanged. The session cannot begin closing while a linked sheet is still draft or submitted. The incident cannot resolve during that time. The transaction rejects duplicate active serials, reused source files, repeat line imports, stale sheet or session versions, and concurrent verification.

Saving a paper-review draft freezes ordinary draft and submit commands for its existing scorecards. Review import is all-or-nothing. The server rechecks the incident, round, active review, panel/table, rubric, and evidence-checkpoint set. It also rechecks assignments, scorecard versions, complete criterion coverage, signatures, required shared notes, and the source checksum. In one transaction, the server creates reviewer-attributed scorecard versions that carry the manual-record ID. The server computes the ordinary evaluation and completes the existing review/team state in the same transaction. The server never creates a score for a blank paper field. Pending review records block ordinary completion, incident resolution, and round close.

Manual records never look like normal app submissions.

## 9. Backups and round exports

Production uses a Convex plan with periodic daily backups including file storage.

Required actions:

- take and download a manual backup before event check-in opens;
- freeze one normalized team-outcome snapshot while each round is `closing`;
- generate the round JSON and CSV directly in private KMS-encrypted, versioned S3 outside the Convex deployment;
- record and read back each exact S3 object version, byte count, and SHA-256 checksum;
- have a different staff member with independent read/verify grants open both files and compare team, result, exclusion, withdrawal, selected-review, scorecard, scorecard-version, correction, and paper-record counts;
- change the round to `closed` only after the backend re-verifies both stored objects and the second person confirms them;
- take and download a final backup after the event;
- rehearse a restore into staging before launch.

The repository provides two operator commands:

```text
pnpm recovery:backup --event-slug code2create-7 --purpose pre_event \
  --operator-id <event-person-reference> --source-deployment <production-reference> \
  --source-release-id <release-reference>

pnpm recovery:rehearse --manifest <manifest-path> \
  --staging-deployment <staging-reference> \
  --confirm-staging-deployment <same-staging-reference> \
  --operator-id <event-person-reference> --reason <reason>
```

`recovery:backup` calls the installed Convex CLI through pnpm. The command always includes Convex file storage. It writes the ZIP, manifest, and receipt with owner-only local permissions. It inventories every ZIP path. The command parses, canonicalizes, and hashes each JSONL record. It compares the records without depending on line order. The command hashes stored files byte-for-byte. It uploads the ZIP and manifest under an event `backups/` prefix. The upload uses KMS encryption, `If-None-Match`, bucket versioning, SHA-256, and exact-version read-back checks.

`recovery:rehearse` accepts that versioned manifest. Before any write, the command downloads the exact S3 object version. It verifies the byte count, SHA-256, paths, record counts, canonical record digests, and stored-file hashes. The command then:

1. requires the target and a second typed confirmation to equal `C2C_STAGING_DEPLOYMENT`;
2. refuses `prod`, `production`, `dev`, `local`, or the configured production deployment;
3. uploads an exact pre-restore staging backup;
4. runs Convex ZIP import with `--replace-all --yes` against the named staging deployment;
5. exports staging again with file storage;
6. compares the new inventory with the production manifest; and
7. stores a versioned pass/fail result in the recovery prefix.

Production-read, staging-write, and recovery-S3 credentials are separate operator secrets. The script passes only the required Convex deploy key to each child command. These credentials do not enter Convex environment variables, a browser bundle, the event app, or the running application identity. The checked-in environment template is `apps/backend/scripts/recovery/recovery.env.example`.

The round export covers adjudicated judging outcomes. It does not cover attendance or the entire database. Attendance exports and Convex backups have separate manifests, permissions, retention, and restore tests. A failed round export leaves the round frozen in `closing`. The export may retry without changing its snapshot. Reopen keeps the verified revision and files as superseded history. Reopen never overwrites them.

Convex backups contain table data and stored files, but not deployed code, environment variables, or pending scheduled functions. Source control and the secret inventory cover those separately.

A production restore is destructive. The staging rehearsal command does not expose this function. When possible, the incident commander takes a new backup first. The incident commander records the chosen object key, version, checksum, release, and environment state. The commander then follows the rehearsed runbook. Production restore stays behind a separate recovery IAM identity. It also stays behind the event's configured one- or two-person approval rule. The planned `recovery.restore.approve` event permission does not enter the deployed catalog until its approval record and protected command ship together. A role is never a substitute.

## 10. Monitoring

### Technical

- Convex function failures and latency;
- failed auth callbacks and roster claims by reason;
- intake answer-save latency; intake Workpool depth/age; model success, refusal, invalid, question-policy rejection, timeout, rate-limit, stale, and fallback rates by configuration version;
- novelty-preview request/terminal latency, cache-hit, team-rate-limit, provider-invalid, provider-timeout, vector-index-empty, sensitive-input-suppression, and stale-attachment counts by corpus version without idea text, fingerprints, nearest themes, prompts, vectors, similarities, or scores;
- admission-analysis Workpool depth/age, success/invalid/refusal/timeout/stale/unavailable rates by policy/model version, and aggregate human used/cleared/overridden disposition;
- operations-intelligence scheduler due lag, policy and state version, durable inbox depth/oldest age, continuation age, and trigger outcome counts;
- operations-intelligence active-run age, current submission head, renewable lease, continuation/abort retry state, signed-dispatch acceptance, callback outcome, and agent or model version;
- operations-intelligence invalid, revoked, conflicting, replayed, and settled operation counts without snapshot, prompt, reasoning, tool, or output content;
- participant email queue age and pending/sending/retry-wait/sent/delayed/delivered/bounced/failed/suppressed/unknown state by template/channel without recipient content, plus signed-webhook age, duplicates, unmatched provider message IDs, and disabled-destination count;
- web/reviewer crashes by release;
- subscription reconnect rate;
- attendance scan acceptance/duplicate/rejection latency, station heartbeat, pending queue age, replay result, and per-station throughput;
- unexpected anti-passback transitions, repeated credential use across zones, and counter/projection drift;
- active roll-call age, expected-versus-shard drift, unresolved/unknown count, and zone with more than one attempted active roll call;
- unexpired emergency-pack generation failures and pending generation older than the bounded export window;
- GitHub signature failures, Figma passcode failures, duplicate deliveries, and oldest unprocessed provider event;
- Synesthesia active-window/request/report state, stale-write failures, pause state, and last playback acknowledgment without participant note/report text;
- separate GitHub, Figma, reviewer-push, and export Workpool depth, running count, retry count, and oldest-job age, plus participant-email scheduler claim/retry age;
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
- active round pauses, their age, linked incident, and whether any connected client still offers a start control;
- open live corrections, open post-session result-review cases, stale remedy-decision conflicts, and manual records.

Each alert must identify an owner and the next action. A metric that no person watches during the event stays in post-event reporting. That metric does not page staff.

## 11. Audit records

Audit these actions:

- person lookup/export where policy requires it; role and roster changes; bundle publication/application/migration; and every permission grant, delegation, expiry, and revocation with the exact authorizing grant; one direct batch audit must enumerate every affected grant and the target access-version change;
- final application member lock, proposal revisions, stale-output invalidation, and exceptional member-snapshot correction;
- application-review assignment/cancellation/completion with source-grant IDs and application versions, AI admission recommendation generation/version/disposition, published human admission decision, offer, expiry, and waitlist promotion;
- communications-policy draft replacement/publication with exact version/checksum and participant-notification retry/destination disablement with the delivery's pinned policy version;
- event/rubric/panel-plan publication;
- attendance-plan publication and attendance-session open/extend/close/cancel;
- scan-station assignment/reconfiguration, VIT ID barcode enrollment/suspension/rebinding, and external badge issue/replacement/revocation;
- attendance exception, manual reconciliation, and post-session result-review open, approve, or decline with the frozen before and after result;
- emergency roll-call start or close with snapshot, final counts, and checksum;
- identifiable attendance-export request or download with purpose, fields, expiry, row count, and checksum;
- emergency-pack request or print-open with purpose, expiry, counts, and both checksums;
- atomic intake-policy, novelty-corpus draft/import/publication, event-phase, checkpoint-plan, and admission-model-config publication;
- reviewer call-consent changes, page push attempts, call attempts, provider events, acknowledgement, cancellation, and escalation;
- after-freeze table changes;
- support-case creation, reporter reply, public/internal note, state transition, and owner change with the authorizing grants and case version;
- manual routing or queue priority;
- substitute acceptance or operator assignment;
- reviewer-presence waiver and participant-availability waiver, including exact scope, observed/published counts where applicable, authorizing grants, actor, reason, review version, and time;
- review extension beyond ordinary allowance;
- incident-linked round pause and resume;
- scorecard correction or void;
- round close/export start, protected file download, retry, independent verification/close, and reopen/supersede;
- identity repair;
- manual incident import;
- operations-autonomy policy draft, publication, and kill switch, including actor, authorizing grants, policy version/checksum, mode, enabled state, reason, and prior/current policy reference;
- manual operations-intelligence brief request, including requester, source projection time/checksum, result state, and agent/model version without copying brief text into the privileged audit summary.

Each record stores the actor, event, action, target type/ID, server time, previous summary, new summary, reason, and related incident/support ID.

Routine accepted attendance scans remain in the immutable presence ledger, not the privileged audit log. Routine Synesthesia requests, votes, reports, and playback acknowledgements remain in their domain ledgers. Privileged catalog, window, moderation, report-resolution, scheduling, playback, and access commands also record their scoped audit event. Routine reads, timer ticks, and draft autosaves are not audit events. Submitted scorecard versions provide their own history.

Scheduled and signal-triggered autonomy runs are domain history, not human audit events. The scheduler claim, trigger provenance, frozen policy/source checksums, idempotent operation receipts, durable checkpoint, model/agent version, recommendation links, and terminal result record what the machine observed and produced. Audit counters describe work already performed; they do not constrain future reasoning. The system does not invent a human actor for a cron tick. Manual run requests, policy changes, kill-switch use, and later recommendation decisions retain their real human actors.

## 12. Barcode, QR, and webhook safety

- Team review QR tokens are opaque, short-lived, round-bound, and revocable.
- Dynamic attendance QR tokens are participant/session-bound, short-lived, single-use, and invalid after credential replacement or session close.
- Send a camera-decoded VIT ID barcode value only to the protected backend. Convert the value to an event-scoped keyed fingerprint, then discard the value. The value is not the Google/person identity and never appears in logs or exports.
- One VIT ID barcode fingerprint maps to one active event membership. Enrollment/rebinding requires a supervised visible card/account match.
- External event-badge QR is a high-entropy revocable bearer credential containing no participant data. The server stores only its hash.
- The bounded badge generator writes a new print artifact with QR geometry and short references only. It produces no plaintext bearer manifest. It refuses to overwrite an existing file. One batch contains at most 500 badges. Control the HTML and unused printed cards as physical credentials.
- Treat VIT ID barcodes and external QR media as presentable and copyable evidence, not cryptographic identity. Require supervised stations, anti-passback, rapid suspension or revocation, and anomaly review.
- Station direction and zone come from an authenticated versioned station assignment, not the scanned payload.
- Codes use enough entropy to prevent venue guessing and are rate-limited by user/device.
- GitHub webhooks validate `X-Hub-Signature-256` against the raw request body.
- GitHub `X-GitHub-Delivery` values are deduplicated before enrichment is queued.
- Figma webhooks validate the encrypted per-webhook passcode, expected webhook ID, context/file key, and event type. Figma does not provide a GitHub-style HMAC signature.
- Figma deliveries are deduplicated from the webhook, event, file, and provider timestamp fields before a job is queued.
- Convex-to-intelligence dispatch and intelligence-to-Convex callback use different environment-specific HMAC secrets. They also use different fixed signature contexts. Each signature covers the exact raw body and millisecond timestamp. Requests outside the five-minute window fail before domain settlement. Malformed signatures, oversized bodies, and unexpected fields also fail before domain settlement.
- One operations brief ID is also the create-only Durable Object identity. A retry may acknowledge that identity. The retry cannot submit another model run. Convex accepts only the matching frozen source checksum. Convex also accepts only the first terminal callback or timeout.
- One autonomy scheduler evaluation can commit each distinct due work item once. Schedule slots and signal fingerprints are canonical and policy-scoped; a currently active run never erases another distinct item. Inbox insert, exact-trigger deduplication, recovery claim, and next evaluation share one Convex transaction.
- Webhook endpoints acknowledge accepted envelopes quickly; provider API reads and snapshot work run in bounded Workpools.
- Figma OAuth callbacks use server-validated state. Better Auth creates and validates Google OAuth state.
- Return URLs are same-origin allowlisted routes.

## 13. Data protection

- Request only provider scopes named in the integration specification.
- Store provider tokens only server-side and encrypt refresh/access tokens with an application key.
- Store one Figma authorization per Figma App/user grant. Reference that authorization from team-owned file bindings. Never copy refresh tokens into team records.
- Keep auth secrets, Google client secrets, GitHub private key, webhook secrets, Figma secret, Expo credentials, and backup credentials out of client bundles and source control.
- Do not put project text, scores, phone numbers, or provider tokens in push payloads or error logs.
- Do not put attendance bearer values, hashes, exact movement history, or sensitive exception reasons in logs, crash reports, analytics, push payloads, or ordinary exports.
- Do not put support descriptions, replies, internal notes, reporter contact, or linked-record identifiers in PostHog, push payloads, or aggregate health signals. Reporter queries exclude internal actions.
- Do not put proposal text, novelty input, fingerprint, vector, or similarity, generated brief text, admission recommendation explanations, OpenAI request content, or system instructions in job metadata, PostHog, or operational metrics.
- Treat every Flue initial-data snapshot and durable agent message as stored service data. Send only the purpose-built aggregate health projection. Keep traces content-free. Never log the snapshot, prompt, model output, callback body, signature, or HMAC secret.
- Treat autonomous-run source snapshots and Flue history as the same restricted intelligence retention class. Metrics may use state, age, area/severity counts, policy/model/agent versions, cumulative activity counters, phase, and terminal category, but not the frozen snapshot, raw read results, prompt, reasoning, tool arguments/results, or private model prose.
- Intake requests send only project text and published routing definitions required for interpretation; they exclude identity, contact, auth, admission, provider-credential, reviewer, and score data.
- Novelty-preview requests send only the normalized idea to `text-embedding-3-small`. A deterministic sensitive-pattern check suppresses the call when it detects contact, registration, URL-credential, or secret material. The request ledger stores only the character count, corpus/team/person references, and an input fingerprint. Participant queries expose only the current whole-number score and comparison state. They do not expose the fingerprint, vector, raw nearest summary, source key, similarity, or provider request ID.
- Admission-analysis requests send only redacted submitted proposal answers, deterministic experience band, and the published admission rubric. They exclude identity, contact, institution-prestige data, human review or decision state, capacity, attendance, integrations, and judging data.
- Outbound call requests contain only the destination, approved purpose, script version, bounded page facts, locale, consent proof, and idempotency key. Logs and provider metadata do not contain proposal, participant, reviewer-note, or score data.
- Set OpenAI Responses requests to `store: false`. Disclose the effective abuse-monitoring and data-retention policy. The embeddings endpoint has no `store` request field. Disclose its effective account-level data controls separately. Do not describe either path as Zero Data Retention unless that control is approved and enabled.
- Redact auth headers and cookies before PostHog or structured logging.
- Store compressed Figma files, previews, and temporary GitHub source blobs in the private artifact bucket. Reviewers receive short-lived URLs only after assignment and snapshot checks.
- Figma's temporary render URL is untrusted transport, not stored evidence. Download it server-side, validate the bounded PNG, copy it to the approved bucket, and expose only the copied object through the fixed-review access path.
- Raw provider payloads and source/design artifacts follow explicit evidence-retention periods; derived judging records keep only the approved manifest and facts.
- Exports containing personal data use restricted storage and an expiry date.
- Each identifiable attendance CSV is one prepared-session snapshot. It uses an allowlisted column set and neutralizes spreadsheet formulas. It excludes exact movement history, credentials, QR/bearer material, and exception reasons. Only the requester can obtain a download. The request and download each require the exact export grant and current scoped authorization. The final download check binds the record version and checksum. The check returns a signed URL that expires at the earlier of 60 seconds or the export expiry.
- Emergency packs contain only the accepted venue cohort. They include the restricted contact/VIT references, last accepted presence, team, and hall placement required for incident work. Each pack is a private, purpose-labeled, checksum-pinned, four-hour record. The list query returns only metadata. Every short print open rechecks the separate grant and current authorization.
- Presence collection is limited to configured venue-zone boundary and session-confirmation events. GPS, Bluetooth, Wi-Fi, and background participant-phone tracking are excluded.
- Exact attendance events use a shorter approved operational/incident window; longer-lived aggregates contain only fields approved by event policy.
- Data-retention and deletion periods require Board approval before registration.

## 14. Launch gates

The release rehearsal is one stored run. It is not a checklist copied into chat or a spreadsheet. The server-owned template creates all 62 scenarios with their expected state and recovery action. Named workstream owners cover the run before it starts. Operators record each attempt and rerun against the current scenario version. After all scenarios pass, the final signer uses a separate permission. A completed run preserves its template version, action history, owners, signer, summary, and timestamps.

- Venue network and backup connectivity tested at every review and attendance station under session-opening load.
- All reviewer and scanner devices pass sign-in, station assignment, push, call-consent, camera, secure-storage, minimum-build, battery, and pending-replay checks.
- Representative current VIT IDs from applicable campuses/batches and the scanner fleet pass barcode-symbology detection, repeated-scan, duplicate, rebinding, wrong-session, conflicting-use, glare/wear, and offline-replay tests; portal QR remains a complete fallback.
- Two full-population hacking-session transitions are rehearsed with multiple entry, exit, and roving stations, including temporary exits and an emergency roll call whose sharded live counts converge and freeze correctly at close.
- Duplicate-submit, stale-write, lost-response, and app-restart tests pass.
- A current emergency pack is prepared, checksum-checked, printed, held under chain of custody, used for one attendance and one already-active review scenario, and reconciled through the two-person flows; opening or printing it alone never enables manual mode.
- Convex backup download and staging restore are proven.
- Multiple GitHub installations, repository kinds, add/archive/reorder, full-set reorder races, topic present/missing, duplicate/out-of-order push, fork overlap, partial access loss, and stale per-repository reconciliation are tested. The GitHub team projection is also checked after connection, add, archive, sync start/success/failure, and webhook transitions; exact SHA overlap is deduplicated, while a comparison beyond the bounded commit page or a project-root binding remains visibly partial.
- Figma PKCE, passcode webhook, view-only fallback, metadata/content divergence, exact-version render selection, null/invalid/oversized render handling, lease expiry, stale completion, rate-limit backoff, reauthorization, and raw/preview artifact access are tested. The Figma team projection is checked after connection, file, metadata, full-sync, preview, and webhook transitions; a 30-team integration board reads one provider summary per team and performs no file/snapshot/preview fan-out until one team is expanded.
- Intake tests cover two fixed questions, two generated-or-fallback slots, grounding, source attribution, prompt injection, answer revision, stale output, queue and provider deadlines, refusal, invalid output, no-model submission, idempotent fallback settlement, and late-result rejection.
- Final preview and membership-lock races are tested. Proposal revision tests cover the deadline, immutable versions, assignment rebinding, and stale human and AI output. Admission tests cover human use, clear, override, provider failure, and the prohibition on model-authored decisions or judging output.
- Reviewer paging tests cover push-first order, consent grant and revocation, call delay, acknowledgement races, duplicate and out-of-order provider callbacks, retry rules, script version, audit, next-candidate fallback, and runner fallback.
- Operations-intelligence signature-context separation, body/time bounds, create-only dispatch retry, strict output parsing, source citation/checksum validation, first-settlement race, timeout, permission revocation, provider failure, and absence of every domain command are rehearsed against the staging Worker.
- Autonomy policy read/draft/validate/publish/disable separation, competing drafts/publications, duplicate due evaluation, canonical signal/schedule deduplication, distinct-work retention during a claimed run, durable continuation, authority revocation, kill-switch abort, and disabled-policy behavior are rehearsed against staging Convex.
- Every allowed read tool has complete, empty, owner-boundary, maximum-window, overflow, redaction-canary, and injected-text fixtures. Planner/investigator/critic evaluations assert source attribution, counter-hypothesis handling, explicit uncertainty, stable target versions, policy allowlists, and rejection of unsupported or incomplete-window claims.
- Provider and durable-runtime tests cover authorization before every model boundary, unlimited durable internal reasoning, bounded transport slices that checkpoint and continue, strict single-flight effect delivery, operation A replay after later operation B, lost read/proposal/callback receipts, fingerprint conflict, traversal of every page without a hidden total read cap, Worker restart, kill-switch abort, policy/owner/event revocation, and late callbacks. They do not misstate an at-least-once provider retry as physical exactly-once delivery or a per-request transport ceiling as an intelligence limit.
- Selected-team next steps/Discord and participant-email delayed/delivered/bounced/failed/unknown states are rehearsed; signed duplicate and out-of-order callbacks converge, manual retry is limited to definite failure, and no provider state is treated as acknowledgment.
- Participant, reviewer, exact-case staff, and event-wide staff support paths are rehearsed together: public replies converge, internal notes stay hidden, stale writes fail, lost responses do not duplicate actions, assignment grants no access, and grant revocation takes effect on the next query/command.
- The final licensed Synesthesia catalog/account, named operator/moderator grants, duplicate request/vote/report races, one-playing invariant, pause/close conflict, privacy boundaries, access suspension, and manual failure response are rehearsed with several participant and operations clients.
- A provider-event burst cannot exhaust review writes or the scheduler; Workpool limits and alert thresholds are verified at event scale.
- Operations can pause calls and starts against an active incident. Operations can observe the generic pause on participant and reviewer clients, finish an active review, and resume through a separate exact-round grant. Operations can page a substitute, move a table, handle a wrong QR, and start a round export. Operations can recover one failed generation, have a different person verify and close it, and reopen and re-close to a higher preserved revision in the rehearsal.
- Attendance operations can redirect an offline station, enroll or rebind a VIT ID, and replace a lost external badge. They can handle a forgotten or unreadable card through QR and reconcile a missed exit. They can extend or cancel a session, review a finalized-result dispute without rewriting scan history, and produce a zone roll call.
- A review call and start both react to the current transactionally maintained team-presence row; an ordinary below-minimum command changes nothing, while one freshly authenticated exact-team/review waiver survives only for its review and races safely with movement, start, and another waiver attempt. Event-scale review-board reads do not fan out through every member's venue row.
- The production-shaped release run contains all 62 required scenarios, every workstream has an active accountable owner, every failure or block has a recorded recovery/rerun, and a separately authorized current-session signer completes it only after all 62 pass.
- No known path can edit another reviewer’s submitted score, authorize from a role label, or grant itself a permission outside an already-held delegation ceiling.

## References

- [Convex transaction behavior](https://docs.convex.dev/database/advanced/occ)
- [Convex backup and restore](https://docs.convex.dev/database/backup-restore)
- [Expo Notifications native device tokens](https://docs.expo.dev/versions/latest/sdk/notifications/)
- [Firebase Admin Cloud Messaging](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)
- [Apple token-based APNs connections](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [Expo Camera barcode scanning](https://docs.expo.dev/versions/latest/sdk/camera/)
- [Flue Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Flue agent API](https://flueframework.com/docs/reference/agent-api/)
