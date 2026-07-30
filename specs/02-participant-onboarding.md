# Participant portal

## 1. Entry

The portal opens with:

- VIT Student
- External Participant

The next action is **Authenticate with Google**. Identity and classification follow the rules in Identity and access.

A returning participant goes to the first unfinished task instead of repeating onboarding.

## 2. Participant profile

The portal collects only event fields that Google does not provide.

### All participants

- preferred name;
- phone number for event operations;
- institution or organisation;
- graduation year or current role;
- dietary/accessibility needs if event operations supports them;
- required policies and consent versions.

### VIT students

- registration number;
- school/programme;
- campus, if more than one campus is eligible.

### External participants

- institution or organisation name;
- city and country;
- student/professional classification;
- eligibility evidence if event policy requires it.

The final eligibility fields remain blocked until the event board approves the participant policy.

## 3. Team formation

A participant can create one team or join one team for the event.

### Create

The creator becomes team lead and receives:

- a short join code;
- an expiring invite link;
- a member list with claim status.

### Join

The server checks:

- participant is eligible for the event;
- participant is not already in another active team;
- team is not submitted, locked, full, or disqualified;
- invitation is valid;
- mixed VIT/External teams comply with event policy.

### Team changes

- A team lead can remove an unconfirmed member.
- A confirmed member can leave before the team-lock time.
- Lead transfer requires acceptance by the new lead.
- Merge, split, or post-lock removal is an operations action with a reason.
- Join codes can be rotated if exposed.

Team-size bounds and mixed-team eligibility are open policy decisions. The backend reads them from event configuration.

## 4. Guided project profile

The project profile is a question-by-question flow. It does not ask for a PPT.

The required prompts are:

1. What problem are you solving?
2. Who has this problem?
3. What evidence tells you the problem is real?
4. What are you building during Code2Create?
5. What already existed before the event?
6. What will your team build yourselves?
7. What tools, datasets, APIs, templates, models, or previous code will you use?
8. What is working now?
9. What will you demonstrate at the next review?
10. What risks involve privacy, safety, security, misuse, or accessibility?
11. Which track best fits the project?

Each answer has a clear length limit and autosaves after the user leaves the field. The portal shows **Saving**, **Saved**, or **Could not save** next to the active answer.

The product may later help shorten a team-written answer, but it cannot invent evidence, novelty, progress, or disclosures.

## 5. Project versions

The team lead can edit a draft until submission.

Submitting creates a project version containing:

- answers and disclosures;
- track selection;
- repository and Figma links;
- demo URL, if present;
- version number;
- submitting member;
- server time;
- policy and form-schema versions.

The team continues updating explicitly live fields such as demo status and checkpoint links. Editing a submitted narrative creates a new version; it never overwrites the earlier reviewer context.

At each review boundary, the backend records which project version and integration snapshots the panel received.

## 6. Application and admission

The first submitted project version becomes the team’s pre-event application.

Application states are:

`draft → submitted → under_review → selected | waitlisted | rejected`

Selected applications continue:

`selected → offer_sent → confirmed | offer_expired | withdrawn`

### Application review

- An admissions administrator assigns each application to the configured number of application reviewers.
- Reviewers inspect project answers, team composition allowed by policy, disclosures, and track choice.
- Each reviewer submits an independent recommendation: `select`, `waitlist`, `reject`, or `needs_information`, with reason codes and a short note.
- Reviewers cannot see peer recommendations until their own is submitted.
- Admissions uses a separate, approved admission policy. The venue judging rubric and scores do not apply.
- A language model cannot accept or reject an application.

An application returned for information opens only the named questions and records a new project version.

### Capacity and offers

The admissions page shows team and participant counts against venue capacity. An admissions administrator publishes selected, waitlisted, and rejected decisions after checking reviewer coverage and eligibility.

A selected team receives an offer with a confirmation deadline. Sending the offer reserves places for the team’s current active members; confirmation locks those members for event check-in. Membership changes after an offer require a capacity recheck. Expired or declined offers release places to the waitlist under the approved promotion rule.

Only a confirmed team can proceed to event check-in. A rejected or expired team can still sign in and view its decision/status, but receives no venue QR or event queue access.

Selection criteria, reviewer count, capacity/track quotas, decision visibility, and offer deadlines require event-board approval.

## 7. GitHub and Figma

The project page contains separate connection cards.

### GitHub

The team lead installs the Code2Create GitHub App on one selected repository and chooses the branch the team will present. The portal shows installation state, repository, tracked branch, latest recorded commit time, and checkpoint status.

The app has read-only repository access. It does not request administration, issues, actions, secrets, or write access.

### Figma

A team member authenticates with Figma, pastes or selects a file they can access, and confirms that it belongs to the team. The portal shows file name, last touched time, latest recorded version, and checkpoint status.

The baseline integration reads file metadata and version history. It does not read the full design document.

### Disclosure

Teams must disclose work that predates the event even if the repository or design file is new. Integration activity is evidence, not proof of originality and not a score.

If the project does not use GitHub or Figma, the team explicitly marks that provider as not used and describes the alternative evidence it will present. A connection made after the event baseline deadline is labelled late.

## 8. Registration and project states

### Participant

`profile_required → eligible → suspended`

### Team

`forming → profile_in_progress → submitted → admitted → confirmed → checked_in → active → completed`

Exceptional terminal states are `withdrawn` and `disqualified`.

### Project version

`draft → submitted → superseded`

A state change happens on the server after it rechecks current policy and membership.

## 9. Venue check-in

An event desk checks in each participant against the registered account and event badge process.

A team becomes venue-ready after:

- the required number of members are checked in;
- the admission offer is confirmed;
- a table has been assigned;
- the submitted project passes required-field checks;
- required disclosures are complete;
- any mandatory integration or alternative evidence is present.

Operations sets the official table. The team lead can confirm or report it as wrong. Table capture starts roughly 90 minutes before a review window and is frozen 30–60 minutes before routing, subject to the final schedule.

## 10. Team QR

The team home screen displays a server-issued QR for the current round.

The payload contains an opaque token, not participant details. It is bound to:

- event;
- team;
- round;
- expiry;
- token version.

The QR rotates after expiry or manual revocation. A six-character fallback code appears below it for camera failure. Reviewers still need an online server check before presence counts.

## 11. Ready and queue experience

Only the team lead can mark the team ready.

The server accepts ready when:

- team and project state allow it;
- a frozen table assignment exists;
- the team has no unresolved eligibility or conflict hold;
- the round accepts new ready teams.

The participant home screen then shows one of:

| State | Participant message |
| --- | --- |
| Not ready | Finish the listed blockers |
| Ready | Waiting for panel assignment |
| Queued | Current queue position, position being called, panel/table, and teams ahead |
| Called | Go to the shown table now |
| At table | Waiting for reviewers to complete presence |
| In review | Review in progress and elapsed time |
| Held | Plain reason and where to get help |
| Missed | Next action under the approved missed-call policy |
| Complete | Review recorded; next checkpoint shown |

The queue displays a coarse window calculated from active reviews and teams ahead. It does not display an exact appointment time that floor delays will break.

## 12. Between reviews

After Review 1, the team sees:

- commitments agreed at the review;
- project answers or disclosures that must be updated;
- the next checkpoint;
- released feedback;
- GitHub/Figma connection health.

The team records what changed since the previous checkpoint. Review 2 receives that update and the integration snapshots captured at both review boundaries.

Raw scores stay hidden until the event’s feedback policy releases them.

## 13. Support and recovery

- Every blocked screen shows the failing condition and a support code.
- A participant can report a wrong table, team-membership issue, integration disconnect, or queue problem.
- Support staff see the same server state and can take only actions granted to their role.
- Refreshing, changing devices, or reinstalling a browser does not duplicate team membership or submissions.
- If the venue network fails, participants keep their QR visible from a short-lived local cache, but review presence still waits for server validation or an authorised manual incident process.

## 14. Acceptance checks

- Both account-class paths reach Google sign-in and the server derives the final class.
- A participant cannot belong to two active teams.
- Two users cannot claim the same rostered/team identity through a duplicated invite.
- The guided profile resumes at the first unfinished question after refresh.
- Submitting twice with the same operation ID creates one project version.
- Application reviewers cannot see peer recommendations before submitting.
- A selected team cannot check in until its offer is confirmed.
- Expiring an offer releases capacity without deleting the application decision.
- GitHub/Figma disconnects are visible without deleting captured checkpoints.
- A ready team appears in operations and participant queue views from the same accepted write.
- The participant never receives another team’s private project, queue, or review data.
