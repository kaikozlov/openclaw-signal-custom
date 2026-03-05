# openclaw-signal-custom

Standalone repo for a custom fork of the OpenClaw Signal plugin.

## Branch model

- `upstream-signal`: snapshot mirror of `openclaw/openclaw` `extensions/signal`.
- `main`: your custom plugin branch (same logic, custom plugin id/name, plus your changes).

## Initial behavior

This repo keeps channel behavior equivalent to upstream Signal, but changes plugin identity so it can be enabled separately:

- plugin id: `signal-custom`
- package name: `@openclaw/signal-custom`

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
