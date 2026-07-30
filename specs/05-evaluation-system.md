# Evaluation system

## 1. Rubric

Each criterion is scored from 0 to 4:

| Score | Anchor |
| ---: | --- |
| 0 | Not shown |
| 1 | Weak or mostly claimed |
| 2 | Basic or partially shown |
| 3 | Strong and clearly shown |
| 4 | Excellent; reviewer can confidently verify |

Working rubric from the June discussion:

| Criterion | Weight | Core question |
| --- | ---: | --- |
| Problem & User Fit | 15 | Is the team solving a clear problem for a clear user? |
| Working Solution | 20 | Does the project perform its core task end to end? |
| Original Team Contribution | 15 | What did the team build beyond templates, APIs, starter kits, or prebuilt tools? |
| Technical Execution | 15 | Are the technical choices appropriate and well executed? |
| User Readiness | 10 | Can the intended user understand and complete the main task? |
| Trust & Responsible Use | 15 | Did the team handle data, safety, security, AI/tool disclosure, and misuse risks responsibly? |
| Communication & Evidence | 10 | Did the team clearly explain and verify what they built? |

Weights total 100. The event may revise names, definitions, or weights before configuration lock.

## 2. Criterion guidance

### Problem & User Fit

Evidence may include a specific user, observed pain, current workaround, constraints, and reason the proposed approach fits. A fashionable topic without a clear user scores poorly.

### Working Solution

Review the core flow live. Distinguish a real end-to-end path from mock screens, disconnected components, or a narrated claim. Reliability under one demonstrated happy path is necessary but not automatically excellent.

### Original Team Contribution

Require disclosure of templates, APIs, pretrained models, generated code, starter repositories, and prior work. Score the decisions and components created during the hackathon, not the prestige of external tools.

### Technical Execution

Consider architecture, correctness, integration, engineering judgment, testing, and handling of failure. Complexity for its own sake is not rewarded.

### User Readiness

Evaluate whether the intended user can understand and complete the main task, including usability, accessibility, feedback, and recovery from error.

### Trust & Responsible Use

Apply proportionately to project risk. Consider data minimisation, consent, secrets, access control, unsafe outputs, bias, misuse, transparency, and appropriate limitations.

### Communication & Evidence

Reward a clear explanation tied to verifiable evidence. Presentation polish must not compensate for a non-working product.

## 3. Criterion ownership

- Every reviewer has explicit criterion grants based on expertise/training.
- Every required criterion must have a configured minimum number of independent scorers.
- A reviewer may raise evidence relevant to any criterion but scores only granted criteria.
- Seniority does not multiply a score.
- Panel composition must avoid a criterion being effectively decided by one organisational faction where feasible.
- If coverage is lost mid-review, the review remains incomplete until substitution or an authorised exception.

## 4. Independent scoring

Reviewers submit without seeing peer scores. Discussion may happen after independent capture, but it cannot overwrite the original record. If a reviewer changes a score after discussion, the system stores both versions and the reason.

The system does not ask the panel to agree on a single number.

## 5. Aggregation

The exact aggregation method is **open** and must be validated with simulations before launch. It must satisfy:

- no hidden seniority multiplier;
- transparent handling of missing scores;
- comparable treatment across panels;
- no silent imputation;
- criterion weights applied only after valid criterion aggregation;
- reproducible output from immutable inputs;
- anomaly flags do not automatically change scores.

Candidate methods should be tested against mock datasets for panel harshness, missing data, outliers, and uneven scorer counts. The chosen formula, rounding, tie policy, and minimum coverage are frozen before reviewer training.

## 6. Improvement across reviews

Review 1 captures specific, demonstrable commitments for Review 2. Review 2 records each as:

- completed and demonstrated;
- partially completed;
- changed with justified reason;
- not completed;
- not assessable.

Progress is evidence for the rubric and finalist discussion. Whether it becomes a separate weighted criterion is open; it must not be double-counted without a deliberate policy.

## 7. Cross-panel consistency

Before the event:

- reviewers complete calibration examples;
- criterion definitions include positive and negative anchors;
- sample projects are scored and variance discussed;
- reviewers must pass a minimal rubric understanding check.

During the event, the dashboard flags:

- unusually harsh or generous panel distributions;
- missing criterion coverage;
- excessive straight-line scoring;
- unusually fast reviews;
- frequent corrections;
- conflict or override concentration.

Flags trigger human review. Scores are never automatically normalised or altered.

## 8. Round and finalist decisions

A round cannot close until every team has one explicit disposition:

- complete and advancing;
- complete and not advancing;
- incomplete with approved resolution;
- withdrawn;
- disqualified with restricted reason.

Finalist selection uses validated review records and documented deliberation. Tracks do not guarantee a finalist or prize. The current direction favours overall and themed prizes over mandatory track winners.

Potential themed recognitions discussed include best design/UX and best all-women team; award policy remains outside the scoring formula until confirmed.

## 9. Appeals and corrections

Participants may report a process problem (missing reviewer, wrong team, interrupted demo, conflict), not negotiate scores in real time. Operations records the claim, evidence, and resolution.

If a process failure is confirmed, board administrators choose a published remedy such as a replacement review. Direct score editing is not the default remedy.

## 10. Exports

Validated exports include:

- criterion-level raw score versions
- active score version and aggregation output
- reviewer eligibility and criterion grants
- panel/team assignments
- review duration and extensions
- evidence and commitments
- missing-data and anomaly flags
- overrides/corrections
- advancement and award decisions

Exports must be reproducible and carry configuration version, generation time, and checksum.

## 11. Acceptance criteria

- Weights total 100 and every score is within the configured scale.
- No active score lacks reviewer, criterion, team, round, and review-session attribution.
- No result is generated with silently missing required criterion coverage.
- A reviewer cannot view peer scores before initial submission.
- A changed score preserves its earlier version and reason.
- Round closure accounts for every eligible team.
- An automatic anomaly flag never changes a human score.

