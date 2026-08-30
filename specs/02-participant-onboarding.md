# Participant portal

## 1. Entry and event deadline

The participant selects **VIT Student** or **External Participant**. The next action is **Authenticate with Google**. The server verifies the account class. The client does not authorize the selected class.

A returning participant goes to the first unfinished task.

The event publishes one authoritative `externalApplicationsCloseAt` time and one authoritative VIT `applicationsCloseAt` time. The external deadline is no later than the VIT deadline. The server uses the deadline for the verified participant class. The browser clock is not authoritative.

Before the applicable deadline, an eligible participant can accept policy, update a profile, change an unlocked team, edit a proposal, answer an intake follow-up, and submit. At or after that deadline, the server rejects new onboarding, submission, and participant-initiated proposal revision for that class. A later organizer-requested admission-information response remains available to the locked lead. A retry with an operation ID that committed before the applicable deadline returns the original result.

## 2. Participant profile

The portal collects only fields that Google does not provide.

All participants provide:

- full name and optional preferred name;
- institution or organization;
- year of study or current role;
- an approved contact route when policy permits it; and
- required policy and consent versions.

A VIT participant must authenticate with a current `@vitstudent.ac.in` Google Workspace identity. The server verifies both the email domain and Google's hosted-domain claim. The verified Google display name must end with the participant's registration number. The configured event start year, not a release-year constant, determines first through fourth year and `fifth_or_later`. A returning membership that predates this identity snapshot is repaired idempotently from the verified Google identity during provisioning or profile save.

Google identity claims are authentication evidence, not configurable profile fields. The profile policy controls whether registration number and programme are copied into the participant profile and shown outside the participant's own identity screen. It does not claim that the Google identity provider omitted those values. Authentication evidence never enters proposal, novelty, admission, review, or judging model input.

A VIT student can also provide a campus when policy permits it. An external participant can also provide city and country.

The participant policy marks phone, VIT registration number, programme, campus, city, and country as `not_collected | optional | required`. Full name, institution, and year or current role are required. Sensitive eligibility, dietary, and accessibility facts use protected evidence or support routes. No profile or contact field enters proposal AI input.

One immutable participant-policy version owns profile fields, team bounds, notices, the privacy URL, the fresh-project acknowledgement, and the membership-lock warning. VIT students and external participants always form separate teams. Each participant accepts the exact current version. A later publication does not edit an earlier profile or consent record.

The event stores one deadline for external participants and one later or equal deadline for VIT students. Profile, team, idea, submission, and proposal-revision writes use the deadline for the signed-in participant's verified class. A team has one class, so every member sees the same deadline. Saved work remains readable after that deadline.

## 3. Team formation

A participant can belong to one active team in the event. Each team has exactly one lead.

### Create

The creator becomes the lead. The server creates a short join code and link. The team view shows active members, pending members, capacity, lead, and lock state in realtime.

### Join

The server checks these facts in the join transaction:

- The participant is eligible.
- The participant accepted the current policy.
- The participant is not in another active team.
- The target team is active, unlocked, and below capacity.
- The invitation is current.
- Every active member has the same verified participant class.

### Membership changes

- The lead can remove a non-lead member before final submission.
- A member can leave before final submission.
- A lead with other members must transfer leadership before leaving.
- The current lead proposes a transfer.
- The proposed lead accepts or declines the transfer.
- Acceptance changes the lead and the source-attributed lead grants in one transaction.
- A membership change rotates or invalidates affected invitations.
- Merge, split, and post-lock correction require a scoped operations command, impact preview, fresh authentication, reason, and audit event.

Final submission locks membership. It also freezes the accepted participant-policy version and materializes immutable member snapshot rows. It does not lock proposal content. A successful final submission disables ordinary join, leave, remove, and lead-transfer commands. A failed submission attempt can release the lock if it created no application.

## 4. Proposal intake

### Opening

The first prompt is:

> What is your project about?

The page contains one multiline text box and one primary action. The team writes free text. The server saves the text verbatim before it requests AI work.

The accepted privacy notice explains that proposal text can be sent to OpenAI for novelty comparison, follow-up generation, and admission analysis. It tells the team not to enter personal data, credentials, or secrets. If the required data policy is not approved, the system disables the related AI function and keeps proposal editing available.

### Follow-up questions

After the first answer, the AI asks two friendly questions. They appear one at a time. The second follow-up is the third total question and must appear before final review. If an AI request fails or returns invalid output, the system uses that ordinal's published fallback question.

Each question must:

- contain at most 140 characters;
- ask one thing;
- use plain and supportive language;
- accept an answer of one to three sentences;
- use only the team's current proposal text;
- avoid repeated questions;
- avoid personal, protected, or credential data;
- avoid admission, judging, scoring, and winner language;
- avoid requests for market size, research, metrics, or a full architecture; and
- offer **Skip**.

The model can generate question text. The server validates the output against the published contract. The model cannot submit, reject, classify, route, or score the team. Each ordinal has a deterministic fallback. Model delay or failure cannot block the proposal.

The sequence should clarify:

- the intended user;
- the problem or task;
- the main experience or approach;
- what the team plans to build during the event; and
- one useful choice, unknown, or risk.

### Fresh-project rule

The lead accepts this statement before first submission:

> We will begin project-specific implementation and design after Code2Create's official start.

The event policy can permit general libraries, frameworks, public data, APIs, pretrained models, starter templates, and skills. The team must disclose material prior resources. GitHub, Figma, and manual baselines record the state at the official start.

### Live novelty number

The live novelty number appears only above the idea text box. The feature returns one whole number from `0` through `100`. A larger number means fewer close ideas exist in the approved corpus and current event idea pool. The number is a relative drafting signal, not a claim of objective originality.

The participant view shows:

- the number;
- a short statement that it is a drafting aid; and
- comparison state such as **Comparing** or **Unavailable**.

The participant view must not show:

- a familiar, developing, distinct, or similar label;
- a prior-project name or text;
- a nearest-theme label;
- a generated reflection prompt;
- a blocking warning; or
- a claim that the number measures objective originality.

The browser waits for the published debounce, initially 800 ms. It requests embeddings for the complete normalized idea and a bounded set of its segments. Segments improve retrieval for an idea with several distinct parts. They are not stored as separate team candidates. Each browser request has an increasing sequence. Only the newest request can update the displayed number. The server also checks the input fingerprint, team, draft, and corpus version.

The first release uses `text-embedding-3-small` at its native 1,536 dimensions. One corpus version must use one model and one vector width. The approved corpus contains 5 to 300 non-identifying curator summaries. Participants never receive a corpus entry or another team's text.

Density uses at most the fifty strongest distinct corpus or team matches. A current team contributes at most one stored full-idea vector for live editing and one for its durable saved or submitted idea. Editing vectors have a short lifetime and lower weight. Saved vectors have lower weight than submitted vectors. Several retrieval hits for one team count once. When both transient and durable rows are retrieved, the durable saved or submitted row is authoritative for that team. The logarithmic mapping reaches `100` with no effective close matches and bottoms out at `0` once the effective density reaches twenty.

Changing a saved or submitted idea invalidates every older team vector and any running preview in the same Convex transaction that accepts the new text. Replacement indexing runs afterward. A missing key, timeout, rate limit, malformed provider response, or other indexing failure can make the signal unavailable, but it cannot leave the previous idea active in the comparison pool. An older in-flight preview cannot reinsert its vector after the idea changes.

The server does not request an embedding when the text contains a detected email, phone number, registration number, credential, or secret. Provider, rate-limit, index, and network failures set the feature to unavailable. They do not block save, revision, or submission.

Novelty request records store an input fingerprint and character count. They do not store another copy of proposal text. Team-density rows store a fingerprint, lifecycle, one full-idea vector, and timestamps; they store no raw idea. The novelty number and similarity values are absent from proposal versions, applications, admission input, human review, reviewer evidence, queues, judging, awards, and exports.

## 5. Proposal versions and final submission

The shared team draft uses optimistic version checks. Two devices cannot silently overwrite each other.

Before final submission, any active member with the team proposal-write grant can edit the draft. Only the current lead can submit or revise the submitted proposal.

The final preview shows:

- the active member list;
- the current lead;
- the proposal text and follow-up answers;
- the fresh-project acknowledgement;
- material prior-resource disclosures; and
- the exact participant-policy version.

The lead confirms the preview. The first submission then:

1. rechecks the current lead and exact-team submit grant;
2. rechecks `applicationsCloseAt`;
3. rechecks team bounds, participant eligibility, policy acceptance, profile completeness, and draft version;
4. locks membership;
5. materializes the immutable member snapshot;
6. creates immutable proposal version 1; and
7. creates one application that points to proposal version 1.

The command uses one stable operation ID. A retry returns the original application.

### Revision before the deadline

The current lead can revise submitted proposal content while server time is before `applicationsCloseAt`. The member snapshot remains locked.

Each revision:

1. reads the current proposal version;
2. compares the expected application and draft versions;
3. validates the complete proposal;
4. creates a new immutable proposal version;
5. moves the application's current-version pointer;
6. marks earlier human recommendations and AI admission recommendations stale;
7. cancels or rebinds active review assignments to the new content version;
8. leaves the application without a published decision;
9. queues fresh optional AI analysis; and
10. records actor, time, operation ID, before version, and after version.

The system retains every older proposal version and its review history. No old output can support a new decision.

At or after `applicationsCloseAt`, the server rejects a revision even if the browser still shows an edit screen. Operations cannot extend one team by editing its application. A deadline change is an event-policy publication that affects all eligible teams and requires its own scoped permission, fresh authentication, reason, and audit record.

## 6. Admission

Each application points to the event's frozen admission-policy version. The admission release contains the criteria, experience-band rule, minimum human review, decision reasons, participant capacity, and either one admission-model release or human-only mode.

Organizers can review applications while applications are open. The server does not publish an admission decision until server time reaches `applicationsCloseAt`. This keeps every submitted proposal editable for the complete published application window.

An assignment gives one exact active event account only the source-attributed application-review grants. Profile context, AI recommendation, decision publication, and offer management require separate grants.

A human reviewer submits a recommendation for one exact proposal version. Peer recommendations stay hidden until the reviewer submits the reviewer's own current-version recommendation.

The AI admission service reads only approved proposal fields, the deterministic experience band, and the published admission rubric. It returns a structured advisory recommendation. It cannot publish a decision or write a judging score.

An authorized human can:

- publish an admission decision for the current proposal version;
- record whether the human used, cleared, or overrode the current AI recommendation; or
- request one or two specific facts from the locked lead.

An information response creates another immutable proposal-content version and invalidates stale outputs in the same way as a lead revision. The response does not unlock membership.

An offer reserves capacity for the exact locked member count. Only the current lead can accept or decline the offer. An expired or revoked offer releases capacity without deleting decision history.

## 7. GitHub and Figma

### GitHub

One team can connect multiple repositories. The repositories can belong to different installations, accounts, or organizations. Each active repository has:

- repository ID and installation;
- repository kind and purpose;
- tracked Git branch;
- optional project root;
- display order;
- baseline and current head;
- topic state;
- freshness and completeness; and
- immutable checkpoint snapshots.

Each repository keeps one tracked branch. This is a Git integration setting.

The team can add, reorder, archive, and replace repositories before the integration freeze. A complete ordered-set update uses optimistic versions. Earlier snapshots remain available.

### Figma

A team member can authorize Figma with scoped OAuth. A team can bind one or more file URLs up to the published limit. The backend stores encrypted credentials separately from team-owned file bindings.

Each checkpoint pins the exact Figma file version, selected node renders, version facts, comment facts, and completeness state. A later provider refresh cannot change review evidence that already started.

### Evidence boundary

GitHub and Figma evidence gives reviewers context. Activity counts do not become scores. Missing provider access produces an explicit incomplete state and an approved alternative-evidence route.

## 8. Attendance and team location

An accepted team must confirm its live offer before venue and review workflows.

Staff scan the barcode on a VIT participant's existing VIT ID from a provisioned phone. External participants use an event-badge QR or current portal QR. A VIT participant can use the portal QR as a staffed fallback when the card is forgotten or unreadable.

Venue arrival, session presence, temporary exit, return, and departure are separate facts. Attendance cannot change admission or judging.

The team dashboard shows a short-lived team-location QR. An authorized organizer scans it while standing with the team and selects the zone and nearest landmark. The team cannot write its own location. The participant view updates from the accepted server record.

The review-presence QR is a separate credential. It proves assigned-reviewer presence. It cannot create participant attendance or team location.

## 9. Staff-managed review queue

The participant portal has no command to enter a team into a panel queue or change queue priority.

The participant sees one accepted state:

| State | Meaning |
| --- | --- |
| Waiting for review desk | Staff have not placed the team |
| Queued | The team has a panel and queue position |
| Called | The team must go to the shown table |
| At table | The team waits for reviewer presence |
| In review | The server has started the review |
| Held | Staff paused the team and supplied a reason |
| Missed | The approved missed-call policy applies |
| Complete | The review is recorded |

The queue shows a five-minute-bucketed range. It uses server time, configured review duration, current review remainder, recent bounded median duration, teams ahead, and handover allowance. A paused round hides the estimate. An expired estimate shows **Taking longer than estimated**.

## 10. Support and recovery

- Support is available after the authenticated event account exists.
- A participant can read and reply only to the participant's own cases.
- A support link grants no access to the linked team, attendance, queue, review, or integration record.
- Reporter-visible replies are separate from internal notes.
- A stable operation ID prevents duplicate cases and replies.
- A staff update requires a manage grant, current case version, reason, and audit event.
- A closed case remains closed. The reporter opens a new case for a new occurrence.
- Refresh, device change, or reinstall cannot duplicate membership, proposal versions, or attendance facts.

## 11. Synesthesia

Accepted participants can request, vote for, and report music catalog tracks during a published Synesthesia window. These tracks belong only to the Synesthesia music catalog. They do not classify proposals.

The participant cannot control playback or queue order. A music action cannot change admission, attendance, review routing, project evidence, or judging.

## 12. Acceptance checks

- Google sign-in and server-side account classification work for both participant classes.
- Profile fields and consent follow the published participant policy.
- One participant belongs to at most one active team.
- One active team has exactly one lead.
- Leadership transfer requires acceptance and updates source-attributed grants atomically.
- Final submission locks only membership and the policy/member snapshot.
- The lead can revise submitted proposal content before `applicationsCloseAt`.
- The server rejects proposal writes at or after `applicationsCloseAt`.
- Every proposal save creates or advances an immutable version without deleting history.
- A revision invalidates stale human and AI admission outputs.
- The intake asks two friendly questions and works without OpenAI through published fallback questions.
- The novelty feature shows only one number above the idea text box.
- The novelty feature never blocks save or submission and never enters admission or judging.
- Proposal routing uses the current proposal and reviewer-domain coverage.
- Git tracked branches and Synesthesia music tracks remain unchanged concepts.
- One team can connect multiple GitHub repositories.
- Figma evidence pins exact provider versions.
- A VIT ID barcode and event QR resolve to the same participant authority.
- A team-location write requires an organizer scan of the team's current dashboard QR.
- Participants cannot enter their team into a review queue.
- Realtime views use the same accepted backend records.
