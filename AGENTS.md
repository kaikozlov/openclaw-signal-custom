# Repository Guidelines

- Repo: https://github.com/kaikozlov/openclaw-signal-custom
- In chat replies, file references should be repo-root relative (example: `src/channel.ts:80`), not `~/...`.
- This repo is a standalone OpenClaw channel plugin, not the OpenClaw core repo. Keep changes scoped to the plugin implementation unless the user explicitly asks otherwise.

## Project Structure & Module Organization

- Source code lives under `src/`.
- Channel entrypoints and plugin glue live at the repo root and in `src/` (`index.ts`, `setup-entry.ts`, `src/channel.ts`, `src/runtime.ts`, `src/runtime-api.ts`).
- Signal-specific transport and behavior lives under `src/signal/`.
- Tests are colocated as `*.test.ts`.
- Reference material lives under `REFERENCE_UNTRACKED/`. Treat it as read-only unless the user explicitly asks you to edit it.
- Keep the canonical plugin id aligned where applicable:
  - `openclaw.plugin.json:id`
  - `package.json:name`
  - `package.json:openclaw.channel.id`
- This repo mirrors OpenClaw channel patterns where useful, but it does not own OpenClaw core surfaces such as CLI wiring, app UIs, Mintlify docs, mobile apps, or maintainer release tooling.

## Import Boundaries

- Treat `openclaw/plugin-sdk/*` and local plugin barrels such as `src/runtime-api.ts` as the supported dependency surface.
- Do not import OpenClaw core internals such as `openclaw/src/**`, `src/plugin-sdk-internal/**`, or another plugin's source directly.
- Prefer routing shared plugin-facing behavior through `src/runtime-api.ts` rather than scattering direct `openclaw/plugin-sdk/*` imports everywhere.
- If the plugin needs a seam that does not exist in the public Plugin SDK, stop and surface that constraint instead of reaching into OpenClaw internals.
- Keep imports inside this repo rooted to this plugin package. Do not add relative imports that escape the package boundary.

## Build, Test, and Development Commands

- Runtime baseline: Node `22+`.
- Install deps: `pnpm install`
- Type-check: `pnpm typecheck`
- Test: `pnpm test`
- Full local gate: `pnpm check`
- If a command fails because dependencies are missing, run `pnpm install` once and retry the exact command.
- For narrowly scoped changes, prefer the narrowest meaningful validation first, for example `pnpm test -- src/signal/send.test.ts`.
- Before committing or pushing, do not leave behind failing typecheck or test results caused by your change or plausibly related to the touched surface.
- There is no `build`, docs, coverage, docker-test, or maintainer release workflow in this repo unless the user adds one later. Do not invent those requirements in this file.

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing and explicit contracts.
- Avoid `any`. Never add `@ts-nocheck`.
- Keep behavior aligned with OpenClaw channel conventions when that improves compatibility, but prefer this repo's local patterns over cargo-culting core-repo abstractions that do not exist here.
- Keep files focused. Extract helpers instead of creating ad hoc `V2` copies.
- Add brief comments only where logic is non-obvious.
- Prefer composition or explicit helper functions over prototype mutation.
- In tests, prefer per-instance stubs over patching class prototypes unless the test clearly requires prototype-level behavior.
- Written English should use American spelling in code, comments, docs, and UI strings.
- Use `OpenClaw` for product naming and `openclaw` for package names, config keys, and code identifiers where appropriate.

## Plugin Scope Guardrails

- This repo owns the Signal channel plugin implementation only.
- Do not add instructions or code here for OpenClaw core CLI wiring, app UI, Mintlify docs, mobile apps, macOS packaging, release notarization, Fly deploys, or maintainer-only operational workflows unless the user explicitly asks for that work.
- When changing channel behavior, think in terms of plugin boundaries:
  - channel config
  - outbound sending
  - inbound monitoring
  - account resolution
  - transport to `signal-cli`
  - message and group actions
- If a requested change would require OpenClaw core behavior, call that out explicitly instead of silently coupling this plugin to core internals.

## Testing Guidelines

- Framework: Vitest.
- Naming: match source files with `*.test.ts`.
- Run `pnpm test` when you change logic.
- For small changes, run the most direct targeted test you can, then broaden to `pnpm test` or `pnpm check` when the surface warrants it.
- Tests should clean up timers, env, globals, mocks, sockets, temp directories, and module state.
- Do not update snapshots, baselines, or expected outputs just to silence failures without understanding the underlying behavior change.
- If a meaningful targeted test does not exist, say so and use the next most direct validation available.

## Commit & Git Guidelines

- Use concise, action-oriented commit messages.
- Group related changes together. Avoid bundling unrelated refactors.
- Do not create merge commits on `main`.
- If `main` has moved and the user asks you to push, rebase your work onto the latest `origin/main` rather than merging.

## Security & Configuration Tips

- Never commit real phone numbers, Signal account data, auth tokens, session data, or live local paths from a real machine.
- Use obviously fake placeholders in docs, tests, and examples.
- Do not edit `node_modules`.
- If you need repo-local ignores for agent tooling or scratch files, prefer `.git/info/exclude` over changing `.gitignore` unless the ignore should be shared.

## Collaboration / Safety Notes

- When answering questions, verify in code and respond with high-confidence answers only.
- Bug investigations should read the relevant local code and any relevant dependency code before concluding root cause.
- Do not create, apply, or drop `git stash` entries unless explicitly requested.
- Do not create or modify git worktrees unless explicitly requested.
- Do not switch branches unless explicitly requested.
- When the user says `commit`, commit only your changes. When the user says `commit all`, include all changes in sensible grouped chunks.
- When the user says `push`, you may rebase onto the latest remote changes, but do not discard unrelated work.
- If other files are dirty, leave unrelated work untouched and focus on the requested surface.
