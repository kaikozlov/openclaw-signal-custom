# Signal Plugin Migration Map

This is the living plan for moving Signal improvements into the standalone plugin repo with the least rewrite possible.

## Goal

Make `openclaw-signal-custom` the source of truth for Signal behavior while staying easy to sync with upstream OpenClaw.

## Core Strategy (Copy-Mostly)

1. Copy Signal logic modules into this plugin repo first.
2. Add thin adapters for missing internals (`compat` layer) only where needed.
3. Keep rewrites limited to:
   - import path changes
   - config/runtime plumbing changes
   - plugin registration/wiring
4. Avoid changing behavior during migration; do behavior changes in follow-up commits.

## Current Baseline

- Plugin repo: `openclaw-signal-custom`
- Branches:
  - `upstream-signal` = upstream snapshot branch
  - `main` = custom branch
- CI: typecheck + tests wired on `main`

## What Must Stay in Plugin Surface

- Channel adapter (`src/channel.ts`)
- Runtime bridge (`src/runtime.ts`)
- Plugin manifest and metadata (`index.ts`, `openclaw.plugin.json`, `package.json`)
- Signal action/capability wiring exposed through plugin APIs

## Workstreams

| Workstream | Scope | Source PRs | Rewrite Level | Status |
|---|---|---|---|---|
| WS1 | Outbound + reactions + mentions + silent send | #27149, #27169, #27148, #27146, #27145 (outbound parts) | Low | Done |
| WS2 | RPC client + probe + transport | #27144, #27155; plus external #33851/#34177 | Medium | In progress |
| WS3 | Directory + groups + group-management actions | #27147, #27171 | Medium | Done |
| WS4 | Monitor/inbound pipeline parity (larger core coupling) | external #15956, #15994, #31232, #32026, #34546, #28417 | High | Backlog |
| WS5 | Security/pairing/group allowlist hardening | external #26029, #26617, #26639, #29154/#25543 | Medium | Planned |

## Your PR Port Matrix

| PR | Title (short) | Primary target in plugin repo | Expected rewrite | Status |
|---|---|---|---|---|
| #27104 | declare `blockStreaming` capability | `src/channel.ts` | Very low | Done |
| #27107 | groups dock adapter | `src/channel.ts` + helper module | Low | Done |
| #27108 | mention strip patterns | `src/channel.ts` | Very low | Done |
| #27144 | typed RPC errors + retry/backoff | `src/signal/client.ts` (plugin-local copy) | Medium | Done |
| #27145 | outbound edit/delete | `src/signal/send.ts` + actions wiring | Medium | Done |
| #27146 | outbound stickers + search | `src/signal/send.ts` + action wiring | Medium | Done |
| #27147 | directory/group lookup RPC + adapter | `src/signal/directory.ts`, `src/signal/groups.ts`, `src/channel.ts` | Medium | Done |
| #27148 | outbound native mentions | `src/signal/send.ts` | Low | Done |
| #27149 | reaction hardening | `src/channel.ts` action prevalidation/normalization + local send-reactions parity | Low | Done |
| #27155 | persistent TCP socket transport | `src/signal/socket-client.ts`, `src/signal/client.ts` | Medium/High | Done |
| #27169 | silent sends (`noUrgent`) | `src/channel.ts` outbound passthrough + future local send module | Very low | Done (adapter passthrough) |
| #27171 | group management/member info actions | action + groups/directory modules | Medium | Done |

## External Signal PR Watchlist (Import Candidates)

### High-value reliability/safety (small-medium first)

- #35931 guard unsafe `URL`/`Buffer` inputs
- #35600 catch unhandled async promise chains
- #35490 defensive string guards in monitor/reactions
- #34546 accept `syncMessage: null` envelopes
- #28417 keep valid group `dataMessage` when `syncMessage` also exists
- #33851 / #34177 probe fallback and RPC-first probing
- #31232 ignore system messages (expiration/group permission noise)
- #32026 drop bare emoji reaction envelopes before dispatch

### Security hardening cluster

- #26029 isolate group allowlist from pairing-store entries
- #26617 keep DM pairing-store entries out of group allowlists
- #26639 scope pairing approvals to `accountId`

### Large feature sets (mine selectively after core slices)

- #15956 enhanced inbound message handling
- #15994 unsend + poll actions
- #16085 container REST support
- #16704 REST lock contention/perf changes

## Boundaries: When We Copy vs Rewrite

Copy as-is when:

- Logic is self-contained under Signal modules and uses stable SDK/runtime hooks.

Adapter rewrite only when:

- Module depends on non-exported OpenClaw internals.
- Module assumes core config schema files owned by the main repo.
- Module assumes runtime registration points outside plugin seams.

## Execution Loop (for every slice)

1. Pick one slice from WS1/WS2/WS3.
2. Copy source module(s) from the corresponding PR branch or upstream file.
3. Patch imports/config/runtime wiring minimally.
4. Run plugin checks (`npm run check`).
5. Update this file:
   - mark row status
   - note blockers
   - link commit/PR.

## Sync Tracking

- Run `./scripts/sync-upstream.sh` to refresh `upstream-signal`.
- The sync script now also updates `SYNC_STATUS.md`.
- `SYNC_STATUS.md` is the canonical quick diff between `main` and `upstream-signal`:
  - commit divergence
  - file-level divergence

## Tracking Checklist

- [x] WS1 outbound/actions slice merged
- [ ] WS2 RPC/probe slice merged
- [x] WS3 directory/groups slice merged
- [ ] WS5 security hardening slice merged
- [ ] Decide whether WS4 full inbound parity is needed

## Notes

- Target outcome is not “zero fork forever”; it is “small, stable plugin-owned fork with predictable upstream sync.”
- Prefer small incremental merges over one large parity dump.
