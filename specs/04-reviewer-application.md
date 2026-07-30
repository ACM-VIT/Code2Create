# Reviewer application

## 1. Design intent

The reviewer application is a dedicated mobile experience because it must reliably page reviewers and stay synchronised with the operations dashboard. It is not a compressed admin dashboard.

The interface uses:

- one primary action per screen;
- large tap targets;
- minimal persistent text;
- high contrast and clear state colour plus text/icon;
- no gesture-only critical actions;
- visible sync state;
- local drafts with explicit server receipts;
- no peer score anchoring before independent submission.

## 2. Implementation baseline

- Expo + React Native + Expo Router, written in TypeScript
- `@clerk/expo` with Google-only authentication
- Convex React client for queries, mutations, authentication, and automatic subscription recovery
- `expo-camera` for QR presence scans
- `expo-notifications` with Expo/native device tokens for paging
- `expo-secure-store` for device-bound secrets and encryption keys
- SQLite-backed durable outbox for protected drafts and unacknowledged commands
- EAS Build for signed Android/iOS artifacts and EAS Update channels for compatible JavaScript fixes
- Sentry for crashes, performance, and release correlation

The app is a native client of the same Convex deployment as the web portal and operations dashboard. It does not call a separate “mobile backend.”

## 3. Navigation

Primary destinations:

1. **Now** — current instruction, active page, panel, or review
2. **Reviews** — upcoming and completed assignments
3. **Panel** — members, readiness, coverage, and contact/escalation
4. **Status** — clock-in, availability, device/network health
5. **Help** — conflict, missing team, safety, device, or connectivity issue

Administrators may receive additional controls, but the default reviewer view stays focused.

## 4. Round clock-in

The reviewer:

- confirms identity;
- verifies device battery and notification permission;
- sees connectivity and last successful sync;
- confirms availability;
- acknowledges panel and meeting point;
- clocks in.

The app displays any missing training, criterion grant, or conflict declaration that blocks eligibility.

## 5. Page handling

A page contains:

- reason (assignment, substitution, escalation)
- team/table or rendezvous point
- response deadline
- accept, decline, and cannot-attend actions

Decline/cannot-attend requires a short reason. Repeated unacknowledged pages raise an operations alert. Critical pages produce a distinct notification pattern, subject to device accessibility settings.

## 6. Team arrival and presence

At the table:

1. App opens scanner from the active assignment.
2. Reviewer scans the team QR.
3. App displays team name, table, round, and project one-line summary.
4. Reviewer confirms the match.
5. Presence is recorded.

The app shows panel readiness without exposing personal explanations. When all required reviewers are present, an eligible panel member can start the review.

## 7. Review workspace

### Header

- team, track, table, and round
- timer
- sync indicator
- panel presence
- pause/help action

### Context

- concise project brief
- prior-round commitments and verified evidence
- material project changes
- disclosed tools, APIs, models, datasets, and starter code
- private assignment rationale where appropriate

### Evidence checklist

Configurable evidence observations include:

- core user flow demonstrated end to end
- UI or interface implemented
- working model/service demonstrated
- repository or build evidence shown
- original contribution explained
- stated milestone completed
- safety/data/tool disclosures consistent

Checkboxes are observations, not automatic scores. Each can include a short note or evidence link.

### Criterion scoring

Only assigned criteria appear as required. Each criterion shows:

- plain-language definition
- 0–4 scale anchors
- weight
- evidence prompts
- score selector
- concise rationale field
- not-applicable/escalate option where permitted

The reviewer cannot see another reviewer's selection before submitting their own.

### Notes

Notes are separated into:

- evidence observed
- claims not verified
- risks or concerns
- next-round commitment
- private operations note
- candidate participant feedback

Audio recording or transcription is deferred and disabled unless separately approved for consent, privacy, retention, and sponsorship feasibility.

## 8. Independent submission

The submit screen checks:

- all assigned criteria completed;
- required rationale present for extreme scores or configured cases;
- critical evidence and risk prompts handled;
- next-round commitment recorded when applicable;
- no unresolved conflict;
- draft sync status.

On submit:

1. The client sends an idempotent versioned submission containing `clientMutationId`, `deviceId`, session ID, lease epoch, rubric version, and expected draft version.
2. The server validates reviewer eligibility, session, criterion grant, and score range.
3. The server returns a receipt.
4. The app displays **Submitted and synced** with time.

Closing the screen before receipt must show a persistent unsynced warning. The reviewer may continue only under the degraded-mode policy.

## 9. Completing the panel review

The review session can complete when:

- every required reviewer has submitted all assigned criteria;
- all required criteria have valid coverage;
- required panel-level evidence/commitments exist;
- the timer is stopped;
- every record has a server receipt or an authorised degraded-mode disposition.

A panel lead coordinates completion but cannot edit peer scores.

## 10. Corrections

A reviewer can request correction after submission. They see:

- existing value
- replacement value
- mandatory reason
- impact warning

The correction creates a new version. Administrators can lock corrections at round close. Emergency changes after lock require board authority and are highlighted in the audit/export.

## 11. Offline and degraded state

The app always labels one of:

- Online and synced
- Online, syncing
- Connection unstable
- Offline with protected draft
- Action blocked: server confirmation required

Scores and notes may be drafted offline. Starting a new review, claiming a team lease, final submission, and privileged overrides require server confirmation unless the formally activated degraded-mode procedure is in effect.

No state may say “submitted” without a server receipt.

The local outbox stores only the minimum command payload, encrypted with a per-installation key held in operating-system protected storage. Records move through `local_draft → queued → sending → acknowledged` or `needs_attention`. A server receipt purges the acknowledged payload after the configured recovery window. A rejected stale command remains visible and is never silently retried as a new version.

Push notifications wake or alert the reviewer. The app always opens and subscribes to `reviewer.now` before presenting an assignment as current; notification payload data is not authoritative.

## 12. Accessibility and ergonomics

- Critical controls are reachable one-handed.
- Minimum touch size and text scaling support are required.
- Timer warnings use visual, haptic, and optional audio cues.
- Colour is never the only status indicator.
- Scanner has manual fallback.
- Reviewers can pre-download assigned team context.
- Long text is not required during active scoring; structured prompts and optional voice-to-text provided by the operating system may be used.

## 13. Acceptance criteria

- A trained reviewer can complete the normal flow without instruction after one rehearsal.
- A reviewer cannot score an unassigned criterion.
- Peer scores never influence the initial independent entry.
- A submission cannot be lost or falsely shown as synced.
- A restarted app recovers the latest acknowledged draft/session.
- A conflict can be raised at any point.
- Every timer extension identifies actor, time, duration, and reason/policy.
- Panel completion detects missing criteria, not merely missing reviewers.
- A push can be late, duplicated, or absent without corrupting assignment state.
- Reinstalling or revoking a device invalidates its push token and prevents old outbox commands from acquiring new authority.
- A change accepted on the operations dashboard appears in the reviewer app through its active subscription without polling.
