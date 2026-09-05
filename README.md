# Code2Create 7.0

Code2Create is the event platform for participant intake, team management, attendance, hall operations, judging, integrations, communications, and organizer workflows.

The product specification lives in [`specs/`](./specs). The canonical private reader is [code2create-specs.theg1239.chatgpt.site](https://code2create-specs.theg1239.chatgpt.site). The repository does not deploy a second handbook application.

The current event work list is [Event follow-up plan](./specs/16-event-follow-up-plan.md). It separates implementation work, reviewer preparation, event-day setup, and rehearsal.

## Prerequisites

- Node.js `22.22.0`
- pnpm `11.18.0`
- Xcode for the iOS reviewer app
- Android Studio for Android reviewer builds
- Wrangler authenticated to the event-owned Cloudflare account

Use the checked-in Node version and install the workspace:

```sh
corepack enable
pnpm install
```

Do not use npm, Yarn, EAS Build, EAS Update, or Expo Push Service.

## Local development

Copy [`apps/backend/.env.example`](./apps/backend/.env.example) to `apps/backend/.env.local` and set the credentials needed by the flow you are testing. Google authentication requires:

```text
AUTH_SITE_URL=http://localhost:3211
PARTICIPANT_SITE_URL=http://localhost:5180
OPERATIONS_SITE_URL=http://localhost:5181
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
INITIAL_SUPREME_EMAILS=...
INITIAL_EVENT_SLUG=code2create-7
```

Register `http://localhost:3211/api/auth/callback/google` as the Google OAuth redirect URI. Register `http://localhost:5180` and `http://localhost:5181` as browser origins.

The mandatory SGLang onboarding step uses a classic GitHub OAuth App with the `public_repo` scope. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and register `http://localhost:5180/onboarding/github/callback` as its exact callback URL. Use a separate OAuth App for each environment because GitHub OAuth Apps have one callback URL. After the participant connects GitHub, the backend stars SGLang and immediately revokes the OAuth grant. These credentials are separate from the read-only GitHub App used for team repository evidence.

Start the ordinary product loop:

```sh
pnpm dev
```

This starts the local Convex backend, participant portal, and operations dashboard. It applies local service configuration but does not create product records or synthetic provider results.

Start every runtime only for a complete rehearsal:

```sh
pnpm dev:full
```

The full command additionally starts reviewer Metro, intelligence, Expo Updates, email, and voice workers. Prefer individual commands while working on one surface:

```sh
pnpm dev:web
pnpm dev:ops
pnpm dev:landing
pnpm dev:backend
pnpm dev:reviewer
pnpm dev:intelligence
pnpm dev:updates
pnpm dev:email
pnpm dev:voice
```

| Surface              | Local address                  |
| -------------------- | ------------------------------ |
| Participant portal   | `http://localhost:5180`        |
| Operations dashboard | `http://localhost:5181`        |
| Public landing page  | `http://localhost:5182`        |
| Convex HTTP/auth     | `http://localhost:3211`        |
| Reviewer Metro       | `http://localhost:8082`        |
| Intelligence Worker  | `http://localhost:8791/health` |
| Expo Updates Worker  | `http://localhost:8792/health` |
| Email Worker         | `http://localhost:8793/health` |
| Voice Worker         | `http://localhost:8794/health` |

Run `pnpm dev:prepare` after changing local backend or worker environment while the backend is already running.

## Applications and packages

| Path                            | Responsibility                                                             |
| ------------------------------- | -------------------------------------------------------------------------- |
| `apps/web`                      | Participant portal                                                         |
| `apps/ops`                      | Organizer operations dashboard                                             |
| `apps/landing`                  | Public Code2Create landing page                                            |
| `apps/reviewer`                 | Native reviewer and floor-operations app                                   |
| `apps/backend`                  | Convex data, authorization, transactions, jobs, and provider orchestration |
| `apps/intelligence`             | Flue-based operations intelligence worker                                  |
| `apps/updates`                  | Event-owned Expo Updates Worker and R2 delivery                            |
| `apps/email`                    | SES/Cloudflare outbound email and Cloudflare routing worker                 |
| `apps/voice`                    | Outbound call and synthesized-audio worker                                 |
| `apps/discord`                  | Discord support bridge                                                    |
| `apps/e2e`                      | Browser verification                                                      |
| `apps/trailer`                  | Event promotional video composition                                       |
| `packages/domain`               | Shared domain contracts and presentation vocabulary                        |
| `packages/web-auth`             | Shared Better Auth browser integration                                     |
| `packages/client-observability` | Shared client analytics and error tracking                                 |
| `packages/web-forms`            | Shared product form validation                                            |

All product surfaces use the same Google identity and Convex deployment. Permissions are exact grants scoped to an event or resource. Role labels provide default permission bundles; they are not authorization shortcuts.

The reviewer app is built and signed locally. Native updates come from `apps/updates` and event-owned R2.

## Checks

Use focused package checks while editing:

```sh
pnpm --filter @code2create/backend typecheck
pnpm --filter @code2create/ops typecheck
pnpm --filter @code2create/web typecheck
pnpm --filter @code2create/landing typecheck
pnpm --filter @code2create/reviewer typecheck
```

Run the complete product checks before release:

```sh
pnpm check:product
pnpm test
pnpm build
pnpm check:release
```

Backend provider and key checks are explicit:

```sh
pnpm check:providers:staging
pnpm --filter @code2create/backend keys:check
```

## Specification map

- [Product brief](./specs/00-product-brief.md)
- [Domain and access](./specs/01-domain-and-access.md)
- [Participant onboarding](./specs/02-participant-onboarding.md)
- [Panels and queues](./specs/03-panel-and-queue-operations.md)
- [Reviewer application](./specs/04-reviewer-application.md)
- [Evaluation system](./specs/05-evaluation-system.md)
- [Operations dashboard](./specs/06-operations-dashboard.md)
- [Reliability and audit](./specs/07-reliability-safety-audit.md)
- [Synesthesia](./specs/08-synesthesia.md)
- [Delivery and acceptance](./specs/09-delivery-and-acceptance.md)
- [Decision register](./specs/10-decision-register.md)
- [Production architecture](./specs/11-production-architecture.md)
- [Data model and realtime](./specs/12-data-model-and-realtime.md)
- [Integrations and release](./specs/13-integrations-and-release.md)
- [Attendance and presence](./specs/14-attendance-and-presence.md)
- [Event review readiness](./specs/15-event-review-readiness.md)
- [Event follow-up plan](./specs/16-event-follow-up-plan.md)

The specifications define product behavior and invariants. Code and generated API types define implementation detail; do not manually duplicate the full schema or endpoint inventory in this file.
