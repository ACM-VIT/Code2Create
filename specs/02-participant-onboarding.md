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

## 4. Guided project intake

This experience is the replacement for a project-application form and a forced PowerPoint presentation. It is sequential, quiet, and adaptive. It is not a chatbot and does not show a long questionnaire.

### Opening

The exact first frame is:

> Hello.

The next frame asks:

> What is your project about?

It contains one multiline text box and one primary continue action. The screen has no chat bubbles, assistant avatar, sample pitch, dashboard, or visible form sections. A small back action, save state, and accessible progress label are the only secondary controls.

The team writes naturally. The server saves that text verbatim before any model work starts.

Before intake begins, the accepted participant policy explains that project-answer text may be sent to OpenAI for interpretation, states the effective retention controls, and asks teams not to enter contact, identity, credential, or other unnecessary personal data. If that policy is not approved, the event runs the same intake in deterministic-only mode.

### Three separate kinds of phase

The system does not overload one `phase` field:

| Concept | Working values | Meaning |
| --- | --- | --- |
| Project maturity | `idea`, `ideation`, `prototype`, `intermediate_build`, `working_build` | Where the project is now |
| Intake stage | `opening`, `idea`, `problem`, `approach`, `track`, `build`, `evidence`, `responsibility`, `review` | Which kind of prompt the participant is answering |
| Event checkpoint | application, pre-event update, a configured round update, or final update | Why the intake is running now |

Project origin is a separate confirmation: `new_for_event` or `continuing_existing_project`. A continuing project can be at any maturity. Maturity and origin help select relevant questions; they are not scores or admission decisions.

The labels, descriptions, allowed transitions, and checkpoint bindings are published configuration. The values above are the production starting set, not client-side constants.

### Adaptive sequence

After the opening answer, the intake gathers only the missing information needed for the current checkpoint. A normal application path covers:

- the maturity and origin the team confirms;
- the problem, intended user, and evidence the team actually has;
- the proposed experience or approach;
- what exists now and what the team intends to build during Code2Create;
- one core track and any optional sponsor-track entries;
- prior work, repositories, designs, datasets, APIs, models, templates, and other third-party material;
- what the team can demonstrate next;
- material privacy, safety, security, misuse, and accessibility concerns;
- a final structured brief assembled from confirmed answers.

This is not a fixed eleven-question sequence. If the opening answer already explains the user and approach, the system should not ask the team to repeat them. If a claim is vague, it chooses an approved follow-up. Every visible question comes from the published intake configuration; the model cannot invent an unreviewed question.

Before each later review, the same engine runs a short update path: what changed, what works now, what the team will demonstrate, what previous commitment remains open, and whether any disclosure or track eligibility changed. It links the configured GitHub/Figma checkpoint instead of asking the team to reproduce provider statistics.

### OpenAI interpretation layer

The OpenAI layer is behind the interface, not the interface itself. A server action sends the minimum project text plus the published maturity, track, field, and question definitions to the Responses API with Structured Outputs. It may return:

- candidate maturity values and reasons;
- candidate core and sponsor tracks and reasons;
- brief-field drafts tied to source answer-version IDs;
- fields that appear answered, missing, or ambiguous;
- the next eligible question keys from the server-provided allowlist.

The model receives no application-owned Google subject, email, phone, registration number, auth/session data, admission recommendation, reviewer note, or score. A deterministic preprocessor also replaces common email, phone, registration-number, URL-credential, and secret-token patterns found in free text before the request; the raw answer stays in Convex. It receives no tools, web access, database function, or provider credential. Participant text is treated as untrusted data, never as instructions to change the system contract.

The model cannot:

- select or change a track or maturity on the team’s behalf;
- write an authoritative answer or silently alter the participant’s words;
- invent validation, users, novelty, progress, disclosures, or evidence;
- accept, reject, rank, route, or score a team;
- choose a question outside the published allowlist.

The participant confirms maturity, project origin, core track, sponsor-track entries, and the final brief. Each generated field remains visibly editable and keeps links to the answers it came from.

The server saves an answer first, then starts interpretation in the bounded intake work pool. It gives the model a short latency budget. On timeout, refusal, invalid output, rate limit, or provider outage, the deterministic route graph immediately supplies the next approved fallback question. A late result cannot replace a question already on screen. Model availability never blocks draft completion or submission.

### Tracks

The working event model reserves five core-track positions and supports zero or more sponsor tracks. The event board has not approved the names or definitions, so the application must read the published catalog rather than ship placeholder tracks as policy.

A team confirms exactly one core track before submission. It may also opt into any published sponsor tracks for which it meets the stated requirements. A sponsor track is additional eligibility, not a replacement for the core track.

Each published track contains:

- stable key, display name, type `core | sponsor`, description, and examples;
- explicit eligibility and required disclosures;
- optional sponsor/tool-use conditions;
- applicable project maturities and event checkpoints;
- domain tags used as one input to reviewer coverage;
- track-specific intake-question bindings;
- capacity or award-policy reference when approved;
- status, display order, version, and checksum.

Tracks describe areas of work. They do not impose mandatory problem statements. Track-specific questions may request relevant evidence, but they do not silently change the shared judging rubric or promise a finalist place or award.

After the opening answer, the model may suggest up to three published tracks with a short source-based reason. The screen always offers **Browse all tracks** and **Not sure yet**. A suggestion is not a selection. The team confirms the core track itself.

A lead may change the confirmed track until the configured submission freeze. The server preserves every raw answer, removes no disclosure, marks now-irrelevant track answers as inactive rather than deleting them, and computes the newly required questions. Submitted project versions keep the exact catalog and track-version IDs that reviewers saw.

Changing the core track after application submission creates a new project version and follows the admission policy for re-review. If track capacity affected an existing offer, the change cannot take effect until admissions rechecks that reservation. A sponsor opt-in follows its own published freeze and eligibility rule.

### Answer and brief behaviour

- One prompt is visible at a time.
- The active answer has a clear character limit.
- The portal shows **Saving**, **Saved**, or **Could not save**.
- Back/edit creates another answer version; it does not erase the earlier text.
- A refresh or another authorised team device resumes at the same accepted session version.
- A stale device cannot overwrite a newer answer.
- The final screen is a plain project brief, not a generated deck.
- Every brief field is editable and cites its source answer versions.
- The lead submits only after confirming the brief, maturity, origin, core track, sponsor entries, and disclosures.

## 5. Project versions

The team lead can edit a draft until submission.

Submitting creates a project version containing:

- verbatim answer versions, confirmed brief fields, and disclosures;
- confirmed project maturity and origin;
- core-track and optional sponsor-track version IDs;
- ordered repository set with declared kinds/purposes and the Figma link;
- demo URL, if present;
- version number;
- submitting member;
- server time;
- participant-policy, track-catalog, intake-flow, intake-model-schema, and integration-policy versions.

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
- Reviewers inspect the confirmed brief, its source answers, team composition allowed by policy, disclosures, project maturity/origin, and confirmed track versions.
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

The project page contains separate team connection cards. Connections belong to the team, so every active member sees the same resources, freshness, statistics, and checkpoints. A team lead confirms, classifies, reorders, replaces, or disconnects them.

### GitHub

The GitHub card is an ordered repository list. A lead can add every repository used by the project, including repositories reached through different GitHub App installations. Each row requires a kind, short purpose, tracked branch, and optional project root. Supported kinds cover full product, frontend, backend/API, mobile, desktop, AI/ML, data pipeline, hardware/firmware, infrastructure, library/SDK, docs/research, and a labelled **Other**.

Every active repository must contain `code2create-7-0`. The App has Metadata read and Contents read. GitHub requires Administration write to replace repository topics, so the production App does not auto-add a missing topic. Each affected row gives the exact topic to that repository’s administrator and rechecks it.

Each repository row updates from signed pushes and shows:

- kind, purpose, topic, installation, repository, and tracked branch/root;
- baseline and current head;
- latest push and reconciliation time;
- commits/pushes, linked and unknown authors, additions/deletions, changed files, languages, and top changed directories;
- force-push, branch, access, rate-limit, truncation, and stale warnings;
- captured checkpoint history.

Above the list, the team sees repository/kind count, topic coverage, combined activity, and complete/expected repositories. Combined totals identify overlapping commits across forks and never hide a failed repository. Counts are evidence, not a team-member leaderboard.

Any team member can switch repositories and open the captured tree and text files at that repository’s checkpoint SHA. Provider credentials never reach the browser. Archiving a repository removes it from future checkpoint sets without deleting its earlier evidence.

### Figma

A team member authenticates with Figma and pastes a file URL they can access. A lead confirms the file for the team. OAuth is granted by that member, but the file binding, snapshots, and statistics belong to the team. If that account loses access, any current lead can reauthorise with another Figma account without erasing the history.

The Figma card shows metadata freshness separately from full-content freshness. It includes pages, captured screens/frames, a layer browser, components/component sets/instances, auto-layout, styles, prototype flows/reactions, named versions, comment status, changed screens, and selected frame previews.

The backend uses a file webhook when the authorizer can edit and the Figma plan allows it. Metadata heartbeat and explicit checkpoints remain active because Figma's file update event can be delayed and full-file API limits vary by seat and plan. A team can request a refresh, but the portal honours provider `Retry-After` and shows the last complete snapshot while waiting.

### Disclosure

Teams must disclose work that predates the event even if a repository or design file is new. Integration activity is evidence, not proof of originality and not a score.

If the project does not use GitHub or Figma, the team explicitly marks that provider as not used and describes the alternative evidence it will present. A repository added after the event baseline deadline is labelled late. The same repository or Figma file cannot be claimed by another event team without an administrator-reviewed shared-resource exception.

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
