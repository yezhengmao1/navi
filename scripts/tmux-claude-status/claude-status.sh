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

# Extract field from our controlled single-line JSON (no jq needed)
_field() { local v="${1##*\"$2\":\"}" ; v="${v%%\"*}" ; echo "$v" ; }

# State display: icon, color
# idle=green, thinking=yellow, tool_use=cyan, pending=red, stale=dim
_icon()  { case "$1" in idle) echo "o";; thinking) echo "*";; tool_use) echo ">";; pending) echo "!";; *) echo "?";; esac; }
_color() { case "$1" in idle) echo "32";; thinking) echo "33";; tool_use) echo "36";; pending) echo "31";; *) echo "37";; esac; }

# Collect active tmux panes once
declare -A active_pane_set
while IFS= read -r p; do
  [ -n "$p" ] && active_pane_set[$p]=1
done < <(tmux list-panes -a -F '#{pane_id}' 2>/dev/null)

now=$(date +%s)

declare -a pane_targets=()
idx=0

# Header
printf "\n  \033[1m%-4s %-20s %-10s %s\033[0m\n" "#" "Project" "State" "Detail"
printf "  %s\n" "──────────────────────────────────────────────────"

for f in "$STATUS_DIR"/*; do
  [ -f "$f" ] || continue
  line=$(<"$f")

  state=$(_field "$line" state)
  detail=$(_field "$line" detail)
  cwd=$(_field "$line" cwd)
  pane=$(_field "$line" pane)

  # Remove status files whose pane no longer exists
  if [ -n "$pane" ] && [ ${#active_pane_set[@]} -gt 0 ]; then
    if [ -z "${active_pane_set[$pane]:-}" ]; then
      rm -f "$f"
      continue
    fi
  fi

  # Show elapsed time for long-running tool use
  if [ "$state" = "tool_use" ]; then
    file_age=$(( now - $(stat -c %Y "$f" 2>/dev/null || echo "$now") ))
    if [ "$file_age" -gt 10 ]; then
      if [ "$file_age" -ge 60 ]; then
        detail="${detail} ($((file_age / 60))m$((file_age % 60))s)"
      else
        detail="${detail} (${file_age}s)"
      fi
    fi
  fi

  project="${cwd##*/}"
  [ -z "$project" ] && project="unknown"

  icon=$(_icon "$state")
  color=$(_color "$state")

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
