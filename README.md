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

**Group chat**
- Per-group `requireMention` mode and tool/skill policies
- Group management: add/remove members, promote admins, ban/unban, update name/description/avatar
- Group-specific allowlists, system prompts, and history limits

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
- Automatic reconnection with exponential backoff

## Install

```bash
git clone <your-repo-url> openclaw-signal-custom
cd openclaw-signal-custom
pnpm install
```

Install into OpenClaw and enable:

```bash
openclaw plugins install -l /absolute/path/to/openclaw-signal-custom
openclaw plugins enable signal-custom
```

If you don't want the bundled Signal channel running alongside it:

```bash
openclaw plugins disable signal
```

If you use `plugins.allow`, add the plugin explicitly:

```yaml
plugins:
  allow:
    - signal-custom
```

## Setup

### Local daemon (recommended)

The plugin spawns and manages `signal-cli` for you. Point it at your Signal account:

```yaml
channels:
  signal-custom:
    enabled: true
    account: "+15551234567"
    configPath: "/Users/you/.local/share/signal-cli"
    cliPath: "signal-cli"       # optional, defaults to "signal-cli"
    autoStart: true
```

Set `configPath` to your `signal-cli` data directory. This is strongly recommended — it enables the local attachment fast path and lets the daemon find your account data.

### External daemon

Connect to an already-running `signal-cli` JSON-RPC instance:

```yaml
channels:
  signal-custom:
    enabled: true
    account: "+15551234567"
    httpUrl: "http://127.0.0.1:8080"
    autoStart: false
```

### Multi-account

Run multiple Signal accounts under one plugin:

```yaml
channels:
  signal-custom:
    enabled: true
    defaultAccount: "personal"
    accounts:
      personal:
        account: "+15551234567"
        configPath: "/Users/you/.local/share/signal-cli"
        autoStart: true
      work:
        account: "+15559876543"
        configPath: "/Users/you/.local/share/signal-cli-work"
        autoStart: true
```

## Configuration

All config lives under `channels.signal-custom` in your OpenClaw YAML config. See [src/config.ts](./src/config.ts) for the full schema with types and defaults.

### Connection

| Key | Type | Description |
|-----|------|-------------|
| `account` | string | Signal phone number |
| `configPath` | string | `signal-cli` config directory (enables local attachment fast path) |
| `httpUrl` | string | URL of an external JSON-RPC daemon |
| `cliPath` | string | Path to `signal-cli` binary (default: `"signal-cli"`) |
| `autoStart` | boolean | Spawn a local daemon automatically (default: `true`) |

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
| `typingTtlMs` | Max duration for typing indicators |
| `sendReadReceipts` | Send read receipts on inbound messages |
| `responsePrefix` | Prefix applied to all bot replies |
| `mediaMaxMb` | Max inbound media size in MB |

### Reactions

| Key | Default | Description |
|-----|---------|-------------|
| `reactionLevel` | `"minimal"` | `off`, `ack`, `minimal`, or `extensive` |
| `reactionNotifications` | `"own"` | `off`, `own`, `all`, or `allowlist` |
| `ackReaction` | — | Emoji sent as ACK when level is `"ack"` |

### Actions

Fine-grained toggles under `actions`:

```yaml
channels:
  signal-custom:
    actions:
      reactions: true
      unsend: true
      poll: true
      editMessage: true
      deleteMessage: true
      stickers: true
      groupManagement: true
```

### Group settings

Per-group configuration under `groups.<group-id>`:

```yaml
channels:
  signal-custom:
    groups:
      "<group-id>":
        requireMention: true
        enabled: true
        allowFrom: ["+15551112222"]
        systemPrompt: "You are a helpful assistant."
        historyLimit: 50
        skills: ["web-search"]
        tools:
          allow: ["read", "write"]
          deny: ["exec"]
```

## Development

```bash
pnpm typecheck
pnpm test
```
