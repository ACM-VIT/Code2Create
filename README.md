# Code2Create

Code2Create is the event platform built by [ACM-VIT](https://github.com/ACM-VIT) for Code2Create 7.0, a 48-hour hackathon for about a thousand people in one venue. It runs the whole event: registration and team formation, proposal intake and admission, venue attendance, review panels and judging, participant support, communications, and organizer operations.

## What it does

- **Participant portal**: Google sign-in, profiles, realtime team formation, proposal intake with AI-assisted follow-up questions, admission offers and RSVP, attendance QR codes, live review-queue status, support cases, and audience music requests.
- **Operations dashboard**: permission-scoped tools for admissions, event setup, attendance stations, panel and queue management, judging, support, communications, integrations, and incident recovery.
- **Reviewer app**: a native iOS and Android app for reviewers and floor staff, covering availability, panel paging, QR check-in, offline-safe scorecards, and attendance scanning.
- **Intelligence worker**: Cloudflare-hosted agents that prepare operations briefs, admission recommendations, and source-linked review questions. They only propose actions; staff decide.
- **Landing page and trailer**: the public event site, photo gallery, and promotional video.

Every surface shares one Google identity and one Convex deployment. Permissions are exact grants scoped to an event or resource. Role labels only bundle default grants and never authorize anything on their own.

## Repository layout

| Path                            | Responsibility                                                             |
| ------------------------------- | -------------------------------------------------------------------------- |
| `apps/backend`                  | Convex data, authorization, transactions, jobs, and provider orchestration |
| `apps/web`                      | Participant portal (Vite, React)                                           |
| `apps/ops`                      | Operations dashboard (Vite, React)                                         |
| `apps/reviewer`                 | Native reviewer and floor-operations app (Expo, React Native)              |
| `apps/landing`                  | Public landing page and photo gallery                                      |
| `apps/intelligence`             | Flue-based operations intelligence Worker                                  |
| `apps/updates`                  | Self-hosted Expo Updates Worker backed by R2                               |
| `apps/email`                    | Outbound email (SES/Cloudflare) and email-routing Worker                   |
| `apps/voice`                    | Outbound call and synthesized-audio Worker                                 |
| `apps/discord`                  | Discord support bridge                                                     |
| `apps/e2e`                      | Playwright browser verification                                            |
| `apps/trailer`                  | Event trailer (Remotion)                                                   |
| `packages/domain`               | Shared domain contracts and presentation vocabulary                        |
| `packages/web-auth`             | Shared Better Auth browser integration                                     |
| `packages/client-observability` | Shared client analytics and error tracking                                 |
| `packages/web-forms`            | Shared form validation                                                     |
| `specs/`                        | Product specification                                                      |
| `infra/`                        | Self-hosted Convex deployment for staging and production                   |
| `templates/participant-emails`  | Participant email templates                                                |

Most apps have their own `README.md` with setup and deployment details.

## Getting started

### Prerequisites

- Node.js `22.22.0` (see `.nvmrc`)
- pnpm `11.18.0` through Corepack
- Xcode and Android Studio, only for building the reviewer app
- Wrangler, only for deploying Cloudflare Workers

```sh
corepack enable
pnpm install
```

The workspace uses pnpm only. Native apps are built and signed locally, and over-the-air updates are served by `apps/updates`. The project does not use EAS Build, EAS Update, or the Expo Push Service.

### Configuration

Copy [`apps/backend/.env.example`](./apps/backend/.env.example) to `apps/backend/.env.local` and fill in the credentials for the flows you want to test. Google sign-in needs:

```text
AUTH_SITE_URL=http://localhost:3211
PARTICIPANT_SITE_URL=http://localhost:5180
OPERATIONS_SITE_URL=http://localhost:5181
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
INITIAL_SUPREME_EMAILS=...
INITIAL_EVENT_SLUG=code2create-7
```

Register `http://localhost:3211/api/auth/callback/google` as the Google OAuth redirect URI, and `http://localhost:5180` and `http://localhost:5181` as browser origins.

Participant onboarding includes a GitHub step that uses a classic GitHub OAuth App with the `public_repo` scope. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and register `http://localhost:5180/onboarding/github/callback` as its callback URL. GitHub OAuth Apps allow one callback URL, so use a separate app per environment. These credentials are separate from the read-only GitHub App used for team repository evidence.

### Running locally

```sh
pnpm dev
```

This starts the local Convex backend, the participant portal, and the operations dashboard. It applies local service configuration but creates no product records.

For a disposable event playground, wait for `Local stack ready`, then run:

```sh
pnpm dev:seed
pnpm dev:playground
```

The seed creates eight teams in different admission states, six five-reviewer panels with reserves, confirmed availability, queued teams, and entry and exit stations. Re-running it keeps existing teams and review progress. It refuses to run against hosted deployments.

Open `http://127.0.0.1:5190/web` for a seeded participant and `http://127.0.0.1:5190/ops` for a seeded operator. The playground keeps simulated reviewer phones online; scoring stays manual. Local sessions are stored in the ignored `outputs/dev/accounts.json` file.

To start every runtime, including reviewer Metro and all Workers:

```sh
pnpm dev:full
```

Or start one surface at a time:

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
| Landing page         | `http://localhost:5182`        |
| Convex HTTP/auth     | `http://localhost:3211`        |
| Reviewer Metro       | `http://localhost:8082`        |
| Intelligence Worker  | `http://localhost:8791/health` |
| Expo Updates Worker  | `http://localhost:8792/health` |
| Email Worker         | `http://localhost:8793/health` |
| Voice Worker         | `http://localhost:8794/health` |

Run `pnpm dev:prepare` after changing backend or Worker environment variables while the backend is running.

### Reviewer app

After changing Expo native plugins, regenerate the native project and build the simulator app:

```sh
pnpm --filter @code2create/reviewer exec expo prebuild --platform ios --no-install
pnpm --filter @code2create/reviewer ios
```

Development manifests are signed with the update key at `~/.config/code2create/updates/private-key.pem`; set `C2C_UPDATE_PRIVATE_KEY_PATH` to use another key. See [`apps/reviewer/README.md`](./apps/reviewer/README.md) and [`apps/updates/README.md`](./apps/updates/README.md) for signing and update delivery.

## Checks

Run focused package checks while editing:

```sh
pnpm --filter @code2create/backend typecheck
pnpm --filter @code2create/web typecheck
pnpm --filter @code2create/ops typecheck
pnpm --filter @code2create/landing typecheck
pnpm --filter @code2create/reviewer typecheck
```

Participant interaction tests run against local browser fixtures without a backend:

```sh
pnpm --filter @code2create/e2e install:browser
pnpm --filter @code2create/e2e test:interactions
```

Run the full product checks before a release:

```sh
pnpm check:product
pnpm test
pnpm build
pnpm check:release
```

## Specification

The [`specs/`](./specs) directory defines product behavior and invariants. Code and generated Convex API types define implementation detail.

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

Contributor and coding-agent conventions are in [`AGENTS.md`](./AGENTS.md).
