# Signal Custom Plugin Task List

## Phase 0: Repo Foundation

- [x] Create migration plan docs
- [x] Wire CI (`typecheck` + `vitest`)
- [x] Add upstream sync tracking

## Phase 1: Standalone Channel Surface

- [x] Change plugin channel id to `signal-custom`
- [x] Change manifest channel list to `signal-custom`
- [x] Add plugin-local Signal config schema
- [x] Add plugin-local Signal account resolver
- [x] Move plugin config root to `channels.signal-custom`
- [x] Add plugin-local onboarding/setup for `signal-custom`
- [x] Keep legacy `signal:` target prefixes accepted for compatibility

## Phase 2: Port Existing PR Stack

- [x] Port outbound/actions slices from your 12 PRs
- [x] Port retry/backoff
- [x] Port TCP socket transport
- [x] Port directory/group lookup
- [x] Port group-management actions
- [x] Add tests proving `channels.signal-custom` drives the plugin

## Phase 3: Finish Option 2

- [x] Copy local `daemon.ts`
- [x] Copy local `probe.ts`
- [x] Copy local `monitor.ts`
- [x] Copy local `monitor/access-policy.ts`
- [x] Copy local `monitor/event-handler.ts`
- [x] Copy local `monitor/event-handler.types.ts`
- [x] Copy local `monitor/mentions.ts`
- [x] Replace hard-coded built-in `signal` inbound metadata with `signal-custom`
- [x] Swap `gateway.startAccount` to local monitor
- [x] Swap `status.probeAccount` to local probe

## Phase 4: Hardening After Standalone Inbound Lands

- [x] Audit remaining generic runtime seams
- [x] Decide whether to replace the remaining generic runtime helper usage
- [x] Port probe reliability fixes (`#33851`, `#34177`)
- [x] Port inbound edge-case fixes (`#34546`, `#28417`, `#31232`, `#32026`)
- [x] Port defensive guard fixes (`#35931`, `#35600`, `#35490`)
- [x] Review pairing/allowlist isolation fixes (`#26029`, `#26617`, `#26639`)

## Phase 5: Remaining Open Signal PR Queue

- [x] Port inbound multi-attachment support (`#30959`; `#6591` parallel fetch behavior covered locally)
- [x] Port group-level allowlist support (`#29154`)
- [x] Port mention-metadata fallback for `requireMention` (`#29345`)
- [x] Port inbound + outbound native quote/reply support (`#24273`, `#36630`)
- [x] Port identity/reaction compatibility fixes (`#10958`, `#17818`, `#17453`, `#31347`)
- [x] Port DM route isolation fix for `session.dmScope=per-channel-peer` (`#31739`)
- [x] Port native JSON-RPC WebSocket receive loop (`#19398`)
- [x] Implement `reactionLevel: "ack"` behavior (`#31078`)
- [ ] Review lower-priority candidates (`#8767`, `#27771`, `#15994`, `#15956`, `#16085`)

## Rules

1. Copy first, shim second, rewrite last.
2. Keep `npm run check` green after every slice.
3. Update this file and `MIGRATION_MAP.md` whenever the boundary changes.
4. Treat Option 2 baseline as done only when config, outbound, daemon, probe, inbound, and gateway are all local.
