# Reviewer app

## 1. Product shape

Reviewers use a dedicated Expo application on Android or iOS. A browser/PWA is not the planned reviewer surface.

The signed binary also contains a permission-gated attendance scanner on provisioned devices. Scanner routes require station-scoped attendance grants. Review context and scorecard routes require review-scoped grants. A role alone exposes neither set. One person can receive either or both sets regardless of role.

The app is built for a reviewer standing at a venue table:

- one current task;
- large controls;
- little text;
- no deep menu;
- clear saved/offline state;
- no peer scores;
- no decorative dashboard.

The app talks to the same Convex backend as the participant portal and operations dashboard.

## 2. Build and distribution

- Expo with React Native and Expo Router
- `@better-auth/expo` for Google sign-in and secure cookie handling
- Convex React client for live queries and writes
- `expo-camera` for review-presence team QR scans
- explicit camera modes for VIT IDs, static external event passes plus external physical IDs, external badges, and review-presence QR
- `expo-notifications` for native APNs/FCM registration, pages, and time warnings
- `expo-secure-store` for the auth cookie and local encryption key
- SQLCipher-backed `expo-sqlite` for the current review draft and unsent operations
- local Expo prebuilds with signed Gradle/Xcode staging and production artifacts

Reviewer testing uses development builds. Expo Go does not represent the production auth callback, notification, camera, or encrypted-database setup.

Attendance scanner mode and its pending queue are specified in **Attendance and presence**. Reviewer team-QR presence remains a separate command and token type.

The attendance surface separates **First check-in** from later **Record presence** scans. The workflow chooser explains the difference before opening the camera. First check-in presents separate VIT and external scan instructions, confirms the resolved identity, shows progress through identity verification and venue arrival, and does not label the flow complete until arrival is recorded. It accepts a VIT ID barcode directly and resolves only an eligible, accepted RSVP membership. External first check-in scans the participant's static emailed event pass and then their physical-ID barcode. A fallback sheet searches VIT participants by registration number and external participants by verified email when a barcode cannot be read.

## 3. Navigation

The bottom-level route set stays small:

1. **Now**
2. **History**
3. **Profile**

Sign-in, page response, scan, and active review are focused screens outside normal navigation.

**Support** is a secondary event-app surface whenever the account retains its self-scoped support create/read/reply grants. It lists only cases reported by that person and accepts a short category, description, and reply. It is never placed inside the scorecard and cannot change the current review, queue, attendance, device registration, or access state.

The **Now** screen can show only one primary action:

- Sign in
- Complete device check
- Clock in
- Respond to page
- Go to team
- Scan team
- Continue review
- Submit scorecard
- No current assignment

### Visual direction

The reviewer application does not share the operations dashboard's design. The dashboard is a dense work surface for a seated operator. A reviewer uses the mobile application while standing, with one hand, in a loud hall, and sometimes late at night. The interface uses few words, large icons, generous targets, and colour with a second non-colour cue.

The single primary action fills the screen. It is a large target with an icon and two or three words. It is not a row in a list. Use a running application's start button as the reference. A reviewer must understand the next action from across a table.

Colour identifies the kind of action rather than decorating it, and each action keeps its colour everywhere it appears, so the mapping can be learned once:

| Action                            | Reads as                                     |
| --------------------------------- | -------------------------------------------- |
| Respond to page                   | Urgent. The panel is waiting for this person |
| Go to team, Scan team             | Move or scan. This is a physical step        |
| Continue review, Submit scorecard | The work itself                              |
| Complete device check, Clock in   | Setup, before judging can begin              |
| No current assignment             | Resting. No action is required               |

Small text under the action shows the team name and round. History or Profile contains other detail.

What a reviewer sees follows from their grants, as everywhere else in the product. A person who holds only review grants never sees the attendance scanner or support surfaces, and the shell does not hint that they exist.

## 4. Sign-in and device check

Google sign-in opens the system browser and returns through a production app deep link. Better Auth stores the resulting session cookie in SecureStore.

After sign-in, the app calls `reviewer.bootstrap`. The response either contains the reviewer’s event grant and current work or a refusal reason.

Before clock-in, the app checks:

- production or approved staging build;
- minimum build number;
- notification permission and a registered token;
- current reviewer-page phone-call consent state and consented E.164 destination;
- camera permission;
- local encrypted database can open;
- current Convex connection;
- active reviewer profile. There is no training acknowledgment or tutorial gate.

The device record stores no Google password or raw OAuth token.

## 5. Clock-in

Before the round, an availability card opens at the scheduled confirmation time, normally 22:00–23:00 IST the evening before the review. It offers all of the round's time windows, a whole-round selection, and an explicit unavailable response. There is no three-selection limit. Form-export hours are never prefilled as promises. Operations sees pending, confirmed, and unavailable responses separately. Only qualified reviewers with confirmed coverage may clock in for a review. Early arrival uses the interval between the published clock-in opening and round start, applied to each confirmed shift, and never opens before the round's published clock-in time. Reminder timing does not gate clock-in. The confirmed shift must still have enough remaining time for a complete review.

The clock-in screen shows:

- event and review window;
- published clock-in opening and reviewer report time;
- assigned panel and venue zone, when published;
- availability end time;
- declared criterion coverage;
- active reviewer profile and any declared conflict.

Clock-in is one server write. The server, not the phone clock, enforces the published opening and round end and rechecks round-confirmed coverage for a complete review. The app keeps the control unavailable before the published opening and treats the server refusal as authoritative. It then subscribes to `reviewer.now`, which contains the reviewer’s current panel, page, assignment, and review.

The reviewer can mark **Temporarily unavailable** with a reason and expected return time. Operations sees it immediately and decides whether to replace the seat.

## 6. Page response

A substitute or reassignment page includes:

- panel and table;
- reason for the page;
- expected duration;
- criteria the reviewer would cover;
- response deadline.

The screen has **Accept** and **Decline**. Decline asks for one short reason.

Opening a notification fetches the current page from the server. A stale or canceled page cannot be accepted from an old notification.

The app explains reviewer-page calls during device setup. The reviewer can grant, update, or revoke consent. The screen names the synthesized fallback purpose and destination. The stored row pins the current consent and script-policy versions. Consent does not grant call authority. A call still requires the page chain's current `review.substitute.page` grant. Push remains first unless it has no usable device address.

If a call arrives, it asks the reviewer to open the app. It contains no proposal, participant, score, or private incident detail. The reviewer still accepts or declines in the app.

The page states are:

`sent → opened → accepted`

or:

`sent → declined | expired | canceled`

## 7. Team presence

The app enables **Scan team** only for the reviewer’s current assignment.

After a scan, it shows:

- team name;
- project title;
- table;
- round;
- presence count, such as `2 of 3 reviewers present`.

The reviewer confirms the result before the presence write. The app does not expose the QR token after parsing it.

If the camera fails, the reviewer can type the fallback code. A backend rejection explains whether the code expired, belongs to another round, or does not match the assignment.

## 8. Review context

When the review starts, the app caches the context required to finish that active review:

- submitted initial idea, ordered follow-up question/answer snapshots, and optional additional information or links written by the team;
- the immutable intake-policy and generated-question references behind that submitted sequence;
- server-assigned event phase and fresh-project attestation;
- problem, user, and evidence;
- disclosed general-purpose starting resources and allowed pre-start setup;
- current demo state;
- a GitHub evidence checkpoint set fixed to this review;
- the team’s Figma link, opened through its existing icon;
- previous review findings and commitments;
- changes claimed since the previous review;
- active rubric and the reviewer’s criteria;
- timer start and end time.

The app does not download another panel’s notes, private eligibility evidence, or peer score values.

The reviewer can expand a brief field to its exact participant-written source answers. A generated phrase is convenience text, not evidence. The original answer, disclosure, demo, and integration checkpoint remain available. The admission-analysis recommendation does not appear in judging context.

The evidence tab can open:

- the ordered GitHub repository index with kind, purpose, topic, branch/root, baseline/head, freshness, and completeness;
- per-repository activity charts, changed paths, commit facts, captured tree, and an authorized text file at that repository’s fixed SHA;
- the participant-provided Figma link;
- freshness, completeness, truncation, rate-limit, and provider-access warnings.

The review keeps the checkpoint-set ID chosen at start. If a repository is added, removed, reclassified, reordered, or refreshed later, the app may show **Newer evidence available** but cannot swap the scoring context. `review.evidence_context.replace` for that review must explicitly restart or replace the context when policy requires it.

Repository browsing uses the SHA fixed for the review. Figma is a link only: no OAuth connection, artifact capture, frame comparison, or automated design analysis is required. Reviewers open the linked design themselves.

If the reviewer notices a conflict that was not declared, **Report conflict** freezes that reviewer’s scorecard and alerts operations.

## 9. Review workspace

The workspace has four parts.

### Timer

The start/query response includes `serverNow`, `startedAt`, and approved extension seconds. The app derives the remaining duration from the server offset, then advances it with a monotonic device clock. It resynchronizes after foregrounding or reconnect so a wrong device wall clock cannot change the official timer.

The discussion limit defaults to seven minutes and follows the published ops configuration. At expiry, the server moves the review to scoring. The UI shows score entry and final comments without locking unfinished scorecards; it never silently submits them.

### Evidence

The configured checklist can include:

- participant demonstrated a working interface;
- core flow worked live;
- prototype/model was shown instead of a working implementation;
- team identified work completed before the event;
- repository/design evidence was available;
- previous commitments were addressed;
- risk or disclosure needs follow-up.

Evidence items support the score but do not calculate it.

### Criteria

The app shows only criteria assigned to the reviewer. Each criterion contains:

- short question;
- anchors for 0 through 4;
- one score control;
- optional evidence note;
- required explanation for 0 or 4.

Changing a score or checkbox saves immediately. Text saves after a short idle period and on blur.

### Notes and commitments

Every reviewer must leave a final comment at the end of the review. That comment is part of completing their scorecard. Private judge notes remain distinct from shared panel findings. Panel commitments are a separate shared field entered by the panel coordinator and confirmed before review completion. The configured final-comment requirement is checked on submission, correction and paper recovery; drafts can remain incomplete.

## 10. Draft saving

The server stores one draft scorecard per reviewer and review session.

Each save contains:

- scorecard ID;
- fields changed;
- client operation ID;
- expected draft version;
- device ID;
- local edit time.

The server returns the new draft version. The app then shows **Saved**.

If the connection drops:

- edits continue in the encrypted local draft;
- the header changes to **Offline: not yet saved**;
- pending changes keep their operation IDs;
- reconnect sends changes in order;
- a stale server version opens a comparison screen instead of overwriting either copy.

Only the active review draft is kept offline. Completed project context and scorecards are not kept as a local archive.

## 11. Submission

The reviewer presses **Review and submit**. The app lists missing criteria, required explanations, the required final comment, and unresolved sync.

Submission sends the complete scorecard plus a stable submission operation ID. The server checks:

- reviewer, panel, and session still match;
- review is open;
- rubric version and criterion assignments match;
- every assigned criterion is valid;
- expected draft version is current;
- the scorecard was not already submitted.

The app shows **Submitted** only after the server returns the submitted scorecard ID and time.

If the response is lost, the app queries that operation ID. It either finds the accepted submission, retries the same operation, or shows a definite rejection. It never creates a second scorecard.

After submission, editing is locked. A correction uses the separately authorized correction flow and keeps both versions.

## 12. Short connection loss

The app is online-first.

Allowed during a brief outage:

- read cached context for the current active review;
- continue the current timer from server time;
- edit the current local scorecard;
- queue draft saves and one submission attempt.

Blocked while offline:

- clock-in;
- page acceptance;
- new QR presence;
- starting a review;
- confirming an extension;
- claiming submission success;
- beginning a different team’s review.

If the active scorecard cannot sync, the reviewer stays on that review. Operations moves the reviewer to a spare device/hotspot or pauses the panel. The system does not copy state over Bluetooth.

## 13. Notification behavior

Push is used for:

- substitute pages;
- imminent assignment;
- panel moved or paused;
- scorecard/correction action requested;
- clock-out reminder.

The payload contains a page or event ID and a route, not private project text or scores.

The app fetches current state after opening. Provider delivery tickets are logged, invalid tokens are disabled, and an unacknowledged critical page becomes an operations exception.

The current panel and reserve projection also carries the round-wide pause bit. The app says that new reviews are paused, suppresses the coordinator’s start control while the pause is active, and keeps an already-active scorecard usable. It does not expose the incident title, summary, or operator reason through reviewer access.

## 14. Ergonomics and accessibility

- primary controls are at least 48 device-independent pixels;
- score controls include number and text, not color alone;
- the app supports system text scaling without hiding submit or timer state;
- scanning has manual-code and screen-reader paths;
- destructive or final actions require a confirmation screen;
- haptics and sound support alerts but are never the only signal;
- light and dark themes maintain readable contrast in the venue.

## 15. Fleet operation

Before the event:

- every reviewer installs and opens the production candidate;
- sign-in, push, camera, and SecureStore are tested on the actual device;
- operations records a spare-device pool and charging plan;
- attendance devices record camera capability, station assignment, tested VIT ID barcode formats, and a tested QR fallback;
- the minimum supported build is fixed after the final rehearsal;
- a remote update is tested, but a new native build is not planned during the event.

On a device handover, operations revokes the old device, registers the spare, and confirms any unsynced active draft before reassignment.

## 16. Acceptance checks

- An unrostered user receives no reviewer context.
- A stale push cannot accept a canceled page.
- The same reviewer cannot hold two accepted pages that overlap.
- A scan for another panel or round is rejected.
- A VIT ID barcode or attendance QR cannot be submitted to the reviewer team-QR command, or vice versa.
- Attendance scanner routes require a current station assignment and never expose participant bearer values after parsing.
- Timer remains correct after backgrounding and restart.
- Peer scores never appear before the configured reveal point.
- A short offline edit survives app restart and syncs once.
- An ambiguous submit response resolves to one submitted scorecard.
- Logout or device revocation removes access and prevents queued operations from gaining authority.
- The support surface can create, list, open, and reply to only the signed-in person's cases; retrying after an ambiguous response adds no duplicate, and internal support actions never appear.
- A provider credential never enters the mobile cache, logs, or an evidence response.
- An assigned reviewer can inspect only repository files listed in that review’s evidence checkpoint set.
- A newer provider snapshot or changed repository set cannot silently replace the evidence fixed when the review started.
- A round pause removes the start control on every connected reviewer device without interrupting an already-active review or its draft.


## Venue confirmation and simpler reviewer actions

GPS is advisory. Sustained outside readings prompt an app reminder and, when configured and consented, a conversational check-in call. Ops selects the published voice agent/version and timing; the response and transcript are recorded separately from GPS and call delivery status. A current explicit unavailable answer can end duty and request a substitute between reviews. Active discussion and unfinished scorecards remain locked; unclear answers or requests for help need ops follow-up. No answer never becomes confirmation. Normal clock-in is the return-to-duty action and cancels an older unresolved check.

The review brief is optional. Eligible repository text and the team's submitted idea inform ungraded follow-up questions. Figma stays a link for the reviewer. Suggested questions cannot change the published rubric or add graded criteria. Binary assets, inaccessible repositories, and runtime verification remain explicit limitations. See [current implementation and rehearsal](15-event-review-readiness.md).

Between reviews, the app shows the assigned panel or an on-call reserve state. Breaks and clock-out are available from duty controls. The break sheet dismisses before those controls disappear. An accepted substitute page opens Reviews; an expired page can be dismissed even when the live query is offline. The team code confirms arrival before the coordinator starts. Paging settings, duty changes, and availability editors are absent while a review is assigned.
