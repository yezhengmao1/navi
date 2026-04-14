#!/usr/bin/env bash
# tmux statusline segment: show indicator when any Claude instance needs approval.
# Usage: add  #(/path/to/statusline.sh)  to tmux status-right or status-left.
# Outputs nothing when no approval is pending (no extra whitespace in your bar).

STATUS_DIR="/tmp/claude-status"
[ -d "$STATUS_DIR" ] || exit 0

pending=0
for f in "$STATUS_DIR"/*; do
  [ -f "$f" ] || continue
  # Fast grep instead of jq — our JSON is single-line, controlled format
  grep -q '"state":"pending"' "$f" 2>/dev/null && pending=$((pending + 1))
done

if [ "$pending" -gt 0 ]; then
  if [ "$pending" -eq 1 ]; then
    echo "✨"
  else
    echo "✨(${pending})"
  fi
fi
