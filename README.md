# openclaw-signal-custom

A standalone Signal channel plugin for [OpenClaw](https://github.com/nicosql/openclaw), powered by `signal-cli`. Plugin id: `signal-custom`, config root: `channels.signal-custom`. Requires OpenClaw `>= 2026.3.24`.

This is a drop-in replacement for the bundled Signal channel. It covers the full `signal-cli` surface — DMs, groups, media, reactions, polls, stickers, stories, mentions, message editing, group admin, and more — with tested transport, clean formatting, and an access-control model that actually works.

## Features

**Messaging**
- Send and receive text, media, and view-once media
- Markdown-to-Signal formatting with native text styles (bold, italic, strikethrough, etc.)
- Native `@mentions` with automatic offset remapping from Markdown
- Reply/quote threading, silent sends, typing indicators, read receipts
- Configurable text chunking for long messages
- Block and draft streaming modes for long replies

**Group chat**
- Per-group `requireMention` mode and tool/skill policies
- Group management: add/remove members, promote admins, ban, and update name/description/avatar
- Group-specific allowlists and system prompts

**Rich content**
- Sticker packs (send and list installed packs)
- Reactions (send, remove, configurable notification level including ACK reactions)
- Polls (create, vote, receive results)
- Stories (send replies, receive inbound story context)
- Message edit and delete (local and remote)
- Link previews and shared contacts

**Inbound handling**
- DM access policies: open, pairing flow, or allowlist
- Group access policies: open or allowlist
- Local attachment-store fast path (skips network round-trip when `configPath` is set)
- Clean media prompt shaping — no junk injected into model context
- Audio transcription compatibility

**Transport**
- Auto-spawn and monitor a local `signal-cli` daemon, or connect to an external one
- HTTP JSON-RPC and TCP socket transports
- SSE event streaming with JSON-RPC polling fallback
- Shared reconnect policy with supervised gateway restarts

## Install

For a local repo checkout:

```bash
git clone <your-repo-url> openclaw-signal-custom
cd openclaw-signal-custom
pnpm install
```

`pnpm install` only installs this repo's dependencies. It does not register the
plugin with OpenClaw.

Link the repo into OpenClaw for development:

```bash
openclaw plugins install -l /absolute/path/to/openclaw-signal-custom
```

Check that OpenClaw sees it:

```bash
openclaw plugins inspect signal-custom
```

Then restart the gateway so the linked plugin is picked up cleanly:

```bash
openclaw gateway restart
```

If you do not want the bundled Signal channel running alongside it:

```bash
openclaw plugins disable signal
```

If you use `plugins.allow`, add the plugin explicitly:

```bash
openclaw config set plugins.allow '["signal-custom"]' --strict-json
```

## Setup

### Local daemon (recommended)

The plugin spawns and manages `signal-cli` for you. Point it at your Signal account:

```bash
openclaw config set channels.signal-custom.account '"+15551234567"' --strict-json
openclaw config set channels.signal-custom.configPath '"/Users/you/.local/share/signal-cli"' --strict-json
openclaw config set channels.signal-custom.cliPath '"signal-cli"' --strict-json
openclaw config set channels.signal-custom.autoStart true --strict-json
```

Set `configPath` to your `signal-cli` data directory. This is strongly recommended — it enables the local attachment fast path and lets the daemon find your account data.

### External daemon

Connect to an already-running `signal-cli` JSON-RPC instance:

```bash
openclaw config set channels.signal-custom.account '"+15551234567"' --strict-json
openclaw config set channels.signal-custom.httpUrl '"http://127.0.0.1:8080"' --strict-json
openclaw config set channels.signal-custom.autoStart false --strict-json
```

### Multi-account

Run multiple Signal accounts under one plugin:

```json5
{
  channels: {
    "signal-custom": {
      defaultAccount: "personal",
      accounts: {
        personal: {
          account: "+15551234567",
          configPath: "/Users/you/.local/share/signal-cli",
          autoStart: true,
        },
        work: {
          account: "+15559876543",
          configPath: "/Users/you/.local/share/signal-cli-work",
          autoStart: true,
        },
      },
    },
  },
}
```

## Configuration

All config lives under `channels.signal-custom` in your OpenClaw config file
(`openclaw.json`, which uses JSON5 syntax), or via `openclaw config set`.
See [src/config.ts](./src/config.ts) for the full schema with types and defaults.

### Connection

| Key | Type | Description |
|-----|------|-------------|
| `account` | string | Signal phone number |
| `configPath` | string | `signal-cli` config directory (enables local attachment fast path) |
| `httpUrl` | string | URL of an external JSON-RPC daemon |
| `cliPath` | string | Path to `signal-cli` binary (default: `"signal-cli"`) |
| `autoStart` | boolean | Spawn a local daemon automatically (default: `true`) |
| `receiveMode` | string | `on-start` or `manual` receive subscription mode |

### Access control

| Key | Default | Description |
|-----|---------|-------------|
| `dmPolicy` | `"pairing"` | `open`, `pairing`, `allowlist`, or `disabled` |
| `allowFrom` | — | DM sender allowlist (E.164, UUID, or `"*"`) |
| `groupPolicy` | `"allowlist"` | `open` or `allowlist` |
| `groupAllowFrom` | — | Group sender allowlist |

### Messaging

| Key | Description |
|-----|-------------|
| `textChunkLimit` | Max characters per outbound text chunk |
| `streaming` | `off`, `block`, or `draft` reply streaming mode |
| `silentIntermediateReplies` | Send non-final auto-reply chunks with Signal `noUrgent` (default: `true`) |
| `typingTtlMs` | Max duration for typing indicators |
| `sendReadReceipts` | Send read receipts on inbound messages |
| `responsePrefix` | Prefix applied to all bot replies |
| `mediaMaxMb` | Max inbound media size in MB |
| `replyToMode` | `off`, `first`, or `all` reply-tag forwarding policy |
| `directoryRefreshTtlMs` | Contact/group directory cache refresh TTL in milliseconds |

`silentIntermediateReplies` only affects outbound auto replies that this plugin sends during a multi-part response. It maps to Signal's `noUrgent` send flag for intermediate chunks. Signal may still surface those earlier messages when a later urgent message arrives and opens the thread.

### Runtime resilience

| Key | Description |
|-----|-------------|
| `reconnect.initialMs` | Initial transport reconnect delay in milliseconds |
| `reconnect.maxMs` | Max transport reconnect delay in milliseconds |
| `reconnect.factor` | Exponential backoff multiplier for transport reconnects |
| `reconnect.jitter` | Jitter ratio for transport reconnects |
| `reconnect.maxAttempts` | Max reconnect attempts before the outer supervisor restarts the gateway cycle |
| `supervision.initialMs` | Initial full-cycle restart delay in milliseconds |
| `supervision.maxMs` | Max full-cycle restart delay in milliseconds |
| `supervision.factor` | Exponential backoff multiplier for supervised restarts |
| `supervision.jitter` | Jitter ratio for supervised restarts |
| `supervision.maxAttempts` | Max supervised restart attempts before the account is marked failed |
| `supervision.drainGraceMs` | Grace period before managed daemon shutdown during gateway stop/restart |

### Exec approvals

Signal can act as an exec-approval surface through per-account `execApprovals`:

```json5
{
  channels: {
    "signal-custom": {
      execApprovals: {
        enabled: true,
        approvers: ["+15550001111"],
        target: "dm", // "dm", "channel", or "both"
      },
    },
  },
}
```

Use `target: "dm"` to route approvals through direct chats, `target: "channel"` for group-only routing, or `target: "both"` to allow both.

### Reactions

| Key | Default | Description |
|-----|---------|-------------|
| `reactionLevel` | `"minimal"` | `off`, `ack`, `minimal`, or `extensive` |
| `reactionNotifications` | `"own"` | `off`, `own`, `all`, or `allowlist` |
| `ackReaction` | — | Emoji sent as ACK when level is `"ack"` |

### Actions

Fine-grained toggles under `actions`:

```json5
{
  channels: {
    "signal-custom": {
      actions: {
        reactions: true,
        unsend: true,
        poll: true,
        editMessage: true,
        deleteMessage: true,
        pinMessage: true,
        stickers: true,
        groupManagement: true,
      },
    },
  },
}
```

### Group settings

Per-group configuration under `groups.<group-id>`:

```json5
{
  channels: {
    "signal-custom": {
      groups: {
        "<group-id>": {
          requireMention: true,
          enabled: true,
          allowFrom: ["+15551112222"],
          systemPrompt: "You are a helpful assistant.",
          skills: ["web-search"],
          tools: {
            allow: ["read", "write"],
            deny: ["exec"],
          },
        },
      },
    },
  },
}
```

You can also inspect your active config path and edit the file directly:

```bash
openclaw config file
```

## Development

```bash
pnpm typecheck
pnpm test
```
