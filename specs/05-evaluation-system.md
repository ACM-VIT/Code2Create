# Evaluation

## 1. Working rubric

Each criterion is scored from 0 to 4.

| Criterion | Weight | Question |
| --- | ---: | --- |
| Problem & User Fit | 15 | Is the problem specific, evidenced, and relevant to a clear user? |
| Working Solution | 20 | Does the demonstrated solution perform the important flow? |
| Original Team Contribution | 15 | What did this team add during the event beyond prior work, templates, and third-party tools? |
| Technical Execution | 15 | Are the implementation choices sound for the problem and current stage? |
| User Readiness | 10 | Can the intended user understand and use the current experience? |
| Trust & Responsible Use | 15 | Has the team handled privacy, security, safety, data, accessibility, and misuse risk? |
| Communication & Evidence | 10 | Did the team explain its decisions and support claims with a demo or other evidence? |
| **Total** | **100** | |

The event board must approve wording and round applicability before the rubric is published.

## 2. Shared score anchors

| Score | Meaning |
| ---: | --- |
| 0 | Not shown |
| 1 | Weak or mostly claimed |
| 2 | Basic or partially shown |
| 3 | Strong or clearly shown |
| 4 | Excellent; the reviewer can confidently verify it |

Each rubric criterion also has examples for 0, 2, and 4. Reviewer training uses the same examples as the app.

## 3. Criterion guidance

### Problem & User Fit

Review the user definition, observed need, urgency, alternatives, and evidence. A broad market statement without a specific user or observation does not earn a high score.

### Working Solution

Score what the team demonstrates. Separate a functioning flow from a slide, video, static mock-up, or verbal promise. The evidence checklist records what was shown.

### Original Team Contribution

Consider disclosed starting material, repository/design checkpoints, third-party services, generated code, templates, datasets, and what changed during the event. Using tools is allowed. Hiding prior work is not.

### Technical Execution

Review architecture, implementation depth, reliability, security, and fit to the problem. Do not reward complexity by itself.

### User Readiness

Review task clarity, interaction, accessibility, error handling, and whether an intended user could complete the main flow. The “interface” may be a GUI, CLI, API, hardware control, data output, or another form appropriate to the project. Do not turn this into a visual-design score.

### Trust & Responsible Use

Review data collection, consent, permissions, model/tool disclosure, unsafe failure modes, abuse prevention, and accessibility concerns relevant to the project.

### Communication & Evidence

Review whether the team explained the problem, decisions, limitations, and progress with evidence. Presentation polish cannot replace a working result.

## 4. Independent scoring

- Reviewers score alone on their own devices.
- A reviewer receives only criteria assigned before the session starts.
- Peer score values remain hidden until the event policy permits reveal.
- Discussion may clarify evidence, but the panel does not negotiate one shared score.
- The panel lead cannot edit another reviewer’s scorecard.
- Reviewer designation and seniority do not change weight.
- A reviewer with a conflict cannot submit.

The working panel has three reviewers. The working coverage rule requires at least two independent scores for each criterion. That gives each criterion more than one opinion without asking every reviewer to score all seven criteria.

The final minimum scorer count remains an open event decision and is stored with the rubric version.

## 5. Criterion assignment

Before routing opens, the panel plan creates a coverage matrix:

| Criterion | Reviewer A | Reviewer B | Reviewer C |
| --- | :---: | :---: | :---: |
| Problem & User Fit | ✓ | ✓ | |
| Working Solution | ✓ | | ✓ |
| Original Team Contribution | | ✓ | ✓ |
| Technical Execution | ✓ | | ✓ |
| User Readiness | ✓ | ✓ | |
| Trust & Responsible Use | | ✓ | ✓ |
| Communication & Evidence | ✓ | ✓ | |

This is an example, not a fixed mapping. The planner uses reviewer expertise and ensures the configured minimum.

If a substitute joins before review start, the server recomputes assignments and freezes a new coverage version. After start, changing criterion ownership requires a review-operations correction and cannot erase submitted work.

## 6. Aggregation

The selected working formula is:

1. calculate the arithmetic mean of valid independent 0–4 scores for each criterion;
2. calculate criterion points as `mean ÷ 4 × criterion weight`;
3. add criterion points for a total out of 100.

The backend stores raw integer scores and computes points from the rubric version. It does not round each reviewer score or alter a reviewer’s input.

Example: scores 3 and 4 for a 20-point criterion produce a mean of 3.5 and 17.5 criterion points.

The following do not occur:

- seniority multipliers;
- automatic score normalisation across panels;
- hidden panel-specific offsets;
- replacement of independent scores with a consensus score;
- AI-written or AI-recommended ratings.

If a criterion lacks its minimum scorer count, the review is incomplete and no total is published.

Tie-breaks, round weighting, and final-round aggregation remain open decisions.

## 7. Score spread

A spread check flags a criterion when the highest and lowest ratings differ by at least two points. The threshold is configurable with the rubric.

A flag does not change the numbers. A review administrator can:

- confirm that reviewers used the same rubric version;
- ask for a short clarification of evidence;
- identify a wrong criterion assignment or data-entry mistake;
- open a correction before round lock.

The administrator cannot ask a reviewer to move toward the panel average. Any correction keeps the original scorecard and the reviewer’s reason.

## 8. Progress between reviews

Review 1 records:

- demonstrated baseline;
- missing or weak evidence;
- specific commitments for the next checkpoint;
- immutable evidence-checkpoint-set ID containing every declared repository and the Figma snapshot.

Before Review 2, the team records what changed. Review 2 receives:

- previous commitments;
- team’s change summary;
- old and new evidence checkpoint sets fixed by ID;
- current demonstration evidence.

Progress is required evidence. The current rubric has no separate progress weight, so reviewers apply it only where it supports Working Solution, Original Team Contribution, Technical Execution, or another relevant criterion.

Provider statistics do not calculate or suggest a score. Commit, line, file, node, version, and comment counts can help a reviewer locate change, but they cannot establish quality, effort, originality, or individual contribution. GitHub authors and Figma version/comment handles are observations from provider records, not a member-attribution system.

The evidence context is immutable after the review starts. A later push, Figma refresh, or repository-set change may be visible as newer available evidence, but scoring remains tied to the recorded checkpoint-set ID unless review operations explicitly replaces the context and records why.

Adding a separate weighted progress criterion is an open decision. The system does not create bonus points without that decision.

## 9. AI boundary

The intake interpretation layer may identify fields already present in team-written answers, suggest published maturity/track values, choose among server-allowed follow-up question keys, and draft a compact source-linked project brief.

It must:

- label every model-assisted brief field and link it to participant-written answer versions;
- leave maturity, origin, track, sponsor eligibility, and final wording unconfirmed until the participant acts;
- avoid novelty verdicts and invented validation, users, progress, disclosures, or evidence;
- avoid predicted admission, rank, score, or winner language;
- never replace reviewer access to original answers.

A track-specific intake overlay can request relevant evidence. It does not alter rubric weights or scoring anchors unless the board separately publishes a new rubric version.

No model receives admission recommendations, private reviewer notes, peer scores, scorecards, evaluation results, or ranking data. No model output can call an admission, routing, score, award, or project-submission mutation. Reviewer/panel routing and criterion coverage use fixed rules.

## 10. Round close

The review administrator sees:

- teams expected and completed;
- required scorecards present and missing;
- criterion coverage;
- score-spread flags;
- conflicts;
- open corrections;
- manual incident records;
- totals computed from the published rubric version.

Round close is blocked until each unresolved item is fixed or handled by an approved exception policy.

Moving a round to `closing` freezes its scorecard versions and starts the export. The final `closed` transition requires a verified export manifest. Reopening requires board capability, a fresh sign-in, and a reason.

## 11. Finalist and award decisions

The system can prepare a ranked view after the event board approves:

- which reviews contribute;
- round weights;
- minimum eligibility;
- tie-break order;
- track and sponsor-award rules;
- whether the final is cumulative or a clean slate.

The ranking view always shows the underlying criterion totals and any missing/exception state. A board decision that departs from the configured ranking requires a recorded reason.

Track participation does not guarantee a finalist place or prize.

## 12. Corrections and complaints

### Correction

A reviewer requests correction to their own submitted scorecard. A review administrator checks that the correction window is open, records the reason, and opens a new scorecard version. The reviewer resubmits. The original remains read-only.

### Administrative void

A review administrator may void a scorecard for duplicate session, confirmed conflict, wrong team, or reviewer ineligibility. The action requires evidence and may trigger a replacement review.

### Process complaint

A participant may report a process problem such as missing panel member, wrong table, or unavailable review. Complaints do not directly edit scores. The board chooses a remedy under the approved complaint policy.

The correction deadline, complaint window, and remedies are open decisions.

## 13. Participant feedback

The release policy decides whether participants receive:

- commitments;
- criterion-level scores;
- written feedback;
- total score;
- finalist decision reason.

Private reviewer notes, conflict reports, other teams’ results, and staff audit details are never participant feedback.

## 14. Exports

Each round export contains:

- event, round, and rubric versions;
- teams and eligibility state;
- review sessions and panel membership;
- raw scorecard versions;
- computed criterion means and totals;
- missing coverage and spread flags;
- correction and override references;
- generation time and export checksum.

CSV supports operations analysis. JSON preserves version and relationship detail for audit and recovery.

## 15. Acceptance checks

- A reviewer cannot score an unassigned criterion.
- Peer values remain hidden during independent scoring.
- Two reviewers’ ratings for the same criterion both remain in the record.
- Missing coverage blocks the total and round close.
- The formula reproduces totals from raw scores and the saved rubric version.
- A spread flag never changes a score.
- A correction keeps the original and corrected versions.
- No AI function can call a score-write function.
- A suggested track or model-assisted brief phrase cannot appear as participant-confirmed evidence until the participant accepts or edits it.
- Track-specific intake prompts cannot change the rubric version or criterion weights.
- Review 2 context contains the exact Review 1 commitments and checkpoint references.
- Provider activity counts cannot write, prefill, weight, or recommend a criterion score.
- A submitted scorecard can be traced to the exact repository snapshots and Figma snapshot inside the checkpoint set shown during that review.
