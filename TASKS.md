# Signal Custom Plugin Task List

This is the execution checklist. We keep it updated as we land each slice.

## Phase 0: Foundation

- [x] Create migration reference map (`MIGRATION_MAP.md`)
- [x] Wire CI (`typecheck` + `vitest`)
- [x] Add upstream sync + divergence tracking (`sync-upstream.sh`, `sync-status.sh`)

## Phase 1: Quick Wins (plugin-local, low risk)

- [x] Port `#27104` blockStreaming capability declaration
- [x] Port `#27108` mention strip pattern (`U+FFFC`)
- [x] Port `#27169` silent send plumbing (`silent` passthrough in outbound adapter)
- [x] Port `#27107` groups dock adapter behavior where possible at plugin boundary

## Phase 2: WS1 Outbound/Action Parity

- [ ] Port `#27149` reaction hardening (in progress: action prevalidation + normalization guards landed)
- [ ] Port `#27148` outbound native mentions (in progress: payload mention passthrough landed)
- [ ] Port `#27146` stickers + sticker search (in progress: plugin-local sticker actions landed)
- [ ] Port outbound subset of `#27145` edit/delete support (in progress: plugin-local actions landed)

## Phase 3: WS2 RPC + Transport

- [ ] Port `#27144` typed RPC errors + retry/backoff (in progress: plugin-local client landed)
- [ ] Port probe reliability improvements (`#33851`, `#34177`)
- [ ] Port `#27155` TCP socket transport

## Phase 4: WS3 Directory + Group Actions

- [x] Port `#27147` directory/group lookup modules
- [x] Port `#27171` group management + member info actions

## Phase 5: Security + Hardening

- [ ] Port allowlist/pairing isolation set (`#26029`, `#26617`, `#26639`)
- [ ] Port defensive guards (`#35931`, `#35600`, `#35490`)
- [ ] Port inbound envelope edge-case fixes (`#34546`, `#28417`, `#31232`, `#32026`)

## Phase 6: Decide Scope Ceiling

- [ ] Decide whether to port large inbound parity sets (`#15956`, `#15994`, `#16085`, `#16704`)

## Working Rules

1. Small slices only (one feature/fix cluster per commit).
2. Run `npm run check` for every slice before commit.
3. After each upstream sync, regenerate `SYNC_STATUS.md`.
4. Update this file and `MIGRATION_MAP.md` on every landed slice.
