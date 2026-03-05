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
- [ ] Copy local `monitor.ts`
- [ ] Copy local `monitor/access-policy.ts`
- [ ] Copy local `monitor/event-handler.ts`
- [ ] Copy local `monitor/event-handler.types.ts`
- [ ] Copy local `monitor/mentions.ts`
- [ ] Replace hard-coded built-in `signal` inbound metadata with `signal-custom`
- [ ] Swap `gateway.startAccount` to local monitor
- [x] Swap `status.probeAccount` to local probe

## Phase 4: Hardening After Standalone Inbound Lands

- [ ] Port probe reliability fixes (`#33851`, `#34177`)
- [ ] Port inbound edge-case fixes (`#34546`, `#28417`, `#31232`, `#32026`)
- [ ] Port defensive guard fixes (`#35931`, `#35600`, `#35490`)
- [ ] Review pairing/allowlist isolation fixes (`#26029`, `#26617`, `#26639`)

## Rules

1. Copy first, shim second, rewrite last.
2. Keep `npm run check` green after every slice.
3. Update this file and `MIGRATION_MAP.md` whenever the boundary changes.
4. Do not claim Option 2 is done until inbound/gateway is local.
