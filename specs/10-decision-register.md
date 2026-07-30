# Decision register

This register separates source requirements from implementation choices and unresolved event policy.

## 1. Confirmed product direction

| ID | Decision |
| --- | --- |
| C-001 | Code2Create 7.0 is a 48-hour event expected to place roughly 900–1,000 people in the venue. |
| C-002 | Participants use a web portal, reviewers use a dedicated mobile application, and staff use a web operations dashboard. |
| C-003 | Participant entry asks VIT Student or External Participant before Google authentication. |
| C-004 | A VIT student must authenticate with the VIT student Google Workspace account. |
| C-005 | Reviewer and staff access comes from an approved roster; users do not select an elevated role. |
| C-006 | Reviewer UI uses large controls, little text, and one current task. |
| C-007 | Panels are planned before the round from reviewer expertise and rubric coverage. |
| C-008 | Every required panel reviewer scans the team QR before a normal review starts. |
| C-009 | A board override can handle an exceptional missing-presence case and must be recorded. |
| C-010 | Reviewers clock in; an absent reviewer triggers a substitute workflow. |
| C-011 | Team tables are captured before the review window and frozen before routing. |
| C-012 | Participants mark ready and see their queue/review state. |
| C-013 | Reviews have a time cap and an explicit extension path. |
| C-014 | Reviewers score independently on criteria assigned from their expertise. |
| C-015 | Reviewer seniority does not multiply score weight. |
| C-016 | No AI model generates, changes, normalises, or recommends judging scores. |
| C-017 | The working rubric uses seven weighted criteria scored 0–4. |
| C-018 | Later reviews receive previous findings, commitments, and progress evidence. |
| C-019 | The working round model is two ordinary reviews followed by a final round. |
| C-020 | Project onboarding is question-by-question and does not require a PPT. |
| C-021 | Teams disclose previous work and third-party tools. |
| C-022 | Teams connect GitHub and Figma so reviewers can inspect progress checkpoints. |
| C-023 | The application uses normal internet/HTTP connectivity. Bluetooth/P2P is not committed. |
| C-024 | Synesthesia accepts participant requests and votes while staff retain playback control. |
| C-025 | Five tracks are planned with room for a sponsor track. Mandatory problem statements were not adopted. |
| C-026 | The guided project intake supports pre-event shortlisting so the organisers can admit fewer teams when venue/review capacity requires it. |
| C-027 | Every active panel reviewer needs a working phone with the reviewer app; otherwise operations supplies a spare or replaces the reviewer. |

## 2. Selected implementation

| ID | Decision | Reason |
| --- | --- | --- |
| T-001 | Better Auth with Google only | Self-hosted auth code and data on the Convex deployment; supported web and Expo clients |
| T-002 | Validate Google `sub`, verified email, and `hd`; derive participant class on the server | The selector cannot grant or bypass VIT classification |
| T-003 | Store event roles in application tables, separate from the auth session | Roster revocation takes effect without changing provider identity |
| T-004 | Next.js for participant and staff web routes | One web codebase and deployment |
| T-005 | Expo/React Native for the reviewer application | Native camera, push, secure storage, and controlled builds |
| T-006 | Convex for application records, transactions, reactive queries, HTTP endpoints, scheduled work, and file storage | One live backend for all three clients |
| T-007 | Expo Notifications for reviewer pages, with in-app acknowledgement and call/runner fallback | Push can attract attention but cannot be trusted as assignment state |
| T-008 | Vercel for web and EAS for mobile delivery | Production-grade Next.js and signed Expo releases |
| T-009 | pnpm workspaces without Turborepo | The first codebase has two apps and one shared package; another build layer is unnecessary |
| T-010 | Sentry for client crash reporting, with domain history kept in Convex | Technical errors and event decisions have different records |
| T-011 | GitHub App with read-only Contents/Metadata access and signed push webhooks | No participant personal access token or write permission |
| T-012 | Figma OAuth with metadata/version scopes and checkpoint polling | File webhooks require permissions and have plan limits that do not fit hundreds of participant files |
| T-013 | Deterministic reviewer/panel routing rules | Assignments can be explained and reproduced without an AI decision |
| T-014 | One encrypted local reviewer draft for the active review | Protects short connection loss without creating a second event database |
| T-015 | Final scorecard submission, review start, assignment, and round changes require server confirmation | Client cache and push cannot claim judging state |
| T-016 | Private versioned S3 bucket in `ap-south-1` for round exports and downloaded backups, pending VIT policy approval | Keeps recovery copies outside the live backend with restricted access |

## 3. Working assumptions

| ID | Assumption | If changed |
| --- | --- | --- |
| A-001 | Standard panel has three scoring reviewers. | Panel capacity, app layout, and coverage matrix change. |
| A-002 | Ordinary review duration is 10 minutes. | Queue estimates and event schedule change. |
| A-003 | One ordinary two-minute extension is available. | Capacity and escalation rules change. |
| A-004 | Each active criterion receives at least two independent ratings. | Reviewer workload and aggregation completeness change. |
| A-005 | Team lead controls project submission and ready state. | Team permissions change. |
| A-006 | Table capture begins about 90 minutes before the window and freezes 30–60 minutes before routing. | Floor preparation timeline changes. |
| A-007 | `vitstudent.ac.in` is the initial VIT student hosted domain. | Auth configuration and fixtures change. |
| A-008 | Expected 200–330 teams, depending on final team size. | Load and panel-capacity plan changes. |
| A-009 | A substitute page expires after 90 seconds. | Page chain and runner/call timing change. |
| A-010 | Better Auth sessions last seven days; event grants end six hours after event close. | Session and operations support settings change. |
| A-011 | Each submitted application receives two independent admission recommendations. | Application-review workload and decision coverage change. |

## 4. Open policy

| ID | Decision | Owner | Deadline |
| --- | --- | --- | --- |
| O-001 | Final team-size bounds | Event board | Before registration opens |
| O-002 | Whether mixed VIT/External teams are allowed | Event board | Before registration opens |
| O-003 | Participant eligibility and evidence for external applicants | Event board | Before registration opens |
| O-004 | Final VIT hosted-domain list and account support route | Technical lead + VIT IT | Before auth staging sign-off |
| O-005 | Exact round schedule and elimination points | Event board | Before panel capacity planning |
| O-006 | Final rubric wording and which criteria apply in each round | Review leads | Before reviewer training |
| O-007 | Minimum scorers per criterion and aggregation formula approval | Review leads | Before reviewer training |
| O-008 | Round weighting, ties, missing-score handling, and final clean-slate/cumulative rule | Review leads + board | Before scoring staging sign-off |
| O-009 | Whether progress becomes a separate weighted criterion | Review leads | Before rubric publication |
| O-010 | Conflict-of-interest rules | Event board | Before roster import |
| O-011 | Panel continuity versus rotation between rounds | Review leads | Before panel planning |
| O-012 | Missed-call grace, number of calls, and queue re-entry | Participant + review operations | Before queue rehearsal |
| O-013 | Extension escalation and forced-close authority | Review operations + board | Before reviewer training |
| O-014 | Score correction window and post-lock remedy | Review leads | Before reviewer training |
| O-015 | Participant process-complaint window and remedies | Event board | Before participant policy publication |
| O-016 | Participant score/feedback release | Event board | Before final-round configuration |
| O-017 | Final tracks, sponsor track, and awards | Event board | Before event marketing freezes |
| O-018 | Reviewer/staff roster owner and emergency authority roster | Event board | Before reviewer staging |
| O-019 | Data retention, deletion, and export recipients | Event board + VIT policy owner | Before registration opens |
| O-020 | Synesthesia catalogue, playback account, moderation, and venue licensing | Event operations | Before Synesthesia production test |
| O-021 | Review transcription/recording | Event board | Deferred unless consent, privacy, and retention are approved |
| O-022 | Whether GitHub/Figma are mandatory for every team, accepted alternatives, and baseline deadline | Review leads | Before project onboarding opens |
| O-023 | Admission criteria, minimum application reviewers, venue/track capacity, waitlist order, offer deadline, and published decision detail | Event board + admissions lead | Before applications open |

## 5. Rejected or deferred

| ID | Direction | Status |
| --- | --- | --- |
| X-001 | Clerk | Removed; Better Auth runs with Convex and avoids another auth vendor/database |
| X-002 | Separate portal, reviewer, and dashboard backends | Rejected; they would create competing event state |
| X-003 | Reviewer PWA instead of a native app | Rejected in the planning discussion |
| X-004 | Participant passwords or local credential database | Rejected; Google is the sign-in provider |
| X-005 | Trust an email suffix as VIT proof | Rejected; use verified Google hosted-domain evidence |
| X-006 | Participant-selected reviewer/admin role | Rejected; staff access is rostered |
| X-007 | AI judging, AI score recommendations, or AI score adjustment | Rejected |
| X-008 | Seniority score multipliers | Rejected |
| X-009 | Automatic cross-panel score normalisation | Rejected |
| X-010 | Panels fixed only by track | Rejected; panels need broad rubric and domain coverage |
| X-011 | Mandatory problem statements for every team | Not adopted |
| X-012 | Bluetooth/P2P event sync | Deferred outside production scope |
| X-013 | Default review audio recording/transcription | Deferred |
| X-014 | A participant mobile app | Deferred; responsive web covers participant work |
| X-015 | Participant GitHub personal access tokens | Rejected; use a GitHub App installation |
| X-016 | One Figma webhook per team file | Rejected for permission, rate, and plan-limit reasons |
| X-017 | Store or judge full source/design files by default | Rejected; capture metadata and progress evidence |
| X-018 | Sponsor CRM, speaker management, or public social feed in the event backend | Outside scope |

## 6. Change procedure

When an open item is decided:

1. add the approved value, date, owner, and source;
2. mark any superseded row;
3. update the affected workflow and event configuration;
4. update automated tests and rehearsal script;
5. tell participants or reviewers before the relevant policy freeze.
