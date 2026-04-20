#!/usr/bin/env bash
# Display all running Claude Code instances and their status.
# Select a number to jump to that pane. Press q/Enter to close.
# Designed for use inside `tmux display-popup`.

set -euo pipefail

STATUS_DIR="/tmp/claude-status"

if [ ! -d "$STATUS_DIR" ] || [ -z "$(ls -A "$STATUS_DIR" 2>/dev/null)" ]; then
  echo "  No Claude instances running."
  read -rsn1
  exit 0
fi

# Collect active tmux panes once
declare -A active_pane_set
while IFS= read -r p; do
  [ -n "$p" ] && active_pane_set[$p]=1
done < <(tmux list-panes -a -F '#{pane_id}' 2>/dev/null)

printf -v now '%(%s)T' -1

declare -a pane_targets=()
idx=0

# Header
printf "\n  \033[1m%-4s %-20s %-10s %s\033[0m\n" "#" "Project" "State" "Detail"
printf "  %s\n" "──────────────────────────────────────────────────"

for f in "$STATUS_DIR"/*; do
  [ -f "$f" ] || continue
  line=$(<"$f")

  # Extract JSON fields — use non-greedy (#) to match first occurrence
  state=${line#*'"state":"'}; state=${state%%'"'*}
  detail=${line#*'"detail":"'}; detail=${detail%%'"'*}
  cwd=${line#*'"cwd":"'}; cwd=${cwd%%'"'*}
  pane=${line#*'"pane":"'}; pane=${pane%%'"'*}

  # Remove status files whose pane no longer exists or was never set
  if [ -z "$pane" ] || { [ ${#active_pane_set[@]} -gt 0 ] && [ -z "${active_pane_set[$pane]:-}" ]; }; then
    rm -f "$f"
    continue
  fi

  # For active states, check staleness (interrupted sessions leave stale state)
  # Also show elapsed time for long-running operations
  if [ "$state" != "idle" ] && [ "$state" != "error" ] && [ "$state" != "pending" ]; then
    file_age=$(( now - $(stat -c %Y "$f") ))
    if [ "$file_age" -gt 300 ]; then
      # >5min without update in an active state = likely interrupted
      detail="stale (${state}>${file_age}s ago)"
      state="idle"
    elif [ "$file_age" -gt 10 ]; then
      if [ "$file_age" -ge 60 ]; then
        detail="${detail} ($((file_age / 60))m$((file_age % 60))s)"
      else
        detail="${detail} (${file_age}s)"
      fi
    fi
  fi

  project=${cwd##*/}
  : "${project:=unknown}"

  # Inline icon/color — no subshells
  case "$state" in
    idle)     icon=o color=32 ;;
    thinking) icon='*' color=33 ;;
    tool_use) icon='>' color=36 ;;
    pending)  icon='!' color=31 ;;
    error)    icon=x color=31 ;;
    *)        icon='?' color=37 ;;
  esac

  idx=$((idx + 1))
  pane_targets+=("$pane")
  printf "  \033[${color}m${icon}\033[0m %-3s %-20s \033[${color}m%-10s\033[0m %s\n" \
    "$idx" "$project" "$state" "$detail"
done

if [ $idx -eq 0 ]; then
  echo "  No Claude instances running."
  read -rsn1
  exit 0
fi

printf "\n  \033[2mSelect [1-%d] to jump, q to close\033[0m " "$idx"

while true; do
  read -rsn1 key
  case "$key" in
    q|"") exit 0 ;;
    [1-9])
      sel=$((key - 1))
      if [ $sel -lt ${#pane_targets[@]} ]; then
        target="${pane_targets[$sel]}"
        if [ -n "$target" ]; then
          tmux switch-client -t "$target" 2>/dev/null \
            || tmux select-window -t "$target" 2>/dev/null
          tmux select-pane -t "$target" 2>/dev/null
          exit 0
        fi
      fi
      ;;
  esac
done
