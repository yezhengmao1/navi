#!/usr/bin/env bash
# 兼容旧部署：把本包扩展和主题复制/链接到当前用户的 Pi 目录。
# 推荐 pi install ./packages/pi；不要同时使用两种安装方式。
# 用法：./install-extensions.sh [--link | --uninstall]
# 会替换同名资源并清理旧入口；执行前请备份自行修改的全局副本。
set -euo pipefail
shopt -s nullglob
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$PACKAGE_DIR/extensions"
DEST_DIR="$HOME/.pi/agent/extensions"
THEME_SRC_DIR="$PACKAGE_DIR/themes"
THEME_DEST_DIR="$HOME/.pi/agent/themes"
MODE=copy
UNINSTALL=0
LEGACY_EXTENSIONS=(thinking-tail.ts bash-truncate.ts shell-safety-guard.ts
  heavy-command-reviewer.ts confirm-feedback.ts magic-editor.ts
  magic-ui.ts magic-header.ts compact-display.ts codex-quota.ts
  clear.ts command-guard.ts)
LEGACY_DIRECTORIES=(herdr-fork)
cleanup_legacy() {
  for name in "${LEGACY_EXTENSIONS[@]}"; do rm -f -- "$DEST_DIR/$name"; done
  # Remove the old standalone entry, never its symlink target.
  for name in "${LEGACY_DIRECTORIES[@]}"; do rm -rf -- "$DEST_DIR/$name"; done
}
for arg in "$@"; do
  case "$arg" in
    --link) MODE=link ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) printf '%s\n' 'Usage: install-extensions.sh [--link | --uninstall]'; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done
# Only root files and directories with an index are extension entry points.
resources=("$SRC_DIR"/*.ts)
for entry in "$SRC_DIR"/*/index.ts; do resources+=("$(dirname "$entry")"); done
[ "${#resources[@]}" -gt 0 ] || { echo '没有可安装的扩展' >&2; exit 1; }
if [ "$UNINSTALL" -eq 1 ]; then
  for resource in "${resources[@]}"; do
    target="$DEST_DIR/$(basename "$resource")"
    rm -rf -- "$target"
  done
  cleanup_legacy
  for theme in "$THEME_SRC_DIR"/*.json; do rm -f -- "$THEME_DEST_DIR/$(basename "$theme")"; done
  echo '已移除本包同名资源（按名称匹配）。'
  exit 0
fi
mkdir -p "$DEST_DIR" "$THEME_DEST_DIR"
cleanup_legacy
install_resource() {
  local source="$1" target="$2"
  # Never follow an old link and overwrite the repository through it.
  rm -rf -- "$target"
  if [ "$MODE" = link ]; then ln -s "$source" "$target"; else cp -R "$source" "$target"; fi
  echo "已安装: $target"
}
for resource in "${resources[@]}"; do install_resource "$resource" "$DEST_DIR/$(basename "$resource")"; done
for theme in "$THEME_SRC_DIR"/*.json; do install_resource "$theme" "$THEME_DEST_DIR/$(basename "$theme")"; done
echo '完成。重启 Pi 或 /reload 生效。'
