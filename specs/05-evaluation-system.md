# Evaluation

## 1. Event rubric

Each criterion is scored from 0 to 4.

The rubric names, fixed questions, criterion guidance and weights, coverage requirements, final-comment requirement, and round weights must be configurable in ops. The following tables are the event defaults. Each review and submitted result pins the published policy version so a later configuration edit cannot silently change earlier judging.

Round 1 contributes 30% of the combined result.

| Criterion                 |  Weight | Fixed review question                                                                    |
| ------------------------- | ------: | ---------------------------------------------------------------------------------------- |
| Research & Scope          |      30 | What research validates the problem, and who and what are in scope?                      |
| User Readiness            |      20 | Can the intended user follow the current experience, and what is ready to use?           |
| Idea Novelty & Uniqueness |      15 | How does the idea differ from existing approaches, and why is that difference useful?    |
| Technical Execution       |      25 | What is the architecture, why was it chosen, and how does the implementation support it? |
| Presentation              |      10 | Can the team clearly pitch its deliverables and explain each member's contribution?      |
| **Total**                 | **100** |                                                                                          |

Round 2 contributes 70% of the combined result.

| Criterion                       |  Weight | Fixed review question                                                                          |
| ------------------------------- | ------: | ---------------------------------------------------------------------------------------------- |
| Technical Completion            |      30 | How completely did the team implement the architecture and technical commitments from Round 1? |
| Demo                            |      15 | Can the team demonstrate the main flow and clearly communicate how it works?                   |
| Reproducibility & Deployment    |      20 | Can the submitted project be run from its instructions and used in its deployed form?          |
| Design & UX                     |      25 | What design decisions support the user journey, and how does the team justify them?            |
| Growth, Progress & Future Scope |      10 | What improved since Round 1, what remains weak, and what are the next realistic improvements?  |
| **Total**                       | **100** |                                                                                                |

Operations provides both rubric presets and a separately published round-weight policy. The combined result uses only closed-round canonical outcomes and keeps missing or excluded rounds explicit; see [Event review readiness](15-event-review-readiness.md).

## 2. Shared score anchors

| Score | Meaning                                           |
| ----: | ------------------------------------------------- |
|     0 | Not shown                                         |
|     1 | Weak or mostly claimed                            |
|     2 | Basic or partially shown                          |
|     3 | Strong or clearly shown                           |
|     4 | Excellent; the reviewer can confidently verify it |

Each rubric criterion also has examples for 0, 2, and 4. Reviewer training uses the same examples as the app.

## 3. Criterion guidance

### Round 1

- **Research & Scope:** 0 means no research or defined scope, only unsupported generic claims. 4 means researched validation examples, a complete understanding of the problem, and a defined scope and target audience.
- **User Readiness:** 0 means no usable flow or deliverables. 4 means a coherent, ready flow with UX appropriate to its intended user.
- **Idea Novelty & Uniqueness:** 0 means a common idea with no demonstrated distinction. 4 means a clearly differentiated idea with a strong use case. This is a human rubric judgment; the intake novelty number never becomes a judging input.
- **Technical Execution:** prioritize architecture, then explanation of the architecture, implementation justification, and finally necessary complexity. 0 means an unsupported simple implementation proposal with no architecture or justification. 4 means all these elements are demonstrated. Complexity alone does not earn points.
- **Presentation:** prioritize concrete deliverables and the pitch, supported by clear roles and contribution. 0 means no coherent presentation, deliverables, or demonstrated teamwork. 4 means a clear pitch, demonstrated deliverables, and a credible role distribution.

### Round 2

- **Technical Completion:** follow up on the architecture and implementation promised in Round 1. Inspect what actually works and the remaining gaps.
- **Demo:** assess the live walkthrough, presentation, and communication of the idea. A promise is not a working demonstration.
- **Reproducibility & Deployment:** inspect setup instructions, dependencies, configuration, reproducible execution, and deployment appropriate to the project.
- **Design & UX:** require a clear explanation of design decisions, task flow, usability, error handling, and accessibility. The interface may be a GUI, CLI, API, hardware control, or another form suited to the project.
- **Growth, Progress & Future Scope:** compare the pinned Round 1 and Round 2 evidence and commitments. Assess demonstrated improvement and realistic next steps.

Scores 1–3 use the published criterion anchors and the evidence shown. Dynamic agent questions never change those anchors. Tool use, provider activity counts, and presentation polish do not establish quality or contribution on their own.

## 4. Independent scoring

- Reviewers score alone on their own devices.
- A reviewer receives only criteria assigned before the session starts.
- Peer score values remain hidden until the event policy permits reveal.
- Discussion may clarify evidence, but the panel does not negotiate one shared score.
- The panel coordinator cannot edit another reviewer's scorecard.
- Reviewer designation and seniority do not change weight.
- A reviewer with a conflict cannot submit.

The panel defaults to five reviewers. Criterion coverage and the final-comment requirement are explicitly published with the round. By default, each required reviewer must submit a scorecard with a final comment, even when they score only part of the rubric.

The minimum scorer count is explicitly selected and stored with the round configuration.

## 5. Criterion assignment

Before routing opens, the panel plan creates a coverage matrix for that round's configured criteria and reviewers. The planner uses reviewer expertise and ensures the published minimum for every criterion. Seniority determines panel composition, not score weight.

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
- automatic score normalization across panels;
- hidden panel-specific offsets;
- replacement of independent scores with a consensus score;
- AI-written or AI-recommended ratings.

If a criterion lacks its minimum scorer count, the review is incomplete and no total is published.

Once both round results are complete, the combined result is `0.30 × Round 1 total + 0.70 × Round 2 total`, out of 100. A missing or unresolved round is incomplete, never an automatic zero and never a reason to silently renormalize the other round. Tie-break and award eligibility rules remain separate decisions.

## 7. Score spread

A spread check flags a criterion when the highest and lowest ratings differ by at least two points. The threshold is configurable with the rubric.

A flag does not change the numbers. A caller with the relevant review/round-scoped permission can:

- confirm that reviewers used the same rubric version;
- ask for a short clarification of evidence;
- identify a wrong criterion assignment or data-entry mistake;
- open a correction before round lock.

No role or permission may ask a judge to move toward the panel average. Any correction keeps the original scorecard and the judge’s reason.

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

Progress is required evidence and has a dedicated 10-point Round 2 criterion. It also informs the follow-up on Technical Completion without creating additional bonus points.

Provider statistics do not calculate or suggest a score. Commit, line, file, node, version, and comment counts can help a reviewer locate change, but they cannot establish quality, effort, originality, or individual contribution. GitHub authors and Figma version/comment handles are observations from provider records, not a member-attribution system.

Rendered Figma frames are derived views of the exact provider version stored in the review checkpoint. A render set may move from pending to ready/partial after review assignment, but it cannot change the pinned source version or substitute the current file. Missing or failed renders are evidence-availability facts, never a score penalty or score suggestion.

The explicit progress comparison joins the current review checkpoint to the latest earlier judging checkpoint for the same team. It does not compare against an intervening webhook or participant refresh. Stored named versions, comments, and side-by-side renders help a reviewer find what to inspect. The system labels an incomplete bounded capture as uncertain. None of these observations becomes a score, effort estimate, or member-attribution claim.

Attendance confirmations, present duration, temporary exits, missed scans, and excused absence are operations/safety records. They are not project progress evidence and never enter a criterion, reviewer context, score, tie-break, or award recommendation.

The evidence context is immutable after the review starts. The app can show a later push, Figma refresh, or repository-set change as newer available evidence. Scoring remains tied to the recorded checkpoint-set ID. Only `review.evidence_context.replace` for that review can replace it, and the command must record a reason.

The system does not create progress bonuses outside the published weights.

## 9. AI boundary

Review preparation continuously reads the team's submitted idea, answers and progress updates, including every connected GitHub repository and Figma file. It may suggest team-specific verbal questions with exact source references. Those questions appear separately from the fixed rubric, are optional reviewer references, and are never graded or used to recommend scores. Missing or inaccessible material remains explicit. Review-start snapshots bind the questions to the evidence actually used for that review; ongoing ingestion can continue without rewriting it. Operations enables and configures question preparation. Every eligible repository text file and every node in the stored Figma structure is processed in resumable batches with explicit coverage. Ops can enable visual analysis of captured Figma renders. Each supplied PNG is checked against its stored checksum and cited by its exact captured frame; missing renders and capture limits remain visible. A static render does not prove working interactions or runtime readiness. See the [Event follow-up plan](16-event-follow-up-plan.md) for verification status. Teams will not be asked for project documents, PDFs or slide decks, and their ingestion is outside scope. The model cannot change scores or event state.

The intake interpretation layer may identify covered purposes in team-written answers and generate one bounded follow-up question.

It must:

- cite the exact active answer versions used for a question;
- leave the freshness attestation and every submitted answer to the participant;
- avoid novelty verdicts and invented validation, users, progress, disclosures, or evidence;
- avoid admission recommendations, rank, score, or winner language;
- never replace reviewer access to original answers.

A separate pre-event admission-analysis contract may read the redacted submitted application, deterministic year/study band, and published admission rubric and return a structured `accept | waitlist | decline` recommendation. Missing evidence remains visible in concerns, limitations, and confidence instead of creating another participant workflow. It receives no human admission recommendation, private reviewer note, judging rubric, peer score, scorecard, evaluation result, ranking, attendance history, or provider-activity count. Its result is visibly advisory, has no numeric score, and cannot call an admission or project mutation. A human with the exact permission publishes the application decision and records whether the AI record was used, cleared, or overridden.

No model can generate, change, normalize, predict, or recommend a hackathon judging score, award, rank, or winner. Admission-analysis output is never supplied to venue judges or judging functions. Reviewer/panel routing and criterion coverage use fixed rules.

## 10. Round close

`score.values.read` at the relevant round/review scope exposes:

- teams expected and completed;
- required scorecards present and missing;
- criterion coverage;
- score-spread flags;
- conflicts;
- open corrections;
- manual incident records;
- totals computed from the published rubric version.

The server blocks round close until each team has one explicit outcome. The outcome must be one valid completed result, one approved exclusion, or `withdrawn`. The server also requires resolution of every live review, pending paper record, and correction.

`round.close` for the exact round does not close it directly. One authorized mutation checks the expected round version, freezes a normalized close snapshot, moves the round from `open` to `closing`, and schedules the export. Each snapshot entry names the team and its selected result/evaluation, approved exclusion, or withdrawal. Canceled and superseded review attempts remain in the database and backup, but do not become a team’s adjudicated round outcome.

The bounded export worker reproduces every selected result from the immutable submitted scorecard versions, fixed rubric checksum, fixed aggregation formula, criterion weights, and spread threshold. A mismatch fails the export. It writes one detailed JSON audit/recovery file and one formula-injection-safe CSV analysis file to the private, KMS-encrypted, versioned Mumbai S3 bucket. The manifest records the exact S3 object version, byte count, and SHA-256 for both files, and the worker reads those exact versions back before marking the export `uploaded`. Failure leaves the round visibly `closing`; `round.export.retry` for that exact round retries the same frozen snapshot.

A different person must hold both `round.export.read` and `round.export.verify` for that exact round, use a current scoped authorization, download/open both files, compare the displayed counts, and give a reason. Verification reads the exact S3 object versions again and checks both hashes before one version-checked mutation changes the export to `verified` and the round to `closed`. There is no other ordinary path to `closed`.

`round.reopen` is independent authority for that exact round. A reopen must occur before a later round moves beyond draft. The caller must have current authorization and give a reason. The reopen marks the verified export `superseded` without deleting its files or audit history. It clears the active close pointers and returns the round to `open`. A later close produces a new revision. A round with downstream activity needs an incident-specific remedy instead of this ordinary command. The caller’s role is irrelevant throughout.

## 11. Paper review recovery

Paper recovery is limited to a review that the backend had already started. An outage does not authorize staff to invent a new review, panel, assignment, score, or evidence snapshot.

Operations opens a `review_backend` incident. Two different authorized holders of `incident.manual_mode.approve` must approve that exact incident. The first recovery operator needs `review.manual_record.read` and `review.manual_record.enter` for the exact review. They copy the numbered sheet’s start/end time, outage reason, every assigned reviewer’s signature and raw ratings, evidence notes, private note when present, shared findings, and commitments. The record pins the round, review, panel, rubric, evidence-checkpoint set, assignments, and current scorecard versions.

The numbered original comes from a current restricted emergency pack prepared and printed under separate event-scoped permissions. It is prefilled for the current non-closed panel with its table, reviewers, rubric, and criteria; a spare remains available when the plan changed after the snapshot. Preparing or printing the pack does not open an incident, approve paper mode, create a review, or grant either manual-record command.

Saving the draft blocks ordinary draft and submit commands for those scorecards. The operator attaches one browser-compressed private JPEG under 900 KB. A different person needs both `review.manual_record.verify` and `review.manual_record.source.read` for the exact review. That person also needs a reason and a current scoped authorization. The person must attest that the numbered original is filed in the event audit packet.

Verification rechecks the source manifest and every pinned version. Import then creates one immutable scorecard version for each named reviewer, tagged with the manual-review record, computes the ordinary evaluation, and completes the existing review and team-round state in one Convex transaction. The verifier does not become the reviewer, and the backend does not fill a blank score. A changed assignment, scorecard, panel, rubric, evidence set, review, or round rejects the import. The verifier may reject the record so a corrected serial revision can be entered.

A draft or submitted paper review blocks ordinary review completion, incident resolution, and round close. Imported paper scorecard versions appear as paper imports in score-value views and remain eligible for the normal append-only correction process.

## 12. Finalist and award decisions

The system can prepare a ranked view after Board approves:

- minimum eligibility;
- tie-break order;
- finalist and award publication rules.

The cumulative score uses Round 1 at 30% and Round 2 at 70% as specified above.

The ranking view always shows the underlying criterion totals and any missing/exception state. A board decision that departs from the configured ranking requires a recorded reason.

## 13. Corrections and complaints

### Correction

A judge may request a correction to their own submitted scorecard only while the round is open and server time is at or before the round's immutable `correctionRequestsCloseAt`. A caller with `scorecard.correction.open` for that scorecard/review may open a requested case under the same inclusive boundary. A requested case may still be rejected after the deadline while the round remains open, so an expired request cannot wedge round close. Once opened on time, the judge may finish and resubmit after the request deadline while the round remains open. Every replacement preserves the original scorecard and recorded reasons.

### Administrative void

`scorecard.void` for the exact scorecard/review may void it for duplicate session, confirmed conflict, wrong team, or judge ineligibility. The action requires evidence and may trigger a replacement review.

### Process complaint

A participant may report a process problem such as a missing panel member, incorrect assignment, or unavailable review. Complaints do not directly edit scores. The board chooses a remedy under the approved complaint policy.

Operations publishes the correction-request deadline with the round. The complaint window and complaint remedies remain board decisions.

## 14. Exports

Each round export contains:

- event, closing-round, close-snapshot, fixed rubric, criterion, aggregation-formula, spread-threshold, panel, and panel-member versions;
- every team's adjudicated disposition, application context, and submitted proposal version;
- the selected review session and frozen integration-evidence checkpoint for each result or approved exclusion;
- assignments, reviewer identities, every scorecard record, every immutable scorecard version, and the exact versions used by the selected result;
- saved and independently recomputed criterion inputs, means, weighted points, spread flags, total, and checksums;
- correction/void cases and paper-review records for the selected review, including links to imported scorecard versions;
- explicit rows for excluded and withdrawn teams;
- deterministic generation time, counts, file sizes, exact S3 object-version IDs, and SHA-256 checksums.

JSON preserves the relationship and version history needed to audit or reproduce the adjudicated result. CSV contains one row per active result rating plus explicit excluded/withdrawn markers for practical analysis. Neither file is a database backup: unrelated canceled review attempts, attendance/presence, provider credentials, and other event domains remain in Convex backups. Both downloads are protected and audited.

## 15. Acceptance checks

- A reviewer cannot score an unassigned criterion.
- Peer values remain hidden during independent scoring.
- Two reviewers’ ratings for the same criterion both remain in the record.
- Missing coverage blocks the total and round close.
- The formula reproduces totals from raw scores and the saved rubric version.
- A spread flag never changes a score.
- A correction keeps the original and corrected versions.
- A paper record cannot import unless it covers the complete current panel, every reviewer signature and assigned criterion is present, the source manifest matches, and a different authorized person verifies it.
- A paper import creates ordinary immutable scorecard versions attributed to the signed reviewers, marks the review as a paper import, computes one result, and cannot race a digital draft, submit, review completion, incident resolution, or round close.
- No AI function can call a score-write function.
- An admission recommendation cannot appear in reviewer judging context, route a panel, set a score, or publish an admission decision.
- Generated question text remains context. Only the participant's answer is participant evidence.
- Review 2 context contains the exact Review 1 commitments and checkpoint references.
- Provider activity counts cannot write, prefill, weight, or recommend a criterion score.
- Attendance state, duration, exit count, or exception cannot write, prefill, weight, or recommend a criterion score.
- A submitted scorecard can be traced to the exact repository snapshots and Figma snapshot inside the checkpoint set shown during that review.
- Starting close cannot jump directly from `open` to `closed`; it freezes one outcome per team and immediately blocks score, correction, paper-import, and review-completion writes through the round state.
- Export generation fails if a selected total, input checksum, criterion input-version list, rubric formula, rating bound, or displayed count cannot be reproduced from the frozen records.
- Only a different person with independently granted read and verify authority can close the round, after both exact S3 object versions pass byte-count and SHA-256 verification.
- Reopen preserves and supersedes the verified export, cannot run after downstream round activity, and forces a later close to create a higher revision.
