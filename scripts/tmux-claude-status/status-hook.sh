#!/usr/bin/env bash
# Claude Code hook: track instance status to /tmp/claude-status/
# Receives hook event JSON on stdin, writes state file per session.

set -euo pipefail

STATUS_DIR="/tmp/claude-status"
mkdir -p "$STATUS_DIR"

# Single jq call to extract all fields at once
IFS=$'\t' read -r SESSION_ID EVENT CWD TOOL STOP_ACTIVE <<< "$(
  jq -r '[.session_id // "", .hook_event_name // "", .cwd // "", .tool_name // "", .stop_hook_active // false] | join("\t")' 2>/dev/null
)"

[ -z "$SESSION_ID" ] && exit 0

STATUS_FILE="$STATUS_DIR/$SESSION_ID"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
PANE="${TMUX_PANE:-}"

write_status() {
  printf '{"timestamp":"%s","cwd":"%s","state":"%s","detail":"%s","pane":"%s"}\n' \
    "$TIMESTAMP" "$CWD" "$1" "$2" "$PANE" > "$STATUS_FILE"
}

case "$EVENT" in
  SessionStart)       write_status "idle"      "session started" ;;
  UserPromptSubmit)   write_status "thinking"  "processing prompt" ;;
  PreToolUse)         write_status "tool_use"  "$TOOL" ;;
  PostToolUse)        write_status "thinking"  "after $TOOL" ;;
  PermissionRequest)  write_status "pending" "approve $TOOL?" ;;
  Stop)
    [ "$STOP_ACTIVE" = "true" ] && exit 0
    write_status "idle" "waiting for input" ;;
  SessionEnd)         rm -f "$STATUS_FILE" ;;
esac

exit 0
