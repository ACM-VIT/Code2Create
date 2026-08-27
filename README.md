# Code2Create 7.0

## Platform handbook

This handbook defines the Code2Create 7.0 platform. It covers the participant portal, event app, operations dashboard, judging workflow, attendance, and backend.

The event lasts 48 hours. Approximately 900–1,000 people attend at one venue. The previous review process had four main problems:

- Reviewers were absent or difficult to locate.
- Teams waited without clear queues.
- Reviewers did not have enough project context.
- People moved scores through informal channels.

The platform must correct these problems.

`README.md` and `specs/*.md` are the sole source of truth for this handbook. The canonical read-only mirror is [code2create-specs.theg1239.chatgpt.site](https://code2create-specs.theg1239.chatgpt.site). It uses a simple password for planning access.

## Local full-flow testing

Run `pnpm dev` from the repository root. It starts the local Convex deployment, applies the localhost service configuration, and starts every application. It does not create an event, account, team, application, queue, review, or provider result.

The command prints the local address list only after every surface answers its readiness route. If one surface never becomes ready, the command names it and stops the complete stack. `Ctrl-C`, terminal close, and normal startup failure terminate the child process groups, so an old Vite, Convex, Expo, or Wrangler process does not keep a port occupied.

Local testing uses real Google identity. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `INITIAL_SUPREME_EMAILS` in `apps/backend/.env.local`. Register `http://localhost:3211/api/auth/callback/google` as the exact redirect URI and the three web origins below as authorized JavaScript origins. Put each provider credential needed for the test in the same environment file; an unconfigured provider reports that it is unavailable and never returns a synthetic success.

| Surface | Local address | Test entry |
| --- | --- | --- |
| Participant portal | `http://localhost:5180` | Choose the participant class and continue with Google after applications open. |
| Operations dashboard | `http://localhost:5181` | Continue with an invited Google account. On an empty backend, an email in `INITIAL_SUPREME_EMAILS` completes first-run event setup. |
| Handbook renderer | `http://localhost:5182` | Continue with a Google account that has `handbook.read`. |
| Reviewer app | `http://localhost:8082` | Run a local native build and continue with an invited Google account on the device or simulator. |
| Intelligence Worker | `http://localhost:8791` | `GET /health` |
| Expo Updates Worker | `http://localhost:8792` | `GET /health` |
| Email Worker | `http://localhost:8793` | `GET /health` |
| Voice Worker | `http://localhost:8794` | `GET /health` |

Every local record now comes from the same user-facing or operator workflow used outside development. Test email, GitHub, Figma, OpenAI, paging, and outbound calls only with their real configured staging resources. Use a locally compiled reviewer app for camera, push, encrypted storage, and offline behavior; a browser is not a substitute.

On an empty deployment, the operations surface becomes the first-run setup after Google sign-in. Only an email listed in `INITIAL_SUPREME_EMAILS` can create the event slug pinned by `INITIAL_EVENT_SLUG`. The owner enters the application deadline, event window, venue, Discord invite, VIT email domain, team bounds, and participant capacity. One Convex mutation creates the draft event, its safe baseline policies, the owner's event account and role label, and the owner's exact scoped grants. Applications remain closed until an authorized organizer opens them from Event setup.

Local briefs, copilot turns, and autonomous runs use the normal signed Convex-to-Flue boundaries. The local Worker uses the configured remote Workers AI binding; it does not replace model work with a browser fixture. Autonomous runs still use the durable semantic inbox, paginated redacted reads, human-only proposal approval, and Worker admission fence used outside development.

If the backend is already running and its environment changed, run `pnpm dev:prepare`. This reapplies configuration only; it never writes product data.

## Encryption key rotation

Attendance event keys and Figma OAuth secrets use named current keys and at most one named previous key. Validate the deployment values before release:

```sh
pnpm --filter @code2create/backend keys:check
```

This command reads the actual process environment and prints only key-version status, never key material. `test:release-environment` runs the parser's unit tests.

For attendance, deploy the new current `ATTENDANCE_WRAPPING_KEY_VERSION` and `ATTENDANCE_WRAPPING_KEY` while retaining the old pair as `ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION` and `ATTENDANCE_PREVIOUS_WRAPPING_KEY`. Check and then rewrap each event:

```sh
pnpm --filter @code2create/backend exec convex run attendanceActions:rewrapEventKey '{"eventSlug":"code2create-7","dryRun":true}' --prod
pnpm --filter @code2create/backend exec convex run attendanceActions:rewrapEventKey '{"eventSlug":"code2create-7","dryRun":false}' --prod
pnpm --filter @code2create/backend exec convex run attendanceActions:rewrapEventKey '{"eventSlug":"code2create-7","dryRun":true}' --prod
```

The final result is complete only when `fromVersion` equals `toVersion`. Rewrapping authenticates the event-bound AES-GCM ciphertext and changes it only when the complete stored ciphertext tuple still matches; credential fingerprints do not change.

For Figma, deploy the new current `PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION` and `PROVIDER_TOKEN_ENCRYPTION_KEY` while retaining the old pair as `PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION` and `PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY`. Run all three bounded owners. Follow each returned `continueCursor` until `isDone` is true, first with `dryRun: true`, then from the beginning with `dryRun: false`:

```sh
pnpm --filter @code2create/backend exec convex run figmaActions:rotateProviderSecrets '{"owner":"active_credentials","limit":50,"dryRun":false}' --prod
pnpm --filter @code2create/backend exec convex run figmaActions:rotateProviderSecrets '{"owner":"pending_intents","limit":50,"dryRun":false}' --prod
pnpm --filter @code2create/backend exec convex run figmaActions:rotateProviderSecrets '{"owner":"verifying_intents","limit":50,"dryRun":false}' --prod
```

Pass the returned cursor as `"cursor":"..."` on the next call. After the write pass, repeat a dry run from the beginning for all three owners. Remove previous-key variables only after every page reports a total of zero `needingRotation`; expired OAuth intents are not live ciphertext owners. Keep the previous key if any page fails or remains incomplete. A later K2-to-K3 rotation starts only after K1 has been removed and every live owner is on K2.

## Confirmed requirements

### Identity and access

- Each participant selects **VIT Student** or **External Participant**. The participant then signs in with Google.
- A VIT student must use a VIT student Google Workspace account.
- After sign-in, each participant completes a profile. The required fields depend on the participant class. They include name, permitted contact details, college or university, and year of study or current role.
- Staff access starts from an approved roster. The four internal labels are Supreme, Board, SC, and JC. External Judge is the separate judging label.
- A user cannot select or promote a role during sign-in.
- A role only suggests a default permission bundle. A role change does not change a grant.
- Each protected read and command checks one atomic, person-specific permission grant. The grant has an exact scope and validity period.
- An unrestricted grant administrator can give any permission to any event-linked user. This includes a specifically invited user who has no role.
- A restricted administrator can act only within one permission key, resource, target boundary, and expiry limit.
- Grant and revoke are separate permissions and delegations.
- The permission editor can add or remove several exact grants for one person as one atomic, audited change. It never leaves a partial batch.
- A sensitive web action with an old session asks for Google verification on the same page and retries the same idempotent command only after the backend sees a fresh session.

### Product surfaces

- Participants use a web portal.
- Reviewers use a dedicated Expo app on Android or iOS.
- Staff use a web operations dashboard.
- The participant portal, operations dashboard, and event app use the same Google identity system and Convex deployment.

### Attendance and venue operations

- Each participant confirms presence for every configured hacking session.
- A staff phone scans the enrolled barcode on a VIT student's existing VIT ID.
- An external participant uses an event-badge QR. All fallback paths use an event badge or a short-lived portal QR.
- During a short outage, a scanner can capture a VIT ID or event badge while offline. It stores the capture in the small, time-limited SQLCipher queue from the published plan.
- The scanner shows an offline capture as pending until an idempotent server replay completes.
- A portal QR requires an online station.
- An old replay cannot overwrite newer presence data.
- External-participant badges are anonymous preprinted QR cards with high-entropy values.
- Staff bind a badge only after they scan a fresh participant portal QR and check the visible identity.
- Staff scan the badge twice during binding.
- Issue, replace, and revoke operations use separate exact-person permissions.
- Temporary exits and returns are boundary events. The system does not track people continuously.
- Attendance is not a judging signal or an automatic punishment.
- A confirmed team sees a separate short-lived hall-location QR on its dashboard.
- Roving floor staff scan this team-owned code and record the team's actual hall location in the event app.
- The system does not use QR stickers on tables.

### Reviews and projects

- Each planned panel member scans the separate team review-presence QR before a normal review starts.
- A review lasts 10 minutes. The working policy permits one two-minute extension.
- Reviewers score independently. Seniority does not change score weight.
- Each hack project has the state `fresh_for_event`.
- A team can describe its idea before the event. Project-specific implementation and design must start at the official event baseline.
- The system has no continuation category.
- Participants can create or join a team before and during project intake.
- Join links, join codes, and membership changes update in realtime.
- One accepted lead transfer moves the team-lead grant. It does not replace the team.
- Project intake starts with **Hello.** and **What is your project about?**
- The flow asks one or two short generated follow-up questions. It shows one question at a time.
- The flow does not require a form, voice interaction, chat interaction, or PPT.
- While the team writes its first description, a debounced novelty counter compares the text with a versioned, curated corpus of past Code2Create projects.
- The counter shows one directional `0–100` number above the text box. It does not disclose earlier project text or add another task.
- The system does not submit the novelty signal with the application. Admissions and judging cannot use it.
- The OpenAI layer can ask a supportive differentiation question.
- Final submission has a review screen. It shows the full team and current project summary.
- One server transaction submits the application and locks the reviewed team membership.
- The team lead can revise the project description and guided answers until the configured application deadline.
- Each edit creates an immutable content version and makes review work for the prior version stale.

### Admissions and accepted teams

- Admissions uses one published, year-adjusted rubric.
- Publication pairs the rubric atomically with one exact AI model release or explicit human-only mode.
- The first submitted application freezes that release for the event.
- Configured AI analysis can produce a structured and explainable admission recommendation.
- Reading that recommendation and retrying a failed analysis are separate permissions. A retry keeps the failed record, creates one new policy-pinned run, and changes no human decision.
- Only an authorized human can accept, waitlist, decline, or request more information.
- An admission recommendation cannot become a judging score or judging advice.
- Human acceptance selects the locked team. It does not check the team into the event.
- An authorized organizer sends an offer that expires.
- Sending the offer reserves participant capacity for the exact roster in one transaction.
- The locked team lead confirms or declines the offer for the team.
- Only confirmation unlocks attendance, hall mapping, and review queues.
- Decline, expiry, or organizer revocation releases the reservation exactly once.
- An accepted team sees a focused next-steps page. It shows status, venue and date, deadlines, locked team and project summary, and the Discord community link.
- A configured notification route reports important changes. Participants do not need to keep the portal open.

### Integrations, evidence, and recovery

- The system can structure or summarize project material. It cannot generate, change, or recommend a judging score.
- A team can connect several GitHub repositories. The team declares the kind and purpose of each repository.
- A team can connect several Figma files when needed.
- Signed events, provider checks, frozen checkpoint sets, and one current GitHub and Figma summary per team record progress. These records do not judge the team.
- If the review backend fails during an active review, two people must approve paper mode.
- One person copies the complete signed review and uploads a photo.
- A different person verifies the photo.
- One transaction then creates the normal immutable scorecard versions and result.
- The event is online-first. The build does not include Bluetooth or peer-to-peer synchronization.

## Current build status

### Policy and admission controls

- Immutable `participantPolicyVersions` records store participant rules.
- Four event-scoped permissions separate read, draft, validation, and publication.
- The portal reads published profile fields and notices. It records exact policy acceptance on the event membership before profile or team work.
- Eligible participants can create or join a team after consent while the profile remains unfinished. Final submission still requires every active member's complete class-aware profile.
- Create, join, and final submission recheck the policy version; join and submission enforce the applicable team-size and mixed-team rules.
- The operations dashboard edits the complete admission policy as one version. The version includes year-adjusted criteria, permitted human decision reasons, review coverage, participant capacity, and an optional model release.
- Admission read, draft, validation, and publication are independent grants.
- Publication atomically changes the policy pointer, optional model pointer, and empty capacity bucket.
- The first application submission freezes this combination. It pins the combination to the project and application.
- An admissions assignment creates only `application.review.read` and `application.review` grants for the exact application.
- The assignment appears in the assignee's realtime queue. The first review of the current application version completes the assignment.
- Cancellation does not revoke an independent manual grant.
- Profile and year context needs a separate exact-application or event grant.
- The AI admission recommendation also needs a separate exact-application or event grant.

### Working product slices

The repository contains working slices for these participant and project functions:

- Google identity, participant provisioning, profile onboarding, team onboarding, sequential project intake, and final lock.
- A version-pinned live novelty signal. It uses native 1,536-dimension OpenAI embeddings and a separately permissioned corpus editor.
- Immutable proposal versions that the team lead can revise until the application deadline.
- An atomic participant-pinned intake policy, deterministic fallback, and separate operations editor.
- Admissions review and decision.
- Capacity-backed accepted-team offer send, confirm, decline, expiry, and revocation.
- An immutable accepted-team communications policy with separate draft, validation, and publication permissions.
- A private realtime projection for venue, next steps, and Discord.
- Policy-pinned decision and offer delivery to verified email addresses.
- A Cloudflare email Worker with complete lifecycle-event validation, signed Convex callbacks, inbound routing, bounded Queue retries, and staging Queue/DLQ resources. The sending domain, Event Subscription, support alias, and forwarding destination remain closed until O-034 is resolved.

The repository contains working slices for these attendance and venue functions:

- Attendance plans, sessions, scanning, scanner authentication, and scanner liveness.
- A bounded SQLCipher replay queue and aggregate pending-queue health.
- One current consumable participant attendance QR.
- Class-aware physical-credential status.
- Person-scoped staffed venue arrival, identity exception, reversal, and a realtime sharded operations count.
- Staffed VIT ID enrollment and exact-person, fresh-authenticated barcode suspension or rebinding.
- Anonymous external-badge batch generation and exact-person issue, replacement, or revocation.
- Live-session reconciliation, closed-session result review, emergency roll call, and protected identifiable export.
- Participant-dashboard QR floor mapping, zone-scoped staff scanning, a realtime hall map, and coarse queue wait estimates.
- Scoped realtime support cases across the portal, event app, and operations desk.
- Incident-authorized two-person paper recovery for attendance and reviews.
- A restricted four-hour emergency-pack snapshot with unique recovery-sheet numbers and audited print access.

The repository contains working slices for these review and operations functions:

- A permission-aware operations home whose Overview shows only the event's next step and three current priorities. Event monitor holds the full attention ledger and system checks; Operations agent holds activity, questions, and generated summaries. Application detail leads with the next human action and keeps completed process detail available without making it the page hierarchy.
- A first-run event screen that replaces the empty-deployment dead end. It admits only the configured initial owner and creates one coherent draft baseline before the normal permissioned dashboard appears.
- A realtime Event setup home that shows the participant form, idea questions, idea comparison, admissions, accepted-team details, schedule, team updates, and operations brief as one short status list. Each row reports the actual published, draft, missing, locked, or active state and opens only when the organizer has the matching read grant.
- A participant lifecycle home that leads with the team's current outcome or action. Locked team/project detail stays available in compact disclosures, and optional event tools stay absent until they contain useful information.
- Incident-linked, round-wide review pause or resume with scoped staff banners and participant or reviewer state.
- Versioned Convex backup export and staging-only restore verification.
- Team-scoped GitHub and Figma capture.
- Atomic full-set GitHub repository ordering and fork-overlap-aware materialized team statistics.
- Transactional materialized Figma statistics and rate-aware metadata heartbeats.
- Version-pinned private Figma frame previews, layer and property browsing, bounded named-version and comment capture, and comparison with an earlier judging checkpoint.
- Lazy exact-team integration detail on the operations board.
- Staff-managed review queues with transactional team-availability projections, scoped exceptions, and substitutions.
- Reviewer push paging, synthesized phone-call escalation, and pinned review evidence.
- Scorecard correction, void, and release governance.
- Two-person verified private round exports and controlled reopen.
- Expiring exact-email event invitations.
- Approved staff and reviewer roster import and Google claim.
- Independent organization role labels and event-account suspension or reactivation.
- Fresh-authenticated unrestricted and bounded delegated permission administration.
- Exact scheduled permission activation and expiry with a repair sweep.
- Versioned permission-bundle draft, publication, exact-target application, and bounded migration.
- Privacy-filtered Sentry boundaries for web and event app.
- An event-scoped realtime operations-health overview.
- An operator-requested operations brief from a separate signed Flue and Cloudflare Worker. The Worker uses a frozen, redacted health snapshot.
- An event-scoped autonomous operations agent that exhaustively traverses its published redacted read allowlist, delegates focused investigations, and records typed recommendations for human review.
- An auditable 62-scenario release-rehearsal workspace with exact-run permissions and final sign-off.
- A protected, manually triggered staging release-verification workflow. It verifies the two controlled browser accounts against staging Convex before Playwright starts, then checks public/authenticated participant and operations surfaces plus read-only synthetic OpenAI, GitHub, Figma, and intelligence paths.
- An optional protected-handbook integration test generated from the repository Markdown.
- The first operator-controlled Synesthesia release with live participant requests, votes, reports, scoped moderation, queue scheduling, access suspension, and playback acknowledgment.

Operations can publish one autonomy policy under four independent permissions. Each distinct manual request, due schedule slot, or changed health fingerprint becomes durable work; exact duplicates coalesce, but an active run never discards later work. The agent may use as many model turns, redacted reads, investigator delegations, and durable continuation submissions as it needs. Its hard boundary is authority and effect: it cannot execute a consequential event command, and every typed recommendation still requires an authorized human to inspect and approve the exact versioned mutation. A reasoned kill switch, policy replacement, owner revocation, or the event leaving live operation cancels the authoritative run, records a durable Worker-side admission fence, and retries its abort intent.

Recommendation evidence is lossless rather than limited to one model response. Derived findings name a bounded set of parent records, forming a private support DAG whose source-leaf closure can grow without a product cap. The Worker uploads those exact leaves in small signed pages; Convex grounds each leaf against its completed read receipt and seals the ordered hash chain before accepting the proposal. The operations card cursor-pages every sealed leaf. If a later run reaches the same still-open action, the event keeps one human decision while attaching that run's own statement, reasoning, model provenance, and sealed evidence as another immutable observation.

The event phase schedule is an immutable configuration with independent permissions. Operations edits all five timezone-aware windows as one version. Publication uses current server time to protect completed and active history. The realtime event projection gives portals the current or next phase.

Phase-bound project checkpoints form a separate immutable layer. Operations publishes three short questions and their grace periods. Confirmed teams edit one shared realtime draft and submit it explicitly. A participant action cannot put a team into a review queue. A review freezes the latest submitted update and its GitHub or Figma evidence. Reviewer context and the verified round export keep the same snapshot. Configuration, event-wide or exact-team read, and team write permissions are independent.

### Release status

GitHub Actions scans changed history for secrets. It installs the frozen pnpm lockfile, lints, type-checks, tests, and builds the Vite apps and Cloudflare Workers. It also checks the Expo configuration and exports both mobile JavaScript bundles.

A separate protected workflow builds the participant and operations surfaces plus the service Workers. Wrangler deploys each surface to its own staging or production Cloudflare Worker. The canonical handbook mirror is published separately from repository Markdown to ChatGPT Sites.

Gradle and Xcode build signed Android APK/AAB and iOS IPA files on a controlled local machine. The release machine exports and signs JavaScript updates. A separate Cloudflare Worker and environment-specific R2 bucket serve those updates.

Staging and production use separate update Workers and R2 buckets. They use different `acmvit.workers.dev` endpoints and admin tokens. Runtime `1.0.0` has a signed rollback-to-embedded pointer in both environments. The live protocol returns signed multipart rollback directives.

This handbook is the launch contract. It does not state that every acceptance item is complete.

The isolated staging Convex deployment and intelligence Worker are deployed. They use environment-specific ingress and callback secrets. The Worker health route succeeds. The Worker rejects unsigned work.

### Staging deployment snapshot · 8 August 2026

- The staging Convex backend is deployed at `patient-dove-650.eu-west-1.convex.cloud`.
- The staging intelligence Worker and self-hosted Expo Updates Worker/R2 service are deployed.
- The participant and operations staging Workers are not deployed. Their release scripts correctly stop until `VITE_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` are supplied together.
- The Cloudflare staging email Queue and dead-letter Queue exist. The email Worker, Event Subscription, sending identity, support alias, and forwarding destination remain closed until O-034 selects the event-owned domain and addresses.

The remaining launch work is:

- Select permanent platform identifiers.
- Supply native signing and provider credentials.
- Configure the OpenAI key and publish a privacy-reviewed novelty corpus.
- Back up the update private key.
- Produce signed builds and test them on the proposed phones.
- Supply the staging Sentry release values, deploy the participant and operations Workers, and test both against staging Convex.
- Bind approved custom domains for the participant and operations surfaces, then repeat the release for production.
- Complete a permissioned staging intelligence run through Workers AI and the signed callback.
- Configure controlled browser accounts, protected browser states, provider sandbox accounts, and approved test destinations. Then run and approve the checked-in staging release-verification workflow against those real boundaries.
- Run and approve backup and restore against production-shaped staging.
- Route production Sentry and Convex alerts to named owners.
- Run the complete venue and release rehearsal in the shipped run workspace.
- Select the final licensed Synesthesia catalog and account.
- Name the Synesthesia operators, publish its moderation policy, and complete its staging rehearsal.

The deployed permission catalog contains only working permissions and scope resolvers. It does not show planned permissions as inactive controls.

## Production baseline

| Part | Choice | Reason |
| --- | --- | --- |
| Participant and operations web | Separate Vite, React, and React Router single-page apps | Each product surface deploys independently and uses the same backend. |
| Reviewer mobile | Expo, React Native, and Expo Router | The app needs a native camera, notifications, secure session storage, and controlled builds. |
| Authentication | Better Auth with Google only | The Convex-maintained adapter runs on Convex and supports the browser apps and Expo. |
| Live backend | Convex | Convex provides transactions, reactive queries, HTTP endpoints, scheduled work, and small live records. |
| Live novelty signal | OpenAI `text-embedding-3-small` at its native 1,536 dimensions and a Convex vector index | A versioned corpus supports one low-latency nearest-project comparison. Embeddings return atomically. The browser debounces requests and discards stale results. It does not claim that vectors stream. |
| Adaptive intake | OpenAI Responses API with Structured Outputs | The API produces bounded, source-linked interpretations and follow-up questions. It cannot own participant or judging state. |
| Admission analysis | Optional OpenAI Structured Outputs release paired with the admission policy | The release produces a policy-versioned, year-adjusted recommendation for human review. Human-only mode remains valid. The model cannot publish a decision or read judging data. |
| Durable intelligence jobs | Flue on a separate Cloudflare Worker with Workers AI | Flue provides durable turns, tool lifecycle, retry, and deduplication. Convex owns authority, the semantic work inbox, exact read-page receipts, resumable continuations, recommendation provenance, and the kill switch. Autonomous work can observe and propose but cannot execute consequential event commands. |
| External job control | `@convex-dev/workpool` | The workpool bounds intake, GitHub, Figma, push, and export work. External work cannot block review traffic. |
| Large artifacts | Private S3 in `ap-south-1` | S3 stores compressed Figma checkpoints and previews, short-lived GitHub blob cache, protected exports, expiring emergency packs, and backups outside one-megabyte live records. |
| Participant email | Cloudflare Email Sending, Email Routing, Event Subscriptions, and Queues | Cloudflare sends transactional mail and routes approved inbound addresses. A Queue Worker sends signed lifecycle events to Convex. Ambiguous sends are never retried automatically. |
| Reviewer paging | Native APNs/FCM plus an event-owned Twilio and Sarvam voice Worker | Push is the first alert. A consented synthesized call can escalate a missed page. Convex remains authoritative and the same typed call service can later deliver explicitly permitted participant operations calls. |
| Event scanning | Capability-gated modes in the signed Expo build | Provisioned staff phones scan VIT ID barcodes, attendance QR codes, review-presence QR codes, and hall-location QR codes. Each mode uses a separate server command. |
| Web hosting | Cloudflare Workers static assets through the official Vite plugin | Cloudflare serves each SPA with an explicit deep-link fallback. The web host has no application backend. |
| Mobile delivery | Local Gradle or Xcode builds and a signed Cloudflare Worker/R2 Expo Updates service | Controlled release machines keep build credentials and the update private key. Staging and production remain separate. |
| Error reporting | Sentry | Sentry records web and mobile crashes with release and environment tags. |
| Repository | pnpm workspaces and strict TypeScript | Eight apps and three focused shared packages remain explicit. The repository does not need a larger build framework. |

The platform does not use Clerk. It does not have a second application database, custom WebSocket service, participant password system, or separate mobile API.

## Surfaces

| Surface | Main jobs |
| --- | --- |
| Participant portal | Sign-in, profile, live team area, sequential project intake, live novelty number, final confirmation, proposal edits until the deadline, admission result, team-lead offer response, next steps, shared phase updates, GitHub and Figma connection, attendance status and QR, team-owned hall-location QR and recorded place in the hall, staff-managed queue status, support cases, review progress, and Synesthesia |
| Event mobile app | Reviewer workflow, self-service support cases, and separate capability-gated camera modes for attendance, review presence, and hall-location mapping |
| Operations dashboard | Event lifecycle, event health, autonomous agent runs and recommendations, manual briefs, copilot, configuration, support, project updates, release rehearsal, exact-person access, permissions, attendance, roll call, emergency packs, hall mapping, Synesthesia, rounds, rosters, panels, queues, substitutes, reviews, score completeness, exceptions, and audit |
| Canonical handbook mirror | Read-only Markdown navigation at [code2create-specs.theg1239.chatgpt.site](https://code2create-specs.theg1239.chatgpt.site), protected by a simple planning password. Repository Markdown remains authoritative. |

## System boundary

Convex stores event state and sends changed query results to authorized clients. A client shows a scan, score submission, review start, assignment, or round change as accepted only after server confirmation.

A push notification wakes a reviewer. It does not assign the reviewer. A participant email points to authoritative portal state. It does not replace that state.

Local mobile storage protects an unfinished scorecard during a short connection loss. It cannot finish a review.

OpenAI, GitHub, and Figma calls run as bounded background work. Convex publishes accepted team state immediately.

The Flue Worker receives only purpose-built frozen projections. It returns proposals or summaries through signed callbacks. It has no broad Convex credential and cannot run an event command.

Intake and admissions remain usable when model work fails. Reviews remain pinned to exact project and evidence versions. An external integration cannot judge a team.

## Status terms

Each document uses three status terms:

- **Confirmed** comes from the planning discussion or a later user instruction.
- **Selected** is the production design in this revision.
- **Open** needs an event-policy decision before launch.

An open policy must exist in versioned event configuration or remain blocked. Client code must not hide a guess.

## Reading order

| Document | Contents |
| --- | --- |
| Product brief | Event problem, scope, users, and outcomes |
| Identity and access | Google sign-in, VIT classification, rosters, role defaults, atomic permissions, and sessions |
| Participant portal | Registration, teams, fresh-project attestation, sequential intake, application revisions, admission, integrations, and staff-managed queue status |
| Attendance and presence | Hacking sessions, VIT ID barcodes, external and fallback QR, temporary exits, realtime presence, scanner recovery, and privacy |
| Panels and queues | Reviewer staffing, routing, presence, timers, and substitutions |
| Reviewer app | Native workflow, score drafts, push, and short connection loss |
| Evaluation | Rubric, criterion coverage, aggregation, progress, and corrections |
| Operations dashboard | Live floor control and protected commands |
| Reliability and audit | Venue network, recovery, backups, incidents, privacy, and logs |
| Synesthesia | Requests, votes, moderation, and playback |
| Delivery and acceptance | Build slices, tests, rehearsals, and launch gates |
| Decision register | Confirmed, selected, open, and rejected directions |
| Production architecture | Apps, packages, authentication, backend, and deployment |
| Data model and realtime | Tables, indexes, writes, subscriptions, concurrency, and retention |
| Integrations and release | GitHub, Figma, notifications, environments, continuous integration, and release operations |

## Required policy decisions

- Team-size limits and participant eligibility.
- Exact round and elimination schedule.
- Final rubric text, aggregation, ties, and missing-score policy.
- Conflict-of-interest rules.
- Missed-call, hold, and queue re-entry rules.
- Final hall zones, zone sizes, published landmarks, floor-mapping crew, and freeze time before review routing.
- Reviewer and staff rosters.
- Data retention, provider-evidence retention, artifact access, and participant feedback.
- Attendance schedule, required or optional rules, grace and duration policy, tracked zones, VIT ID barcode format and enrollment, external badge format, excused absence, and presence-data retention.
- Awards, event checkpoints, and allowed pre-start setup.
- OpenAI intake consent, effective data controls, and interpretation retention.
- Published year-of-study bands for mixed-year, postgraduate, professional, and external teams.
- Human admissions rubric and disclosure text.
- Accepted-team Discord destination, official participant notification channel, Cloudflare email message templates, and delivery or retention policy.
- Intelligence model approval, brief and autonomous-run retention, production triggers, accountable owner, redacted read scope, recommendation scope, and sanitized trace retention.
- Final Synesthesia catalog, licensed playback account, moderation owner, and venue license.

The decision register assigns an owner and deadline to each decision.
