# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Ensure every requirement, workflow, and implementation makes practical sense in real use. Correct obvious inconsistencies instead of blindly following them. When a material doubt cannot be resolved from the available context, ask the user before proceeding.
- Use pnpm for dependency, workspace, script, and CLI execution. Do not add npm or Yarn lockfiles or instructions.
- Keep TypeScript strict and model untrusted input explicitly. Do not use `any`, `as any`, `as unknown`, or `unknown as`; parse external values into named types and make race-sensitive transitions transactional and idempotent.
- Do not add defensive branches, wrappers, or abstractions for states the product contract makes impossible. Enforce the invariant at the owning boundary and keep callers simple.
- Build and sign Expo native applications locally and serve Expo Updates from the event-owned Cloudflare Worker/R2 service. Do not introduce EAS Build, EAS Update, or Expo Push Service.
