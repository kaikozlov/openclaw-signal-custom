#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REPO_URL="${UPSTREAM_REPO_URL:-https://github.com/openclaw/openclaw.git}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Fetch only the Signal plugin folder snapshot from upstream.
git -C "$TMP_DIR" init -q
git -C "$TMP_DIR" remote add upstream "$UPSTREAM_REPO_URL"
git -C "$TMP_DIR" fetch --depth=1 upstream "$UPSTREAM_REF"

# Commit snapshot to upstream branch.
git -C "$REPO_ROOT" switch upstream-signal >/dev/null
find "$REPO_ROOT" -mindepth 1 -maxdepth 1 \
  ! -name .git \
  ! -name .gitignore \
  ! -name README.md \
  ! -name scripts \
  -exec rm -rf {} +

git -C "$TMP_DIR" archive FETCH_HEAD extensions/signal | tar -x -C "$REPO_ROOT" --strip-components=2

if ! git -C "$REPO_ROOT" diff --quiet; then
  git -C "$REPO_ROOT" add -A
  git -C "$REPO_ROOT" commit -m "chore(upstream): sync signal from ${UPSTREAM_REF}"
fi

git -C "$REPO_ROOT" switch main >/dev/null

"$SCRIPT_DIR/sync-status.sh"

echo "Upstream snapshot updated on branch upstream-signal."
echo "Next: git merge upstream-signal"
