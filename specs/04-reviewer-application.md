# Reviewer app

## 1. Product shape

Reviewers use a dedicated Expo application on Android or iOS. A browser/PWA is not the planned reviewer surface.

The signed binary also contains a capability-gated attendance scanner for rostered SC/JC staff on provisioned devices. An External Judge never sees scanner routes; an SC or JC on attendance duty does not receive review context or scorecard routes.

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
- `expo-camera` for team QR scans
- `react-native-nfc-manager` behind an app-owned adapter for compatible existing VIT ID cards in custom builds
- `expo-notifications` for pages and time warnings
- `expo-secure-store` for the auth cookie and local encryption key
- SQLCipher-backed `expo-sqlite` for the current review draft and unsent operations
- EAS development, staging, and production builds

Reviewer testing uses development builds. Expo Go does not represent the production auth callback, notification, camera, or encrypted-database setup.

Attendance scanner mode and its pending queue are specified in **Attendance and presence**. Reviewer team-QR presence remains a separate command and token type.

## 3. Navigation

The bottom-level route set stays small:

1. **Now**
2. **History**
3. **Profile**

Sign-in, page response, scan, and active review are focused screens outside normal navigation.

The **Now** screen can show only one primary action:

- Sign in
- Complete device check
- Clock in
- Respond to page
- Go to table
- Scan team
- Continue review
- Submit scorecard
- No current assignment

## 4. Sign-in and device check

Google sign-in opens the system browser and returns through a production app deep link. Better Auth stores the resulting session cookie in SecureStore.

After sign-in, the app calls `reviewer.bootstrap`. The response either contains the reviewer’s event grant and current work or a refusal reason.

Before clock-in, the app checks:

- production or approved staging build;
- minimum build number;
- notification permission and a registered token;
- camera permission;
- local encrypted database can open;
- current Convex connection;
- reviewer profile and training acknowledgement.

The device record stores no Google password or raw OAuth token.

## 5. Clock-in

The clock-in screen shows:

- event and review window;
- assigned panel and venue zone, when published;
- availability end time;
- declared criterion coverage;
- unresolved conflict or training block.

Clock-in is one server write. The app then subscribes to `reviewer.now`, which contains the reviewer’s current panel, page, assignment, and review.

The reviewer can mark **Temporarily unavailable** with a reason and expected return time. Operations sees it immediately and decides whether to replace the seat.

## 6. Page response

A substitute or reassignment page includes:

- panel and table;
- reason for the page;
- expected duration;
- criteria the reviewer would cover;
- response deadline.

The screen has **Accept** and **Decline**. Decline asks for one short reason.

Opening a notification fetches the current page from the server. A stale or cancelled page cannot be accepted from an old notification.

The page states are:

`sent → opened → accepted`

or:

`sent → declined | expired | cancelled`

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

- confirmed project brief with team-written and model-assisted fields clearly distinguished;
- the source participant answers behind every model-assisted brief field;
- server-assigned event phase, fresh-project attestation, core-track version, and optional sponsor-track versions;
- problem, user, and evidence;
- disclosed general-purpose starting resources and allowed pre-start setup;
- current demo state;
- one GitHub/Figma evidence checkpoint set fixed to this review;
- previous review findings and commitments;
- changes claimed since the previous review;
- active rubric and the reviewer’s criteria;
- timer start and end time.

The app does not download another panel’s notes, private eligibility evidence, or peer score values.

The reviewer can expand a brief field to its exact participant-written source answers. A generated phrase is convenience text, not evidence. The original answer, disclosure, demo, and integration checkpoint remain available, and no OpenAI suggestion or hidden candidate track appears in review context.

The evidence tab can open:

- the ordered GitHub repository index with kind, purpose, topic, branch/root, baseline/head, freshness, and completeness;
- per-repository activity charts, changed paths, commit facts, captured tree, and an authorised text file at that repository’s fixed SHA;
- the Figma page/frame index, captured previews, layer properties, components, prototype flows, named versions, comment state, and changed-screen list;
- freshness, completeness, truncation, rate-limit, and provider-access warnings.

The review keeps the checkpoint-set ID chosen at start. If a repository is added, removed, reclassified, reordered, or refreshed later, the app may show **Newer evidence available** but cannot swap the scoring context. SC with review-operations duty must explicitly restart or replace the context when policy requires it.

If the reviewer notices a conflict that was not declared, **Report conflict** freezes that reviewer’s scorecard and alerts operations.

## 9. Review workspace

The workspace has four parts.

### Timer

The start/query response includes `serverNow`, `startedAt`, and approved extension seconds. The app derives the remaining duration from the server offset, then advances it with a monotonic device clock. It resynchronises after foregrounding or reconnect so a wrong device wall clock cannot change the official timer.

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

Private judge notes remain attached to that judge. Panel commitments are a separate shared field entered by the panel coordinator and confirmed before review completion.

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
- the header changes to **Offline — not yet saved**;
- pending changes keep their operation IDs;
- reconnect sends changes in order;
- a stale server version opens a comparison screen instead of overwriting either copy.

Only the active review draft is kept offline. Completed project context and scorecards are not kept as a local archive.

## 11. Submission

The reviewer presses **Review and submit**. The app lists missing criteria, required explanations, and unresolved sync.

Submission sends the complete scorecard plus a stable submission operation ID. The server checks:

- reviewer, panel, and session still match;
- review is open;
- rubric version and criterion assignments match;
- every assigned criterion is valid;
- expected draft version is current;
- the scorecard was not already submitted.

The app shows **Submitted** only after the server returns the submitted scorecard ID and time.

If the response is lost, the app queries that operation ID. It either finds the accepted submission, retries the same operation, or shows a definite rejection. It never creates a second scorecard.

After submission, editing is locked. A correction uses the review-administrator flow and keeps both versions.

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

## 13. Notification behaviour

Push is used for:

- substitute pages;
- imminent assignment;
- panel moved or paused;
- scorecard/correction action requested;
- clock-out reminder.

The payload contains a page or event ID and a route, not private project text or scores.

The app fetches current state after opening. Provider delivery tickets are logged, invalid tokens are disabled, and an unacknowledged critical page becomes an operations exception.

## 14. Ergonomics and accessibility

- primary controls are at least 48 device-independent pixels;
- score controls include number and text, not colour alone;
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
- attendance devices record NFC/camera capability, station assignment, tested VIT card batch/campus compatibility, and a tested QR fallback;
- the minimum supported build is fixed after the final rehearsal;
- a remote update is tested, but a new native build is not planned during the event.

On a device handover, operations revokes the old device, registers the spare, and confirms any unsynced active draft before reassignment.

## 16. Acceptance checks

- An unrostered user receives no reviewer context.
- A stale push cannot accept a cancelled page.
- The same reviewer cannot hold two accepted pages that overlap.
- A scan for another panel or round is rejected.
- A VIT ID card or attendance QR cannot be submitted to the reviewer team-QR command, or vice versa.
- Attendance scanner routes require a current station assignment and never expose participant bearer values after parsing.
- Timer remains correct after backgrounding and restart.
- Peer scores never appear before the configured reveal point.
- A short offline edit survives app restart and syncs once.
- An ambiguous submit response resolves to one submitted scorecard.
- Logout or device revocation removes access and prevents queued operations from gaining authority.
- A provider credential never enters the mobile cache, logs, or an evidence response.
- An assigned reviewer can inspect only repository files and Figma artifacts listed in that review’s evidence checkpoint set.
- A newer provider snapshot or changed repository set cannot silently replace the evidence fixed when the review started.
