# Code2Create 7.0

## Platform handbook

This handbook defines the participant portal, native event app, operations dashboard, judging workflow, participant attendance, and event backend for Code2Create 7.0.

The source discussion describes a 48-hour event with roughly 900–1,000 people in the venue. The previous review process failed when reviewers were absent or hard to locate, teams waited without clear queues, reviewers lacked project context, and scores moved through informal channels. The product has to fix those specific failures.

The password on this handbook only protects the specifications. It has no connection to authentication in the Code2Create product.

## What is confirmed

- Participants choose **VIT Student** or **External Participant**, then authenticate with Google.
- VIT students must use the VIT student Google Workspace account.
- Staff access comes from an approved roster with four internal levels: Supreme, Board, SC, and JC. External Judge is the only separate judging role. Nobody can select or promote a role during sign-in.
- Attendance, admissions, review operations, configuration, support, release, incident, and Synesthesia work are scoped duties assigned to those internal roles, not additional account roles.
- Participants use a web portal. Reviewers use a dedicated Expo application on Android or iOS. Staff use a web operations dashboard.
- The three clients read and write the same Convex deployment.
- Every participant confirms presence for each configured hacking session. Staff phones read an enrolled existing VIT ID card for VIT students; external participants and all fallbacks use event-badge or short-lived portal QR.
- Temporary exits and returns are recorded as boundary events. Attendance is not continuous tracking, a judging signal, or an automatic punishment.
- Every planned panel member must scan the team QR before a normal review starts.
- Reviews are timed. The working policy is 10 minutes with one two-minute extension.
- Reviewers score independently. Seniority does not change score weight.
- Every hack project is `fresh_for_event`: the idea may be described before the event, but project-specific implementation and design begin from the official event baseline. There is no continuation category.
- Project intake begins with **Hello.** and **What is your project about?**, then asks three to five generated follow-ups one at a time instead of showing a form or requiring a PPT.
- The OpenAI layer writes short, relevant questions that are mostly easy to answer, structures team-written answers, and suggests tracks. The team confirms every authoritative field, and a deterministic path works without the model.
- Five core-track positions are planned. Their definitions, prompt bindings, and any additional sponsor tracks are versioned event configuration, not hard-coded problem statements.
- The system may structure or summarise project material, but it may not generate, change, or recommend a judging score.
- Teams can connect several GitHub repositories, declare each repository’s kind and purpose, and connect a Figma file. Signed events, provider checks, frozen checkpoint sets, and derived statistics record progress without judging it.
- The event is online-first. Bluetooth and peer-to-peer sync are not part of the build.

## Production baseline

| Part | Choice | Reason |
| --- | --- | --- |
| Participant and staff web | Next.js App Router | One deployment can serve participant and role-gated staff routes. |
| Reviewer mobile | Expo, React Native, Expo Router | Native camera, notifications, secure session storage, and controlled builds. |
| Authentication | Better Auth with Google only | Runs on the Convex deployment through the Convex-maintained adapter and works with Next.js and Expo. |
| Live backend | Convex | Transactions, reactive queries, HTTP endpoints, scheduled work, and small live records in one backend. |
| Adaptive intake | OpenAI Responses API with Structured Outputs | Produces bounded, source-linked interpretations and generated follow-up questions behind the sequential interface; it owns no participant or judging state. |
| External job control | `@convex-dev/workpool` | Bounds intake, GitHub, Figma, push, and export work so external work does not block review traffic. |
| Large artifacts | Private S3 in `ap-south-1` | Stores compressed Figma checkpoints/previews, short-lived GitHub blob cache, exports, and backups outside one-megabyte live records. |
| Reviewer paging | Expo Notifications | Background attention signal, backed by an in-app assignment and an operations fallback. |
| Attendance scanning | Capability-gated mode in the signed Expo build | Provisioned staff phones read compatible VIT ID cards through native NFC or scan QR; every accepted method reaches the same Convex mutation. |
| Web hosting | Vercel | Preview, staging, and production Next.js deployments. |
| Mobile delivery | EAS Build and Update | Signed reviewer builds and controlled release channels. |
| Error reporting | Sentry | Web and mobile crash reports with release and environment tags. |
| Repository | pnpm workspaces and TypeScript | Two applications and one shared domain package do not need a larger build framework yet. |

Clerk is not used. There is no second application database, custom WebSocket service, participant password system, or separate mobile API.

## Surfaces

| Surface | Main jobs |
| --- | --- |
| Participant portal | Sign-in, profile, team, sequential project intake, track confirmation, admission result, GitHub/Figma connection, attendance status and QR, readiness, queue, review progress, and Synesthesia |
| Event mobile app | Reviewer workflow plus a capability-gated staff scanner mode using NFC or QR on provisioned devices |
| Operations dashboard | Attendance sessions, live presence, emergency roll call, rounds, rosters, panels, tables, queues, substitutes, reviews, scoring completeness, exceptions, and audit |

## System boundary

Convex stores event state and pushes changed query results to authorised clients. A client only shows an attendance scan, score submission, review start, assignment, or round change as accepted after the server confirms it.

Push notifications wake a reviewer but do not assign them. Local mobile storage protects an unfinished scorecard during a short connection loss but cannot finish a review. OpenAI, GitHub, and Figma calls run as bounded background work; Convex publishes accepted team state immediately. The intake continues through an approved fallback graph when model work fails. Reviews stay pinned to exact project and evidence versions, and no external integration judges the team.

## Status language

Each document separates three kinds of statements:

- **Confirmed** comes from the planning discussion or the user’s later direction.
- **Selected** is the production design used by this revision.
- **Open** needs an event-policy decision before launch.

An open policy must live in versioned event configuration or remain blocked. Client code must not hide a guess.

## Reading order

| Document | Contents |
| --- | --- |
| Product brief | Event problem, scope, users, and outcomes |
| Identity and access | Google sign-in, VIT classification, rosters, roles, and sessions |
| Participant portal | Registration, teams, fresh-project attestation, sequential intake, tracks, application, admission, integrations, readiness, and queue experience |
| Attendance and presence | Hacking sessions, existing VIT ID cards, external/fallback QR, temporary exits, realtime presence, scanner recovery, and privacy |
| Panels and queues | Reviewer staffing, routing, presence, timers, and substitutions |
| Reviewer app | Native workflow, score drafts, push, and short connection loss |
| Evaluation | Rubric, criterion coverage, aggregation, progress, and corrections |
| Operations dashboard | Live floor control and protected commands |
| Reliability and audit | Venue network, recovery, backups, incidents, privacy, and logs |
| Synesthesia | Requests, votes, moderation, and playback |
| Delivery and acceptance | Build slices, tests, rehearsals, and launch gates |
| Decision register | Confirmed, selected, open, and rejected directions |
| Production architecture | Applications, packages, authentication, backend, and deployment shape |
| Data model and realtime | Tables, indexes, writes, subscriptions, concurrency, and retention |
| Integrations and release | GitHub, Figma, notifications, environments, CI, and release operations |

## Policy decisions still required

- team-size bounds and participant eligibility;
- the exact round and elimination schedule;
- final rubric wording, aggregation, ties, and missing-score policy;
- conflict-of-interest rules;
- missed-call, hold, and queue re-entry rules;
- reviewer and staff rosters;
- data retention, provider-evidence retention, artifact access, and participant feedback;
- attendance-session schedule, required/optional rules, grace and duration policy, tracked zones, VIT card compatibility/enrolment, external badge format, excused absence, and presence-data retention;
- final core-track names/definitions, sponsor tracks, awards, event checkpoints, and the exact allowed pre-start setup policy;
- OpenAI intake consent, effective data controls, and interpretation retention;
- Synesthesia catalogue, playback source, and licensing.

These decisions have owners and deadlines in the decision register.
