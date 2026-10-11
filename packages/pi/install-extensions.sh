#!/usr/bin/env bash
#
# 兼容旧部署：把本包 extensions/ 下的扩展安装到 pi 的全局扩展目录，
# 推荐改用 pi install ./packages/pi；不要同时使用两种安装方式。
# 这样所有项目都能用，且不依赖本项目目录。
#
# 用法:
#   ./install-extensions.sh          安装(复制)
#   ./install-extensions.sh --link   软链接(改源文件立即生效)
#   ./install-extensions.sh --uninstall  卸载
#
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$PACKAGE_DIR/extensions"
THEME_SRC_DIR="$PACKAGE_DIR/themes"
DEST_DIR="$HOME/.pi/agent/extensions"

MODE="copy"
UNINSTALL=0

# Extensions merged into compact-display.ts or command-guard.ts. Keep these
# names to clean up stale globally-installed copies during install/uninstall.
LEGACY_EXTENSIONS=(
  "thinking-tail.ts"
  "bash-truncate.ts"
  "shell-safety-guard.ts"
  "heavy-command-reviewer.ts"
  "confirm-feedback.ts"
  "magic-editor.ts"
)

for arg in "$@"; do
  case "$arg" in
    --link) MODE="link" ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

if [ ! -d "$SRC_DIR" ]; then
  echo "源目录不存在: $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# 卸载: 只删我们装的(按文件名匹配), 不动别人的
if [ "$UNINSTALL" -eq 1 ]; then
  removed=0
  for f in "$SRC_DIR"/*.ts; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if [ -e "$DEST_DIR/$name" ]; then
      rm -f "$DEST_DIR/$name"
      echo "已移除: $DEST_DIR/$name"
      removed=1
    fi
  done
  for name in "${LEGACY_EXTENSIONS[@]}"; do
    if [ -e "$DEST_DIR/$name" ]; then
      rm -f "$DEST_DIR/$name"
      echo "已移除旧扩展: $DEST_DIR/$name"
      removed=1
    fi
  done

  # 同时移除主题
  THEME_DEST_DIR="$HOME/.pi/agent/themes"
  for f in "$THEME_SRC_DIR"/*.json; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if [ -e "$THEME_DEST_DIR/$name" ]; then
      rm -f "$THEME_DEST_DIR/$name"
      echo "已移除主题: $THEME_DEST_DIR/$name"
      removed=1
    fi
  done
  [ "$removed" -eq 0 ] && echo "没有要卸载的扩展"
  exit 0
fi

# 安装
installed=0
themes_installed=0
for name in "${LEGACY_EXTENSIONS[@]}"; do
  if [ -e "$DEST_DIR/$name" ]; then
    rm -f "$DEST_DIR/$name"
    echo "已清理旧扩展: $DEST_DIR/$name"
  fi
done

for f in "$SRC_DIR"/*.ts; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [ "$MODE" = "link" ]; then
    ln -sf "$f" "$DEST_DIR/$name"
    echo "已链接: $DEST_DIR/$name -> $f"
  else
    cp -f "$f" "$DEST_DIR/$name"
    echo "已复制: $DEST_DIR/$name"
  fi
  installed=1
done

# 同时安装主题 JSON 到全局主题目录(这样扩展/用户都能用)
THEME_DEST_DIR="$HOME/.pi/agent/themes"
mkdir -p "$THEME_DEST_DIR"
for f in "$THEME_SRC_DIR"/*.json; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [ "$MODE" = "link" ]; then
    ln -sf "$f" "$THEME_DEST_DIR/$name"
    echo "已链接主题: $THEME_DEST_DIR/$name -> $f"
  else
    cp -f "$f" "$THEME_DEST_DIR/$name"
    echo "已复制主题: $THEME_DEST_DIR/$name"
  fi
  themes_installed=1
done

if [ "$installed" -eq 0 ]; then
  echo "$SRC_DIR 下没有 .ts 扩展文件" >&2
  exit 1
fi
[ "$themes_installed" -eq 0 ] && echo "(没有主题文件要安装)"

echo "完成。重启 pi 或 /reload 生效。"
