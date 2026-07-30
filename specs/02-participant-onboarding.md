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

The final eligibility fields remain blocked until Board approves the participant policy.

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

### Fresh-project rule and event phases

Every Code2Create project is `fresh_for_event`. A team may arrive with an idea and may describe it during the application, but project-specific implementation, prototype work, and product/design artefacts begin at the official build start. There is no continuing-project option and the introduction never asks how far along the project is.

Before submission, the lead accepts one sentence: **We will begin project-specific implementation and design after Code2Create's official start.** General-purpose libraries, frameworks, public datasets, APIs, pretrained models, starter templates, and skills are allowed under the event policy and must be disclosed when material. Board separately defines any allowed pre-start account, repository, or empty-project setup. GitHub, Figma, and manual baselines record exactly what exists at the official start. A project-specific implementation or design that existed before that baseline triggers admissions/operations eligibility review.

The system keeps two separate configured concepts:

| Concept | Initial working values | Meaning |
| --- | --- | --- |
| Event phase | `introduction`, `ideation`, `build`, `intermediate_update`, `review_ready`, `final_update` | The schedule/checkpoint currently assigned by the server |
| Question purpose | `user`, `problem`, `experience`, `event_goal`, `tradeoff`, `risk`, `track_fit` | What one generated question is trying to clarify |

Participants do not select an event phase. The server derives it from the event schedule and checkpoint. Phase names, timing, generation guidance, and fallback bindings are published configuration rather than client-side constants.

### Adaptive sequence

After the opening answer, the model generates three to five follow-up questions. They appear one at a time. The sequence should leave the organisers with a clear description of:

- who the project is for and what it helps them do;
- the main experience or approach;
- what the team wants to make during Code2Create;
- one or two important choices, unknowns, or risks that are useful to think through;
- likely core-track fit and any material starting tools or third-party resources.

The sequence uses what the team has already said instead of a fixed questionnaire. It avoids asking for the same fact twice and may stop after the third question when there is enough coverage. It never exceeds five generated follow-ups. Every generated question:

- is one plain-language question no longer than 140 characters;
- asks about one idea and can normally be answered in one to three sentences;
- requires no research, metrics, market proof, technical specification, or pitch preparation;
- is specific enough to be insightful without judging the idea;
- avoids personal data, protected or sensitive traits, credentials, novelty claims, eligibility, scores, and winner language;
- does not ask compound questions or demand TAM, validation, a full architecture, or “why should you win?”;
- offers a small **Skip** action.

Sample tone:

- **Who would use this first?**
- **What should they be able to do with it?**
- **What would you most like to finish during Code2Create?**

The product presents the required freshness attestation, track confirmation, disclosures, and final-brief confirmation after the generated sequence.

Before each later review, the same engine runs a short update path: what changed, what works now, what the team will demonstrate, what previous commitment remains open, and whether any disclosure or track eligibility changed. It links the configured GitHub/Figma checkpoint instead of asking the team to reproduce provider statistics.

### OpenAI interpretation layer

OpenAI runs behind the static interface. A server action sends the minimum project text plus the current server-assigned phase, published track/brief definitions, and generation policy to the Responses API with strict Structured Outputs. Its output contract is:

```json
{
  "briefFieldDrafts": [
    {
      "fieldKey": "string",
      "text": "string",
      "sourceAnswerVersionIds": ["opaque-id"]
    }
  ],
  "trackCandidates": [
    {
      "trackVersionId": "opaque-id",
      "reason": "string",
      "sourceAnswerVersionIds": ["opaque-id"]
    }
  ],
  "coverage": [
    {
      "purposeKey": "user",
      "sourceAnswerVersionIds": ["opaque-id"]
    }
  ],
  "nextQuestion": {
    "text": "What would someone do first when they open it?",
    "purposeKey": "experience",
    "answerLength": "short",
    "sourceAnswerVersionIds": ["opaque-id"]
  },
  "stopReason": "needs_question"
}
```

`nextQuestion` may be `null`. `purposeKey` uses the published purpose enum, `answerLength` is `short | medium`, and `stopReason` is `needs_question | enough_context | question_limit`. The model writes the question text; it does not choose it from a wording allowlist. The server requires a question for introduction ordinals one through three, permits `enough_context` after the third, and rejects any question after the fifth.

The model receives no application-owned Google subject, email, phone, registration number, auth/session data, admission recommendation, reviewer note, or score. A deterministic preprocessor also replaces common email, phone, registration-number, URL-credential, and secret-token patterns found in free text before the request; the raw answer stays in Convex. It receives no tools, web access, database function, or provider credential. Participant text is treated as untrusted data, never as instructions to change the system contract.

The model cannot:

- select or change a track or event phase on the team’s behalf;
- write an authoritative answer or silently alter the participant’s words;
- invent validation, users, novelty, progress, disclosures, or evidence;
- accept, reject, rank, route, or score a team;
- write or accept the freshness attestation for the team.

Strict Structured Outputs guarantees the response shape. Application code validates the free text and rejects a generated question that is too long, contains more than one question, uses a disallowed purpose, repeats normalized prior wording, cites stale answers, includes blocked personal/credential patterns, violates the published wording policy, or appears after the question limit. Semantic repetition and ease are also measured in the release evaluation suite. A rejected result uses the published fallback for that phase and purpose.

The participant confirms the freshness attestation, core track, sponsor-track entries, and final brief. Each model-assisted field remains visibly editable and keeps links to the answers it came from.

The server saves an answer first, then starts interpretation in the bounded intake work pool. It gives the model a short latency budget. A valid generated question is stored as an immutable, versioned record tied to its source answers and exact model/configuration versions before it becomes visible. On timeout, refusal, invalid output, policy rejection, rate limit, or provider outage, the deterministic route graph immediately supplies the next published fallback question. A late result cannot replace a question already on screen. Model availability never blocks draft completion or submission.

### Tracks

The working event model reserves five core-track positions and supports zero or more sponsor tracks. Board has not approved the names or definitions, so the application must read the published catalog rather than ship placeholder tracks as policy.

A team confirms exactly one core track before submission. It may also opt into any published sponsor tracks for which it meets the stated requirements. A sponsor track is additional eligibility, not a replacement for the core track.

Each published track contains:

- stable key, display name, type `core | sponsor`, description, and examples;
- explicit eligibility and required disclosures;
- optional sponsor/tool-use conditions;
- applicable event phases/checkpoints;
- domain tags used as one input to reviewer coverage;
- track-specific generation guidance and fallback-prompt bindings;
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
- The lead submits only after confirming the brief, `fresh_for_event` attestation, core track, sponsor entries, and disclosures.

## 5. Project versions

The team lead can edit a draft until submission.

Submitting creates a project version containing:

- verbatim answer versions, confirmed brief fields, and disclosures;
- the `fresh_for_event` attestation, policy version, and official baseline reference;
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

- A caller with `admissions.application.assign` assigns each application to the configured number of people. Each assignment materialises application-scoped review/read and own-recommendation grants regardless of assignee role.
- Reviewers inspect the confirmed brief, its source answers, team composition allowed by policy, freshness attestation, starting-material disclosures, and confirmed track versions.
- Each reviewer submits an independent recommendation: `select`, `waitlist`, `reject`, or `needs_information`, with reason codes and a short note.
- Reviewers cannot see peer recommendations until their own is submitted.
- Admissions uses a separate, approved admission policy. The venue judging rubric and scores do not apply.
- A language model cannot accept or reject an application.

An application returned for information opens only the named questions and records a new project version.

### Capacity and offers

The admissions page shows team and participant counts against venue capacity. `admissions.decision.prepare` opens the decision/capacity workspace; `admissions.decision.publish` publishes selected, waitlisted, and rejected decisions after checking review coverage and eligibility.

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

All submitted projects start at Code2Create. Teams disclose material general-purpose starting resources and any allowed pre-start setup. A sign of project-specific implementation or design before the official baseline is flagged for eligibility review rather than reclassified as a continuation. Integration activity is evidence of what changed after the baseline, not proof of quality or a score.

If the project does not use GitHub or Figma, the team explicitly marks that provider as not used and describes the alternative evidence it will present. A repository added after the event baseline deadline is labelled late. The same repository or Figma file cannot be claimed by another event team without `integration.shared_resource.override` for every affected team/resource scope.

## 8. Registration and project states

### Participant

`profile_required → eligible → suspended`

### Team

`forming → profile_in_progress → submitted → admitted → confirmed → checked_in → active → completed`

Exceptional terminal states are `withdrawn` and `disqualified`.

### Project version

`draft → submitted → superseded`

A state change happens on the server after it rechecks current policy and membership.

## 9. Venue arrival and session attendance

An event desk checks in each participant against the registered account and attendance-credential process. Staff enrol and verify the existing VIT ID card or issue/verify the external QR badge as applicable. This one-time staffed venue check is separate from the participant’s repeated entry/exit events and hacking-session confirmations.

After check-in, the portal shows:

- current venue state: not arrived, inside, temporarily out, departed, or needs review;
- the active or next attendance session, location, check-in window, and whether it is required;
- the participant’s session state and latest accepted server time;
- a short-lived personal attendance QR;
- a correction/support action when the displayed state is wrong.

Every expected participant confirms each configured hacking session individually. A VIT student normally taps the enrolled existing VIT ID card against a staff scanner phone. An external participant uses the event-badge QR or dynamic portal QR; the portal QR is also the fallback for a VIT student whose card is forgotten or unreadable. Someone who remains inside across a session boundary still sees **On site · confirmation due** until that session is confirmed.

When the participant crosses a tracked-zone boundary during a session, an exit scan changes the state to **Temporarily out** and a return scan restores **Present**. Ordinary exits need no reason. Several exit/return intervals are valid, and a long-away alert is an operations prompt rather than an automatic penalty.

Attendance is a participant record, even when team availability is summarised. It cannot change a score, track, project evidence, or admission recommendation. Full credential, state, failure, privacy, and recovery rules are defined in **Attendance and presence**.

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

This is a review-presence credential for assigned reviewers to scan. It is not the participant’s attendance QR and cannot create a participant venue/session presence event.

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
- Support staff see only the records covered by their person-specific support grants; role does not expand that view.
- Refreshing, changing devices, or reinstalling a browser does not duplicate team membership or submissions.
- If the venue network fails, participants keep their QR visible from a short-lived local cache, but review presence still waits for server validation or an authorised manual incident process.

## 14. Acceptance checks

- Both account-class paths reach Google sign-in and the server derives the final class.
- A participant cannot belong to two active teams.
- Two users cannot claim the same rostered/team identity through a duplicated invite.
- The guided profile resumes at the first unfinished question after refresh.
- Submitting twice with the same operation ID creates one project version.
- An application-scoped review grant cannot expose peer recommendations before the assignee submits.
- A selected team cannot check in until its offer is confirmed.
- Venue check-in, venue presence, and hacking-session confirmation cannot satisfy one another accidentally.
- A VIT ID card tap, external event-badge QR, or current portal QR produces the same server-owned attendance state.
- A forgotten/unreadable VIT ID uses QR or staffed recovery and does not require Code2Create to issue another NFC credential.
- A participant sees only their own movement history and no sensitive reason attached to another team member’s absence.
- Leaving and returning during a session creates accurate intervals without removing the participant from the event or team.
- A missing scan produces a correction route and never an automatic judging or eligibility decision.
- Expiring an offer releases capacity without deleting the application decision.
- GitHub/Figma disconnects are visible without deleting captured checkpoints.
- A ready team appears in operations and participant queue views from the same accepted write.
- The participant never receives another team’s private project, queue, or review data.
