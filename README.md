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

The optional [Cloudflare staging handbook](https://code2create-handbook-staging.acmvit.workers.dev) tests Google identity and the exact event-scoped `handbook.read` grant. Its public browser assets do not contain the Markdown. It is not a source of truth, participant portal, operations dashboard, second required reader, or required production surface.

## Local full-flow testing

Run `pnpm dev` from the repository root. It starts the local Convex deployment, enables the localhost-only identity and email fixtures, seeds the Code2Create 7.0 event, and starts every application.

| Surface | Local address | Test entry |
| --- | --- | --- |
| Participant portal | `http://localhost:5180` | Select VIT Student or External participant, then use **Use local test account**. |
| Operations dashboard | `http://localhost:5181` | Use **Use local Supreme account**. |
| Handbook renderer | `http://localhost:5182` | Use **Use local Supreme account**. |
| Reviewer app | `http://localhost:8082` | Run a local native build, then use **Use local event operator**. |
| Intelligence Worker | `http://localhost:8791` | `GET /health` |
| Expo Updates Worker | `http://localhost:8792` | `GET /health` |
| Email Worker | `http://localhost:8793` | `GET /health` |

The local identities create ordinary Better Auth sessions and use the normal Convex permission and workflow boundaries. The reviewer fixture is available only inside the locally compiled native app; it does not create a browser replacement for camera, push, encrypted storage, or offline behavior. Local email follows the normal delivery state machine with a localhost-only synthetic provider event. None of these fixtures can run outside the full localhost stack. Real deployments still require Google OAuth and Cloudflare Email configuration.

On an empty staging or production deployment, the operations surface becomes the first-run setup after Google sign-in. Only an email listed in `INITIAL_SUPREME_EMAILS` can use it. The owner enters the event window, venue, Discord invite, VIT email domain, team bounds, participant capacity, and five starting tracks. One Convex mutation creates the draft event, its safe baseline policies, the owner's event account and role label, and the owner's exact scoped grants. Applications remain closed until an authorized organizer opens them from Event setup.

Local operations briefs use the normal signed Convex-to-Flue dispatch and signed callback. The local Worker uses the configured remote Workers AI binding; it does not replace the model result with a browser fixture.

If the backend is already running and only the fixtures or seed need repair, run `pnpm dev:prepare`.

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

### Product surfaces

- Participants use a web portal.
- Reviewers use a dedicated Expo app on Android or iOS.
- Staff use a web operations dashboard.
- The participant portal, operations dashboard, and event app use the same Google identity system and Convex deployment.
- The optional Cloudflare handbook integration uses that identity system and deployment only to test protected handbook access.

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
- The counter returns one directional `0–100` signal, the closest approved theme, and one supportive reflection question.
- The system does not submit the novelty signal with the application. Admissions and judging cannot use it.
- When the team commits the first description, the portal immediately shows the complete track list.
- The OpenAI layer can highlight one published track and give a short reason.
- The OpenAI layer can ask a supportive differentiation question.
- The team can select any track. A different selection cannot cause an admission penalty.
- Final submission has a review screen. It shows the full team, confirmed core track, optional sponsor tracks, and project summary.
- One server transaction submits the application and locks the reviewed team and track set.

### Admissions and accepted teams

- Admissions uses one published, year-adjusted rubric.
- Publication pairs the rubric atomically with one exact AI model release or explicit human-only mode.
- The first submitted application freezes that release for the event.
- Configured AI analysis can produce a structured and explainable admission recommendation.
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

### Tracks, evidence, and recovery

- The plan has five core-track positions.
- Core-track definitions, prompt bindings, and sponsor tracks are versioned event configuration. They are not hard-coded problem statements.
- A team can select zero or more sponsor tracks from its pinned catalog.
- The team must read each published sponsor requirement before selection.
- The submitted project keeps the exact sponsor-track set. Sponsor selection does not change admissions or judging.
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
- Immutable participant-pinned track catalogs and race-safe sponsor-track selection.
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

- A permission-aware operations home organized around current work: Overview, Applications, Event day, Judging, and Manage. Application detail leads with the next human action and keeps completed process detail available without making it the page hierarchy.
- A first-run event screen that replaces the empty-deployment dead end. It admits only the configured initial owner and creates one coherent draft baseline before the normal permissioned dashboard appears.
- A realtime Event setup home that shows the participant form, tracks, idea questions, idea comparison, admissions, accepted-team details, schedule, team updates, and operations brief as one short status list. Each row reports the actual published, draft, missing, locked, or active state and opens only when the organizer has the matching read grant.
- A participant lifecycle home that leads with the team's current outcome or action. Locked team/project detail stays available in compact disclosures, and optional event tools stay absent until they contain useful information.
- Incident-linked, round-wide review pause or resume with scoped staff banners and participant or reviewer state.
- Versioned Convex backup export and staging-only restore verification.
- Team-scoped GitHub and Figma capture.
- Atomic full-set GitHub repository ordering and fork-overlap-aware materialized team statistics.
- Transactional materialized Figma statistics and rate-aware metadata heartbeats.
- Version-pinned private Figma frame previews, layer and property browsing, bounded named-version and comment capture, and comparison with an earlier judging checkpoint.
- Lazy exact-team integration detail on the operations board.
- Staff-managed review queues with transactional team-availability projections, scoped exceptions, and substitutions.
- Reviewer push paging and pinned review evidence.
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
- An auditable 61-scenario release-rehearsal workspace with exact-run permissions and final sign-off.
- A protected, manually triggered staging release-verification workflow. It verifies the two controlled browser accounts against staging Convex before Playwright starts, then checks public/authenticated participant and operations surfaces plus read-only synthetic OpenAI, GitHub, Figma, and intelligence paths.
- An optional protected-handbook integration test generated from the repository Markdown.
- The first operator-controlled Synesthesia release with live participant requests, votes, reports, scoped moderation, queue scheduling, access suspension, and playback acknowledgment.

Operations can publish one proactive-intelligence policy under four independent permissions. A due scheduler commits one redacted signal, outbox item, and brief in one transaction. It suppresses unchanged health and starts again after recovery. It enforces cooldown, an event-local daily limit, relevance expiry, and accountable ownership before the advisory-only Flue job runs.

The event phase schedule is an immutable configuration with independent permissions. Operations edits all five timezone-aware windows as one version. Publication uses current server time to protect completed and active history. The realtime event projection gives portals the current or next phase.

Phase-bound project checkpoints form a separate immutable layer. Operations publishes three short questions and their grace periods. Confirmed teams edit one shared realtime draft and submit it explicitly. A participant action cannot put a team into a review queue. A review freezes the latest submitted update and its GitHub or Figma evidence. Reviewer context and the verified round export keep the same snapshot. Configuration, event-wide or exact-team read, and team write permissions are independent.

### Release status

GitHub Actions scans changed history for secrets. It installs the frozen pnpm lockfile, lints, type-checks, tests, and builds all three Vite apps. It also builds the update and intelligence Workers, checks the Expo configuration, and exports both mobile JavaScript bundles.

A separate protected workflow builds the three web surfaces and intelligence Worker. Wrangler deploys each surface to its own staging or production Cloudflare Worker.

Gradle and Xcode build signed Android APK/AAB and iOS IPA files on a controlled local machine. The release machine exports and signs JavaScript updates. A separate Cloudflare Worker and environment-specific R2 bucket serve those updates.

Staging and production use separate update Workers and R2 buckets. They use different `acmvit.workers.dev` endpoints and admin tokens. Runtime `1.0.0` has a signed rollback-to-embedded pointer in both environments. The live protocol returns signed multipart rollback directives.

This handbook is the launch contract. It does not state that every acceptance item is complete.

The isolated staging Convex deployment and intelligence Worker are deployed. They use environment-specific ingress and callback secrets. The Worker health route succeeds. The Worker rejects unsigned work.

### Staging deployment snapshot · 8 August 2026

- The staging Convex backend is deployed at `patient-dove-650.eu-west-1.convex.cloud`.
- The optional protected-handbook integration is deployed at [code2create-handbook-staging.acmvit.workers.dev](https://code2create-handbook-staging.acmvit.workers.dev). Release `handbook-staging-2026-08-08-code-split` is live. Its deep-link fallback returns HTTP 200.
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
- Bind approved custom domains for all three web surfaces, then repeat the release for production.
- Complete a permissioned staging intelligence run through Workers AI and the signed callback.
- Configure the controlled browser accounts, protected browser states, and synthetic provider fixtures, then run and approve the checked-in staging release-verification workflow.
- Run and approve backup and restore against production-shaped staging.
- Route production Sentry and Convex alerts to named owners.
- Run the complete venue and release rehearsal in the shipped run workspace.
- Select the final licensed Synesthesia catalog and account.
- Name the Synesthesia operators, publish its moderation policy, and complete its staging rehearsal.

The deployed permission catalog contains only working permissions and scope resolvers. It does not show planned permissions as inactive controls.

## Production baseline

| Part | Choice | Reason |
| --- | --- | --- |
| Participant and operations web; optional handbook integration | Separate Vite, React, and React Router single-page apps | Each app can deploy independently. The optional handbook app tests typed authentication and `handbook.read` against the shared backend. |
| Reviewer mobile | Expo, React Native, and Expo Router | The app needs a native camera, notifications, secure session storage, and controlled builds. |
| Authentication | Better Auth with Google only | The Convex-maintained adapter runs on Convex and supports the browser apps and Expo. |
| Live backend | Convex | Convex provides transactions, reactive queries, HTTP endpoints, scheduled work, and small live records. |
| Live novelty signal | OpenAI `text-embedding-3-small` at its native 1,536 dimensions and a Convex vector index | A versioned corpus supports one low-latency nearest-project comparison. Embeddings return atomically. The browser debounces requests and discards stale results. It does not claim that vectors stream. |
| Adaptive intake | OpenAI Responses API with Structured Outputs | The API produces bounded, source-linked interpretations and follow-up questions. It cannot own participant or judging state. |
| Admission analysis | Optional OpenAI Structured Outputs release paired with the admission policy | The release produces a policy-versioned, year-adjusted recommendation for human review. Human-only mode remains valid. The model cannot publish a decision or read judging data. |
| Durable intelligence jobs | Flue on a separate Cloudflare Worker with Workers AI | Flue gives bounded jobs durable retry and deduplication state. Convex remains authoritative. The first job can publish only a validated operations brief. |
| External job control | `@convex-dev/workpool` | The workpool bounds intake, GitHub, Figma, push, and export work. External work cannot block review traffic. |
| Large artifacts | Private S3 in `ap-south-1` | S3 stores compressed Figma checkpoints and previews, short-lived GitHub blob cache, protected exports, expiring emergency packs, and backups outside one-megabyte live records. |
| Participant email | Cloudflare Email Sending, Email Routing, Event Subscriptions, and Queues | Cloudflare sends transactional mail and routes approved inbound addresses. A Queue Worker sends signed lifecycle events to Convex. Ambiguous sends are never retried automatically. |
| Reviewer paging | Native APNs and FCM tokens through `expo-notifications` | A direct push wakes the reviewer. The in-app assignment and operations fallback remain authoritative. |
| Event scanning | Capability-gated modes in the signed Expo build | Provisioned staff phones scan VIT ID barcodes, attendance QR codes, review-presence QR codes, and hall-location QR codes. Each mode uses a separate server command. |
| Web hosting | Cloudflare Workers static assets through the official Vite plugin | Cloudflare serves each SPA with an explicit deep-link fallback. The web host has no application backend. |
| Mobile delivery | Local Gradle or Xcode builds and a signed Cloudflare Worker/R2 Expo Updates service | Controlled release machines keep build credentials and the update private key. Staging and production remain separate. |
| Error reporting | Sentry | Sentry records web and mobile crashes with release and environment tags. |
| Repository | pnpm workspaces and strict TypeScript | Eight apps and three focused shared packages remain explicit. The repository does not need a larger build framework. |

The platform does not use Clerk. It does not have a second application database, custom WebSocket service, participant password system, or separate mobile API.

## Surfaces

| Surface | Main jobs |
| --- | --- |
| Participant portal | Sign-in, profile, live team area, sequential project intake, core-track choice, optional sponsor-track choice, final lock confirmation, admission result, team-lead offer response, next steps, shared phase updates, GitHub and Figma connection, attendance status and QR, team-owned hall-location QR and mapped spot, staff-managed queue status, support cases, review progress, and Synesthesia |
| Event mobile app | Reviewer workflow, self-service support cases, and separate capability-gated camera modes for attendance, review presence, and hall-location mapping |
| Operations dashboard | Event lifecycle, event health, bounded briefs, configuration, support, project updates, release rehearsal, exact-person access, permissions, attendance, roll call, emergency packs, hall mapping, Synesthesia, rounds, rosters, panels, queues, substitutes, reviews, score completeness, exceptions, and audit |
| Canonical handbook mirror | Read-only Markdown navigation at [code2create-specs.theg1239.chatgpt.site](https://code2create-specs.theg1239.chatgpt.site), protected by a simple planning password. Repository Markdown remains authoritative. |
| Optional handbook integration | Google sign-in, exact `handbook.read` enforcement, Markdown navigation, and server-side search for staging tests. No public bundle contains the documents. |

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
| Participant portal | Registration, teams, fresh-project attestation, sequential intake, tracks, application, admission, integrations, and staff-managed queue status |
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
- Final hall zones and spots, accessible placements, floor-mapping crew, and freeze time before review routing.
- Reviewer and staff rosters.
- Data retention, provider-evidence retention, artifact access, and participant feedback.
- Attendance schedule, required or optional rules, grace and duration policy, tracked zones, VIT ID barcode format and enrollment, external badge format, excused absence, and presence-data retention.
- Final core-track names and definitions, sponsor tracks, awards, event checkpoints, and allowed pre-start setup.
- OpenAI intake consent, effective data controls, and interpretation retention.
- Published year-of-study bands for mixed-year, postgraduate, professional, and external teams.
- Human admissions rubric and disclosure text.
- Accepted-team Discord destination, official participant notification channel, Cloudflare email message templates, and delivery or retention policy.
- Intelligence model approval, brief and trigger-signal retention, production triggers, cooldown, event-local daily limit, relevance period, accountable owner, and model-call cost limit.
- Final Synesthesia catalog, licensed playback account, moderation owner, and venue license.

The decision register assigns an owner and deadline to each decision.
