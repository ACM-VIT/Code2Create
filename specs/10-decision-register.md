# Decision register

This file records current decisions only. It does not keep obsolete product paths.

## 1. Product decisions

| ID | Decision |
| --- | --- |
| P-001 | The product serves about 900 to 1,000 people at one 48-hour event. |
| P-002 | The product has a participant Vite portal, an operations Vite dashboard, an Expo reviewer app, a Vite handbook, and a separate backend. |
| P-003 | Google sign-in is the only interactive sign-in method. |
| P-004 | Participant accounts are VIT student or external participant profiles. The server verifies the class. |
| P-005 | The only role labels are Supreme, Board, SC, JC, and External Judge. |
| P-006 | Role labels do not authorize actions. Atomic, scoped, time-bounded per-user grants authorize actions. |
| P-007 | Any event-linked account can receive a grant without receiving a role label. |
| P-008 | One participant can belong to one active team. One active team has exactly one lead. |
| P-009 | Leadership transfer requires acceptance by the proposed lead. |
| P-010 | Final submission creates the first immutable team and proposal snapshot. It does not close team management. |
| P-011 | Membership, leadership, and proposal content remain editable until the deadline for the team's verified participant class. |
| P-012 | Every accepted post-submission team or proposal change creates an immutable version and invalidates stale human-review and AI-admission outputs. |
| P-013 | Route proposals by current proposal content and reviewer-domain coverage. |
| P-014 | Git tracked branches remain part of GitHub evidence. Synesthesia music tracks remain part of the music catalog. |
| P-015 | Proposal intake is free text followed by two required fixed questions and up to two grounded AI questions when useful. |
| P-016 | The proposal flow remains usable without OpenAI. |
| P-017 | Live novelty appears only as a non-blocking number above the idea text box. |
| P-018 | Novelty does not affect submission, admission, review routing, judging, awards, or exports. |
| P-019 | Admission AI returns an advisory structured recommendation. An authorized human controls the decision. |
| P-020 | Admission and judging are separate. AI never writes or recommends judging scores. |
| P-021 | Staff scan the barcode on an existing VIT ID from provisioned phones. Approved QR credentials cover external and fallback cases. |
| P-022 | Venue arrival, session presence, temporary exit, return, and departure are separate participant facts. |
| P-023 | A team shows a short-lived location QR on its dashboard. An authorized organizer scans it and records the team location. |
| P-024 | A separate team QR proves assigned-reviewer presence. It does not create attendance or location. |
| P-025 | Participants cannot enter or prioritize their team in a review queue. |
| P-026 | Reviewers score assigned criteria independently. No panel coordinator replaces scorecards with one consensus score. |
| P-027 | Reviewer paging sends push first. It can escalate to a synthesized outbound phone call after the configured delay. |
| P-028 | Phone calls require active consent, exact permissions, audit records, provider-state records, and cancellation on acknowledgement. |
| P-029 | The outbound-calling service is reusable. A later participant-calling release requires a separate purpose and consent policy. |
| P-030 | One team can connect multiple GitHub repositories across installations or organizations. |
| P-031 | Each connected repository keeps its own Git tracked branch, purpose, baseline, snapshots, and health. |
| P-032 | Figma uses scoped OAuth and exact-version evidence snapshots. |
| P-033 | GitHub and Figma facts are evidence. They do not become scores. |
| P-034 | Synesthesia is a separate licensed-catalog request, vote, report, moderation, and playback-record system. |
| P-035 | Support links do not grant access to linked domain records. |
| P-036 | Protected corrections preserve earlier records and add actor, reason, time, and before/after values. |
| P-037 | External participants and VIT students have separate application deadlines. The external deadline is no later than the VIT deadline. |
| P-038 | A team contains only VIT students or only external participants. This rule is not configurable. |

## 2. Technical decisions

| ID | Decision | Reason |
| --- | --- | --- |
| T-001 | Use Convex as the realtime event authority. | Reads, writes, scheduled work, and subscriptions use one accepted state. |
| T-002 | Use Better Auth with Google on Convex. | The backend can map one Google identity to event accounts and grants. |
| T-003 | Use Vite for the participant portal, operations dashboard, and handbook. | These are separate web frontends with a shared backend. |
| T-004 | Build and sign Expo native applications locally. | The event owns the native release process. |
| T-005 | Serve Expo Updates from an event-owned Cloudflare Worker and R2 bucket. | Mobile release does not depend on EAS Update. |
| T-006 | Do not use EAS Build, EAS Update, or Expo Push Service. | The event owns build, update, and notification infrastructure. |
| T-007 | Use Cloudflare Workers for approved external I/O boundaries. | External calls remain separate from Convex transactions. |
| T-008 | Use Cloudflare Email Routing and the event-owned email service for participant email. | Delivery state and routing remain under event control. |
| T-009 | Store protected exports and previews in approved private S3 storage. Store Expo Update assets in event-owned R2 storage. | Large private artifacts and mobile update assets do not enter Convex documents. |
| T-010 | Use immutable policy versions and one optimistic published pointer. | An accepted action pins the policy that authorized it. |
| T-011 | Use idempotent operation IDs for commands that can be retried. | A lost response cannot create a second accepted effect. |
| T-012 | Use optimistic target versions for mutable shared records. | Concurrent devices cannot silently overwrite accepted state. |
| T-013 | Use server time for deadlines, QR expiry, page expiry, review timers, and attendance windows. | A device clock cannot create authority. |
| T-014 | Store every submitted proposal revision as a new immutable version. | Review and AI outputs can point to exact content. |
| T-015 | Move one application current-version pointer in the same transaction that invalidates stale outputs. | No old output can decide changed content. |
| T-016 | Use `text-embedding-3-small` at native 1,536 dimensions for the first novelty corpus. | Corpus and query vectors use one validated width. |
| T-017 | Store only a fingerprint and character count on novelty requests. | The proposal draft remains the only participant-text source. |
| T-018 | Use OpenAI strict structured output with `store: false` for follow-up and admission requests. | The server validates a closed contract. |
| T-019 | Give AI no event command tools. | Model output cannot carry product authority. |
| T-020 | Use a GitHub App with Metadata read and Contents read. | The evidence path does not need repository writes. |
| T-021 | Bind several repositories to one team integration. | A product can span several repositories and organizations. |
| T-022 | Use Figma OAuth with the minimum approved file scopes. | The system can capture exact design evidence without write access. |
| T-023 | Pin GitHub SHAs and Figma file versions at review start. | Later provider changes cannot rewrite review evidence. |
| T-024 | Keep push delivery, outbound-call attempts, and in-app page acknowledgement as separate records. | Provider acceptance is not reviewer response. |
| T-025 | Give outbound calls a purpose key and script version. | Reviewer and future participant calls cannot mix policy or wording. |
| T-026 | Use append-only attendance facts and derived presence intervals. | A correction does not erase scanner evidence. |
| T-027 | Use distinct opaque token types for attendance, team location, and reviewer presence. | One QR cannot create another domain effect. |
| T-028 | Use server start time for review timers. | Clients do not write one row per second. |
| T-029 | Use two-person verification for paper score recovery and final round exports. | A protected manual source needs independent confirmation. |
| T-030 | Run operations intelligence outside the authority boundary. | It can observe and recommend, but a human command makes effects. |
| T-031 | Deploy staging Workers from `staging` and production Workers from `main` through separate Cloudflare Workers Builds connections. | Branch identity, Worker runtime configuration, deployment history, and rollback stay exact for each surface. |
| T-032 | Derive a VIT participant's study year from the verified registration number and configured event start year. | A release-year prefix table would reject valid later cohorts and fifth-year participants. |
| T-033 | Invalidate older team novelty vectors and running previews in the same transaction that accepts changed idea text. | Provider failure or late completion cannot leave an obsolete idea active in the density pool. |

## 3. Required concurrency rules

| Race | Required result |
| --- | --- |
| Two team joins | At most one conflicting join commits. Capacity and one-team membership remain true. |
| Leadership transfer and membership change | One transaction wins. The team retains exactly one lead. |
| Final submission and membership change | One transaction wins. The application member snapshot matches the confirmed preview. |
| Proposal revision and application review | A review can submit only for the current proposal version. |
| Proposal revision and AI completion | The old AI result settles as stale and cannot attach to the new version. |
| Proposal revision and deadline | The server-time order decides. No write commits at or after `applicationsCloseAt`. |
| Two proposal saves | One expected version wins. The loser reloads current state. |
| Idea edit and novelty completion | The accepted edit marks the older request stale and removes older team vectors. A late action cannot restore them. |
| Two repository reorders | One complete ordered set wins. The loser reloads. |
| Attendance scan and session close | The transaction order decides against the authoritative session boundary. |
| Duplicate attendance scans | One accepted fact produces one resulting state transition. |
| Location map and correction | Exact token, plan, location, and grant versions decide. |
| Two substitute acceptances | One reviewer fills the seat. The other receives current state. |
| Two review starts | One authoritative review session and start time exist. |
| Round pause and review start | The transaction order decides. A paused round accepts no new start. |
| Lost score-submit response | Retry returns the accepted scorecard version and creates no duplicate. |
| Round close and late score | One transaction wins. Close cannot ignore a required accepted score. |
| Push acknowledgement and call escalation | Acknowledgement cancels an unclaimed call. A claimed call records the race result. |
| Call callback and retry | Provider event IDs and operation IDs converge on one call-attempt state. |
| Permission revoke and protected write | The mutation rechecks the grant. The transaction order decides. |

## 4. Open policy decisions

| ID | Decision owner | Required decision |
| --- | --- | --- |
| O-001 | Board | Team-size bounds |
| O-002 | Board | External-participant and VIT-student application deadlines |
| O-003 | Board and admissions owner | Admission rubric, minimum human reviews, AI-use rule, capacity, waitlist order, offer deadline, and participant-visible reasons |
| O-004 | Board and participant owner | Profile fields, notices, consent, privacy URL, fresh-project text, and final-submission warning |
| O-005 | Board and review owner | Panel size, reviewer eligibility, expertise coverage, review duration, and substitute policy |
| O-006 | Board and judging owner | Rubric, correction deadline, feedback release, finalist process, and awards |
| O-007 | Attendance owner | Sessions, expected groups, scan windows, grace rules, and result policy |
| O-008 | Floor owner | Floor plan, mapping window, freeze, zone grants, and correction policy |
| O-009 | Communications owner | Reviewer push text, call delay, call script, consent, quiet hours, retries, and escalation stop rules |
| O-010 | Integrations owner | GitHub and Figma requirements, repository/file limits, freeze, and alternative evidence |
| O-011 | Privacy owner | Retention periods for proposals, provider jobs, call recordings or transcripts if any, exports, and audit |
| O-012 | Synesthesia owner | Music catalog, windows, request limits, moderation, explicit-content rule, and playback policy |
| O-013 | Release owner | Load envelope, rehearsal owners, launch gates, rollback owners, and final sign-off |

## 5. Excluded or deferred

- AI-generated judging scores and score recommendations are excluded.
- Automatic cross-panel score normalization is excluded.
- Review audio recording and transcription are excluded.
- Bluetooth, mesh, and peer-to-peer event state are excluded.
- A participant native application is excluded.
- A public social feed and engagement-points system are excluded.
- Sponsor CRM, speaker outreach, marketing, and ticket sales are excluded.
- A general agent with broad database credentials or direct event-command tools is excluded.
- Participant operational phone calls are deferred until a separate consent and communications policy is approved.

## 6. Change procedure

1. The owner records the proposed requirement and affected scopes.
2. The owner resolves contradictions in this handbook.
3. Engineering updates the domain model, permission catalog, tests, fixtures, and release checks.
4. The release owner verifies the full affected workflow.
5. The authorized policy owner publishes the new immutable version.

Do not add a compatibility path for an obsolete product decision.
