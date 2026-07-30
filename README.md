# Code2Create 7.0

## Platform specifications

This is the source of truth for the Code2Create 7.0 participant portal, reviewer application, operations dashboard, judging system, and live event backend.

It is not a starter-project README. The handbook viewer uses a shared password only because these documents are internal. The product described here uses Google authentication and scoped application roles.

- **Status:** architecture selected; product policy still contains named open decisions
- **Audience:** product, design, engineering, review operations, event board, and audit
- **Scale:** approximately 900–1,000 people in the venue, with bursty round-start traffic

## The system we are building

Code2Create runs as one realtime event system with three primary surfaces:

| Surface | Users | Responsibility |
| --- | --- | --- |
| Participant portal | VIT students and external participants | Identity, teams, project profile, check-in, readiness, queue, review progress, and Synesthesia |
| Reviewer app | Reviewers and panel leads | Clock-in, pages, QR presence, timed reviews, evidence, independent scores, and recovery |
| Operations dashboard | Operations, review administrators, board, auditors | Configuration, panels, assignments, queues, exceptions, scoring oversight, round close, and audit |

These are not separate products with copied databases. They are clients of the same authenticated Convex backend. A successful mutation becomes visible to every authorised subscriber from the same committed database snapshot.

## Confirmed identity flow

The public participant flow begins with exactly two choices:

1. **VIT student**
2. **External participant**

The selected account class is recorded in a short-lived signed authentication intent. The user then continues with **Authenticate with Google**.

- A VIT student must authenticate with the VIT student Google Workspace account. The initial allowlisted hosted domain is `vitstudent.ac.in`.
- The server validates the Google identity token and its `hd` hosted-domain claim. An email suffix check alone is not accepted as proof of Workspace membership.
- An external participant authenticates with any verified Google account and supplies institution and affiliation details during onboarding.
- Google `sub`, reached through the Clerk identity, is the stable external identity. Email remains a verified contact attribute and may change.
- Participant class is not an application role. Reviewer, operations, administrator, moderator, and auditor access comes only from approved invitations or rosters.
- Reviewer and staff sign-in uses Google as well, but roster matching—not the participant selector—grants staff capability.

If VIT IT enables a managed Google Workspace SSO connection, that replaces the social-OAuth VIT verification path without changing application user IDs or permissions.

## Selected technology baseline

| Layer | Selected technology | Purpose |
| --- | --- | --- |
| Repository | pnpm workspaces + Turborepo + TypeScript | Shared types, domain rules, UI primitives, and coordinated builds |
| Participant and staff web | Next.js App Router + React | Portal and role-gated operations dashboard in one web deployment |
| Reviewer mobile | Expo + React Native + Expo Router | Android/iOS reviewer app with camera, push, secure storage, and offline draft outbox |
| Authentication | Clerk with Google-only sign-in | One web/mobile session system and Convex-compatible JWTs |
| VIT verification | Google OIDC token verification | Validate signature, issuer, audience, expiry, `sub`, verified email, and `hd` |
| Realtime backend | Convex | Reactive queries, transactional mutations, scheduling, file storage, and one authoritative data model |
| Push | Expo Notifications through Expo Push Service | Reviewer paging and time-sensitive background alerts; never the source of truth |
| Web deployment | Vercel | Next.js preview, staging, and production deployments |
| Mobile delivery | EAS Build, Submit, and Update | Signed builds and controlled preview/production channels |
| Monitoring | Sentry + structured Convex audit/domain events | Client/backend errors, performance, operational alerts, and forensic history |
| Testing | Vitest, Testing Library, Playwright, Maestro | Domain, web, backend, and mobile workflow verification |

The reasoning, package boundaries, deployment topology, and alternatives are defined in **Technical architecture** and **Infrastructure & delivery**.

## Non-negotiable rules

- Convex is the only live application source of truth.
- Every client reads authorised projections through reactive subscriptions.
- Every write goes through a named server mutation that validates identity, capability, scope, state transition, and expected version.
- Outcome-affecting commands are idempotent and return a durable receipt.
- Queue state, panel state, review state, score state, and round state are explicit state machines.
- External effects such as push notifications are driven from a transactional outbox and may be retried.
- A notification tells a device to look; it never proves the current state.
- Clients may cache context and encrypted drafts. They may not create a second source of truth.
- Reviewer scores remain independent and hidden from peers until the configured reveal point.
- Overrides require the narrow capability, a reason, scope, expiry where relevant, and an audit event.
- No AI model assigns, alters, normalises, or recommends a judging score.

## Reading order

| Document | Read it for |
| --- | --- |
| Product brief | Outcomes, event model, scope, actors, and success measures |
| Domain & access | Canonical concepts, account classes, roles, capabilities, and visibility |
| Participant onboarding | Google authentication, teams, project profile, check-in, and queue experience |
| Panels & queues | Staffing, routing, presence, queue state, leases, timers, and exceptions |
| Reviewer application | Focused mobile workflow, independent submission, push, and offline behaviour |
| Evaluation system | Rubric model, criterion coverage, progress, aggregation, and corrections |
| Operations dashboard | Live command centre, exceptions, overrides, scoring oversight, and round close |
| Reliability & audit | Source of truth, integrity, recovery, incidents, and data protection |
| Synesthesia | Requests, votes, moderation, playback, and isolation from core operations |
| Delivery & acceptance | Build sequence, rehearsals, load model, and launch gates |
| Decision register | Confirmed, assumed, open, superseded, and rejected decisions |
| Technical architecture | Full stack, applications, boundaries, request paths, and package layout |
| Data schema | Convex tables, indexes, ownership, state machines, and invariants |
| Realtime synchronization | Subscription projections, commands, receipts, concurrency, and offline recovery |
| Authentication & authorization | Exact Google/VIT flow, session claims, roster grants, and threat controls |
| Backend function catalog | Public queries/mutations/actions, internal jobs, and authorization contracts |
| Infrastructure & delivery | Environments, deployment, secrets, observability, backups, and release process |

## Decisions that still need event-owner input

Architecture is no longer deferred. The remaining blockers are event policy:

- final team-size bounds;
- exact round and elimination schedule;
- final rubric, aggregation, ties, and missing-score policy;
- conflict-of-interest policy;
- queue re-entry and missed-call policy;
- retention and participant-feedback policy;
- exact VIT Google Workspace coordination available from VIT IT;
- approved reviewer/staff rosters and emergency authority owners;
- Synesthesia playback source and licensing.

Until those are decided, they remain versioned configuration or explicit launch gates—never hidden assumptions in client code.
