# Attendance and presence

## 1. Purpose

Attendance is an event-operations system. Admission, judging, and reviewer presence are separate systems.

It answers four different questions:

1. **Staffed arrival:** Did an authorized desk operator verify this confirmed participant’s identity and eligibility?
2. **Venue presence:** Is this participant currently inside a tracked event zone?
3. **Session attendance:** Did this participant confirm presence for this scheduled hacking session?
4. **Current availability:** Is the participant present, temporarily outside the zone, or in an unresolved state right now?

The system supports emergency roll calls, session planning, and accurate floor operations. It does not score productivity, track continuous location, or disqualify a participant automatically.

Reviewer presence and team hall mapping are separate workflows. A reviewer scans the review-presence team QR for one review session. A floor mapper scans the hall-location team QR and records roughly where in the hall the team is sitting. A participant presents an attendance credential for venue and hacking-session presence. Each command rejects the QR prefix from another workflow.

## 2. Operating concepts

| Concept              | Meaning                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Venue check-in       | The first staffed identity and eligibility check on arrival                                |
| Attendance session   | A configured time block such as hacking, briefing, review preparation, or overnight access |
| Tracked zone         | A physical boundary where entry and exit scans have operational meaning                    |
| Session confirmation | A participant-specific scan proving presence for one attendance session                    |
| Presence event       | An immutable accepted, duplicate, rejected, or reconciled scan attempt                     |
| Presence interval    | Time between an accepted entry/confirmation and the corresponding exit or session close    |
| Attendance result    | A policy interpretation derived from events and intervals, never the source record         |
| Result-review case   | An append-only request to review one exact finalized participant/session result            |

Staffed arrival, venue presence, and session attendance do not replace one another. A participant can complete the arrival desk before entering the venue. A participant who is already inside must still confirm each new hacking session.

## 3. Configurable attendance plan

An event publishes an immutable attendance-plan version before participant check-in opens. The plan defines:

- session kinds and participant-facing names;
- scheduled start and end;
- check-in opening, grace, and late-arrival windows;
- expected cohort, such as all admitted participants, volunteers, finalists, or an explicit list;
- required, optional, or information-only status;
- tracked zones and valid scan stations;
- allowed methods by participant class: VIT ID barcode, external event-badge QR, portal QR, staffed confirmation, or manual exception;
- the maximum encrypted offline queue size and maximum replay age, constrained to 1–25 scans and 30–600 seconds;
- temporary-exit behavior and the duration after which operations receives an away alert;
- whether a minimum presence duration or one or more checkpoints are required;
- whether a review call/start requires a configurable minimum number of currently available team members;
- excused-absence and accessibility rules;
- raw-event, aggregate, and export retention.

There is no global hard-coded attendance percentage. Different sessions can use different rules. A session can record presence without enforcing a minimum.

Before a session opens, a replacement published plan can change its time, zones, or expected cohort. The session becomes an operational record when preparation of the expected cohort starts. Open, extend, close, and cancel commands require `attendance.session.manage` for the exact session. Each command also requires the current version. A command that can retry requires a stable operation ID. Each command that changes a bound requires a reason. No command rewrites the scan ledger.

The server accepts an extension only while the session is open and before its current accepted end. The extension adds 1–1,440 whole minutes to the accepted end and late-arrival close. It cannot cross the configured event end. The same transaction increments the session version. Competing extend, close, cancel, and scan operations use one authoritative version and server order. An operator cannot extend a session after its accepted end.

A replacement plan cannot publish while a current-plan session is `preparing`, `ready`, `open`, or `closing`. Staff must cancel a prepared session first so its participant projections reach a terminal result instead of becoming orphaned. When replacement is allowed, one publication transaction performs these actions:

- It disables each station from the old plan.
- It revokes each assigned phone.
- It revokes only the grants that came from that station assignment.
- It advances each affected operator's access version once.
- It supersedes the old plan.
- It publishes the new plan.

The server accepts a scan, enrollment, or heartbeat only for a station in the current published plan.

The schedule may contain gaps, meals, rest periods, optional workshops, and overnight access. The software does not assume every minute of the 48-hour event is one continuous mandatory hacking block.

One plan contains at most 32 zones, 64 sessions, and 128 scanner stations. Sessions can overlap for different cohorts. An optional workshop can also overlap a broader hacking block. The system evaluates presence separately for each session. Draft creation, publication, and live extension reject a schedule in which one participant could match more than four simultaneous sessions or more than one simultaneous required session. It also verifies that each required participant has a physically possible zone and checkpoint path.

## 4. Participant credentials

Code2Create does not issue a separate attendance card to the full participant population.

### VIT students

A VIT student presents the VIT ID they already carry. A provisioned staff phone uses its camera to decode the printed barcode on the card. The scanner does not use OCR or NFC.

The card is normally enrolled to the participant’s event membership at the staffed arrival desk:

1. the participant is already authenticated through the VIT Google path;
2. staff compare the card’s visible name/photo and registration number with the participant record;
3. the phone scans the barcode without displaying its decoded value;
4. the backend normalizes it with the approved barcode-profile adapter and computes an event-scoped keyed fingerprint;
5. one active fingerprint is bound to one event membership;
6. the scanner immediately reads the card again and verifies the resulting participant.

The system does not store, log, or export the raw barcode value. It does not use that value as account identity. The Google-linked person and event membership remain authoritative. The barcode fingerprint is a pseudonymous server lookup value. It is not a biometric. It proves only that someone presented the enrolled physical card to a supervised scanner.

One event cannot bind the same active barcode fingerprint to two people. A rebind after card replacement or incorrect enrollment requires `attendance.credential.rebind` for the exact person. An explicit event-wide grant can also authorize it. The operator also needs a provisioned current-plan phone with station-read access. The phone or station grant alone cannot replace a participant's binding.

The participant first presents a fresh portal QR. The QR resolves the exact membership without showing a barcode value. Staff compare the new card with the returned identity details. They enter a reason and use a current scoped authorization.

The first scan claims the resolution's credential slot for the exact replacement and pending credential. It creates a pending replacement that expires after five minutes. An existing active card remains active during this period. A suspended card remains unusable.

The second scan must use the same resolution, operator, phone, station, and member. It checks the current active or suspended credential ID and version. It then reads the different new printed barcode again. A matching second scan performs these actions atomically:

- It marks the previous binding `replaced`.
- It activates the new binding.
- It links both records.
- It records the actor and reason.

A stale version cannot change the current binding. A reused or mismatched resolution cannot change it. A same-card attempt, different second scan, duplicate active fingerprint, expired attempt, or competing replacement also cannot change it. The old binding remains in history. It stops resolving on the first online scan after the replacement commits.

Suspension is an independent one-way command. It requires `attendance.credential.suspend` for the exact participant or an explicit event-wide grant. Staff must use an assigned current-plan phone. They must scan a fresh participant portal QR, confirm visible identity, and give a reason. Their scoped authorization must still be active.

The server checks the active credential and version. One transaction then changes the credential to `suspended` and cancels each unfinished successor. The old barcode fails at the next online attendance scan.

The system has no resume button or `suspended → active` transition. The portal QR remains available. Only a separately authorized two-scan rebind to a different VIT ID restores a physical credential. A suspended row remains the participant's current VIT binding for setup. Station-scoped initial enrollment cannot bypass the exact-person recovery boundary.

The production team must test current VIT IDs before it makes barcode scanning mandatory. The handbook does not assume Code 128, QR, or another symbology before the team tests representative cards. If qualified phones cannot reliably read a campus or batch barcode, staff can verify the visible VIT ID and record arrival. The participant then uses the portal QR for later attendance and keeps event access.

### External participants and fallback

External participants use:

- a short-lived dynamic QR in the authenticated participant portal;
- an opaque printed QR on an ordinary event badge when the event issues one;
- staffed lookup/manual confirmation when neither is available.

Attendance operations preprint anonymous badge stock with `pnpm attendance:badges --count <n> --output <new-file.html>`. Each card contains one opaque 32-byte bearer as QR geometry. A short reference is printed below the QR. The generator limits a batch to 500 cards. It atomically creates a new owner-only `0600` file, refuses to overwrite an existing file, and does not write a plaintext bearer list. Staff keep the HTML and all unused cards in controlled custody. They destroy a partly scanned card when its five-minute verification expires. They do not bind that card again.

Badge issue starts in the app's separate **Credential setup** mode. The participant presents a fresh portal QR. Staff compare the participant with the returned profile.

Badge issue requires all of these conditions:

- The operator has `attendance.badge.issue` for the exact person.
- The operator has a recent Google session.
- The operator uses an assigned current-plan phone with station-read access.
- The station permits `badge_qr`.

The first badge scan claims the resolution's credential slot. It creates a pending hash and shows the derived reference. Staff compare the reference with the physical card. They move the card away and scan the same card again under the exact claim. Only the second scan activates the badge.

Replacement uses the same two-scan flow. It requires independent `attendance.badge.replace` authority, a reason, and the current active credential and version. The old badge remains active until the second scan. That scan atomically marks the old badge `replaced` and activates its successor.

Lost-card revocation requires `attendance.badge.revoke`. It has a separate reason and version check. One transaction revokes the active card and each unfinished successor.

Possession of the phone does not authorize these actions. A station-read grant or another badge permission also does not authorize them. The public action keeps the scanned bearer only long enough to derive the event HMAC and short reference. Internal mutations, tables, audit records, operation records, logs, exports, and user interfaces never receive or show the bearer.

VIT students receive the same portal QR fallback for a forgotten, unreadable, or unavailable VIT ID. Code2Create does not print a replacement attendance card.

Dynamic QR state is:

- bound to the event, participant, credential version, token scope, and attendance session when session-scoped;
- opaque and free of personal data;
- valid for 60 seconds, with at most one active code per membership; minting or manual refresh revokes every prior active code in the same transaction;
- invalid after use, revocation, session close, or account/credential repair.

When the server resolves a portal token, the attendance receipt consumes it. The outcome can be accepted, duplicate, rejected, or needs review. The token cannot cause a second transition after its first resolved use. A successful staffed-participant resolution also consumes the token and revokes each sibling. This resolution does not create an attendance event. The portal always shows **Refresh code** after use or a lost response. A screenshot or old portal QR cannot become a permanent event credential.

## 5. Scanner surfaces

Attendance scanning is a capability-gated mode in the signed Expo event application. It uses:

- the camera for VIT ID barcodes, external event-badge QR, and attendance portal QR while Attendance mode is selected;
- secure session storage and registered-device checks;
- an encrypted, bounded pending queue for short connection loss.

The camera also has a separate online-only participant-first surface. A configured `venue_entry` station labels it **Arrival desk**. Other stations label it **Credential setup**.

The surface accepts a fresh participant portal QR. It shows only the identity, team, and current-arrival state needed at that station. It creates a two-minute server resolution. The resolution is bound to the operator, assigned phone, station, and person.

Independent one-action venue and credential slots permit one valid action in each domain. To repeat an action, staff must scan another QR. A two-scan credential workflow stays bound to its claimed resolution and pending credential for five minutes. The surface then accepts the VIT ID barcode or external badge QR for the participant class.

The arrival button does not record presence. Credential controls do not issue or change an arrival record. Ordinary Attendance mode performs neither action.

Arrival authority is person-scoped. `attendance.venue_check_in.read`, `.record`, `.override_identity`, and `.reverse` are independent exact-person permissions. Each permission can also have an explicit event-wide scope. The phone also needs its current exact-station `attendance.station.read` assignment.

A normal record confirms the visible VIT ID for a VIT student. For an external participant, it confirms the event-approved external photo ID. A no-ID recovery uses only `.override_identity`. It requires a bounded reason and a current scoped authorization. The system stores it as `approved_exception`.

A reversal requires its separate permission, current check-in version, reason, and current authorization. Neither exception nor reversal changes venue or session presence.

Repetitive VIT ID scanning is operated on provisioned phones that passed the actual-card and lighting rehearsal. VIT barcodes and attendance QR use the same Attendance camera mode, while the event app mounts separate Review and Hall map modes for their separately prefixed team credentials and server commands.

Each scanner installation is assigned to a station configuration:

- event and venue zone;
- mode: `venue_entry`, `venue_exit`, `session_confirm`, `zone_entry`, `zone_exit`, or `roving`;
- direction and current attendance session where applicable;
- operator/device assignment and validity window;
- allowed credential methods;
- configuration version.

Direction comes from the station configuration, not from a participant choosing “in” or “out.” A bidirectional or roving device makes the operator confirm the intended transition before accepting it.

The phone sends an authenticated heartbeat every 45 seconds while the camera-ready scanner is in the foreground. It checks immediately when it returns to the foreground. A background app does not claim scanner liveness. A phone without camera permission also does not claim liveness.

The heartbeat includes the encrypted queue count and oldest capture time. It does not include a credential payload. The server rechecks all of these values:

- `attendance.scan.execute`;
- the exact station configuration version;
- the active device assignment;
- the hashed installation secret;
- the current plan's queue limits.

The server updates `lastSeenAt` at most once every 30 seconds unless the queue state changes. During the live event, operations marks an expected station stale after two minutes. It raises a separate aggregate watch signal while an assigned phone reports pending replay. Provisioning time and an old accepted scan do not replace a heartbeat. A stale heartbeat never creates or changes a participant attendance record.

One idempotent, version-checked mutation disables an active station. It performs these actions:

- It marks the phone installation revoked.
- It removes the phone from the station.
- It changes the station to `disabled`.
- It increments the station configuration version.
- It removes the assignment's active or scheduled `attendance.scan.execute` and `attendance.station.read` grants.

Making the station available again changes it to `inactive` and increments the version. It does not restore the old secret or grants. The phone clears its revoked local scanner record before it creates a new installation secret and assignment.

The scanner result is deliberately brief:

- preferred name, badge reference, and team;
- accepted state and server time;
- one clear color, sound, and haptic result;
- a direct recovery action for already present, wrong session, revoked badge, expired QR, or pending network state.

The screen never exposes the bearer token.

## 6. Participant flow

### Venue arrival

1. The participant shows one current portal attendance QR at a provisioned `venue_entry` station; resolving it consumes that code and returns the exact confirmed member, team, class, and minimum identity details.
2. Staff compare the person with the visible class-appropriate ID. A separately authorized no-ID exception is available when the published recovery policy permits it.
3. The operator explicitly records venue check-in. A normal retry is idempotent, a second active check-in is rejected, and the participant portal shows this arrival state separately from venue presence.
4. As applicable, the same participant-first surface enrols the VIT ID barcode or issues an unused external badge through the independent two-scan credential command. An unreadable/unavailable physical credential does not prevent the approved portal-QR fallback.
5. A separate entry scan places the participant inside the configured venue zone.
6. The participant portal shows arrival, current venue state, physical credential, and the next scheduled attendance session as separate facts.

Venue check-in occurs once unless staff reverse it. The row records the station and zone, identity method, actor and time, and active physical credential and version when present. A reversal marks the row and permits a later check-in. It does not overwrite history.

The team reaches the coarse `checked_in` milestone when each active member of the confirmed locked team has a current check-in. If staff reverse one member while the team is at that milestone, the team returns to `confirmed`. A team in an active event phase keeps that phase. Live routing still reads the current participant check-in count directly. Venue entry and exit can occur many times.

### Session start

The portal subscribes to a current-plan projection containing only all current sessions and the next upcoming session. It shows each session's check-in window, location, and current status. It does not subscribe to old session rows. Each expected participant confirms the session separately. VIT students normally present the enrolled VIT ID barcode. External participants and fallback paths use QR.

Confirmation can happen at:

- entry lanes;
- several self-flow stations supervised by staff;
- team-table sweeps using roving scanners;
- an accessibility desk.

Using several stations and table sweeps prevents a thousand-person queue at one door. A participant who stayed inside across the session boundary appears as **On site · confirmation due** until the new session scan is accepted.

A participant can confirm late while the session accepts arrivals. The system records the actual time and a `late` flag. It does not block or penalize the participant automatically. The late-arrival close applies to the first session confirmation. A confirmed participant can still scan a temporary exit or return until the accepted session end.

### Temporary exit and return

When a participant leaves a tracked hacking zone, an exit scan changes current availability to **Temporarily out** and closes the active presence interval. A return scan opens another interval and restores **Present**.

A participant may leave and return multiple times. One participant/session accepts at most 64 presence intervals; another attempted entry becomes a visible needs-review state rather than creating unbounded close-time work. Scanner, paper import, and live reconciliation use the same interval-creation boundary, and finalization reads at most the same bound. No reason is required for an ordinary temporary exit. If toilets are inside the tracked zone, using them requires no scan. The system does not store “bathroom” as a movement reason.

An attendance policy may set an operational away threshold. Crossing it creates a visible **Away longer than expected** flag for staff, not an automatic violation. Medical, accessibility, organizer-directed, or other exceptions can be recorded using a coarse reason with restricted visibility.

### Session end

Closing a session fixes one cutoff. The cutoff is the earlier of server receipt time and the current accepted end. A late operator command cannot add presence time. The operator must record a planned later end through an extension before the prior end. Session close ends each session interval at the cutoff and calculates results. It does not check a participant out of the venue. The next required session still needs a new confirmation.

A canceled session produces no absence. Cancellation is available from `scheduled`, `preparing`, `ready`, or `open`. It stops an active expectation job and fixes the same server-owned cutoff. A resumable cancellation batch closes derived intervals and marks each materialized participant as not expected. The session becomes `canceled` only after the batch completes. Early close, extension, and cancellation do not change an accepted scan event.

Close and cancel do not update about 1,000 participant projections in one transaction. The first command changes the session to `closing`. It fixes the cutoff and interpretation version and starts the applicable internal batch.

Expectation building inserts each session-participant source row and its required current projection in one transaction. Open, close, and cancel fail if the projection count or identity does not exactly match the prepared source set. Indexed terminal batches validate and delete each projection in the same transaction that closes intervals and calculates ordinary results or no-absence cancellation results. The dashboard distinguishes **Finalizing results** from **Canceling session**. It shows progress or failure. The session reaches `closed` or `canceled` only when the batch and counters agree. A draft or submitted manual attendance sheet blocks both commands until staff cancel, reject, or import it.

### Post-session result review

Closed-session history is not mounted with the live attendance subscription. The participant opens it explicitly, and the server returns newest-first pages of at most ten finalized source rows with the latest remedy case for only those rows. If a missing scan or boundary case appears after finalization, the participant can send a short description for review. This action does not change the result. Staff can open the same case type when operations finds the issue. One participant and session can have only one open case. A new case can open after the previous case is resolved.

Opening a case freezes these values:

- the exact closed-session version;
- the participant-result version;
- the result and duration;
- the confirmation time and late flag;
- the latest evidence event.

Staff evidence access, case opening, and case decision use independent exact-session permissions. The permissions are `attendance.remedy.read`, `attendance.remedy.open`, and `attendance.remedy.decide`. Participant read and open permissions are self-scoped. Staff case opening and decision require a current scoped authorization. A role label cannot replace a grant.

An authorized decision-maker can approve a reviewed replacement result with valid duration and confirmation facts. The decision-maker can also decline and keep the result. Approval updates the derived participant and session result with the applicable counter shard in one transaction. It does not change scanner events or presence intervals.

The immutable case records the before and after values. It also records the actor, authorizing grants, restricted internal reason, and a separate participant note. The decision fails if any frozen value or version changed after case opening. Staff must then review the case again.

## 7. Presence states and interpretation

Current venue state:

`not_arrived | inside | temporarily_out | departed | unknown`

Current session state:

`not_expected | confirmation_due | present | temporarily_out | complete | excused | needs_review`

These are projections of the event ledger. They are not the ledger itself.

Venue state is singular. Session state exists once per participant/session, so an optional workshop may overlap a hacking block without overwriting it. The portal highlights the current required session and lists any other applicable session separately.

Examples:

- A repeated entry scan while already inside returns the existing state and does not open another interval.
- An exit with no matching entry is recorded as an anomaly and produces `needs_review`; the server does not invent the missing event.
- A session confirmation proves that session’s presence even when the venue-entry scan happened earlier.
- A lost exit scan leaves the state uncertain. Staff reconcile it with a compensating event rather than editing history.
- A participant can satisfy an attendance policy through total present duration, one or more checkpoints, or an approved exception, depending on that session’s published rule.

## 8. Team availability and reviews

Attendance remains participant-scoped. Confirming the locked offer creates one derived team-availability projection; accepted venue entry and exit update its inside count with the participant projection. Operations receives:

- expected members;
- confirmed present members;
- temporarily out members;
- unknown or excused members;
- last accepted change.

This row is operationally derived. Participants cannot edit it, and it is not a judging fact.

A review policy can set a minimum number of currently present team members. The minimum applies before a call or review start. The round board reads one indexed projection for each team and shows the total. Both commands recheck the same row transactionally.

One temporarily absent member does not remove a team from the queue automatically. The portal asks the team to regroup. Operations can apply a short hold.

To continue below the minimum, the operator needs `review.participant_availability.waive` for the exact team or pending review. An explicit event-wide grant can also authorize the action. The operator also needs a recent Google session and a reason. The immutable waiver records the observed and required counts and authorizing grants. It does not change an attendance record and applies to one review only.

Attendance duration and temporary exits never enter a judging score or GitHub/Figma progress statistic.

## 9. Scan command and realtime update

Enrolled VIT ID barcodes, external-badge QR, and portal QR all reach the same protected scanner command. A staffed missing or incorrect transition uses the separate authorized reconciliation command and the same presence ledger/projections; it does not impersonate a scanner device.

The request contains:

- event, station, and expected configuration version;
- credential kind and opaque QR value or camera-decoded VIT ID barcode value;
- device installation and signed-in operator;
- client operation ID and device sequence;
- device-captured time and whether this transmission is replaying a locally persisted operation.

The server:

1. authenticates the operator and registered device;
2. checks `attendance.scan.execute` for the exact station and the active station assignment;
3. converts a VIT ID barcode value into its event-scoped keyed fingerprint, or resolves the QR token, then validates event, membership, and credential/binding state;
4. resolves the applicable attendance session or sessions and expected participant records;
5. applies station direction, anti-passback, duplicate, and time-window rules;
6. records the scan attempt with accepted, duplicate, rejected, or needs-review outcome;
7. creates or closes the participant interval when accepted;
8. updates the participant, applicable sessions, team, zone, and emergency-roll-call projections;
9. returns the authoritative state and server time.

The accepted event, individual projection, and the relevant counter shard change in one Convex mutation. Large dashboards subscribe to the projections and sharded counts; they never scan the raw movement ledger to draw a card.

Expected-cohort materialization and session finalization run as resumable indexed batches before open and after close. A session cannot open with an incomplete expectation snapshot or claim to be closed while result batches are incomplete.

The working performance target on the venue network is:

- accepted online scan response under 750 ms at the 95th percentile;
- affected participant and operations views updated within two seconds at the 95th percentile;
- sustained event-wide bursts of at least 60 scan attempts per second without delaying review or score writes.

The final target is signed off after testing with the chosen phones, representative VIT ID barcode formats and conditions, external-badge and portal QR, Wi-Fi, backup connection, and station layout.

## 10. Duplicate and conflict behavior

- Repeating the same client operation ID returns the first result.
- The same credential and transition repeated within the deduplication window returns **Already recorded**.
- Two near-simultaneous VIT-barcode and portal-QR scans for one participant create one accepted transition and one duplicate result.
- Two entry scans do not manufacture extra present time.
- A stale station configuration is rejected with the current station mode.
- A scan racing session close is evaluated against server order. An operator may reconcile a legitimate boundary case only if the correction commits while the session is still open; otherwise it enters the reviewed post-session remedy path.
- Two simultaneous post-session requests cannot create two open cases. Two decisions serialize on the case and participant-result versions; a stale decision cannot move the result or counters.
- Two simultaneous roll-call starts for one zone create one active record. A venue scan that races start is in the starting snapshot or updates the active shard. A scan that races close is in the final counts or occurs after the frozen boundary.
- Offline replays keep device order and capture time. Server receipt time remains visible. A valid replay uses capture time for the transition window and interval boundary. If evidence with an equal or later effective time owns the projection, the replay becomes `needs_review`. It does not change a projection or counter.
- Manual corrections are `reconciled` events. A missed transition links the exact participant projection version and latest event when available. Staff can void an incorrect transition only while it is the latest accepted scanner event. Staff never edit or delete accepted movement records during operational retention.

## 11. Operations workspace

The attendance board shows:

- the current staffed venue check-in count and latest change, only with event-wide `attendance.venue_check_in.read`;
- active and next attendance sessions;
- expectation-build or closing/finalization progress;
- expected, confirmed, present, temporarily out, late, excused, and needs-review counts;
- entry and exit throughput by station;
- stale/offline scanner devices and pending replay count;
- participants away beyond the configured operational threshold;
- team availability and review-call impact;
- credential replacements, rejected scans, and anti-passback anomalies;
- zone occupancy against a configured safe capacity;
- last server update and connection state.

Filters include session, zone, team, participant class, state, and support flag. Staff can search by preferred name, badge reference, registration number where authorized, or team.

Protected actions include:

- open, extend, close, or cancel a session;
- disable an active station or make a checked disabled station available for a fresh phone assignment;
- issue, revoke, or replace a credential;
- confirm an accessibility or excused-attendance exception;
- reconcile a missing or incorrect transition;
- read, open, or decide a finalized-result review under separate exact-session grants;
- place or clear a review-call hold;
- start an emergency roll call;
- export a purpose-limited attendance report.

An emergency roll call selects a prepared attendance session in `ready`, `open`, or `closing`. The expected cohort and zone are therefore frozen and physically meaningful. The operator names it as an incident or drill.

Start requires `attendance.roll_call.start` for the exact session. It also requires the current session version, a reason, an idempotent operation ID, and a current scoped authorization. A zone can have only one active roll call.

Start records these values atomically:

- expected count;
- server time;
- snapshot checksum;
- counts for **Inside**, **Temporarily out**, **Not arrived**, **Departed**, **Elsewhere**, and **Unknown**.

The command initializes a fixed set of sharded counters. It does not copy one thousand participant records. A new accepted venue scan updates the ordinary venue projection and each applicable active roll-call shard in one transaction.

`attendance.roll_call.read` shows exact-session counts and a paginated expected-cohort roster. The independent `attendance.roll_call.close` grant permits close. Close requires a fresh sign-in and reason and freezes the final counts. Later scans continue ordinary attendance and do not change the closed record.

An identifiable export requires `attendance.export.identifiable` for the exact prepared session. An explicit event-wide grant can satisfy this scope. The operator selects columns from a fixed allowlist, gives a purpose, and chooses a lifetime from 15 minutes through seven days. The request sends that duration, and the mutation derives the absolute expiry from server time.

The request requires the current session version. It also requires current scoped authorization and an idempotent operation ID. One consistent Convex query captures at most 1,200 cohort rows. A bounded export worker creates a CSV that is safe from formula injection. It stores the file in private KMS-backed S3.

Only the requester can download the file. Download rechecks the grant, current authorization, expiry, export version, and checksum. It returns a signed URL that expires after 60 seconds or at export expiry, whichever occurs first. The file does not include exact movement history, credential values or fingerprints, QR values, bearer material, or exception reasons.

The default dashboard is operational, not punitive. It prioritises unknown states, unsafe occupancy, long-away alerts, offline stations, and review blockers rather than ranking participants by hours.

## 12. Network and device failure

An online scanner shows **Accepted** only after the server response.

During a short connection loss:

- The scanner stores a small queue in its SQLCipher database. Device-only secure storage holds the database key. Each row contains the operation ID, credential payload, station and configuration version, device time, and sequence. Raw VIT ID barcode values, badge bearers, and a portal bearer after an uncertain response expire with the row. The system never logs them.
- The screen shows **Pending**. It does not show **Accepted**.
- A definitely offline phone puts only VIT ID and event-badge scans in the queue. A portal QR requires an online station because the phone cannot check its current short-lived state locally.
- The operator can continue only within the immutable plan's queue and age limits.
- Backup connectivity or another online station is the preferred recovery.
- After reconnection, the phone sends events in device order. It shows accepted, duplicate, rejected, or needs-review results.

Staffed participant resolution, venue check-in, identity exception, reversal, and credential setup remain online-only. They require a current single-use portal QR and current permission state. Some actions also require a current scoped authorization. These actions never enter the offline scan queue.

The phone saves each scan before online transmission. If the response is uncertain, replay uses the same operation ID and semantic request. A server commit and retry therefore resolve to one receipt. A definite server rejection removes the row. A connection failure keeps it. The phone deletes the row after a definite receipt, definite rejection, or short recovery expiry. The queue is not another attendance database.

If the scanner battery or camera fails, staff change the method or device. A VIT student can use the portal QR without changing the VIT ID barcode binding. If backend failure exceeds the incident threshold, operations can open an attendance-backend incident. Before paper entry starts, two different authorized people must approve paper mode. Each person must hold `incident.manual_mode.approve` for the exact incident.

The paper sheet comes from a current restricted emergency pack. Staff prepare the pack while the backend and private storage are healthy. The pack contains one prefilled sheet for each active station and current session. It also contains the requested spare sheets. Each sheet has a serial in the attendance manual-import format.

Preparing or printing the pack does not open an incident. It does not satisfy either manual-mode approval. Staff use the controlled original and do not use a photocopy. They keep the original for the verifier's filing attestation.

The first operator enters one numbered sheet for a single transition. The sheet must use an open session and compatible session station. The operator resolves 1–25 participant references against the frozen cohort. The operator attaches one compressed JPEG source under 900 KB.

A different authorized person verifies the sheet. This person must hold `attendance.manual_sheet.verify` and `attendance.manual_sheet.source.read` for the exact session. The verifier inspects the protected source and imports or rejects the sheet.

Import requires the original-paper filing attestation. It creates append-only `manual_import` events through the scanner transition logic. Newer online evidence wins. An older paper row becomes linked `needs_review` evidence and does not rewrite current presence.

## 13. Privacy, accessibility, and fair use

- The system records boundary events, not continuous GPS, Bluetooth, Wi-Fi, or background phone location.
- Ordinary temporary exits require no reason.
- Sensitive exception details stay in the support case; attendance views use a coarse operational code.
- Participants see their own current state and recent accepted scans. They also see their finalized session result, latest result-review state, and participant-facing resolution note. They do not receive the restricted staff reason or another participant's case.
- Team leads see only the team availability needed to regroup, not another member’s exception detail.
- `attendance.station.read` shows only the minimum identity/current state needed for its exact station; role does not change the payload.
- Venue arrival read, record, identity exception, and reversal are separate person-scoped authorities. The station assignment alone can resolve the presented participant but cannot perform any of those commands.
- Exact movement events and identifiable exports use a shorter approved retention period than event membership.
- Raw VIT ID barcode values, barcode fingerprints, QR values, hashes, and bearer values never appear in logs, exports, analytics, or support screens.
- Accessibility desks, manual confirmation, excused attendance, and authorized companions are first-class paths.
- Attendance cannot modify a judging score, model prompt, proposal, GitHub or Figma statistic, or admission recommendation.
- No participant is automatically disqualified from a missed scan, long break, unknown state, or device failure. Any consequence follows an approved policy and human review.

## 14. Acceptance checks

- Venue check-in, venue entry, and session confirmation remain distinct records.
- A fresh portal QR at a venue-entry station resolves one exact confirmed team member and is consumed even when the operator performs no later arrival or credential command.
- A staffed venue action rejects a missing, expired, mismatched, or already claimed resolution; the successful domain write claims it in the same transaction.
- A credential begin/single-step command rejects a missing, expired, mismatched, or already claimed credential slot; its second scan rejects a different action, target, operator, phone, station, or member.
- Normal venue check-in, approved no-ID exception, and reversal fail independently without their exact person permission; a station grant, credential permission, or role label cannot substitute.
- One membership/event has at most one active venue check-in. Reversal preserves the prior row, decrements only the sharded arrival projection, and a later valid arrival creates a new row.
- Recording or reversing arrival creates no presence event, venue state, interval, session participant/result, judging fact, or score change.
- The team reaches `checked_in` only after every member of its deadline-frozen roster has a current venue check-in; a reversal at that milestone returns it to `confirmed` without rewriting a later active event phase.
- The same participant can check into every configured hacking session without receiving a new account or badge.
- An enrolled VIT ID barcode, external event-badge QR, and portal QR produce the same accepted domain transition.
- A portal QR cannot be used for another participant, event, session scope, or incompatible station; direction remains server-owned station configuration.
- Two concurrent portal-QR mints leave only the last committed code active; consuming one code also revokes any older active sibling.
- A suspended or replaced VIT ID barcode or revoked external badge fails immediately on every online scanner.
- A VIT ID rebind cannot deactivate the old card after only one scan. An unchanged pending attempt expires after five minutes; verification and expiry serialize on the pending credential version.
- Repeated and simultaneous scans produce one accepted transition and stable totals.
- Temporary exit and return create separate intervals and update participant, team, zone, and dashboard views in realtime.
- A participant already inside at the next session still appears as confirmation due until explicitly confirmed.
- Extending before the accepted end moves the end and late-arrival close together, is event-bounded, and loses a race to any version-changing close or cancellation.
- Closing late uses the accepted end rather than the operator's later click; closing early uses the command's server time.
- Canceling a scheduled, preparing, ready, or open session remains visibly in progress until its resumable batch closes derived intervals and produces no absence. Extension, close, and cancellation preserve every scan event.
- Overlapping optional and required sessions keep separate per-participant state and cannot overwrite one another.
- Session open fails while its expectation build is incomplete; close or cancellation remains visibly in progress until every indexed batch and count check succeeds.
- An offline queue never displays server acceptance, never exceeds the published count/age bounds, and replays in device order with the original operation ID.
- A definitely offline portal QR is refused locally; an uncertain online attempt can only retry its already-persisted operation and cannot turn the bearer into a reusable credential.
- A resolved portal QR is consumed by its first scanner receipt even when that receipt is duplicate, rejected, or needs review.
- A quiet scanner that receives no cards remains online through its authenticated heartbeat; closing or disconnecting its camera surface makes an expected live station visible as stale within two minutes.
- Disabling a scanner revokes its device secret and source-attributed station grants in the same transaction, increments the station configuration version, and makes its next heartbeat, scan, or offline replay fail.
- Making a disabled station available never revives the old phone or operator grants; provisioning creates a fresh installation secret and assignment.
- Replacing a published attendance plan fails while any old session is preparing, open, or closing. A successful replacement atomically disables the old plan's stations, and no old-plan station can scan against the new plan.
- A contradictory offline replay becomes needs review and cannot overwrite a newer accepted state.
- A live manual correction requires exact-session authority, current session and participant versions, a reason, and current scoped authorization. It adds a linked compensating event and changes the interval projection atomically. It fails after close starts.
- A finalized-result review opens only after session close completes. It freezes the exact result and evidence snapshot, permits one open case, and rejects stale decisions. Participant self read/open and staff read/open/decide boundaries remain independent.
- Approval of a finalized-result review changes only the derived participant result and its counter shard. It records before and after values and a participant-facing note. It does not change a presence event or interval. Decline keeps the result.
- An emergency roll call uses a prepared session cohort. It separates inside, temporarily out, not arrived, departed, elsewhere, and unknown people. Its sharded total equals expected. It freezes final counts without stopping ordinary scans.
- An identifiable attendance export is one atomic prepared-session snapshot. It has only selected allowlisted columns and neutralizes spreadsheet formulas. It remains requester-owned, records purpose, manifest, and checksum, and expires on the server. Permission revocation or stale authentication prevents a signed URL.
- Manual paper mode cannot start without two different incident approvals. One person cannot both enter and verify a sheet, and verification additionally requires protected-source read access for the exact session.
- Emergency-pack preparation and print access are independent event grants, expire separately from manual work, and cannot substitute for either incident approval or sheet permission.
- A numbered paper sheet has one incident/session/station configuration, one transition, one active serial revision, 1–25 unique lines, one immutable source manifest, and one atomic verification/import outcome.
- A session cannot begin closing or cancellation, and an incident cannot resolve, while any linked paper sheet remains draft or submitted. A stale or concurrent import cannot cross either boundary.
- Imported paper lines use the scanner transition rules, preserve sheet/line provenance, cannot import twice, and cannot overwrite newer accepted evidence.
- A no-phone, forgotten or unreadable VIT ID, inaccessible-station, and lost external badge path each completes through QR or a staffed fallback.
- Attendance data cannot be read through reviewer, application-reviewer, or unrelated participant access.
- Attendance never appears in a judging score or progress metric.
- The event-scale rehearsal scans the full registered population through several stations for two consecutive sessions. It includes representative VIT ID barcode formats and card conditions, external QR, fallbacks, exits, returns, duplicates, barcode rebinding, offline replay, and one session extension.
