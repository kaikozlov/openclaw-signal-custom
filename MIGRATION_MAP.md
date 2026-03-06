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
- plugin-local daemon, status probe, monitor, and inbound event handling
- plugin-local gateway startup wired to the local monitor

Still not fully hardened:

- generic runtime helper usage for media staging / markdown table mode
- remaining hardening is mostly generic-runtime cleanup, not known Signal ownership gaps

## Workstreams

| Workstream | Scope | Source PRs | Status |
|---|---|---|---|
| WS1 | Standalone identity/config/account surface | structural | Done |
| WS2 | Outbound/action parity on `signal-custom` | #27104, #27107, #27108, #27145, #27146, #27148, #27149, #27169, #27171 | Done |
| WS3 | RPC hardening + TCP transport on `signal-custom` | #27144, #27155 | Done |
| WS4 | Standalone monitor/provider lifecycle | built-in Signal monitor stack | Done |
| WS5 | Inbound hardening + external Signal PR watchlist | #34546, #28417, #31232, #32026, #33851, #34177, #35931, #35600, #35490, #24273, #36630, #10958, #17818, #17453, #31347, #31739, #19398, #31078, #8767, #27771, others | Probe + inbound + guard + quote/reply + reaction compatibility + dmScope isolation + JSON-RPC receive fallback + ACK reactions + daemon/config hardening done |

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

## Integrated PR Summary

Current PR-backed port count:

- your PRs ported: `12`
- other Signal PRs ported: `23`
- total PR-backed ports integrated: `35`

Your PR set now integrated here:

- #27104
- #27107
- #27108
- #27144
- #27145
- #27146
- #27147
- #27148
- #27149
- #27155
- #27169
- #27171

Additional open Signal PRs already ported here:

- #30959
- #29154
- #29345
- #24273
- #36630
- #10958
- #17818
- #17453
- #31347
- #31739
- #19398
- #31078
- #8767
- #27771
- #33851
- #34177
- #34546
- #28417
- #31232
- #32026
- #35931
- #35600
- #35490

Reviewed and regression-covered here without code changes:

- #26029
- #26617
- #26639

## Remaining Runtime Seams

- `src/signal/send.ts`
  - `channel.media.saveMediaBuffer`
  - `channel.text.resolveMarkdownTableMode`
- `src/signal/monitor.ts`
  - generic runtime text/media helpers used for chunking + inbound media storage
- `src/signal/monitor/event-handler.ts`
  - generic runtime reply/routing/session/pairing helpers

These are generic host utility seams, not built-in `signal` ownership seams. The plugin now owns the channel-specific config, outbound, daemon, probe, inbound, gateway flow, and action routing.

Decision:

- keep the remaining generic runtime seams
- do not copy shared host utilities just to eliminate SDK calls

Why:

- these helpers are channel-agnostic host services, not built-in Signal behavior
- copying them would create unnecessary divergence from upstream
- keeping them shared improves reintegration odds and reduces maintenance cost

## Next Copy Set

Focus after the standalone baseline:

1. watch for new Signal PRs that materially improve the standalone channel

## Open Signal PR Review (2026-03-05)

Review source:

- `gh api /search/issues?q=repo:openclaw/openclaw+is:pr+is:open+label:"channel: signal"`

Current snapshot:

- open PRs with `channel: signal`: `75`
- already accounted for here: `23`
- remaining unported PRs reviewed: `52`

### Priority Queue

These are the remaining open Signal PRs that look materially useful for `signal-custom`.

1. Native Signal quote/reply support
   - PRs: #24273, #36630
   - Reference: #20732
   - Why: current plugin flattens inbound quote context and does not emit native outbound quote params
2. Identity + reaction compatibility hardening
   - PRs: #10958, #17818, #17453, #31347
   - Why: current plugin still has UUID/source fallback gaps and incomplete newer reaction/control payload support
3. DM route isolation
   - PR: #31739
   - Why: needed when `session.dmScope=per-channel-peer`
4. Native `signal-cli` WebSocket receive loop
   - PR: #19398
   - Why: current plugin inbound monitor still depends on SSE `/api/v1/events`
5. ACK reaction behavior
   - PR: #31078
   - Why: `reactionLevel: "ack"` exists in config but is not yet implemented

### Newly Landed From This Review

- `#30959`: inbound media arrays now preserve all fetched attachments
- `#29154`: group-level allowlist support now flows through Signal group gating
- `#29345`: `requireMention` now uses Signal mention metadata when regex patterns are absent
- `#24273`: inbound Signal quote context now populates `ReplyToId`, `ReplyToBody`, `ReplyToSender`, and `ReplyToIsQuote`
- `#36630`: local outbound replies now attach native Signal quote metadata on the first sent chunk/media item
- `#10958`: UUID allowlist entries now match senders when Signal provides both `sourceNumber` and `sourceUuid`
- `#17818`: legacy `source` sender fallback is now accepted for older Signal payloads
- `#17453`: group reaction sends can now hydrate `targetAuthor`/`targetAuthorUuid` from a local inbound cache
- `#31347`: newer reaction envelope shapes and edit/delete/pin/unpin control events are now handled locally
- `#31739`: isolated DM scopes no longer overwrite main-session last-route metadata
- `#19398`: the monitor now falls back to JSON-RPC `receive` polling when SSE `/api/v1/events` is unavailable
- `#31078`: `reactionLevel: "ack"` now sends immediate ACK reactions before reply dispatch, with shared scope gating
- `#8767`: daemon startup now rejects unsafe `cliPath` values before spawning `signal-cli`
- `#27771`: `configPath` is now supported and passed through as `signal-cli --config ...` on local daemon startup
- `#6591`: parallel attachment fetch behavior is covered locally, but the PR's extra UX/quote formatting pieces are not yet ported

### Lower-Priority Candidates

- #15994: unsend + poll lifecycle actions
- #15956: broad inbound metadata preservation bundle
- #16085: container REST-mode compatibility

### Reviewed But Not New Priority Work

- #25543 duplicates #29154 in practice
- #26061 is effectively covered by current local probe behavior
- #10709 is already covered by local JSON parse guards
- hook/core-wide PRs remain useful upstream work, but they are not Signal-plugin-first tasks

## Hard Rule

Do not write new Signal behavior when copied logic or a thin compatibility shim will do. The plugin should stay structurally close to upstream Signal so reintegration stays possible.
