# Participant onboarding and portal

## 1. Experience goal

Registration must feel like a guided project conversation, not a dense form. It asks one meaningful question at a time, explains why it matters, saves continuously, and produces a structured project profile suitable for shortlisting and later review.

No PPT is required.

## 2. Onboarding flow

### Step 1: Identity

The first screen asks:

- **VIT student**
- **External participant**

No email field or password field is shown. Selecting a class creates a one-time authentication intent, after which the primary action is **Authenticate with Google**.

#### VIT student

1. The user chooses **VIT student**.
2. The UI explains that the VIT Google Workspace account is required.
3. Google authentication opens with the hosted-domain hint `vitstudent.ac.in`; the hint improves account selection but is not security.
4. The server verifies the Google ID token and requires `email_verified = true` and `hd = vitstudent.ac.in` (or another explicitly configured VIT student domain).
5. The application links Google `sub` to one internal user and marks the event participant class `vit_student`.
6. The user confirms display name, registration number, campus, programme, expected graduation year, phone/contact preference, terms, and required consent.

The registration number remains a separately validated profile field. It is not parsed from the email and is not used as the login identifier.

#### External participant

1. The user chooses **External participant**.
2. The user authenticates with any verified Google account.
3. The application records class `external`.
4. The user provides institution/organisation, course or role, city/country, expected graduation year where applicable, phone/contact preference, terms, and required consent.

#### Mismatch and recovery

- Non-VIT Google identity on the VIT path: block provisioning, explain the mismatch, and offer **Start again as External**.
- VIT identity on the External path: respect the selected class for that event and offer a clearly explained reclassification request.
- Abandoned or replayed auth intent: expire it and restart at the selector.
- Existing account on another device: resolve the same internal user and restore onboarding progress.
- Invited reviewer/staff account: authenticate successfully, then resolve roster grants separately from participant registration.

Progress can resume across devices after provisioning because drafts are stored against the internal user and current project version.

### Step 2: Team

The participant creates a team or joins by a single-use invitation. The lead sees invited, verified, accepted, declined, and expired states.

Rules:

- A person can belong to only one active team.
- Team-size limits are configurable; the June discussion did not conclusively settle 2–5 versus 3–5.
- The lead cannot submit while membership violates the configured limit.
- Removing a member after submission creates a revision and may require organiser approval.

### Step 3: Project narrative

Ask one prompt at a time:

1. What is your project about? Provide a plain-language one-sentence description.
2. Who specifically experiences the problem?
3. What problem are you solving, and what evidence suggests it is real?
4. What does the user do today?
5. What will your team build during Code2Create?
6. What is the single end-to-end action your demo must complete?
7. What will be your team's original contribution?
8. Which tools, APIs, templates, models, datasets, and starter code do you expect to use?
9. What could go wrong for a user? Address privacy, security, safety, bias, and misuse where relevant.
10. How will you test that the project works?
11. Select the best-fit track and explain the fit in one short answer.
12. What will you deliver by Review 1 and Review 2?

Questions may branch based on prior answers, but all teams must produce the same canonical fields. AI may help participants understand a prompt or improve clarity, but it must not invent claims or silently replace their answer.

### Step 4: Review

Show the project as a readable brief, not a field dump. Flag contradictions, missing evidence, overly vague answers, prohibited content, and incomplete disclosures. The team explicitly confirms accuracy before submission.

### Step 5: Submission

Submission freezes a version and issues a receipt. The team can continue to update allowed live fields such as repository and demo links. Material narrative changes create a new version and remain visible to reviewers.

## 3. Shortlisting workspace

Authorised organisers see:

- project brief and track
- team eligibility
- answer completeness
- similarity/duplication signals, if later approved
- feasibility and safety flags
- reviewer comments
- shortlist status and reason

Automation can group or summarise applications, but cannot autonomously accept or reject a team. There are no fixed problem statements in the current direction; tracks should be approachable but deep enough to discourage repetitive low-effort concepts.

## 4. Check-in

At the venue:

1. A team member presents the team identifier.
2. Staff verifies required members and eligibility.
3. The system marks individual and team arrival.
4. The team is assigned or confirms a venue table.
5. The participant portal displays the canonical table and team QR.
6. Conflicts are routed to an exception desk.

The QR contains a short-lived, signed reference. It must not expose personal data or serve as a permanent bearer credential.

## 5. Table association

- A table has a visible human-readable code.
- Table-to-team association is confirmed 30–60 minutes before a review round.
- Operations begins verification approximately 90 minutes before the round.
- A team confirms its current table from the portal or through staff-assisted scan.
- A table cannot have overlapping active assignments.
- Moving a team ends the prior assignment and creates a new audited assignment.
- Unconfirmed and conflicting tables appear as operations exceptions.

## 6. Readiness and queue

Before each review:

- The team confirms required members are present.
- Required project links and round deliverables are updated.
- The team verifies its table.
- The lead selects **Ready for review**.

The portal then displays:

- current state
- teams ahead or queue number
- estimated window as a range, not a false exact promise
- assigned panel only when policy permits
- required preparation
- pause or help state

A team can withdraw readiness before being called. After being called, it must request assistance rather than silently leaving the queue.

## 7. Participant-facing review states

`Not eligible → Not ready → Ready → Queued → Called → Panel arriving → In review → Submitted → Complete`

Exceptional substates:

- Table unconfirmed
- Panel incomplete
- Participant unavailable
- Technical hold
- Operations hold
- Review disputed

Every exceptional state has a human-readable explanation and next action.

Every state is returned by a reactive portal query. The client does not infer queue position, panel readiness, or review completion from local events.

## 8. Project updates across rounds

At Review 1, the team confirms planned Review 2 deliverables. Before Review 2, it reports:

- completed commitments
- changed commitments and reason
- repository/demo evidence
- blockers
- new tool or data disclosures

The system calculates a descriptive progress summary but does not invent a score. Reviewers verify whether claimed progress is demonstrated.

## 9. Acceptance criteria

- The first participant decision is exactly VIT student or External participant, followed by Google authentication.
- A VIT-student account cannot be provisioned from an email suffix alone; the configured Google hosted-domain claim is required.
- A non-VIT Google user can complete the external flow without manual account creation.
- A participant class never grants staff/reviewer/admin access.
- Replaying or changing an authentication intent cannot change the provisioned class.
- A participant can stop after any prompt and resume without losing an answer.
- A submitted project always maps to one immutable version.
- A team cannot submit with duplicate membership or invalid size.
- A participant sees only their own private team data.
- Table reassignment never leaves two active canonical tables.
- A team can identify its current queue state without messaging an organiser.
- Every material project change between reviews is attributable and reviewable.
- No workflow asks for a PPT.
- An accepted queue or review mutation appears in the participant portal without manual refresh while connected.
