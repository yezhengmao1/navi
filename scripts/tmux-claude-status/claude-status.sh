#!/usr/bin/env bash
# Display all running Claude Code instances and their status.
# Select a number to jump to that pane. Press q/Enter to close.
# Designed for use inside `tmux display-popup`.

set -euo pipefail

STATUS_DIR="/tmp/claude-status"

# State icons
icon_for() {
  case "$1" in
    idle)      echo "o"  ;;
    thinking)  echo "*"  ;;
    tool_use)  echo ">"  ;;
    pending)   echo "!"  ;;
    *)         echo "?"  ;;
  esac
}

color_for() {
  case "$1" in
    idle)      echo "32" ;;
    thinking)  echo "33" ;;
    tool_use)  echo "36" ;;
    pending)   echo "31" ;;
    *)         echo "37" ;;
  esac
}

# Collect running claude PIDs and their CWDs
declare -A pid_cwd
for pid in $(pgrep -x claude 2>/dev/null); do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  [ -n "$cwd" ] && pid_cwd[$pid]="$cwd"
done

if [ ${#pid_cwd[@]} -eq 0 ] && [ ! -d "$STATUS_DIR" ]; then
  echo "  No Claude instances running."
  read -rsn1
  exit 0
fi

# Arrays to store pane targets for jumping
declare -a pane_targets=()

idx=0

# Header
printf "\n  \033[1m%-4s %-20s %-10s %s\033[0m\n" "#" "Project" "State" "Detail"
printf "  %s\n" "──────────────────────────────────────────────────"

# Track known cwds for dedup
declare -A known_cwds

# Collect active tmux panes for stale-session cleanup
active_panes=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null | sort)

# Show sessions with status files (hook-tracked) — single jq call per file
if [ -d "$STATUS_DIR" ]; then
  for f in "$STATUS_DIR"/*; do
    [ -f "$f" ] || continue
    IFS=$'\t' read -r state detail cwd pane <<< "$(
      jq -r '[.state // "unknown", .detail // "", .cwd // "", .pane // ""] | join("\t")' "$f" 2>/dev/null
    )" || continue

    # Remove stale status files whose pane no longer exists
    if [ -n "$pane" ] && [ -n "$active_panes" ]; then
      if ! echo "$active_panes" | grep -qxF "$pane"; then
        rm -f "$f"
        continue
      fi
    fi

    [ -n "$cwd" ] && known_cwds[$cwd]=1
    project="${cwd##*/}"
    [ -z "$project" ] && project="unknown"

    icon=$(icon_for "$state")
    color=$(color_for "$state")

    idx=$((idx + 1))
    pane_targets+=("$pane")
    printf "  \033[${color}m${icon}\033[0m %-3s %-20s \033[${color}m%-10s\033[0m %s\n" \
      "$idx" "$project" "$state" "$detail"
  done
fi

# Show running claude processes not already tracked — no nested jq loop
for pid in "${!pid_cwd[@]}"; do
  cwd="${pid_cwd[$pid]}"
  [ -n "${known_cwds[$cwd]:-}" ] && continue

  project="${cwd##*/}"
  tty=$(readlink "/proc/$pid/fd/0" 2>/dev/null || true)
  pane=$(tmux list-panes -a -F '#{pane_tty} #{pane_id}' 2>/dev/null \
         | awk -v t="$tty" '$1==t {print $2}' | head -1)

  idx=$((idx + 1))
  pane_targets+=("$pane")
  printf "  \033[37m?\033[0m %-3s %-20s \033[37m%-10s\033[0m %s\n" \
    "$idx" "$project" "unknown" "pid:$pid"
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
          # switch to the session/window containing the target pane, then select it
          tmux switch-client -t "$target" 2>/dev/null \
            || tmux select-window -t "$target" 2>/dev/null
          tmux select-pane -t "$target" 2>/dev/null
          exit 0
        fi
      fi
      ;;
  esac
done
