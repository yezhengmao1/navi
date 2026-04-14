#!/usr/bin/env bash
# tmux statusline segment: show Claude instance states.
# Usage: add  #(/path/to/statusline.sh)  to tmux status-right or status-left.

STATUS_DIR="/tmp/claude-status"
printf -v TIME '%(%H:%M)T' -1

if [ ! -d "$STATUS_DIR" ]; then
  printf '%s' "$TIME"
  exit 0
fi

idle=0 thinking=0 tool_use=0 pending=0

for f in "$STATUS_DIR"/*; do
  [ -f "$f" ] || continue
  line=$(<"$f")
  state=${line##*'"state":"'}; state=${state%%'"'*}
  case "$state" in
    idle)      idle=$((idle + 1)) ;;
    thinking)  thinking=$((thinking + 1)) ;;
    tool_use)  tool_use=$((tool_use + 1)) ;;
    pending)   pending=$((pending + 1)) ;;
  esac
done

parts=()
[ "$pending" -gt 0 ]  && parts+=("◐ ${pending}")
[ "$tool_use" -gt 0 ] && parts+=("● ${tool_use}")
[ "$thinking" -gt 0 ] && parts+=("✢ ${thinking}")
[ "$idle" -gt 0 ]     && parts+=("○ ${idle}")

if [ ${#parts[@]} -eq 0 ]; then
  printf '%s' "$TIME"
else
  printf '%s │ %s' "${parts[*]}" "$TIME"
fi
