#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
MAIN_BRANCH="${1:-main}"
UPSTREAM_BRANCH="${2:-upstream-signal}"
OUT_FILE="${3:-$REPO_ROOT/SYNC_STATUS.md}"

if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$MAIN_BRANCH"; then
  echo "Missing branch: $MAIN_BRANCH" >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$UPSTREAM_BRANCH"; then
  echo "Missing branch: $UPSTREAM_BRANCH" >&2
  exit 1
fi

main_ahead="$(git -C "$REPO_ROOT" rev-list --count "${UPSTREAM_BRANCH}..${MAIN_BRANCH}")"
upstream_ahead="$(git -C "$REPO_ROOT" rev-list --count "${MAIN_BRANCH}..${UPSTREAM_BRANCH}")"

{
  echo "# Sync Status"
  echo
  echo "Generated (UTC): $(date -u +"%Y-%m-%d %H:%M:%S")"
  echo
  echo "Main branch: \`${MAIN_BRANCH}\`"
  echo "Upstream snapshot branch: \`${UPSTREAM_BRANCH}\`"
  echo
  echo "- \`${MAIN_BRANCH}\` commits ahead of \`${UPSTREAM_BRANCH}\`: ${main_ahead}"
  echo "- \`${UPSTREAM_BRANCH}\` commits ahead of \`${MAIN_BRANCH}\`: ${upstream_ahead}"
  echo
  echo "## Commits In \`${MAIN_BRANCH}\` Not In \`${UPSTREAM_BRANCH}\`"
  echo
  if git -C "$REPO_ROOT" log --oneline "${UPSTREAM_BRANCH}..${MAIN_BRANCH}" | sed 's/^/- /'; then
    :
  fi
  if [ "$(git -C "$REPO_ROOT" rev-list --count "${UPSTREAM_BRANCH}..${MAIN_BRANCH}")" -eq 0 ]; then
    echo "- (none)"
  fi
  echo
  echo "## Files Diverged Between Branches"
  echo
  if git -C "$REPO_ROOT" diff --name-only "${UPSTREAM_BRANCH}...${MAIN_BRANCH}" | sed 's/^/- /'; then
    :
  fi
  if [ -z "$(git -C "$REPO_ROOT" diff --name-only "${UPSTREAM_BRANCH}...${MAIN_BRANCH}")" ]; then
    echo "- (none)"
  fi
} > "$OUT_FILE"

echo "Wrote sync status to: $OUT_FILE"
