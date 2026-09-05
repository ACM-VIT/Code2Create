# AGENTS.md

Follow the repository-root `AGENTS.md` and these Worker-specific rules.

- Convex is the sole source of event truth. Durable agent state is work state, never participant, admission, operations, judging, or permission state.
- Expose only explicit signed service routes. Do not mount a general agent router, public chat surface, or database proxy.
- Give an agent only purpose-built, redacted, frozen inputs. Never hand it a broad Convex credential or direct domain mutation tool.
- A model result is untrusted input. Parse it strictly and let Convex revalidate source versions, evidence references, permission boundaries, and race-sensitive state.
- Keep every tool narrow and specific to its agent surface. Brief, copilot, autopilot, episode, and idea-submission agents have distinct read, analysis, publication, and recommendation contracts. Recommendations are proposals for human review; an agent cannot execute the event action it describes.
- Use create-only durable identities for retry deduplication and make callbacks idempotent. A timeout, retry, stale source checksum, or competing settlement must have one deterministic outcome.
- Keep observability content-free. Do not log prompts, snapshots, model output, request bodies, signatures, or secrets.
- Use pnpm scripts and the checked-in Flue/Vite/Wrangler configuration. Do not introduce EAS, Vercel, Next.js, another database, or another queue.

The agent source lives in `src/agents/`, route handlers in `src/routes/` are composed in `src/app.ts`, transport and autonomy modules live in `src/lib/`, application-owned Worker exports live in `src/cloudflare.ts`, and Durable Object migrations live in `wrangler.jsonc`. Read `README.md` for the current agent surfaces and their contracts.

For changes here, choose relevant checks from `package.json`. `pnpm --filter @code2create/intelligence test` includes deterministic autonomy evaluations and spends no model tokens. `pnpm --filter @code2create/intelligence eval` also runs the live brief evaluation when `OPENAI_API_KEY` is available and spends real tokens; use it when live model behavior needs validation, and report whether it ran or was skipped.
