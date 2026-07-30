# Synesthesia

## 1. Goal

Synesthesia gives participants a lightweight way to shape the room's music without surrendering ambience, safety, or final control to an unmoderated popularity queue.

## 2. Roles

- Participant: request, upvote, remove own vote, report
- Moderator: approve/reject, edit metadata, mark explicit, schedule, skip
- Playback controller: start/pause/skip/reorder within policy
- Board administrator: override and manage policy

## 3. Request flow

1. Participant searches the approved music catalogue/source.
2. Existing matching requests appear first.
3. Participant upvotes an existing item or creates a request.
4. New requests enter moderation unless the source/policy allows automatic eligibility.
5. Eligible items appear in the participant queue with title, artist, duration, votes, and broad playback status.

Free-text URLs do not directly enter playback.

## 4. Voting

- One active vote per person per song request.
- A requester automatically adds one vote.
- Votes can be removed until the item is locked for playback.
- Duplicate song/version requests merge under moderator control.
- Vote count influences priority but does not guarantee immediate playback.
- Rate limits prevent one participant from flooding requests.

## 5. Queue policy

Ranking can consider:

- unique votes
- request age
- recent artist/genre repetition
- song duration
- energy/ambience window
- language and genre diversity
- moderator scheduling

The exact formula may remain private to reduce gaming, but participants must be told that votes are advisory and moderation/ambience rules apply.

## 6. Ambience windows

Moderators can define room modes such as:

- arrival / soft ambient
- build session / low-distraction
- high-energy break
- late-night
- announcements pause
- quiet/review window

A request can be eligible now, held for a suitable window, or rejected.

## 7. Moderation

Reasons include:

- explicit or unsuitable content
- duplicate
- unavailable source
- excessive duration
- repeated artist/genre
- disruptive for current event phase
- reported content
- organiser policy

Rejection reasons are visible to the requester at an appropriate level. Moderator actions are audited.

## 8. Playback

- Only one controller owns the active playback lease.
- Now playing and recently played are visible.
- Playback history prevents accidental repeats.
- Organisers can pause for announcements or reviews.
- Skip/override requires a reason category; free text is required for exceptional cases.
- A fallback curated playlist/set is available if the queue is empty or the service fails.

## 9. Privacy and safety

- Public views show aggregate votes, not voter identities.
- Reports are private.
- Requests and votes are tied to verified event identities for abuse control.
- Content filtering is configured before launch.
- Playback source licensing and venue terms must be reviewed by organisers.

## 10. Acceptance criteria

- Duplicate requests do not split votes indefinitely.
- A participant cannot cast duplicate votes.
- Voting never removes organiser control.
- The active player cannot be controlled simultaneously by two devices.
- Announcements can interrupt playback immediately.
- The system can fall back to a curated source without blocking event operations.
- Moderator and override actions are auditable.

