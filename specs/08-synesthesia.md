# Synesthesia

## 1. Purpose

Synesthesia is the event music-request system. Participants request and vote for music catalog tracks. Staff moderate the queue and record playback actions. Playback occurs in a separate licensed application.

Synesthesia uses music catalog tracks. These tracks do not classify proposals or affect other event domains.

## 2. Eligibility

A participant can use Synesthesia only when:

- the participant has an active accepted event membership;
- the admission offer is confirmed when policy requires it;
- a published music window is active;
- requests or votes are enabled for that window; and
- the participant's music access is not suspended.

Team state, attendance state, project state, and judging state do not change music eligibility unless the published music policy names that fact.

## 3. Permissions

Staff actions use separate grants:

- `synesthesia.catalog.manage`;
- `synesthesia.window.manage`;
- `synesthesia.window.publish`;
- `synesthesia.request.moderate`;
- `synesthesia.queue.schedule`;
- `synesthesia.playback.pause`;
- `synesthesia.playback.acknowledge`;
- `synesthesia.report.read`;
- `synesthesia.report.resolve`;
- `synesthesia.access.suspend`; and
- `synesthesia.access.restore`.

The role string is never checked for a music action; only a materialized permission grant can allow one. Playback permission does not grant moderation or report access.

An active `synesthesia.queue.read` grant for a window (or the event) also permits approving and rejecting requests in that window, without hosting playback. It does not permit hiding requests, reading internal notes or reports, scheduling, changing requester access, or controlling playback. The audit entry records the actual grant used. Explicit request-moderation grants continue to work independently.

## 4. Catalog

An authorized operator creates an event catalog entry with:

- provider and provider track ID;
- title and artist;
- optional album;
- duration;
- explicit-content flag;
- one normalized energy tag; and
- `active | disabled` state.

The first release supports at most 500 catalog tracks for one event. Search returns at most 20 active results. The current music window filters duration, explicit content, and energy tag.

Disabling a catalog track removes it from later search. It does not edit an earlier request snapshot.

The system stores no provider account token and sends no participant free text to a playback provider.

## 5. Music windows

One event can have at most 64 music windows. A window contains:

- participant-facing name and licensed-source label;
- start and end;
- request and vote switches;
- automatic-approval switch;
- person and event request limits;
- person vote limit;
- duration, explicit-content, and energy rules;
- playback-pause state; and
- `draft | published | closed` state.

Published windows cannot overlap. Server time controls start, end, and pause state.

## 6. Participant flow

1. The participant opens **Music**.
2. The page shows the current music window, current playback item, participant usage, catalog search, and visible request queue.
3. The participant selects one active catalog result.
4. The server rechecks eligibility, suspension, current window, catalog policy, and limits.
5. If the track already has a visible request in the window, the server returns that request. The participant can vote for it.
6. Otherwise, the server creates one request with an immutable catalog snapshot.
7. A rejected or hidden request prevents a second hidden duplicate for that track and window.

The participant can add or remove one vote. The server enforces one vote for each participant and request. A vote guides the playback operator. It does not promise playback.

The participant can report one visible request with a short reason. The report gives staff no permission outside the report.

## 7. Moderation

An authorized moderator can:

- approve in one click, without hosting playback or entering a reason;
- reject in one click, using a default participant-facing message when none is supplied;
- hide with participant-facing text;
- queue;
- pin;
- defer within the current window; or
- return a request to its legal prior state.

Every write uses the current request version, a stable operation ID, and an audit reason. Approval and rejection use automatic audit text when the operator supplies none; hiding, access changes, and report resolution still require their existing reasons. Internal notes and report details require narrower read authority. The authorized Ops queue shows the requester's display name, without adding contact details to the participant queue. Hosting playback is never a prerequisite for moderation.

Two concurrent requests for the same catalog track and window create one request. Two votes by the same participant create one active vote.

## 8. Playback

The dashboard does not control provider audio.

The operator:

1. selects an approved or queued request;
2. starts the same music track in the licensed playback application;
3. records **Started** in Code2Create;
4. later records **Played** or **Skipped**.

One window can have at most one playing request. Two start commands serialize on the window state. A pause or close command fails while a request is playing unless the operator first records a terminal playback action.

Playback records the operator, request version, action, reason when required, and server time.

## 9. Realtime views

Participant and operations views use the same accepted request, vote-count, moderation, report-count, and playback records.

Stable request metadata and high-frequency vote counts use separate bounded projections. A vote update does not resend every request.

The participant view contains no provider login, audio player, exact play-time promise, or queue-order control.

## 10. Safety and privacy

- A music action cannot change admission, attendance, proposal, integration evidence, review routing, judging, or awards.
- A music suspension changes only Synesthesia access.
- Participant search uses the event catalog. It does not query a provider.
- A report reason is visible only to an authorized report reader.
- A hidden request is absent from participant views.
- A rejected request shows only the approved public reason.
- The system stores immutable title and artist snapshots so provider metadata changes do not rewrite history.

## 11. Acceptance checks

- Participant search returns only active tracks allowed by the current window.
- One provider track is unique inside one event catalog.
- One window and track have at most one request.
- One participant and request have at most one vote and one report.
- One window has at most one playing request.
- Duplicate requests and votes converge under concurrent writes.
- Rejected or hidden requests cannot create invisible duplicates.
- Provider playback and Code2Create playback records remain separate.
- Moderation, report, queue, playback, and access grants fail independently.
- Music state reaches participant and operations views in realtime.
- No Synesthesia action changes another product domain.
