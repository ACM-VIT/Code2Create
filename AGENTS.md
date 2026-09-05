# AGENTS.md

## Working approach

- Treat requests for action as instructions to implement and verify the result. Carry the authorized task to completion rather than stopping at a plan or offering to continue.
- Resolve routine implementation choices from the relevant code, types, tests, and specifications. Ask only when an unresolved choice materially changes product behavior, scope, or an irreversible action; continue independent work while awaiting the answer.
- Use authorization already provided in the conversation. Complete authorized preparation before requesting any additional approval so the user can review a concrete result.
- Incorporate corrections and new requirements into the active task. Answer side questions without abandoning the original objective unless the user cancels or replaces it.
- Read the relevant parts of `README.md`, `specs/`, and the affected package's instructions and scripts. Keep investigation scoped to the change and preserve unrelated working-tree edits.

## Implementation principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Ensure every requirement, workflow, and implementation makes practical sense in real use. Correct obvious inconsistencies within the requested scope and surface material product ambiguities using the working approach above.
- Use pnpm for dependency, workspace, script, and CLI execution. Do not add npm or Yarn lockfiles or instructions.
- Keep TypeScript strict and model untrusted input explicitly. Do not use `any`, `as any`, `as unknown`, or `unknown as`; parse external values into named types and make race-sensitive transitions transactional and idempotent.
- Do not add defensive branches, wrappers, or abstractions for states the product contract makes impossible. Enforce the invariant at the owning boundary and keep callers simple.
- Build and sign Expo native applications locally and serve Expo Updates from the event-owned Cloudflare Worker/R2 service. Do not introduce EAS Build, EAS Update, or Expo Push Service.

## Skills and instruction files

- Apply skills relevant to the task. Explicit user instructions take precedence over skill guidelines; do not infer additional approval requirements from general advice.
- If a skill causes a pause, permission request, or departure from the requested work, link the exact `SKILL.md`, quote the relevant instruction, and explain its effect. Distinguish an explicit requirement from your interpretation.

## Verification and reporting

- Choose checks that exercise the changed behavior. Use the affected package's existing scripts, such as `pnpm --filter @code2create/web typecheck` or a relevant backend `test:*` script. Cover affected consumers when changing shared contracts.
- Add regression tests for meaningful behavior changes and bug fixes. For documentation or other low-impact edits, inspect the diff and validate references instead of adding tests that repeat the implementation.
- Complete required checks. Once they pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it. Use `pnpm check:release` for release validation, not as the default for every edit.
- Keep progress updates and the final response concise and concrete. Report what changed, what verification actually ran, and any remaining blocker; do not claim checks passed when they were skipped or could not run.
