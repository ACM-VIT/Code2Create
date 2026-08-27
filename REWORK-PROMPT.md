# Code2Create 7.0 — product-oriented rework

## Mission

Rework Code2Create 7.0 so that every surface is product-oriented and everything makes sense.

**Product-oriented** means each screen, flow, name, and state exists because a specific person at the event needs it at a specific moment, is organized around what that person is trying to do, and speaks in words they understand.

**Makes sense** means you can walk any journey end to end as that person and never hit a step that is confusing, out of order, dead-ended, mislabeled, or unexplained.

You are not adding features. You are reshaping what exists until the product reads like it was designed outward from the people using it, not upward from the database.

## Read before touching anything

1. `README.md` — platform overview, surfaces, ports, local full-flow testing.
2. `AGENTS.md` — binding engineering rules: no backward compatibility, simplest implementation that fully meets requirements, grow in layers, strict TypeScript, no speculative abstraction.
3. `specs/00-product-brief.md` and `specs/01-domain-and-access.md` first, then the other `specs/*.md` as the area you're touching requires. `README.md` and `specs/*.md` are the sole source of truth for behavior.

The product is an event operating system for a 48-hour hackathon: ~900–1,000 people, one venue, two ordinary reviews and a final round. Surfaces: participant portal (`apps/web`, :5180), operations dashboard (`apps/ops`, :5181), handbook renderer (`apps/handbook`, :5182), reviewer Expo app (`apps/reviewer`), Convex backend (`apps/backend`), and the intelligence, email, and updates workers.

## The product test — five questions

Every screen, state, action, and message must answer these. If you cannot answer them, that is a finding to fix. If the honest answer is "nobody, for no job", delete it.

1. **Who is looking at this?** One of: participant (VIT or external), team lead, Supreme, Board, SC, JC, External Judge — at a specific moment in the event.
2. **What are they trying to do right now?** The job, in one sentence: "find out when my review is", "fill the empty seat on Panel 3", "clock in and get my first page".
3. **Does the screen lead with that job?** The most important true fact first, the primary action next, everything else after or elsewhere.
4. **Is the next action obvious and legal?** Show only the legal next actions for the current state — Event setup already works this way ("only its legal next action"); apply the same rule everywhere. No mystery disabled buttons: an unavailable action is either absent or explained in one sentence.
5. **When it goes wrong, does the screen tell the truth?** Empty, loading, denied, failed, and stale states each say what is true and what to do next. A missing permission is explained in human terms ("You need the queue-management grant for this hall — an access admin can give it to you"), never a blank panel or a raw error.

## The event arc is the spine

Everything hangs off where the event is: setup → applications open → admissions and offers → teams locked and confirmed → event live (attendance, queues, review 1, review 2, final) → results → closed.

- Every surface must know where the event is in that arc and lead with what matters *now*.
- A screen surfacing a pre-event concern mid-event (or the reverse) without a reason is a finding.
- Time is a first-class fact. People at the venue think in event time — "hour 26 of 48", "review 2 calls begin around 14:00" — so show it that way.

## What product-oriented means concretely

- **Screens map to jobs, not tables.** No grid-because-the-collection-exists. An ops workspace is "run the review floor", not "browse the panels table". If a page is a thin skin over a Convex table, redesign it around the decisions its user actually makes there.
- **Words a person can read.** Carry "name every state in words a person can read" to completion: every label, state, button, toast, email, and empty state is plain product language. No enum-speak, no internal codenames, no raw IDs where a name exists. The same concept has the same name on every surface — a "panel" on the ops board is a "panel" in the reviewer app and in the spec.
- **The UI never lies about state.** What is rendered reflects the server, live where the spec says live. No optimistic state that can strand someone, no stale queue positions, no "submitted" that is not.
- **No dead ends.** Every screen has somewhere to go. Empty states say why they are empty and what fills them ("No applications yet — applications open when an organizer opens them from Event setup"). Terminal states say what happens next in the real world.
- **One thing at a time where the product promises it.** The one-prompt-at-a-time intake, the ordered next steps, the only-legal-next-action setup — that is the product's character. Do not flatten these into forms and grids; extend the same character to flows that lack it.
- **Nothing asks for what the system already knows.** Prefill it, derive it, or drop the field.
- **Delete what serves no one.** Unreachable routes, fields no screen renders, flags nothing reads, components without a caller, states no transition can produce — remove them. AGENTS.md forbids compatibility layers; deletion is the fix.

## Method

Work surface by surface, and keep the whole product working end to end at every step — never trade a working product for unfinished complexity.

1. **Inventory.** For each app, list every route, screen, and workspace, and every user-facing state on it. Tag each with persona + job + arc moment. Anything you cannot tag is a finding.
2. **Walk the journeys.** Use a clean local or staging deployment with real Google accounts. Create the event and every test state through the product or an ordinary authorized operator workflow; do not use seed data, identity bypasses, or synthetic provider success. Walk at minimum:
   - **Participant:** sign in → profile → team formation → project intake → final confirmation → proposal edits until the deadline → admission status → offer response → attendance QR → queue status → review history.
   - **First-run owner:** empty deployment → event setup → open applications.
   - **Ops mid-event:** event health → live review board → fill the empty panel seat → deal with the overdue review and the held team → attendance → a support case.
   - **Reviewer:** sign in → clock in → receive a page → scan → review context → score draft → submit → brief connection loss.
   - **Each staff label** (Supreme, Board, SC, JC, External Judge) with a representative grant bundle — and once with **no grants**, to see exactly what denial looks like.
3. **Record findings before fixing.** Every point where you would be confused, misled, stuck, or shown the wrong thing as that person, written down with the persona and moment.
4. **Fix in journey order, not codebase order.** The step a person hits first gets fixed first.
5. **Verify after each surface.** Re-walk the affected journeys against the dedicated test event, and keep `pnpm check:product` and `pnpm test` green.

## Guardrails — what product-oriented does NOT mean

- **Never weaken the model underneath.** Roles never authorize; atomic scoped grants with validity windows do. Immutable policy, rubric, and release versions; append-only records; transactional, idempotent transitions — all of it stays. Product-orientation means making these *comprehensible*, not making them soft.
- **Specs stay the source of truth.** When a spec detail collides with practical sense, follow AGENTS.md: correct the obvious inconsistency and update the corresponding spec section in the same change so behavior and spec never drift. When a material doubt cannot be resolved from the available context, stop and ask instead of inventing product behavior.
- **No new scope.** No new features, integrations, or settings unless a journey literally cannot be completed without one. The output of this rework is coherence, not surface area.
- **Engineering rules hold.** pnpm only; strict TypeScript with no `any`, `as any`, or `unknown as`; no speculative configuration; prefer the dependencies already in the project; no EAS.

## Definition of done

- Every screen in every app passes the five questions.
- Every user-visible word is plain language, and the same concept is named identically on every surface.
- Every journey above is walkable start to finish with real test accounts and product-created data, without reading code, a spec, or the database to know what to do next.
- No orphan routes, dead fields, unreachable states, or unexplained controls remain.
- `pnpm check:product` and `pnpm test` pass, `pnpm dev` full flow works, and the specs match shipped behavior.

Report findings and fixes surface by surface as you go, not as one dump at the end.
