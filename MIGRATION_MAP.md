# Signal Plugin Migration Map

This is the living plan for turning the copied Signal work into a true standalone `signal-custom` channel that runs on stock OpenClaw releases.

## Goal

Make `openclaw-signal-custom` usable without patching upstream core:

- plugin id: `signal-custom`
- channel id: `signal-custom`
- config root: `channels.signal-custom`

## Strategy

1. Copy existing Signal logic first.
2. Keep behavior aligned with your PRs.
3. Only rewrite seams that were hard-coded to the built-in `signal` channel.
4. Track every remaining runtime dependency explicitly.

## Current Baseline

Done now:

- standalone channel id and manifest wiring (`signal-custom`)
- plugin-local Signal schema and account resolver
- plugin-local onboarding/setup for `channels.signal-custom`
- plugin-local outbound sends, mentions, silent sends, reactions, stickers, edits, deletes
- plugin-local directory, groups, and group-management actions
- plugin-local retry and TCP socket transport
- plugin-local daemon scaffolding and status probe

Still not standalone:

- inbound monitor/provider lifecycle
- runtime group-policy helper fallback
- runtime fallback for unported message actions

## Workstreams

| Workstream | Scope | Source PRs | Status |
|---|---|---|---|
| WS1 | Standalone identity/config/account surface | structural | Done |
| WS2 | Outbound/action parity on `signal-custom` | #27104, #27107, #27108, #27145, #27146, #27148, #27149, #27169, #27171 | Done |
| WS3 | RPC hardening + TCP transport on `signal-custom` | #27144, #27155 | Done |
| WS4 | Standalone monitor/provider lifecycle | built-in Signal monitor stack | Next |
| WS5 | Inbound hardening + external Signal PR watchlist | #34546, #28417, #31232, #32026, #33851, #34177, others | Pending |

## Your PR Matrix

| PR | Scope | Status in plugin repo |
|---|---|---|
| #27104 | blockStreaming capability | Done |
| #27107 | group-policy adapter behavior | Done on plugin surface |
| #27108 | mention strip patterns | Done |
| #27144 | typed RPC errors + retry/backoff | Done |
| #27145 | outbound edit/delete | Done |
| #27146 | stickers + sticker search | Done |
| #27147 | directory/group lookup | Done |
| #27148 | outbound native mentions | Done |
| #27149 | reaction hardening | Done |
| #27155 | TCP socket transport | Done for plugin-local RPC and default outbound |
| #27169 | silent sends (`noUrgent`) | Done |
| #27171 | group-management actions | Done |

## Remaining Runtime Seams

- `src/channel.ts`
  - fallback `getSignalRuntime().channel.signal.messageActions`
  - `getSignalRuntime().channel.groups.resolveRequireMention`
  - `getSignalRuntime().channel.groups.resolveGroupPolicy`
  - `getSignalRuntime().channel.signal.monitorSignalProvider`
- `src/signal/send.ts`
  - `channel.media.saveMediaBuffer`
  - `channel.text.resolveMarkdownTableMode`

The first three are the real blockers for full Option 2 parity. The last two are generic runtime utilities and are acceptable unless they become unstable.

## Next Copy Set

Copy/adapt from upstream core into this repo:

1. `src/signal/monitor.ts`
2. `src/signal/monitor/access-policy.ts`
3. `src/signal/monitor/event-handler.ts`
4. `src/signal/monitor/event-handler.types.ts`
5. `src/signal/monitor/mentions.ts`
6. any direct helper deps that are not exported through `openclaw/plugin-sdk`

## Hard Rule

Do not write new Signal behavior when copied logic or a thin compatibility shim will do. The plugin should stay structurally close to upstream Signal so reintegration stays possible.
