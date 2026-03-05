# Sync Status

Generated (UTC): 2026-03-05 22:05:59

Main branch: `main`
Upstream snapshot branch: `upstream-signal`

- `main` commits ahead of `upstream-signal`: 24
- `upstream-signal` commits ahead of `main`: 0

## Commits In `main` Not In `upstream-signal`

- cb1a9d2 Signal: verify pairing isolation invariants
- d59bd39 Signal: harden monitor and reaction guards
- 9c5e6e1 Signal: harden inbound event handling
- 3f4d8bf Signal: harden probe for JSON-RPC-only daemons
- 68b5062 Signal: remove built-in action fallback
- 8213f66 Signal: add local monitor and inbound stack
- 07222e9 Signal: add local daemon and probe
- 740a92e Signal: make signal-custom a standalone channel baseline
- ef5e09c Docs: refresh sync status
- ccf272a Signal: route outbound sends through local sender
- dcf3f18 Signal: port #27155 socket transport and finalize PR parity
- 101ccc4 Signal: port #27149 local reaction handling
- 1f6c0a3 Signal: port #27171 group-management actions
- 2d8f9f4 Signal: port #27147 directory/group lookup modules
- e86ce90 feat: port signal sticker actions with local rpc wiring
- 7bb4b21 feat: port signal edit and delete actions via local rpc
- def6dac feat: port signal rpc typed error and retry client foundation
- 1df7954 feat: harden signal reaction prevalidation in plugin
- 910a220 feat: add signal payload mention passthrough support
- 99bf226 feat: add migration task board and port ws1 signal adapter slices
- f10016a feat: start signal migration with ws1 channel patches and sync tracking
- 5d06220 ci: add github actions checks for typecheck and tests
- adf0c1a feat: rename plugin identity to signal-custom
- 3881ad9 chore: bootstrap signal-custom fork and upstream sync workflow

## Files Diverged Between Branches

- .github/workflows/ci.yml
- .gitignore
- MIGRATION_MAP.md
- README.md
- SYNC_STATUS.md
- TASKS.md
- index.ts
- openclaw.plugin.json
- package-lock.json
- package.json
- scripts/sync-status.sh
- scripts/sync-upstream.sh
- src/channel.outbound.test.ts
- src/channel.test.ts
- src/channel.ts
- src/config.test.ts
- src/config.ts
- src/constants.ts
- src/markdown/ir.ts
- src/onboarding.ts
- src/runtime.ts
- src/signal/client.test.ts
- src/signal/client.ts
- src/signal/daemon.ts
- src/signal/directory.test.ts
- src/signal/directory.ts
- src/signal/format.ts
- src/signal/groups.test.ts
- src/signal/groups.ts
- src/signal/identity.ts
- src/signal/inbound-debounce.ts
- src/signal/monitor.edge-cases.test.ts
- src/signal/monitor.pairing-isolation.test.ts
- src/signal/monitor.test.ts
- src/signal/monitor.ts
- src/signal/monitor/access-policy.ts
- src/signal/monitor/event-handler.ts
- src/signal/monitor/event-handler.types.ts
- src/signal/monitor/mentions.ts
- src/signal/probe.test.ts
- src/signal/probe.ts
- src/signal/rpc-context.ts
- src/signal/send-actions.test.ts
- src/signal/send-actions.ts
- src/signal/send-reactions.test.ts
- src/signal/send-reactions.ts
- src/signal/send.test.ts
- src/signal/send.ts
- src/signal/socket-client.test.ts
- src/signal/socket-client.ts
- src/targets.ts
- tsconfig.json
