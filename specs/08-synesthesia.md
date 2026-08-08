# Synesthesia

## 1. Release boundary

Synesthesia is the shared-room music request system. Participants choose tracks from an event-owned catalog. They can request tracks, vote, and report a request. Event staff moderate the queue. Staff also record what the operator starts, finishes, or skips in a separate licensed playback application.

The platform does not stream or store audio. It does not scrape a provider or hold a participant streaming token. It does not promise that a request will play. A Synesthesia failure does not block registration, attendance, reviews, scoring, or round close.

## 2. Eligibility

A caller can use the participant surface only when all of these are true:

- the event account and participant membership are active;
- eligibility is `eligible`;
- the caller belongs to one active team in `admitted`, `confirmed`, `checked_in`, `active`, or `completed` state;
- the caller has no active staff/judge role for the event;
- the participant's Synesthesia-only access is not suspended;
- one published ambience window is active at server time.

Suspending Synesthesia access blocks requests, votes, and reports. The suspension does not suspend the event account. It does not alter the team, attendance, admission, project, or judging state.

## 3. Permission boundary

Role labels never authorize this surface. Each protected read or command checks its own grant and exact event resource.

| Permission | Valid scope |
| --- | --- |
| `synesthesia.catalog.read` | event |
| `synesthesia.catalog.manage` | event |
| `synesthesia.window.read` | event or exact `synesthesia_window` |
| `synesthesia.window.manage` | event or exact `synesthesia_window` |
| `synesthesia.window.publish` | event or exact `synesthesia_window` |
| `synesthesia.queue.read` | event or exact `synesthesia_window` |
| `synesthesia.request.moderate` | event or exact `song_request` |
| `synesthesia.queue.schedule` | event or exact `song_request` |
| `synesthesia.playback.acknowledge` | event or exact `song_request` |
| `synesthesia.playback.pause` | event or exact `synesthesia_window` |
| `synesthesia.report.read` | event or exact `song_request` |
| `synesthesia.report.resolve` | event or exact `song_request` |
| `synesthesia.access.suspend` | event or exact person |
| `synesthesia.access.restore` | event or exact person |

Queue read does not reveal internal moderation notes without request-moderation authority. Report counts do not reveal report text without report-read authority. Permission to read a window does not grant permission to change it.

## 4. Catalog

An authorized operator enters the provider ID and provider track ID. The operator also enters the title, artist, optional album, duration, explicit-content flag, and one short energy tag. Provider and energy tags use normalized lowercase identifiers. A track is `active` or `disabled`. Disabling a track removes it from future participant searches. Disabling a track does not rewrite requests that already captured its metadata.

The first release supports at most 500 catalog tracks per event. Participant search returns at most 20 active tracks. Each returned track must satisfy the current window's duration, explicit-content, and energy-tag policy. The system never sends free-form participant text to a playback provider.

The final catalog and playback account remain an event policy decision. The catalog owner must verify that every entry exists in the licensed source used at the venue.

## 5. Ambience windows

An ambience window contains:

- name and kind: arrival, working session, late night, morning reset, judging, closing, or a named custom kind;
- start and end, no more than 24 hours apart;
- request-open and voting-open flags;
- manual or automatic approval for catalog-valid requests;
- per-participant request and vote limits;
- total request limit;
- maximum track duration;
- explicit-content and allowed-energy policy;
- a plain label for the licensed catalog source.

The event can hold at most 64 windows. Staff can edit drafts. Publication checks the expected version and the exact publish permission. Publication also checks the event schedule when configured, the future end time, and overlap with every other published window. Published policy is immutable. Staff may pause playback or close the window with a reason. Staff cannot close the window while a request is marked `playing`.

## 6. Participant flow

1. The portal subscribes to the active window and live queue.
2. The participant searches the allowed catalog and may add a note of at most 160 characters.
3. The server rechecks eligibility and suspension. It also rechecks the active window, track policy, total limit, and participant limit.
4. A new request enters `pending` or `approved` according to the published window.
5. If the track already has a visible request in the window, the server returns that request. The participant can then vote instead of creating a duplicate request.
6. A rejected or hidden track cannot be requested again in that window.

Pending requests are visible. This visibility lets another requester find and vote on the existing item. A rejected request remains visible only to its requester and includes the public reason. Participants cannot see hidden requests.

The participant view uses these plain states: waiting for review, approved, in the queue, playing now, played, skipped, or not added. The view does not show an exact play time.

## 7. Voting and reports

- One vote row exists per participant/request.
- Adding or removing the same vote again is idempotent.
- The active vote limit is enforced inside the same transaction that changes the request count.
- Voting is allowed only for pending, approved, or queued requests while the window permits it.
- One report exists per participant/request.
- A report stores a short reason and increments the request's open-report count in the same transaction.
- Resolving or dismissing one report decrements that count in the same transaction and records public and optional internal resolution text.

Votes guide the operator. They are not engagement points, a participant ranking, project evidence, or a judging input.

## 8. Moderation and ordering

A request moves through:

```text
pending -> approved -> queued -> playing -> played
              |          |          |
              +----------+----------+-> skipped
pending/approved/queued -> rejected | hidden
```

Approval, rejection, hiding, normal queueing, pinning, and deferral are separate commands. Playback acknowledgment, report resolution, and requester-access changes are also separate commands. Each command carries a client operation ID. A command that changes an existing request, window, or report also carries the expected version.

The queue order is:

1. playing;
2. queued, with pinned items first and deferred times respected;
3. approved;
4. pending;
5. completed or rejected states.

Votes break ties before request age. An operator may change the mode to normal, pinned, or deferred. The operator must give a reason. A deferral must specify a future server-valid time inside the window.

Rejection or hiding requires a short participant-facing reason. Only a caller with the moderation permission can access internal moderation notes. A caller can read and resolve a report only through its independent grants.

## 9. Playback operation

The first release is operator-driven:

1. the dashboard shows the live queue;
2. the operator starts the chosen track in the licensed playback application;
3. the operator marks that exact request `playing`;
4. the operator marks it `played` or `skipped` with a reason.

Only one request can be playing in a window. The server rejects a start outside the published time. It also rejects a start while playback is paused, before a deferred time, or while another request is playing. The server rejects pause and close commands while a request is playing. This rule prevents an operational boundary from stranding an active item.

Direct provider control is deferred. The Board must first approve the provider terms, venue licence, account owner, token handling, rate limits, and manual fallback. Direct provider control must not replace operator acknowledgements or store audio.

## 10. Data and limits

The live release uses:

- `synesthesiaCatalogTracks` for event-owned catalog metadata;
- `synesthesiaWindows` for draft/published/closed policy;
- `songRequests` for immutable track snapshots and current queue state;
- `songVotes` for one participant/request vote;
- `synesthesiaReports` for one participant/request report;
- `synesthesiaPlaybackEvents` for append-only start/played/skipped acknowledgements;
- `synesthesiaAccessStates` for participant-specific music access.

One window holds at most 200 requests. Every list and participant search is bounded. Each list and search uses a declared index or search index. Convex transactions serialize duplicate requests and votes. They also serialize the one-playing invariant, expected-version writes, report counters, and access-state changes.

## 11. Acceptance checks

- Two concurrent requests for one track create one request.
- A second participant sees a pending duplicate and can vote instead of losing the action.
- A rejected or hidden track cannot create an invisible duplicate request.
- One participant can hold at most one active vote per request and cannot exceed the published window vote limit.
- Participant, queue, vote, report, pause, and playback states update across authorized clients without refresh.
- Event-wide and exact-resource grants produce the same command only inside their permitted scope; losing the grant blocks the next read/write.
- A moderation note or report reason never appears through queue-read alone.
- A stale moderation, schedule, playback, report, catalog, window, or access write changes nothing.
- Two start commands cannot create two playing requests.
- Pause or close cannot strand a playing request.
- A participant music suspension changes no event-account, attendance, project, admission, or judging record.
- Synesthesia unavailability leaves registration, attendance, reviews, scores, and round close usable.
