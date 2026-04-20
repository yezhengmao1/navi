#!/usr/bin/env bash
# Claude Code hook: track instance status to /tmp/claude-status/
# Receives hook event JSON on stdin, writes state file per session.

set -euo pipefail

STATUS_DIR="/tmp/claude-status"
mkdir -p "$STATUS_DIR"

# Save stdin for single jq call
INPUT=$(cat)

# Extract all fields in one jq call.
# Use \x01 (SOH) as delimiter — safe because jq output won't contain it,
# unlike \t which can appear in user prompts and break field parsing.
SEP=$'\x01'
IFS="$SEP" read -r SESSION_ID EVENT CWD TOOL STOP_ACTIVE \
  AGENT_TYPE SOURCE ERROR_TYPE ERROR_MSG \
  NOTIF_TYPE PROMPT TOOL_ERROR TOOL_DETAIL <<< "$(
  echo "$INPUT" | jq -r --arg s $'\x01' '
    [
      .session_id // "",
      .hook_event_name // "",
      .cwd // "",
      .tool_name // "",
      (.stop_hook_active // false | tostring),
      .agent_type // "",
      .source // "",
      .error_type // "",
      .error_message // "",
      .notification_type // "",
      (.prompt // "" | .[0:80] | gsub("[\\n\\r\\t]"; " ")),
      (.error // ""),
      (.tool_input // {} |
        if .command then (.command | .[0:60] | gsub("[\\n\\r\\t]"; " "))
        elif .file_path then .file_path
        elif .pattern then .pattern
        elif .query then (.query | .[0:60] | gsub("[\\n\\r\\t]"; " "))
        elif .prompt then (.prompt | .[0:60] | gsub("[\\n\\r\\t]"; " "))
        elif .url then .url
        else ""
        end)
    ] | join($s)
  ' 2>/dev/null
)"

[ -z "$SESSION_ID" ] && exit 0

STATUS_FILE="$STATUS_DIR/$SESSION_ID"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
PANE="${TMUX_PANE:-}"

write_status() {
  printf '{"timestamp":"%s","cwd":"%s","state":"%s","detail":"%s","pane":"%s"}\n' \
    "$TIMESTAMP" "$CWD" "$1" "${2//\"/\\\"}" "$PANE" > "$STATUS_FILE"
}

case "$EVENT" in
  # ── State: idle (waiting for user input) ─────────────────
  SessionStart)
    # compact: context compaction mid-turn, Claude continues working
    if [ "$SOURCE" = "compact" ]; then
      write_status "thinking" "compacted"
    else
      write_status "idle" "${SOURCE:-started}"
    fi ;;
  SessionEnd)
    rm -f "$STATUS_FILE" ;;
  Stop)
    [ "$STOP_ACTIVE" = "true" ] && exit 0
    write_status "idle" "waiting for input" ;;

  # ── State: error (API/billing failures) ──────────────────
  StopFailure)
    case "$ERROR_TYPE" in
      rate_limit)            write_status "error" "rate limited" ;;
      authentication_failed) write_status "error" "auth failed" ;;
      billing_error)         write_status "error" "billing error" ;;
      invalid_request)       write_status "error" "invalid request" ;;
      server_error)          write_status "error" "server error" ;;
      max_output_tokens)     write_status "error" "output too long" ;;
      *)                     write_status "error" "${ERROR_MSG:-unknown}" ;;
    esac ;;

  # ── State: thinking (Claude is working) ──────────────────
  UserPromptSubmit)
    write_status "thinking" "${PROMPT:-processing}" ;;
  PostToolUse)
    write_status "thinking" "done: $TOOL" ;;
  PostToolUseFailure)
    if [ -n "$TOOL_ERROR" ]; then
      write_status "thinking" "$TOOL failed: $TOOL_ERROR"
    else
      write_status "thinking" "$TOOL failed"
    fi ;;
  PermissionDenied)
    write_status "thinking" "$TOOL denied" ;;
  SubagentStart)
    write_status "thinking" "agent: ${AGENT_TYPE:-unknown}" ;;
  SubagentStop)
    write_status "thinking" "agent done" ;;
  PreCompact|PostCompact)
    write_status "thinking" "compacting" ;;
  ElicitationResult)
    write_status "thinking" "MCP responded" ;;

  # ── State: tool_use (executing a tool) ───────────────────
  PreToolUse)
    if [ -n "$TOOL_DETAIL" ]; then
      write_status "tool_use" "$TOOL: $TOOL_DETAIL"
    else
      write_status "tool_use" "$TOOL"
    fi ;;

  # ── State: pending (needs user action) ───────────────────
  PermissionRequest)
    if [ -n "$TOOL_DETAIL" ]; then
      write_status "pending" "approve $TOOL: $TOOL_DETAIL"
    else
      write_status "pending" "approve $TOOL?"
    fi ;;
  Elicitation)
    write_status "pending" "MCP input: ${TOOL:-server}" ;;
  Notification)
    case "$NOTIF_TYPE" in
      # permission_prompt handled by PermissionRequest (Notification fires
      # async and can overwrite thinking/tool_use state after approval)
      elicitation_dialog) write_status "pending" "input requested" ;;
      idle_prompt)        write_status "idle" "waiting for input" ;;
    esac ;;

  # ── Ignored (informational, don't change state) ─────────
  # FileChanged, CwdChanged, ConfigChange, InstructionsLoaded,
  # TaskCreated, TaskCompleted, TeammateIdle, WorktreeCreate,
  # WorktreeRemove: these are background events that should
  # not overwrite the current working state.
esac

exit 0
