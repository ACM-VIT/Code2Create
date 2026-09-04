# Advisory admissions shortlist

The Ops workspace is `/admissions/shortlist`. It never applies admission decisions, releases results, or contacts participants. Read access requires event-wide application, profile-context and AI-assessment reads; starting or retrying additionally requires AI-assessment run permission.

## Selection

1. Freeze the submitted/under-review pool, published policy/model, source versions and existing commitments. Use locked roster counts, not estimated team sizes.
2. Wait for current individual idea assessments. Preserve their criterion-based Accept / Waitlist / Decline ladder.
3. Extract cited user, problem, workflow, mechanism, deliverable, distinction, domain and premise evidence from the idea and **all four actual follow-up questions**. Separate premise credibility from implementation difficulty. Exclude romantic matchmaking, not ordinary community or teammate tools.
4. Retrieve the nearest 12 semantic neighbours per eligible proposal, plus exact concept profiles. Compare the original answers directly. Similar vocabulary or shared AI does not establish overlap; pair preferences do not imply transitive clusters.
5. Rank within original quality tiers by direct overlap preferences and criterion evidence. Domain/workflow variety breaks equal-evidence ties. Choose a whole-team prefix near the requested people target, within ±5 and never beyond remaining real capacity. Do not weaken quality floors to fill places.
6. Consider displaced qualifying teams for Waitlist before original Waitlist teams. Preserve reasons, preferred overlapping alternatives, ties and cycles. Missing analysis is unresolved, not a rejection.
7. Independently audit bounded overlapping slices and recheck source/decision freshness before publishing the advisory snapshot. These checks are not proof of exhaustive duplicate detection.

The existing copilot cohort read returns this same completed snapshot summary, not a second vote/time-based ranking. The existing human decision and release workflows are unchanged.

## Work boundaries

- Maximum 1,000 applications; preparation/comparison inputs are paged.
- Existing admission workpool: at most 16 live dispatches; a slot remains occupied while its model task runs.
- Signed, create-only Worker tasks identified by job ID and attempt. Callbacks validate exact citations and frozen sources. Expiration starts at dispatch, not while queued. Retrying preserves successful tasks; old attempts cannot settle new ones.
- Separate ingress/callback HMAC contexts. No model receives a Convex credential, arbitrary database tool or admission mutation.
- New policy/model/content/release changes require a new snapshot. Bump `shortlistVersion` for shortlist semantic changes and the idea-agent release when its assessment prompt changes.

## Local seed evaluation — no Convex connection

From the repository root, with `OPENAI_API_KEY` supplied in the process environment:

```sh
pnpm --filter @code2create/backend shortlist:seed --concurrency 16
```

The runner reads `outputs/data/admissions-review-seed-source.json`, uses the same structured model/profile/comparison functions as the Worker, and writes private local artifacts under `outputs/shortlist-seed/<fingerprint>/`. It has no Convex client, callback or deployment step. OpenAI calls incur usage charges. Raw participant identifiers, contact details and team names are removed from model projections; participant-supplied links are not fetched.

`manifest.json` records the source/code fingerprint and assumptions. Successful model tasks are cached and parsed again on restart with the same fingerprint. `report.json` contains every team's suggestion, original quality, profile, direct comparisons and audit warnings; `review.md` groups teams for inspection. Reports and raw seed data are ignored by Git.

**This export lacks locked rosters, experience bands, the published event policy and previous AI assessments.** The local runner uses repository-default first-year guidance, freshly evaluates individual quality, and assumes four people per team. Its people totals are simulations, not actual admission totals. Historical similarity tools are unavailable during local individual-quality calibration; current-pool overlap is evaluated in the later comparison stage.

For synthetic premise/category/overlap regression fixtures and the exported cough example:

```sh
pnpm --filter @code2create/intelligence shortlist:local --sample-seed ../../outputs/data/admissions-review-seed-source.json
```

Never start `convex dev`, deploy, push seed data, or apply human decisions as part of this local evaluation workflow.
