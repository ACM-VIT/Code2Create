# Decision register

This file is authoritative for product decisions. Update it when organisers decide an open item; link the decision to meeting/chat evidence and revise affected specifications.

## 1. Confirmed

| ID | Decision |
| --- | --- |
| D-001 | Create detailed Markdown specifications before implementation or technology selection. |
| D-002 | Build a dedicated reviewer app synchronised with a web operations dashboard. |
| D-003 | Reviewer UI is minimal, with large controls and little text. |
| D-004 | Panels are pre-planned around reviewer expertise and criterion coverage. |
| D-005 | The system can recommend dynamic team-to-panel matches rather than using only rigid track panels. |
| D-006 | Every required panel member proves presence by scanning the team QR before a normal review starts. |
| D-007 | Board-level override exists for exceptional cases and must be controlled. |
| D-008 | Reviewer absence triggers paging/substitution logic. |
| D-009 | Participants have visible queued review status and a readiness mechanism. |
| D-010 | Reviews use a time cap with explicit two-minute extension controls. |
| D-011 | Reviewers independently score criteria associated with their expertise; one dominant person must not set all panel scores. |
| D-012 | No AI-generated score determines judging outcomes. |
| D-013 | Project onboarding is guided question-by-question, not a traditional long form or PPT. |
| D-014 | Project tools, prior work, and original team contribution are disclosed and assessed. |
| D-015 | Progress against commitments across reviews is captured. |
| D-016 | Five tracks are planned with buffer for a sponsor track; exact tracks are separate. |
| D-017 | Current event model is two reviews plus a final round. |
| D-018 | Track participation does not automatically guarantee a finalist or track prize. |
| D-019 | Synesthesia accepts participant requests/upvotes but organisers retain override. |
| D-020 | Technology stack decisions are deferred until specifications are approved. |

## 2. Working assumptions to confirm

| ID | Assumption | Consequence if changed |
| --- | --- | --- |
| A-001 | Standard panel has three scoring reviewers. | Panel staffing, UI, coverage, and capacity change. |
| A-002 | Default review duration is 10 minutes. | Queue simulation and timer design change. |
| A-003 | One ordinary +2 minute extension is allowed before escalation. | Review completion and capacity change. |
| A-004 | The seven-criterion, 100-point rubric in the June discussion is the baseline. | Scoring configuration and training change. |
| A-005 | Team leads control submissions and readiness. | Permission and UX changes. |
| A-006 | Server remains authoritative; offline mode permits drafts but not ordinary final authority transitions. | Reliability architecture changes. |
| A-007 | Table confirmation begins 90 minutes before reviews and is finalised 30–60 minutes before. | Staffing and queue readiness change. |

## 3. Open decisions

| ID | Decision needed | Owner | Needed by |
| --- | --- | --- | --- |
| O-001 | Final team size: 2–5, 3–5, or another range | Event board | Milestone 0 |
| O-002 | Exact round schedule and which stages eliminate | Event board | Milestone 0 |
| O-003 | Final rubric wording, weights, and per-round applicability | Review leads | Milestone 0 |
| O-004 | Aggregation formula, minimum scorers, rounding, ties, missing-data policy | Review leads | Milestone 0 |
| O-005 | Whether progress is a separate weighted criterion or supporting evidence | Review leads | Milestone 0 |
| O-006 | Whether later rounds preserve panel continuity, rotate panels, or use a hybrid | Review leads | Milestone 3 |
| O-007 | When, if ever, reviewers see peer scores | Review leads | Milestone 0 |
| O-008 | Ordinary extension count and escalation threshold | Review operations | Milestone 0 |
| O-009 | Queue policy: exact ordinal versus teams-ahead/time window | Participant ops | Milestone 4 |
| O-010 | Late, missed-call, hold, and re-entry rules | Participant ops | Milestone 0 |
| O-011 | Exact conflict-of-interest policy | Event board | Milestone 0 |
| O-012 | External judge role and permissions | Event board | Milestone 3 |
| O-013 | Correction deadline and post-lock remedy | Review leads | Milestone 0 |
| O-014 | Process complaint/appeal window and remedies | Event board | Milestone 0 |
| O-015 | Degraded-mode authority and permitted offline transitions | Technical + ops leads | Milestone 0 |
| O-016 | Data retention and participant feedback policy | Event board | Milestone 0 |
| O-017 | Final tracks and whether there are open problem statements | Event board | Before registration |
| O-018 | Award categories and relationship to rubric | Event board | Before marketing prizes |
| O-019 | Synesthesia catalogue/playback source, moderation policy, and licensing | Event ops | Milestone 7 |
| O-020 | Whether transcription is approved with consent/privacy controls and a sponsor | Event board | Deferred |

## 4. Rejected or deferred directions

| ID | Direction | Status/reason |
| --- | --- | --- |
| X-001 | Choose a technology stack during ideation | Rejected for this phase |
| X-002 | Traditional application form plus PPT | Rejected |
| X-003 | AI-generated judging scores | Rejected |
| X-004 | Seniority-based score multipliers | Rejected due to skew risk |
| X-005 | Automatic score normalisation | Not approved; anomaly review is human |
| X-006 | Panels fixed exclusively by track | Replaced by expertise-aware dynamic routing |
| X-007 | Mandatory problem statements for every project | Not adopted; concern about repetitive implementations |
| X-008 | Bluetooth/P2P as a committed transport | Deferred architecture exploration |
| X-009 | Review transcription by default | Deferred pending sponsor, consent, privacy, and retention |
| X-010 | Social engagement points | Deferred outside core review platform |

## 5. Change procedure

For every approved change:

1. assign a decision ID;
2. record date, approver, rationale, and source;
3. mark superseded decisions;
4. update affected specifications;
5. update acceptance tests and configuration;
6. communicate participant- or reviewer-facing policy changes before freeze.

