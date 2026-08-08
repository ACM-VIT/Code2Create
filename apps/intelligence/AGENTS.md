# AGENTS.md

Follow the repository-root `AGENTS.md` and these Worker-specific rules.

- Convex is the sole source of event truth. Durable agent state is work state, never participant, admission, operations, judging, or permission state.
- Expose only explicit signed service routes. Do not mount a general agent router, public chat surface, or database proxy.
- Give an agent only purpose-built, redacted, frozen inputs. Never hand it a broad Convex credential or direct domain mutation tool.
- A model result is untrusted input. Parse it strictly and let Convex revalidate source versions, evidence references, permission boundaries, and race-sensitive state.
- Keep every tool narrow. The current operations agent may only publish its bounded brief callback; it cannot execute the next action it describes.
- Use create-only durable identities for retry deduplication and make callbacks idempotent. A timeout, retry, stale source checksum, or competing settlement must have one deterministic outcome.
- Keep observability content-free. Do not log prompts, snapshots, model output, request bodies, signatures, or secrets.
- Use pnpm scripts and the checked-in Flue/Vite/Wrangler configuration. Do not introduce EAS, Vercel, Next.js, another database, or another queue.
- Keep TypeScript strict. Do not use `any`, `as any`, `as unknown`, or `unknown as`; parse untrusted values into named types.
- Prefer the smallest end-to-end capability over a general agent abstraction. Delete obsolete scaffold routes and examples instead of retaining compatibility paths.

The agent source lives in `src/agents/`, explicit routes in `src/app.ts`, Worker exports in `src/cloudflare.ts`, and the Durable Object migration in `wrangler.jsonc`.
