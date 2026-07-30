# Synesthesia

## 1. Purpose

Synesthesia lets participants request and upvote music during the event while event staff keep control of safety, ambience, timing, and playback.

It shares participant identity and event configuration with the main platform. Its records and failures do not block registration, reviews, scoring, or round close.

## 2. Access

| Person | Access |
| --- | --- |
| Participant | Search/request an allowed track, vote once, remove own vote, report a request |
| JC/SC with Synesthesia duty | Approve, reject, hide, schedule, add a reason, view the playback queue, and acknowledge start/finish/skip |
| Board | Publish windows, vote policy, catalogue source, and moderation rules |

## 3. Request flow

1. Participant searches the approved catalogue or enters the supported track identifier.
2. The server checks event window, participant status, duplicate track, request limit, and moderation rules.
3. If the track already exists in the active window, the participant is offered a vote.
4. Otherwise the request enters `pending` or `approved` according to moderation policy.
5. Participant sees the request state and any plain rejection reason.

Free-form text is limited to a short optional note. It is not sent to the playback provider as a search query without validation.

## 4. Voting

- One active vote per participant per request.
- Repeating the same vote operation does not add another vote.
- Removing a vote subtracts it once.
- Vote totals update live.
- Staff and playback accounts do not vote.
- A participant may not vote while suspended.

The event can set per-window request and vote limits.

## 5. Playback queue

Approved requests receive a priority from:

- vote count;
- age;
- ambience window;
- recently played artist/track limits;
- moderator scheduling;
- explicit event override.

The normal queue order is computed from published rules. A moderator can pin, defer, or skip an item with a reason.

Participant views show **Requested**, **Approved**, **Queued**, **Playing**, **Played**, **Skipped**, or **Rejected**. They do not promise an exact play time.

## 6. Ambience windows

Board can publish windows such as:

- arrival;
- working session;
- late night;
- morning reset;
- judging;
- closing.

A window can change allowed energy/explicit-content tags, maximum duration, request limits, and whether participant voting is open.

Judging and announcements can pause playback without deleting the queue.

## 7. Moderation and safety

Reject or hide a request for:

- explicit content outside the configured window;
- harassment or targeted message;
- unsafe or prohibited media;
- duplicate/spam behaviour;
- licensing or catalogue restriction;
- event direction.

A moderator action stores actor, reason, and time. Participants see a short public reason, not internal notes.

Reports create support cases. Repeated abuse can suspend Synesthesia access without suspending the participant from the event unless Board chooses that separate action.

## 8. Playback integration

The playback source and licensing are open decisions.

The first release can use an operator-driven queue:

1. dashboard shows the next approved item;
2. operator starts it in the licensed playback application;
3. operator acknowledges **Playing**;
4. operator marks **Played** or **Skipped**.

Direct provider control should be added only after confirming API terms, venue licensing, account ownership, and failure behaviour. The platform must not scrape a streaming service or store audio.

## 9. Data model

Core records:

- `synesthesiaWindows`
- `songRequests`
- `songVotes`
- `playbackEvents`
- moderation audit events

Requests store provider track ID and display metadata, not media files.

## 10. Acceptance checks

- A participant can hold at most one vote on a request.
- Duplicate requests resolve to the existing active request.
- Moderation changes appear in participant and playback views without refresh.
- A moderator override records a reason.
- Closing a voting window blocks new requests/votes but keeps the playback queue.
- Synesthesia outage does not affect any review or score function.
