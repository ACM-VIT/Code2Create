# Attendance and presence

## 1. Purpose

Attendance is an event-operations system, separate from admission, judging, and reviewer presence.

It answers three different questions:

1. **Venue presence:** Is this participant currently inside a tracked event zone?
2. **Session attendance:** Did this participant confirm presence for this scheduled hacking session?
3. **Current availability:** Is the participant present, temporarily outside the zone, or in an unresolved state right now?

The system supports emergency roll calls, session planning, and accurate floor operations. It is not a productivity score, continuous location tracker, or automatic disqualification engine.

Reviewer presence before a review remains a separate workflow. A reviewer scans the team QR for a review session; a participant scans their own attendance credential for venue and hacking-session presence.

## 2. Operating concepts

| Concept | Meaning |
| --- | --- |
| Venue check-in | The first staffed identity and eligibility check on arrival |
| Attendance session | A configured time block such as hacking, briefing, review preparation, or overnight access |
| Tracked zone | A physical boundary where entry and exit scans have operational meaning |
| Session confirmation | A participant-specific scan proving presence for one attendance session |
| Presence event | An immutable accepted, duplicate, rejected, or reconciled scan attempt |
| Presence interval | Time between an accepted entry/confirmation and the corresponding exit or session close |
| Attendance result | A policy interpretation derived from events and intervals, never the source record |

Venue presence and session attendance do not replace one another. Someone may already be inside the venue when a new hacking block starts and still need a session-specific confirmation.

## 3. Configurable attendance plan

An event publishes an immutable attendance-plan version before participant check-in opens. The plan defines:

- session kinds and participant-facing names;
- scheduled start and end;
- check-in opening, grace, and late-arrival windows;
- expected cohort, such as all admitted participants, selected tracks, volunteers, finalists, or an explicit list;
- required, optional, or information-only status;
- tracked zones and valid scan stations;
- allowed methods by participant class: VIT ID card tap, external event-badge QR, portal QR, staffed confirmation, or manual exception;
- temporary-exit behaviour and the duration after which operations receives an away alert;
- whether a minimum presence duration or one or more checkpoints are required;
- whether team review readiness uses a configurable minimum number of currently available members;
- excused-absence and accessibility rules;
- raw-event, aggregate, and export retention.

There is no global hard-coded attendance percentage. Different sessions can use different rules, and a session may simply record presence without enforcing a minimum.

Before a session opens, an authorised operator may adjust its time, zones, or expected cohort. After it opens, an extension, early close, cancellation, or material policy change is recorded as a new operational version with an actor and reason. The scan ledger is never rewritten. Derived results are recalculated against the accepted session version and actual session bounds.

The schedule may contain gaps, meals, rest periods, optional workshops, and overnight access. The software does not assume every minute of the 48-hour event is one continuous mandatory hacking block.

Sessions may overlap for different cohorts or for an optional workshop inside a broader hacking block. Presence is evaluated per session. Configuration validation caps the number of sessions that can apply to one participant at once, rejects contradictory required sessions, and ensures every required participant has a physically possible zone/checkpoint path.

## 4. Participant credentials

Code2Create does not issue NFC tags to the full participant population.

### VIT students

A VIT student presents the VIT ID card they already carry. A provisioned staff phone reads the card using NFC when the actual card technology is compatible with the tested Android fleet.

The card is enrolled to the participant’s event membership at the first staffed venue check:

1. the participant is already authenticated through the VIT Google path;
2. staff compare the card’s visible name/photo and registration number with the participant record;
3. the phone reads the machine identifier without displaying it;
4. the backend normalises it with the approved card-profile adapter and computes an event-scoped keyed fingerprint;
5. one active fingerprint is bound to one event membership;
6. the scanner immediately reads the card again and verifies the resulting participant.

The raw card identifier is not stored, logged, exported, or used as the person’s account identity. The Google-linked person and event membership remain authoritative. The card fingerprint is a pseudonymous server lookup value, not a biometric; it proves only that the enrolled physical card was presented to a supervised scanner.

The same card cannot be actively bound to two people in one event. Rebinding after a replacement, damaged card, or incorrect enrolment requires SC with attendance duty, a fresh sign-in, a visual identity check, and a reason. The previous binding remains in history but cannot produce another accepted event.

The production team must test real current VIT cards before making the tap path mandatory. The public handbook does not assume a particular card family, UID format, or NFC protocol. If a campus/batch card cannot be read reliably from the qualified phones, that participant uses QR without losing attendance access.

### External participants and fallback

External participants use:

- a short-lived dynamic QR in the authenticated participant portal;
- an opaque printed QR on an ordinary event badge when the event issues one;
- staffed lookup/manual confirmation when neither is available.

VIT students receive the same portal QR fallback for a forgotten, unreadable, or unavailable VIT ID. Code2Create does not print an electronic replacement for a VIT card.

Dynamic QR state is:

- bound to the event, participant, credential version, token scope, and attendance session when session-scoped;
- opaque and free of personal data;
- expired quickly and replaced automatically;
- invalid after use, revocation, session close, or account/credential repair.

A screenshot or old portal QR does not become a permanent event credential.

## 5. Scanner surfaces

Attendance scanning is a capability-gated mode in the signed Expo event application. It uses:

- the camera for external event-badge and portal QR codes;
- a native NFC reader module for compatible VIT ID cards in production EAS builds;
- secure session storage and registered-device checks;
- an encrypted, bounded pending queue for short connection loss.

NFC is not promised through the participant website or a browser API. Repetitive VIT ID scanning is operated on provisioned Android devices that passed the actual-card matrix. QR remains available on every scanner device with a working camera; iOS NFC is enabled only if the exact build and VIT card types pass the fleet rehearsal.

Each scanner installation is assigned to a station configuration:

- event and venue zone;
- mode: `venue_entry`, `venue_exit`, `session_confirm`, `zone_entry`, `zone_exit`, or `roving`;
- direction and current attendance session where applicable;
- operator/device assignment and validity window;
- allowed credential methods;
- configuration version.

Direction comes from the station configuration, not from a participant choosing “in” or “out.” A bidirectional or roving device makes the operator confirm the intended transition before accepting it.

The scanner result is deliberately brief:

- preferred name, badge reference, and team;
- accepted state and server time;
- one clear colour, sound, and haptic result;
- a direct recovery action for already present, wrong session, revoked badge, expired QR, or pending network state.

The screen never exposes the bearer token.

## 6. Participant flow

### Venue arrival

1. Staff locate the participant’s confirmed event membership.
2. They perform the approved identity and eligibility check.
3. For a VIT student, staff enrol and verify the existing VIT ID card; for an external participant, staff verify or issue the configured QR badge.
4. An entry scan places the participant inside the configured venue zone.
5. The participant portal shows the accepted status, time, and next scheduled attendance session.

Venue check-in happens once unless it is reversed. Entry and exit presence events may happen many times.

### Session start

The portal shows the next session, check-in window, location, and current status. Every expected participant confirms the session individually: VIT students normally tap the enrolled VIT ID card, while external participants and fallbacks use QR.

Confirmation can happen at:

- entry lanes;
- several self-flow stations supervised by staff;
- team-table sweeps using roving scanners;
- an accessibility desk.

Using several stations and table sweeps prevents a thousand-person queue at one door. A participant who stayed inside across the session boundary appears as **On site · confirmation due** until the new session scan is accepted.

Late confirmation remains possible while the session accepts arrivals. It records the actual time and a `late` flag; it does not silently block the participant or apply a penalty.

### Temporary exit and return

When a participant leaves a tracked hacking zone, an exit scan changes current availability to **Temporarily out** and closes the active presence interval. A return scan opens another interval and restores **Present**.

A participant may leave and return multiple times. No reason is required for an ordinary temporary exit. If toilets are inside the tracked zone, using them requires no scan. The system does not store “bathroom” as a movement reason.

An attendance policy may set an operational away threshold. Crossing it creates a visible **Away longer than expected** flag for staff, not an automatic violation. Medical, accessibility, organiser-directed, or other exceptions can be recorded using a coarse reason with restricted visibility.

### Session end

Closing a session closes any open session interval at the accepted actual end time and calculates the current result. It does not check the participant out of the venue. The next required session still needs a fresh confirmation.

A cancelled session produces no absence. An early close or extension recalculates durations from the accepted operational version rather than editing old scan times.

Closing does not try to update roughly 1,000 participant results in one database transaction. The first command moves the session to `closing`, fixes the cutoff and interpretation version, and starts an internal batched finalisation job. Indexed batches close intervals and calculate results; the dashboard shows progress and exact failures. The session reaches `closed` only when expectation, interval, result, and counter checks agree.

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

## 8. Team readiness and reviews

Attendance is participant-scoped. Operations also receives a derived team availability summary containing:

- expected members;
- confirmed present members;
- temporarily out members;
- unknown or excused members;
- last accepted change.

This summary does not turn attendance into a team-owned record.

A review policy may require a configurable minimum number of currently present team members before the team is called or a review starts. One temporarily absent member does not automatically eject a team from the queue. The portal asks the team to regroup, and operations may apply a short hold, continue under policy, or record an exception.

Attendance duration and temporary exits never enter a judging score or GitHub/Figma progress statistic.

## 9. Scan command and realtime update

Enrolled VIT cards, external-badge QR, portal QR, and manual fallback all reach the same protected scan command.

The request contains:

- event, station, and expected configuration version;
- credential kind and opaque QR value or phone-read VIT card identifier;
- device installation and signed-in operator;
- client operation ID and device sequence;
- device-captured time and current connectivity state.

The server:

1. authenticates the operator and registered device;
2. checks the attendance capability and station assignment;
3. converts a VIT card identifier into its event-scoped keyed fingerprint, or resolves the QR token, then validates event, membership, and credential/binding state;
4. resolves the applicable attendance session or sessions and expected participant records;
5. applies station direction, anti-passback, duplicate, and time-window rules;
6. records the scan attempt with accepted, duplicate, rejected, or reconciled outcome;
7. creates or closes the participant interval when accepted;
8. updates the participant, applicable sessions, team, zone, and emergency-roll-call projections;
9. returns the authoritative state and server time.

The accepted event, individual projection, and the relevant counter shard change in one Convex mutation. Large dashboards subscribe to the projections and sharded counts; they never scan the raw movement ledger to draw a card.

Expected-cohort materialisation and session finalisation run as resumable indexed batches before open and after close. A session cannot open with an incomplete expectation snapshot or claim to be closed while result batches are incomplete.

The working performance target on the venue network is:

- accepted online scan response under 750 ms at the 95th percentile;
- affected participant and operations views updated within two seconds at the 95th percentile;
- sustained event-wide bursts of at least 60 scan attempts per second without delaying review or score writes.

The final target is signed off after testing with the chosen phones, representative VIT card profiles, external-badge and portal QR, Wi-Fi, backup connection, and station layout.

## 10. Duplicate and conflict behaviour

- Repeating the same client operation ID returns the first result.
- The same credential and transition repeated within the deduplication window returns **Already recorded**.
- Two near-simultaneous VIT-card and portal-QR scans for one participant create one accepted transition and one duplicate result.
- Two entry scans do not manufacture extra present time.
- A stale station configuration is rejected with the current station mode.
- A scan racing session close is evaluated against server order. An operator may reconcile a legitimate boundary case.
- Offline replays retain device order and capture time, but server receipt time remains visible. A contradictory replay becomes `needs_review` rather than silently changing a newer accepted state.
- Manual corrections are compensating events linked to the incorrect or missing event. Accepted movement records are never edited or deleted during the operational retention window.

## 11. Operations workspace

The attendance board shows:

- active and next attendance sessions;
- expectation-build or closing/finalisation progress;
- expected, confirmed, present, temporarily out, late, excused, and needs-review counts;
- entry and exit throughput by station;
- stale/offline scanner devices and pending replay count;
- participants away beyond the configured operational threshold;
- team availability and review-readiness impact;
- credential replacements, rejected scans, and anti-passback anomalies;
- zone occupancy against a configured safe capacity;
- last server update and connection state.

Filters include session, zone, team, track, participant class, state, and support flag. Staff can search by preferred name, badge reference, registration number where authorised, or team.

Protected actions include:

- open, extend, close, or cancel a session;
- activate or disable a station;
- issue, revoke, or replace a credential;
- confirm an accessibility or excused-attendance exception;
- reconcile a missing or incorrect transition;
- place or clear a review-readiness hold;
- start an emergency roll call;
- export a purpose-limited attendance report.

An emergency roll call freezes a snapshot of expected people and displays confirmed inside, temporarily out, departed, unknown, and not expected by zone. New scans continue to update the live view while the frozen starting snapshot remains auditable.

The default dashboard is operational, not punitive. It prioritises unknown states, unsafe occupancy, long-away alerts, offline stations, and review blockers rather than ranking participants by hours.

## 12. Network and device failure

An online scanner shows **Accepted** only after the server response.

During a short connection loss:

- the scanner stores a small encrypted queue with operation ID, credential payload, station/configuration version, device time, and sequence; raw VIT card identifiers in this queue are never logged and expire with the queue;
- the screen shows **Pending**, never **Accepted**;
- the operator can continue only within the configured queue and age limit;
- backup connectivity or another online station remains the preferred recovery;
- reconnect submits events in device order and displays accepted, duplicate, rejected, or needs-review results.

The queue is deleted after confirmed replay or its short recovery expiry. It is not another attendance database.

If the scanner battery, NFC reader, or camera fails, staff switch method or device. A VIT student may use the portal QR without changing the VIT card binding. If the backend is unavailable beyond the incident threshold, operations uses numbered paper sheets containing participant/event reference, direction, station, device/operator, and local time. Two authorised staff reconcile the sheet after recovery.

## 13. Privacy, accessibility, and fair use

- The system records boundary events, not continuous GPS, Bluetooth, Wi-Fi, or background phone location.
- Ordinary temporary exits require no reason.
- Sensitive exception details stay in the support case; attendance views use a coarse operational code.
- Participants see their own current state, recent accepted scans, session result, and a correction-request route.
- Team leads see only the team availability needed to regroup, not another member’s exception detail.
- JC/SC members on attendance duty see the minimum identity needed to scan and resolve mismatches.
- Exact movement events and identifiable exports use a shorter approved retention period than event membership.
- Raw VIT card identifiers, card fingerprints, QR values, hashes, and bearer values never appear in logs, exports, analytics, or support screens.
- Accessibility desks, manual confirmation, excused attendance, and authorised companions are first-class paths.
- Attendance cannot modify a judging score, model prompt, track, GitHub/Figma statistic, or admission recommendation.
- No participant is automatically disqualified from a missed scan, long break, unknown state, or device failure. Any consequence follows an approved policy and human review.

## 14. Acceptance checks

- Venue check-in, venue entry, and session confirmation remain distinct records.
- The same participant can check into every configured hacking session without receiving a new account or badge.
- An enrolled VIT ID card, external event-badge QR, and portal QR produce the same accepted domain transition.
- A portal QR cannot be used for another participant, event, session scope, or incompatible station; direction remains server-owned station configuration.
- A suspended/rebound VIT card or revoked external badge fails immediately on every online scanner.
- Repeated and simultaneous scans produce one accepted transition and stable totals.
- Temporary exit and return create separate intervals and update participant, team, zone, and dashboard views in realtime.
- A participant already inside at the next session still appears as confirmation due until explicitly confirmed.
- Extending, closing early, or cancelling a session preserves all scan events and recalculates only the derived result.
- Overlapping optional and required sessions keep separate per-participant state and cannot overwrite one another.
- Session open fails while its expectation build is incomplete; session close remains visibly closing until every indexed finalisation batch and count check succeeds.
- An offline queue never displays server acceptance and replays idempotently.
- A contradictory offline replay becomes needs review and cannot overwrite a newer accepted state.
- A manual correction adds a linked compensating event with actor and reason.
- An emergency roll call separates confirmed inside, temporarily out, departed, and unknown people.
- A no-phone, forgotten/unreadable VIT ID, broken-NFC, inaccessible-station, and lost external badge path each completes through QR or a staffed fallback.
- Attendance data cannot be read through reviewer, application-reviewer, or unrelated participant access.
- Attendance never appears in a judging score or progress metric.
- The event-scale rehearsal scans the full registered population through several stations for two consecutive sessions, including representative VIT card batches/campuses, external QR, fallbacks, exits, returns, duplicates, card rebinding, offline replay, and a session extension.
