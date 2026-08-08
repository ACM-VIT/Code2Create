# Participant portal

## 1. Entry

The portal opens with:

- VIT Student
- External Participant

The next action is **Authenticate with Google**. Identity and classification follow the rules in Identity and access.

A returning participant goes to the first unfinished task instead of repeating onboarding. Authentication creates no completed application state; the participant still supplies the event profile fields and joins or creates a team.

Participant onboarding writes are available only while the event state is **Applications open**. Closing applications stops policy acceptance, profile changes, team changes, idea edits, track changes, follow-up answers, and final submission in the same realtime backend. It does not remove saved drafts or submitted applications. An idempotent retry of a write that committed before the close still returns that original result. Reopening applications restores those unlocked writes; submitted team and track locks remain unchanged.

## 2. Participant profile

The portal collects only event fields that Google does not provide.

### All participants

- full name for event records and optional preferred/display name;
- phone number or other approved contact route for event operations, only where the published participant policy permits it;
- college, university, institution, or organization;
- current year of study, or current role for a non-student external participant;
- required policies and consent versions.

### VIT students

- registration number;
- school/programme;
- campus, if more than one campus is eligible.

### External participants

- institution or organization name;
- city and country when the published policy marks either field optional or required.

The published participant policy makes phone, VIT registration number, programme, campus, external city, and external country independently `not_collected | optional | required`. Full name, institution, and year of study or current role remain required. Dietary, accessibility, and sensitive eligibility evidence use the protected support or evidence route rather than the general profile. The intake model never receives profile or contact fields.

One immutable policy version also owns team-size bounds, whether VIT and external participants may mix in one team, the participant-facing profile and project-text notices, the privacy-notice URL, the fixed fresh-project acknowledgment, and the final lock warning. The event membership keeps every exact policy version that the participant accepted. Consent therefore exists even before the participant creates a profile. The portal computes profile completeness against the current publication. Publishing a new version does not edit a membership or profile. The participant must review and accept the new version before saving the profile, creating or joining a team, or submitting the project.

## 3. Team formation

A participant can create one team or join one team for the event.

The team area remains reachable throughout profile completion and project intake. It shows the lead, active/pending members, join link/code, capacity, and current lock state without turning the intake into a dashboard. Create and join become available as soon as an eligible participant accepts the current policy. They do not wait for profile completion. The participant can form the team and finish the profile in either order after consent. Missing required profile fields remain visible blockers to final submission. Member changes arrive live on every authorized team device.

### Create

The creator becomes team lead and receives:

- a short join code;
- a join link carrying the same code, valid until the code rotates or the team locks;
- a live active-member list.

### Join

The server checks:

- participant is eligible for the event;
- participant accepted the current participant policy;
- participant is not already in another active team;
- team is not submitted, locked, full, or disqualified;
- invitation is valid;
- mixed VIT/External teams comply with event policy.

### Team changes

- A team lead can remove an active non-lead member; removal rotates the join code so the removed member cannot reuse an old link.
- An active member can leave before final project submission.
- A lead with other active members transfers leadership before leaving. A sole lead may leave, which withdraws the now-empty team.
- The current lead starts a transfer and the proposed lead explicitly accepts it. Acceptance atomically moves the `lead` membership role and team-lead permission grants; there is never a leaderless or two-lead team.
- Merge, split, or post-lock removal is an operations action with a reason.
- Join codes can be rotated if exposed.

Final project submission locks the exact active membership set and the core track. After that command, ordinary join, leave, remove, lead-transfer, and core-track-change actions are unavailable. A genuine identity or eligibility correction uses a separately scoped operations command, impact preview, reason, and audit record; it never pretends the application was submitted with a different team.

Team-size bounds and mixed-team eligibility come from the current published participant policy. Create, join, and final submission load that policy inside the same transaction as the write. Create and join require current policy acceptance but not a complete profile. Final submission also requires a complete class-aware profile for every active member. A policy publication can therefore change an unlocked team's blockers but cannot rewrite a locked submission.

## 4. Guided project intake

This experience is the replacement for a project-application form and a forced PowerPoint presentation. It is sequential, quiet, and adaptive. It is not a chatbot and does not show a long questionnaire.

### Opening

The exact first frame is:

> Hello.

The next frame asks:

> What is your project about?

It contains one multiline text box and one primary continue action; pressing Enter may perform the same action when it does not insert a newline. The screen has no chat bubbles, assistant avatar, sample pitch, dashboard, or visible form sections. A small back action, save state, team-area action, and accessible progress label are the only secondary controls. The visual system is low-text and high-contrast, with a restrained cherry-blossom motif rather than decorative panels or uppercase labels.

The team writes naturally. The server saves that text verbatim before any model work starts. As soon as the save succeeds, the next screen is track selection; it does not wait for interpretation.

Before intake begins, the accepted participant policy explains that the system can send project-answer text to OpenAI for embedding comparison and interpretation. The policy states the effective retention controls. It asks teams not to enter contact, identity, credential, or other unnecessary personal data. If the policy is not approved, the event runs the same intake without live comparison and in deterministic-only question mode.

### Fresh-project rule and event phases

Every Code2Create project is `fresh_for_event`. A team may arrive with an idea and may describe it during the application, but project-specific implementation, prototype work, and product/design artefacts begin at the official build start. There is no continuing-project option and the introduction never asks how far along the project is.

Before submission, the lead accepts one sentence: **We will begin project-specific implementation and design after Code2Create's official start.** The event policy permits general-purpose libraries, frameworks, public datasets, APIs, pretrained models, starter templates, and skills. The team must disclose these resources when they are material. Board separately defines any allowed pre-start account, repository, or empty-project setup. GitHub, Figma, and manual baselines record exactly what exists at the official start. A project-specific implementation or design that existed before that baseline triggers admissions/operations eligibility review.

The system keeps two separate configured concepts:

| Concept | Initial working values | Meaning |
| --- | --- | --- |
| Event phase | `introduction`, `ideation`, `build`, `intermediate_update`, `final_update` | The schedule/checkpoint currently assigned by the server |
| Question purpose | `user`, `problem`, `experience`, `event_goal`, `tradeoff`, `risk`, `track_fit` | What one generated question is trying to clarify |

Participants do not select an event phase. The five semantic keys are fixed, while display names, descriptions, start times, and end times come from the event's current immutable phase-schedule version. The participant portal shows only the current phase or the next scheduled phase. A schedule change reaches every open portal through the same realtime public projection; a browser timer changes the label at the accepted server boundary without manufacturing another phase state.

The schedule may contain deliberate gaps but cannot contain overlaps. Once a phase has ended, a later publication cannot rewrite it. Once a phase has started, its key, wording, start, and order are fixed; only its still-future end may change. Checkpoint assignment, generation guidance, and fallback bindings remain separately versioned configuration rather than properties inferred from the browser clock.

### Adaptive sequence

After the opening answer and track screen, the intake asks one or two follow-up questions. They appear one at a time. A valid model result supplies the question; the same ordinal has a published deterministic fallback when the model is late, disabled, or unusable. The sequence should leave the organizers with a clear description of:

- who the project is for and what it helps them do;
- the main experience or approach;
- what the team wants to make during Code2Create;
- one important choice, unknown, or risk that is useful to think through;
- likely core-track fit and any material starting tools or third-party resources.

The sequence uses what the team has already said instead of a fixed questionnaire. It avoids asking for the same fact twice, may stop after the first follow-up when there is enough coverage, and never exceeds two introduction follow-ups. Every generated question:

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

The published intake policy can include a small, reviewed catalog of common idea patterns from prior events. When the opening resembles one pattern, the model can use that pattern only to ask a constructive differentiation or follow-through question. For example: **What should happen after someone reports a pothole?** The model must not call the idea unoriginal. It must not compare the team with identifiable past submissions, lower an admission recommendation, or prevent submission. The catalog is versioned and contains abstract patterns, not prior participant text.

The product presents the freshness attestation and final project summary after the short sequence. The chosen track remains visible and editable until final submission. Later event checkpoints use their own three-question plan and submission records; they do not reuse the admission-intake route or imply review readiness.

### Live novelty signal

Once the normalized opening answer reaches the published minimum length, the text box exposes one small live counter. It compares the current text with a curated, privacy-reviewed corpus of past Code2Create projects and returns:

- a directional whole-number signal from `0` through `100`, where a larger value means the nearest corpus project is less semantically similar;
- the approved theme label of the nearest match, never its project name, team, institution, raw summary, or source identifier;
- one approved supportive reflection question attached to that theme;
- the corpus label and compared-project count;
- plain copy stating that the result is a drafting aid and is never used for admission or judging.

The first release uses cosine similarity against the nearest result. The published policy maps its distinct and familiar similarity boundaries linearly to `100` and `0`, then labels `0–34` **Familiar**, `35–69` **Developing**, and `70–100` **Distinct**. These are interface bands, not claims that an idea is objectively original. Operations calibrates the two similarity boundaries against a frozen evaluation set before publication; a threshold change creates another corpus version.

The browser waits for the configured debounce, initially `800 ms`. It then requests one embedding for the whole normalized answer. OpenAI's embeddings endpoint returns one complete vector instead of a token stream. The participant experience therefore streams state, not vector components: **waiting → comparing → ready**. Every local request has a monotonically increasing sequence. Only the newest sequence can update the counter. The browser discards a result for text that has since changed. The server independently fingerprints the normalized input. It can attach a result to a saved draft only when the team, pinned corpus, current idea fingerprint, and unlocked draft still match.

`text-embedding-3-small` is called without the optional `dimensions` override, so the provider's native `1,536` floats are validated at the OpenAI response and Convex vector-index boundaries. The same model and width embed every corpus entry and participant query. A model or dimension change requires a new fully re-embedded corpus; mixed vectors cannot be published.

The published corpus is immutable and contains `5–200` representative past-project entries. Each entry has a non-identifying source key, year, participant-safe theme label, bounded curator-written summary, and a single supportive reflection question. Summaries and questions containing contact details, credentials, identifiers, multiple questions, discouraging language, admission language, or judging language are rejected. Only the summary and theme are embedded. Participants receive only the approved theme/question projection.

The first successful idea save pins the exact corpus version on the project draft alongside the track-catalog and intake-policy pins. If publication changes between page load and that save, the server asks the participant to refresh instead of silently comparing and pinning different versions. Publishing a later corpus affects only unpinned drafts. A superseded corpus remains queryable for already pinned drafts.

Preview requests require `team.project.write` for that exact team, are capped per team by the published rate, reuse a successful same-input result for 30 minutes, and use an idempotent client request ID. The request row stores the input fingerprint and character count, never a second copy of the answer. If the text contains a detected email, phone, registration number, URL credential, or secret pattern, no embedding request is created and the counter quietly becomes unavailable; the participant can still save the idea. Provider, index, corpus, rate-limit, or network failure has the same non-blocking outcome.

Novelty fields remain draft assistance. They are absent from `projectVersions`, `applications`, admission-model input, human admission views, reviewer context, queue routing, integration statistics, scorecards, exports, and awards. Current-year participant drafts never enter the corpus automatically. A later event may curate approved non-identifying summaries into a new corpus only through the separately permissioned operations flow and published event privacy policy.

### OpenAI interpretation layer

OpenAI runs behind the static interface. A server action sends a bounded request to the Responses API with strict Structured Outputs. The request contains the active answer-version IDs and redacted project text. It also contains the pinned core-track catalog, allowed purpose keys, prior question text, reviewed common-idea patterns, and pinned generation policy. The output contract is:

```json
{
  "trackRecommendation": {
    "trackStableKey": "people",
    "reason": "string",
    "sourceAnswerVersionIds": ["opaque-id"]
  },
  "coveragePurposeKeys": ["user"],
  "nextQuestion": {
    "text": "What would someone do first when they open it?",
    "purposeKey": "experience",
    "answerLength": "short",
    "sourceAnswerVersionIds": ["opaque-id"]
  },
  "matchedIdeaPatternKey": "optional-published-key",
  "stopReason": "needs_question"
}
```

`trackRecommendation`, `matchedIdeaPatternKey`, and `nextQuestion` may be `null`. `purposeKey` uses the published purpose enum, `answerLength` is `short | medium`, and `stopReason` is `needs_question | enough_context | question_limit`. The model writes question text; it does not choose it from a wording allowlist. The server permits `enough_context` only when the first follow-up is complete and rejects any question after ordinal two.

The model receives no application-owned Google subject, email, phone, registration number, auth/session data, admission recommendation, reviewer note, or score. A deterministic preprocessor also replaces common email, phone, registration-number, URL-credential, and secret-token patterns found in free text before the request; the raw answer stays in Convex. It receives no tools, web access, database function, or provider credential. Participant text is treated as untrusted data, never as instructions to change the system contract.

The model cannot:

- select or change a track or event phase on the team’s behalf;
- write an authoritative answer or silently alter the participant’s words;
- invent validation, users, novelty, progress, disclosures, or evidence;
- submit, accept, decline, rank, route, or score a team;
- write or accept the freshness attestation for the team.

Strict Structured Outputs guarantees the response shape. Application code validates the free text. It rejects a generated question in these cases:

- the question is too long;
- the question contains more than one question;
- the question uses a disallowed purpose;
- the question repeats normalized prior wording;
- the question cites stale answers;
- the question includes blocked personal/credential patterns;
- the question violates the published wording policy; or
- the question appears after the question limit.

The release evaluation suite also measures semantic repetition and ease. A rejected result uses the published fallback for that phase and purpose.

The participant confirms the freshness attestation, core track, sponsor-track entries, and the summary built from the team's verbatim idea and follow-up answers. Every answer remains editable before submission. Revising an earlier answer creates another answer version and replaces any later question generated from the old route. The model's track recommendation stays visually and structurally separate from the participant's chosen track.

The server saves an answer first, then starts interpretation in the bounded intake work pool. It gives the model a short latency budget. A valid generated question is stored as an immutable, versioned record tied to its source answers and exact model/configuration versions before it becomes visible. On timeout, refusal, invalid output, policy rejection, rate limit, or provider outage, the deterministic route graph immediately supplies the next published fallback question. A late result cannot replace a question already on screen. Model availability never blocks draft completion or submission.

### Tracks

The working event model reserves five core-track positions and supports zero or more sponsor tracks. Board has not approved the names or definitions, so the application must read the published catalog rather than ship placeholder tracks as policy.

The first saved project description pins the current immutable catalog ID directly on that team's draft. Editing the idea, choosing a core track, changing sponsor-track selections, settling a late AI recommendation, opening final confirmation, and submitting all resolve against that pin. Publishing another catalog changes the default only for teams that create a project draft afterward; an in-progress team never changes tracks or recommendation context because an operator published while it was typing.

A team confirms exactly one core track before submission. On the final review screen, the team can also opt into zero or more published sponsor tracks after reading each requirement. Selection is the team's declaration that its project meets that wording. The first release validates the immutable catalog, type, status, non-empty requirement, and distinct selection. A checkbox does not prove external tool use. Sponsor evidence, award verification, and any sponsor capacity rule require their own published policy and human/provider evidence. A sponsor track is additional eligibility. It does not replace the core track.

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

Immediately after the opening answer commits, the screen shows every published core track in a compact, readable list. A background interpretation may visually highlight at most one recommended track with one short source-based reason. The screen remains usable before that result arrives, keeps all tracks equally selectable, and may offer **Not sure yet** while the draft is incomplete. A recommendation is not a selection.

A lead may change the chosen track until final project submission. The server preserves every raw answer, removes no disclosure, marks now-irrelevant track answers as inactive rather than deleting them, and recomputes any remaining guidance. Submitted project versions keep the exact catalog and track-version IDs that reviewers saw. Choosing a track other than the recommendation is not a negative admissions signal and is excluded from admission-policy criteria.

Final project submission locks the core track and the selected sponsor-track set. There is no ordinary post-submission track-change path. A material correction requires a separately scoped operations action, records the original and corrected values, invalidates any stale admission analysis, and explicitly returns the application to human review. Changing sponsor award eligibility after submission is an evidence or award-policy decision; it does not rewrite what the team selected.

### Answer and summary behavior

- One prompt is visible at a time.
- The active answer has a clear character limit.
- The portal shows **Saving**, **Saved**, or **Could not save**.
- Back/edit creates another answer version; it does not erase the earlier text.
- A refresh or another authorized team device resumes at the same accepted session version.
- A stale device cannot overwrite a newer answer.
- The final screen is a plain project summary, not a generated deck.
- It shows the verbatim initial idea and each current follow-up question with the team's answer or skipped state.
- Immediately before submission, the portal shows the full active team with its lead, chosen track, and complete project summary.
- The warning states plainly that final submission locks team membership, the core track, and the displayed sponsor-track set. A separate explicit confirmation is required; merely arriving at the screen, pressing Enter in an earlier field, or accepting AI wording cannot submit.
- The lead submits only after confirming the preview, project summary, `fresh_for_event` attestation, core track, and sponsor entries.

## 5. Project versions

The team lead can edit a draft until submission.

Submitting creates a project version containing:

- the verbatim initial idea and ordered current follow-up snapshots, including question, purpose, source, answer or skipped state;
- the `fresh_for_event` attestation and exact participant-policy version ID;
- core-track and optional sponsor-track version IDs;
- the exact locked active team-member IDs and lead membership ID;
- final-confirmation metadata: exact participant-policy version ID, previewed draft/team/core-track versions, the exact ordered sponsor-track version IDs, confirming member, and server time;
- ordered repository set with declared kinds/purposes and the Figma link;
- demo URL, if present;
- version number;
- submitting member;
- server time;
- participant-policy, track-catalog, and atomic intake-policy version IDs.

Sponsor selection is one complete-set, team-scoped write against the current draft version. The server rejects duplicates, foreign/core/unpublished entries, and a stale version, stores the selected IDs in pinned-catalog order, and treats an exact retry or unchanged set idempotently.

The final submission mutation verifies the current participant-policy ID, every member's acceptance and class-aware profile, team-size and mixed-team rules, the previewed membership and lead, core-track version, and exact sponsor-track set. It then creates the immutable project/application version and writes the team/track lock metadata together. The browser's confirmation is keyed to the policy ID, team version, draft version, core track, and sponsor set. A policy publication, member change, leadership change, or track change clears the effective confirmation and forces the lead to review the new snapshot.

The team continues updating explicitly live fields such as demo status and checkpoint links. Editing a submitted narrative creates a new version; it never overwrites the earlier reviewer context.

At each review boundary, the backend records which project version and integration snapshots the panel received.

## 6. Application and admission

The first submitted project version becomes the team’s pre-event application.

Application states are:

`draft → submitted → under_review → accepted | waitlisted | declined`

When the reviewed evidence is almost complete, the non-terminal loop is:

`under_review → needs_information → under_review`

Accepted applications continue:

`accepted → offer_sent → confirmed | offer_expired | withdrawn`

### Application review

- A caller with `application.assign` for the exact application or event enters one active event-account email. The same transaction creates a separate active routing row and source-attributed exact-application `application.review.read` and `application.review` grants regardless of assignee role.
- The assignee sees active and completed work in a personal realtime queue. The first current-content review completes the routing row; replacing that review does not increment completion twice. Two reviewers may submit against the same unchanged application content without losing either completion.
- Canceling pending work requires the current application and assignment versions plus a reason. It revokes only assignment-sourced grants. A separately issued manual review grant continues to work, and manually granted review access does not require a routing row.
- Reviewers inspect the confirmed brief, its source answers, team composition allowed by policy, freshness attestation, starting-material disclosures, and confirmed track versions.
- Each reviewer submits an independent human recommendation: `accept`, `waitlist`, `decline`, or `needs_information`, with reason codes and a short note.
- An assignment does not include profile/year or AI-analysis access. `application.profile_context.read` and `application.ai_recommendation.read` must cover the same application independently. Reviewers cannot see peer recommendations until their own current-version recommendation is submitted.
- Admissions uses a separate, approved and publicly disclosed admission policy. The venue judging rubric and scores do not apply.
- A separately configured model may produce one structured admission recommendation. It cannot publish a decision, call an admissions mutation, or silently change queue order, capacity, or application state.

An authorized human can choose **Needs information** only with one or two short, distinct questions. The questions must be tied to the published decision-reason matrix. Publication supersedes any earlier open request. It records the exact project/content versions that support the questions. It notifies every locked team member through the same generic status channel. Publication does not unlock team membership, leadership, the core track, sponsor tracks, or any earlier project answer.

Every member can see the current questions. Only the current locked lead has exact-team `application.information.respond`. The lead answers every question in one quiet form. Submission rechecks the current application/request versions in one transaction. The same transaction rechecks the current locked project and roster, locked lead identity, and pinned admission release. It appends the exact questions and answers to a new immutable project version. It advances the team's locked-project pointer, marks the request answered, returns the application to `under_review`, and increments the application content version. Existing active assignments follow the new content version. The system supersedes prior human recommendations and returns the completed-review count to zero. A fresh optional AI recommendation uses the cumulative requested-information answers as source-linked evidence. Pending or running older AI work becomes stale. A late result for the prior content version cannot attach.

A stale, superseded, partially answered, non-lead, or duplicated response changes nothing. A later **Needs information** decision can open another one-or-two-question request. Cumulative response snapshots remain in the project history and admissions dossier.

### Published year-adjusted admission policy

The published event policy must calculate the year or study band from participant profile data. It must define the rules for mixed-year teams, postgraduate students, working professionals, and external participants. The model receives the resulting band and policy version. It does not infer experience from names, institutions, writing style, or project choice.

The initial rubric is welcoming and progressive:

| Team context | Published expectation |
| --- | --- |
| First-year band | A clear problem, genuine intent, and a workable basic idea. Missing polish or advanced technical detail is not a defect. |
| Second-year band | The first-year expectation plus a coherent user flow, plausible event-sized scope, and an initial implementation direction. |
| Third-year band | Clear scope, feasibility, relevant technical detail, meaningful risks/trade-offs, and differentiation from common versions of the idea. |
| Fourth-year/later, postgraduate, or professional band | A well-defined event-sized plan, credible technical choices, explicit feasibility/trade-offs, and clear differentiation without requiring a finished prototype or prior traction. |

Every application is considered within its published band. Track choice, choosing against the AI track recommendation, institutional prestige, writing polish, and pre-event implementation are not positive criteria. The policy cannot require work that would violate `fresh_for_event`.

The rubric is not editable after admissions starts. Before the first submission, operations publishes one complete release containing the band guidance, minimum human-review count, closed human decision reasons, overall participant capacity, and either an exact admission-model configuration or explicit human-only mode. Policy and model draft together and publish together. Publication also creates the empty overall capacity bucket for that policy. The first application submission closes draft replacement and publication for the event and stores the exact policy ID on both the immutable project and application.

Submission and publication are both authoritative Convex transactions. If they race, only one order commits: publication first means the application pins the new release; submission first means publication fails as frozen. There is no interval in which the policy pointer, model pointer, capacity bucket, project, and application can disagree. A correction or a later model run continues to use the application's pinned release.

The structured AI record contains:

- recommendation `accept | waitlist | decline | needs_information` and confidence/limitations;
- derived experience-band key and admission-policy/model-schema versions;
- criterion assessments `meets | partly_meets | not_yet_clear`, each with source answer/brief references;
- concise strengths, concerns, and at most two suggested information questions;
- an explicit statement that it is an admission aid, not a judging score or judging recommendation.

The AI must not manufacture evidence, use a numeric pseudo-score, compare identifiable teams, or treat a common idea as grounds for rejection. Invalid, stale, or unavailable analysis leaves the application fully reviewable by humans.

### Capacity and offers

The admissions page shows team and participant counts against venue capacity. Exact-application `application.decide` publishes accepted, waitlisted, declined, or needs-information decisions after checking review coverage and eligibility. The operator can explicitly use the AI recommendation, clear it, or override it with **Accept**, **Waitlist**, **Decline**, or **Needs information**; the last choice additionally requires one or two questions. The stored decision records that disposition, the human actor, reason, reviewed application version, and policy versions. Decision publication itself does not reserve a place.

A human **Accept** decision moves the application to `accepted`, the team to `admitted`, and the locked members to `selected`. That is a published selection, not event check-in and not a capacity reservation. The portal immediately unlocks a quiet next-steps view containing that state, venue/date, ordered next actions, locked team roster, confirmed track/project summary, and the event's Discord invite as the primary community/support route. These details come from the current published `communicationsPolicyVersions` row through an authenticated exact-team query; venue and Discord are not included in the unauthenticated public event payload. A later publication updates every eligible open portal through the normal Convex subscription.

After submission, the participant portal is one lifecycle home, not a dashboard of platform modules. Its main navigation is **Home**, **Code and design**, **Music**, and **Help**. The home changes with the team's current application, offer, event, and review state. It leads with the one current outcome or action. It does not repeat the same status in several cards.

The locked team remains available in one compact disclosure instead of a permanent sidebar. The project summary is also a disclosure after submission. Optional event tools render only when they contain useful information. Normal delivered-email state does not occupy the home; only a delivery problem that needs attention appears there. Queue status and an estimated wait can appear when staff have placed the team in a queue, but participants cannot place themselves or request a judging visit.

An organizer with exact-application `application.offer.manage` chooses the approved response deadline and sends the offer. One transaction verifies the accepted application, published policy, locked project, locked team, locked roster, overall capacity, and optional track capacity. It creates the immutable offer and reserves the exact locked member count. It changes the application to `offer_sent` and those members to `offer_pending`. No participant can change the roster or track at this point.

Only the submitted locked lead can respond, using the ordinary team-lead grant for exact-team `application.offer.respond`. **Confirm for team** preserves the reservation and changes the application/team/members to `confirmed`/`confirmed`/`accepted`. **Decline for team** releases the whole reservation once and leaves the immutable submitted roster intact. The deadline worker expires an unchanged open offer and releases it once; a stale worker cannot undo a confirmation. An organizer may revoke an open offer with a reason, release its reservation, and return the application/team/members to `accepted`/`admitted`/`selected` so a corrected offer can be sent. Waitlist promotion remains unavailable until the board publishes the ordering rule in O-023.

Publishing an admission decision creates one verified-email destination and one delivery record for every member in the locked submitted roster in the same Convex transaction. The current implementation sends a generic text-only message through Cloudflare Email Sending to the person's current Google-verified email. It contains no decision, project text, track, venue, Discord link, or other sensitive application content; it points to the authenticated participant portal as the source of truth. Each delivery pins the exact communications-policy version that supplied its generic subject and introduction, so a later publication cannot change an already queued message. A provider outage therefore cannot roll back the human decision or hide it from the portal.

The participant sees only a small transport status: queued, accepted by the provider, delayed, delivered to the recipient mail server, or needs attention. **Delivered** is explicitly not a read or acknowledgment signal. Discord remains the primary community/support route for selected teams, but is not the official decision record and participants are not required to leave either Discord or the portal open.

Cloudflare Email Sending publishes lifecycle events to an event-scoped Queue. The event-owned email Worker validates and reduces each event. The Worker then signs a bounded callback to Convex. The backend deduplicates by Cloudflare event ID. It applies events in deterministic provider-time/event-ID order. It disables the exact address only after a hard bounce, provider suppression, or complaint. A soft exhausted bounce remains visible but does not disable the address. Cloudflare Email Sending documents no send idempotency key. Therefore, a network timeout, invalid success response, or expired in-flight lease immediately becomes terminal `unknown`. The system never retries this outcome automatically. A structured provider rejection that proves non-acceptance can retry within the bounded attempt schedule. A manual retry is allowed only for the latest definitively failed record. The retry creates a new append-only delivery. It requires `communications.delivery.manage` for the exact person, the current delivery version, a reason, and a Google session created within the last 15 minutes. An `unknown` provider outcome must be reconciled in Cloudflare Email logs before another send. The system cannot retry the outcome without reconciliation. Reading a person's destination and detailed delivery state independently requires `communications.delivery.read` for that person. Disabling the address uses the same exact-person manage boundary. It suppresses queued attempts without claiming that an in-flight provider request was canceled.

The event's approved inbound support alias uses Cloudflare Email Routing and an Email Worker to forward to one verified operations mailbox. The alias, destination, retention, and reply policy are launch configuration under O-034; inbound messages do not become application evidence or participant commands.

Only a confirmed team can proceed to event check-in, mint the hall-location QR, or enter a review queue. A selected, offer-pending, declined, or expired team can still sign in and view its decision/status, but receives no attendance QR, hall-mapping credential, or event queue access.

Selection criteria, reviewer count, capacity/track quotas, decision visibility, and offer deadlines require event-board approval.

## 7. GitHub and Figma

The project page contains separate team connection cards. Connections belong to the team, so every active member sees the same resources, freshness, statistics, and checkpoints. A team lead confirms, classifies, reorders, replaces, or disconnects them.

### GitHub

The GitHub card is an ordered repository list. A lead can add every repository used by the project, including repositories reached through different GitHub App installations. Each row requires a kind, short purpose, tracked branch, and optional project root. Supported kinds cover full product, frontend, backend/API, mobile, desktop, AI/ML, data pipeline, hardware/firmware, infrastructure, library/SDK, docs/research, and a labeled **Other**.

Moving a row submits the complete visible repository ID/version list. The server checks that it is still the exact current non-archived set, checks every row version, and writes the compact order in one transaction. An add, archive, refresh, or another reorder racing that command makes the stale reorder fail and refresh the shared list; it cannot partly restore an older order.

Every active repository must contain `code2create-7-0`. The App has Metadata read and Contents read. GitHub requires Administration write to replace repository topics, so the production App does not auto-add a missing topic. Each affected row gives the exact topic to that repository’s administrator and rechecks it.

Each repository row updates from signed pushes and shows:

- kind, purpose, topic, installation, repository, and tracked branch/root;
- baseline and current head;
- latest push and reconciliation time;
- commits/pushes, linked and unknown authors, additions/deletions, changed files, languages, and top changed directories;
- force-push, branch, access, rate-limit, truncation, and stale warnings;
- captured checkpoint history.

Above the list, the team sees repository/kind count, topic coverage, combined activity, and complete/expected repositories. The current team summary is one materialized row rebuilt with every accepted connection, repository, sync, and webhook transition, so the participant and operations views receive the same state without scanning provider events.

Combined commit activity is explicitly **observed**. A whole-repository comparison retains the at-most-100 commit SHAs returned by the bounded comparison request. It deduplicates those identities across connected forks. The unique count is a labeled lower bound if GitHub reports more commits than the response contains. The same rule applies if the binding tracks only a project root that the commit list cannot attribute safely. In both cases, the repository/team result is partial. Per-repository provider counts remain visible. The system never invents an exact combined total or hides a failed repository. Counts are evidence. They do not form a team-member leaderboard.

Any team member can switch repositories and open the captured tree and text files at that repository’s checkpoint SHA. Provider credentials never reach the browser. Archiving a repository removes it from future checkpoint sets without deleting its earlier evidence.

### Figma

A team member authenticates with Figma and pastes one or more file URLs they can access, up to the event's published team cap. A lead confirms each file for the team. OAuth is granted by that member, but every file binding, snapshot, and statistic belongs to the team. If that account loses access, any current lead can reauthorise the affected files with another Figma account without erasing their history.

The Figma card lists every active file and shows metadata freshness separately from full-content freshness for each one. A file view includes pages, captured screens/frames, a layer browser, components/component sets/instances, auto-layout, styles, prototype flows/reactions, named versions, comment status, changed screens, and selected frame previews.

Above the files, every member sees the same compact team design summary: file completeness, pages, frames, components, nodes, prototype interactions, comments/open threads, named versions, preview readiness, and latest observed activity. This is one materialized team row rebuilt in the transaction that accepts a connection, file, metadata, full-sync, preview, or webhook transition. It is evidence and freshness context, not a measure of effort, quality, or individual contribution.

The backend uses a file webhook when the authorizer can edit and the Figma plan allows it. Metadata heartbeat and explicit checkpoints remain active because Figma's file update event can be delayed and full-file API limits vary by seat and plan. A team can request a refresh, but the portal honors provider `Retry-After` and shows the last complete snapshot while waiting.

### Disclosure

All submitted projects start at Code2Create. Teams disclose material general-purpose starting resources and any allowed pre-start setup. A sign of project-specific implementation or design before the official baseline is flagged for eligibility review rather than reclassified as a continuation. Integration activity is evidence of what changed after the baseline, not proof of quality or a score.

If the project does not use GitHub or Figma, the team explicitly marks that provider as not used and describes the alternative evidence it will present. A repository added after the event baseline deadline is labeled late. The same repository or Figma file cannot be claimed by another event team without `integration.shared_resource.override` for every affected team/resource scope.

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

At a provisioned venue-entry desk, the participant first shows one current portal attendance QR. The event app consumes it while resolving the exact confirmed team member and shows the minimum identity, team, class, credential, and prior-arrival state. That creates a two-minute server resolution bound to the operator, assigned phone, station, and member; one venue action can claim it, so reversal or a later re-check-in requires another QR. Staff compare the visible VIT ID or event-approved external photo ID, then explicitly record the one-time staffed arrival. `attendance.venue_check_in.read`, `.record`, `.override_identity`, and `.reverse` are separate exact-person permissions with an explicit event-wide option; the assigned station grant alone performs none of them. A no-ID recovery additionally requires its own permission, a reason, and a Google session created within the last 15 minutes.

On the same participant-first surface, staff may enrol and verify the barcode on the existing VIT ID or issue an unused anonymous preprinted external badge as applicable. Each activation takes two matching scans and remains independent from the arrival command. VIT ID suspension/rebinding and external badge issue/replacement/revocation keep their independent exact-person boundaries. A lost VIT ID is suspended immediately, while a suspended participant continues to use portal QR until a different card completes the two-scan rebind. The later venue-entry scan and every hacking-session confirmation are separate again; recording or reversing arrival changes neither one.

After check-in, the portal shows:

- staffed arrival: not checked in, checked in with accepted time, or reversed;
- current venue state: not arrived, inside, temporarily out, departed, or needs review;
- the active or next attendance session, location, check-in window, and whether it is required;
- the participant’s session state and latest accepted server time;
- their applicable physical credential: not enrolled, active, or suspended VIT ID; or not issued, active with printed reference, or revoked external badge;
- a short-lived personal attendance QR;
- a live correction/support action when the displayed current state is wrong;
- finalized closed-session results, present duration, and the caller’s own result-review status.

Every expected participant confirms each configured hacking session individually. A VIT student normally presents the enrolled barcode on their existing VIT ID to a staff scanner phone. An external participant uses the event-badge QR or dynamic portal QR; the portal QR is also the fallback for a VIT student whose card is forgotten or unreadable. Someone who remains inside across a session boundary still sees **On site · confirmation due** until that session is confirmed.

When the participant crosses a tracked-zone boundary during a session, an exit scan changes the state to **Temporarily out** and a return scan restores **Present**. Ordinary exits need no reason. Several exit/return intervals are valid, and a long-away alert is an operations prompt rather than an automatic penalty.

After a session fully closes, a participant who believes the finalized result is wrong may submit one short self-scoped review request. The portal shows whether it is open, approved, or declined and returns the staff’s participant-facing resolution note. A request never changes the result by itself and never exposes internal decision detail or another participant’s movement history. Approved correction changes only the derived result; the scanner ledger and intervals remain intact.

Attendance is a participant record, even when team availability is summarized. It cannot change a score, track, project evidence, or admission recommendation. Full credential, state, failure, privacy, and recovery rules are defined in **Attendance and presence**.

A team becomes eligible for staff review routing after the server verifies:

- the required number of members are checked in;
- the admission offer is confirmed;
- a hall location has been mapped;
- the submitted project passes required-field checks;
- required disclosures are complete;
- any mandatory integration or alternative evidence is present.

The participant dashboard shows the team's current hall zone and spot after mapping. Participants cannot assign, confirm, or move it themselves. If it is wrong, they show a fresh hall-location code to an authorized floor mapper, who corrects it from the physical location. Mapping starts roughly 90 minutes before a review window and is frozen 30–60 minutes before routing, subject to the final schedule.

## 10. Team codes

### Hall-location QR

A confirmed team can open a short-lived hall-location QR from its dashboard. Roving floor staff scan this code while standing with the team, then tap the team's real spot in the event app. The QR is on the team's screen; the event does not print or attach QR stickers to tables.

The opaque code is bound to the event, published floor-plan version, team, token version, and ten-minute expiry. A short manual code is available when the camera cannot read the screen. Scanning consumes the token and creates a three-minute claim owned by that exact operator and destination zone. Saving the location rechecks the plan, team, spot, current assignment version, token claim, and exact zone grant in one transaction.

Before freeze, `floor.location.map` for the destination zone is required; moving a team across zones also requires the same key for the origin zone. After freeze, the ordinary command stops working. A correction requires `floor.location.override` for every affected zone and a reason. The participant sees the result live but receives no location-write command.

This code cannot create attendance, enter a review queue, confirm reviewer presence, or change a panel assignment.

### Review check-in QR

The team home screen displays a server-issued QR for the current round.

This is a review-presence credential for assigned reviewers to scan. It is not the participant’s attendance QR and cannot create a participant venue/session presence event.

The payload contains an opaque token, not participant details. It is bound to:

- event;
- team;
- round;
- expiry;
- token version.

The QR rotates after expiry or manual revocation. A fallback code appears below it for camera failure. Reviewers still need an online server check before presence counts. Its prefix, table, token store, permissions, and server command are separate from the hall-location QR.

## 11. Staff-managed queue experience

The participant portal has no command that enters a team into a review round, chooses a panel, or changes queue priority. The review desk places a team into a panel queue through `queue.manage` for that exact panel. The server accepts the placement only when the round is open. The team and locked project must satisfy the round requirements. The panel must be operational and complete. No panel member can have a current conflict with the team.

Before placement, the participant home screen says that the review desk has not assigned the team. It updates from the authoritative queue record. The team supplies no extra declaration or status.

The participant home screen shows one of:

| State | Participant message |
| --- | --- |
| Waiting for review desk | Staff have not placed the team in this round yet |
| Queued | Current queue position, position being called, panel/table, and teams ahead |
| Called | Go to the shown table now |
| At table | Waiting for reviewers to complete presence |
| In review | Review in progress and elapsed time |
| Held | Plain reason and where to get help |
| Missed | Next action under the approved missed-call policy |
| Complete | Review recorded; next checkpoint shown |

The queue displays a coarse five-minute-bucketed window. The estimate starts with the configured review duration. After three valid samples, it uses the bounded median of up to nine recent completed reviews. It adds the current panel review's remaining time and the number of queued teams ahead. It widens the upper bound for handover delay. The estimate disappears while the round is paused. It never displays an exact appointment time that floor delays will break.

## 12. Shared music

Accepted participants have a small **Music** page during a published Synesthesia window. It shows the licensed catalog source, window end, personal request/vote usage, current track, catalog search, and the live request queue.

A participant can request only a track returned by the current event catalog, vote or remove their vote, and report one visible request with a short reason. A vote guides the playback operator and never guarantees playback. Rejected requests show their requester the public reason; hidden requests disappear. A Synesthesia-only suspension leaves the participant's event, team, attendance, project, admission, and review access unchanged.

The page has no provider login, free-form provider search, audio player, exact play-time promise, participant queue-order control, or project engagement score.

## 13. Between reviews

Confirmed teams receive three configured project updates tied to the published `ideation`, `intermediate_update`, and `final_update` phase windows. Each update is a small shared team flow:

1. answer one plain-language progress question;
2. answer one short configured reflection;
3. review both answers;
4. explicitly submit the immutable update.

The team may edit the shared draft until submission. Every save compares the exact draft version, so two devices cannot silently overwrite each other. Any active member may write or submit; the actor is retained. This avoids blocking the team when its lead is busy or temporarily away. Submission cannot enter a queue, call a team, start a review, or change a score.

The phase end is the due time. A separately configured grace period may keep the update open as visibly late; after the close time it becomes read-only. Missing or late updates remain factual operations context and do not create an automatic judging penalty.

After Review 1, the team also sees:

- commitments agreed at the review;
- project answers or disclosures that must be updated;
- the next checkpoint;
- released feedback;
- GitHub/Figma connection health.

When operations starts a review, its evidence transaction pins the latest submitted team update that exists at that moment alongside the GitHub/Figma snapshot set. Later edits, submissions, schedule changes, or provider refreshes cannot alter that review. The reviewer sees the pinned update as project context, not a score or recommendation. The verified round export preserves the same relation.

Raw scores stay hidden until the event’s feedback policy releases them.

## 14. Support and recovery

- Support is available as soon as the authenticated event account exists; unfinished profile, team, or intake work does not hide the route.
- A participant or reviewer chooses a short category, writes a factual description, and receives a collision-checked public code. There is no chat bot, severity picker, or participant-controlled escalation state.
- Their list and timeline update from the same accepted case and action records used by operations. They can add a reply while a case is open, investigating, waiting, or resolved; replying to a waiting or resolved case reopens it. A closed case stays closed and the person opens a new case if the problem returns.
- Reporter-visible replies and state changes are separate from internal notes and ownership history. A reporter never receives an internal note or another person's case.
- A participant can report a wrong hall location, team-membership issue, integration disconnect, attendance problem, queue problem, accessibility need, or safety issue. Linking a case to a team, review, or attendance session changes no domain state and grants no access to that record.
- Support staff see only the records covered by their person-specific event-wide or exact-case read grants; role and ownership do not expand that view. Managing a case requires a separate event-wide or exact-case manage grant.
- Case creation, reply, and staff update use stable operation IDs. Staff updates also compare the current case version, require an audit reason, and append rather than rewrite timeline actions.
- Every blocked screen names the failing condition and offers the support route when the current account retains it. A technical correlation code may accompany the case, but is not itself the support case.
- Refreshing, changing devices, or reinstalling a browser does not duplicate team membership or submissions.
- If the venue network fails, participants keep their QR visible from a short-lived local cache, but review presence still waits for server validation or an authorized manual incident process.

## 15. Acceptance checks

- Both account-class paths reach Google sign-in and the server derives the final class.
- Required name, contact, institution, and year/current-role fields follow the published class-aware participant policy and never enter intake-model input.
- Publishing a participant policy is an optimistic, reasoned, fresh-authenticated pointer swap. Competing drafts leave one winner. The new version becomes unaccepted on each event membership, and a saved profile becomes incomplete for it until its owner explicitly accepts it and supplies any newly required fields.
- Policy acceptance rejects a stale publication and records one exact membership acceptance under an idempotent operation.
- Create and join reject an ineligible participant or missing current acceptance. Join also rejects a full team or a disallowed mixed-class result. Neither command requires profile completion.
- Final submission independently rejects a stale participant-policy version, an out-of-range team, a disallowed mixed-class team, or an active member whose profile is incomplete for that exact publication.
- A participant cannot belong to two active teams.
- Two users cannot claim the same rostered/team identity through a duplicated invite.
- Team membership and an accepted leadership transfer update every authorized team view without refresh and preserve exactly one lead.
- Leaving, removal, and leadership transfer compare the live team version, cancel stale pending transfers, and revoke only grants sourced from the affected membership or lead assignment.
- The guided profile resumes at the first unfinished question after refresh.
- Saving the opening idea makes the complete track list usable immediately, even while interpretation is pending or unavailable.
- The introduction asks no more than two follow-ups; a common-idea match can produce only a supportive reflection question. The separate live novelty signal remains directional, exposes no prior project text, and can never block submission.
- Debounced novelty requests use the pinned corpus and native 1,536-dimension vector contract; concurrent duplicates create one request, stale results cannot attach to changed text, and provider failure leaves intake fully usable.
- The novelty signal is absent from the submitted project/application, admission recommendation and human review context, reviewer evidence, queue state, judging, exports, and awards.
- The recommended track and chosen track remain separate, and choosing another published track cannot reduce an admission assessment.
- Final submission fails if the previewed member set, lead, draft, core track, or sponsor-track set changed; a successful retry creates one project/application version and one matching team/track lock.
- Submitting twice with the same operation ID creates one project version.
- An exact-account assignment creates only the two source-attributed review grants, appears in that person's queue, and completes once when a current-content review is saved.
- Assignment cancellation and review submission serialize on current state. Cancellation revokes no manual grant; concurrent reviewers on unchanged content leave two recommendations and a completed count of two.
- `application.review.read` cannot expose peer recommendations before the caller submits, and neither it nor `application.review` exposes profile/year or AI context without its separate grant.
- A structured AI admission recommendation names its policy/model versions and source fields, cannot publish a decision, and can be used, cleared, or overridden only through a human admissions action.
- First-year expectations remain intentionally lighter than later-year expectations, and a mixed/external team's band follows the published deterministic rule rather than model inference.
- An accepted portal view leads with the current outcome or action and shows venue/date, next steps, locked team/project summary, and Discord without repeated status cards; an important status change also produces a recorded notification delivery.
- After submission, the locked team and project summary stay available through compact disclosures. Empty optional tools and healthy delivery telemetry add no page furniture.
- The participant navigation uses product destinations, and no participant control can place the team in a review queue or request a judging visit.
- Every locked team member receives a separate decision-delivery record for the Google-verified email current at publication; no email contains the decision or project text.
- Duplicate, callback-before-response, or out-of-order Cloudflare lifecycle events converge on one delivery state, only a hard bounce/suppression/complaint can disable that exact destination, and provider delivery never appears as participant acknowledgment.
- A person-scoped delivery reader sees only covered recipients. A manual retry fails without exact-person manage authority, a fresh session, current versions, latest definitively failed state, and a reason; an unknown outcome exposes no retry path.
- An accepted team cannot check in until its offer is confirmed.
- Venue check-in, venue presence, and hacking-session confirmation cannot satisfy one another accidentally.
- A venue check-in reversal preserves its historical row, changes no presence/session record, and allows a later new staffed arrival. The current team check-in count controls review-routing eligibility. The coarse team milestone alone does not control eligibility.
- A VIT ID barcode, external event-badge QR, or current portal QR produces the same server-owned attendance state.
- An external badge is not active after one scan; the second matching scan commits issue or atomic replacement, while revocation retires the active badge and any unfinished successor together.
- A forgotten or unreadable VIT ID uses QR or staffed recovery; Code2Create does not issue another electronic credential.
- A participant sees only their own movement history and no sensitive reason attached to another team member’s absence.
- Leaving and returning during a session creates accurate intervals without removing the participant from the event or team.
- A missing live scan produces a compensating-correction route before close; a disputed finalized result produces one versioned post-session review route. Neither creates an automatic judging or eligibility decision, and neither edits the original scan evidence.
- Expiring an offer releases capacity without deleting the application decision.
- GitHub/Figma disconnects are visible without deleting captured checkpoints.
- A second request for an already-visible track returns the existing request and offers a vote; rejected or hidden tracks cannot create an invisible duplicate.
- Music request, vote, moderation, report, pause, and playback state reach the participant page from the same accepted records used by operations.
- A music vote, request, report, or access suspension cannot change admission, attendance, review routing, project evidence, or judging.
- A staff queue placement appears in operations and participant queue views from the same accepted write; no participant command can create it.
- Participant and reviewer support surfaces can create, list, open, and reply to only their own cases. A retry cannot duplicate a case or reply, and a reporter never sees an internal action.
- Support ownership grants no read or manage authority. A case-linked team, review, round, or attendance session also grants no authority and no support command can alter attendance, queue placement, judging, admission, team membership, or permissions.
- The participant never receives another team’s private project, queue, or review data.
