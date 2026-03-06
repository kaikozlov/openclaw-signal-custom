# openclaw-signal-custom

Standalone repo for a custom fork of the OpenClaw Signal plugin.

## Branch model

- `upstream-signal`: snapshot mirror of `openclaw/openclaw` `extensions/signal`.
- `main`: your custom plugin branch.

## Current behavior

This repo is moving toward a true standalone channel for stock upstream releases:

- plugin id: `signal-custom`
- channel id: `signal-custom`
- package name: `@openclaw/signal-custom`
- config root: `channels.signal-custom`

What is standalone today:

- config/account resolution
- onboarding/setup
- outbound sends
- reactions, ACK reactions, polls, stickers, edit/delete, silent send
- directory/group lookup and group-management actions
- retry + TCP socket transport
- configurable `signal-cli --config` path and validated daemon spawn path
- local daemon startup
- local status probe
- local monitor/inbound event handling, including JSON-RPC receive fallback
- richer inbound Signal context: styles, link previews, stickers, contacts, polls, quote/edit metadata, attachment captions/dimensions
- gateway startup wired to the local monitor

What still remains after the standalone baseline:

- audit the remaining generic runtime helper seams
- port additional Signal hardening/watchlist PRs

## Sync upstream Signal changes

Run:

```bash
./scripts/sync-upstream.sh
```

Then merge into your custom branch:

```bash
git switch main
git merge upstream-signal
```

If there are conflicts, resolve them in favor of your intended custom behavior.

## Publish/use in OpenClaw

From your OpenClaw checkout, load this plugin repo path or package and enable `signal-custom`.

Typical local path flow:

```bash
openclaw plugins install -l /path/to/openclaw-signal-custom
openclaw plugins enable signal-custom
openclaw plugins disable signal
```

Config lives under `channels.signal-custom`.
