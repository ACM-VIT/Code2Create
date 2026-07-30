# Product brief

## 1. Problem

Code2Create 6.0 exposed operational failures that must not recur:

- Review panels were inconsistently formed and some reviewers were absent.
- Teams were not always judged by people with relevant context.
- Reviews ran late, with no reliable queue or time control.
- Scoring could be dominated by one voice in a panel.
- Notes were incomplete, making later reviewers unaware of earlier commitments and evidence.
- The dashboard and portal could not support the desired operating model.
- Review data was passed through informal channels and was vulnerable to loss or inconsistency.

Code2Create 7.0 expects roughly 900–1,000 participants in the venue, with the public proposal targeting 2,000+ participants/reach. The platform must make a large review operation predictable, fair, recoverable, and observable.

## 2. Product outcome

At any point during a review round, organisers must be able to answer:

1. Where is every team and what is its review state?
2. Where is every reviewer, and is each panel complete?
3. Which panel is best suited to each team?
4. What is blocking the next review?
5. What evidence and independent scores were recorded?
6. Has every required record reached the server and its backup?
7. Which intervention is needed, who performed it, and why?

Participants must know when to prepare without chasing organisers. Reviewers must be able to complete their work from a deliberately simple mobile interface.

## 3. Confirmed event model

- The hackathon is planned as a 48-hour event.
- The working structure is two reviews followed by a final round.
- The second review and final selection are eliminating stages; exact elimination policy remains open.
- Five primary tracks are planned, with capacity for one sponsor track.
- Teams should be routed by project needs and reviewer expertise rather than rigid track-only panels.
- The platform is a one-stop event system, with participant portal, reviewer app, and web operations dashboard kept in sync.
- Participant registration starts by choosing **VIT student** or **External participant**, followed by Google authentication.
- VIT-student classification requires a verified Google Workspace identity for the configured VIT student domain; a matching email string alone is insufficient.
- Reviewer, operations, and administrator authority is assigned from approved rosters and is independent of participant class.
- All surfaces use one realtime backend and see authorised projections of the same committed state.
- Every panel member must be present before a standard review can begin.
- Presence is confirmed by scanning a team QR displayed on the participant portal.
- Board-level users may override exceptional blocks, with a mandatory reason and audit entry.
- Reviews have a time budget. The working default is 10 minutes, with explicit two-minute extensions.
- Scores are entered independently at criterion level; a dominant panel member must not set a consensus score for everyone.
- Reviewers score only criteria they are authorised and assigned to assess.
- No automatic AI judging. An AI-generated project summary or novelty aid may be considered later, but cannot award or alter scores.
- Project registration is a guided, question-by-question experience rather than a traditional long form or PPT upload.
- Synesthesia lets participants request songs and upvote the queue, subject to organiser override.

## 4. Product principles

### Fairness is procedural

Fairness comes from consistent panel composition, independent input, common evidence standards, visible exceptions, and auditable decisions—not from hidden weighting by seniority.

### The system enforces the operating model

Critical rules cannot depend on reminders:

- an incomplete panel cannot silently start;
- a reviewer cannot skip required scoring and move on;
- a timer cannot be extended invisibly;
- missing sync cannot be discovered only after a round ends;
- an override cannot exist without an actor, time, target, and reason.

### One committed truth

The participant portal, reviewer application, and operations dashboard never reconcile independent copies of live event state. Convex is authoritative. Clients subscribe to scoped projections and issue validated commands. Push notifications, local caches, and offline drafts accelerate or protect the experience, but none of them becomes a competing source of truth.

### Fast at the point of work

Reviewers use large targets, short labels, sensible defaults, and one primary action per screen. Participants see a clear state and next step. Operations users can identify exceptions before normal cases.

### Degrade safely

Weak venue connectivity is expected. The experience may become slower, but it must not silently lose data, duplicate reviews, or produce competing truths.

### Humans decide

Automation can recommend panel assignments, identify conflicts, summarise evidence, and flag anomalies. Humans retain authority over review content, scores, eliminations, and overrides.

### No hidden policy

Rubric definitions, time rules, readiness rules, and relevant participant-facing statuses should be published before the event. Internal risk flags and security controls remain restricted.

## 5. Architecture baseline

- Next.js web application for the participant portal and role-gated staff/administration surfaces
- Expo React Native reviewer application for Android and iOS
- Clerk sessions with Google-only authentication across web and mobile
- Server-side Google OpenID Connect verification for VIT Workspace classification
- Convex reactive queries, transactional mutations, scheduled jobs, and storage
- Expo Notifications for background reviewer paging
- pnpm/Turborepo TypeScript monorepo with shared domain and UI packages
- Vercel web deployment, EAS mobile delivery, separate Convex/Clerk environments
- Sentry error monitoring plus structured domain and audit events

The architecture is a confirmed implementation direction, not an example. Vendor substitutions require a decision-register entry and must preserve the realtime, identity, transactional, offline, and audit contracts.

## 6. In scope

- Google authentication, VIT/external participant classification, and account provisioning
- Participant and staff identity
- Team creation and membership
- Guided project onboarding
- Track selection
- Check-in and table/team association
- QR-based team and review identity
- Reviewer profiles and expertise
- Panel creation and staffing
- Reviewer clock-in, paging, and substitution
- Team-to-panel recommendations and assignments
- Review readiness and live queues
- Timed review sessions and extensions
- Evidence, milestone, notes, and criterion scoring
- Review history and progress across rounds
- Finalist operations and exports
- Live operations, exception handling, audit, and recovery
- Reactive synchronization across participant, reviewer, and operations clients
- Push paging, device registration, delivery receipts, and notification fallbacks
- Synesthesia requests, voting, moderation, and playback control

## 7. Out of scope for this cycle

- Bluetooth or peer-to-peer transport architecture
- Sponsor CRM and outbound email tooling
- Sponsor decks and partnership proposals
- Automatic AI scoring
- Social-media engagement points
- Public event marketing website redesign
- Prize amounts and sponsor benefits
- Exact track names and problem statements
- Venue and final event timeline
- Replacing VIT's own identity directory or managing VIT Google Workspace accounts

## 8. Actors

| Actor | Primary need |
| --- | --- |
| Participant | Register, join a team, submit a credible project profile, check in, know review status |
| Team lead | Manage membership and project answers, declare readiness, confirm table |
| Reviewer | Receive assignments, prove attendance, review within time, record independent evidence and scores |
| Panel lead | Coordinate the panel without controlling other reviewers' scores |
| Operations member | Associate tables, manage queues, resolve ordinary exceptions |
| Review administrator | Define panels, criteria, assignments, substitutions, and round controls |
| Board administrator | Exercise exceptional overrides and finalist authority |
| Playback moderator | Moderate and control Synesthesia |
| Auditor | Read immutable operational history and exports |

## 9. Success measures

Targets must be finalised after rehearsal, but the launch candidate should support measurement of:

- Percentage of scheduled teams receiving every required review
- Median and 95th-percentile wait time after declaring ready
- Median review duration and extension rate
- Percentage of panels complete at scheduled round start
- Substitution count and median substitution time
- Percentage of required criterion scores submitted
- Score variance by criterion, panel, track, and round
- Number of sync incidents, unresolved records, and duplicate attempts
- Number and type of overrides
- Participant-visible queue accuracy
- Time from round close to a validated finalist dataset
- Support requests per 100 teams
- 95th-percentile propagation time from an accepted command to subscribed online clients
- Percentage of Google authentications provisioned without manual intervention
- Push acknowledgement and fallback-escalation time for critical reviewer pages

## 10. Non-goals

The platform is not intended to make judging subjective questions disappear. It exists to ensure the same process, evidence expectations, and operational controls are applied consistently enough that human judgment is defensible.
