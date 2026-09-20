#!/usr/bin/env bash
# Kapibala 本地开发启动脚本（macOS / Linux / Git Bash 薄壳）
#
# 这里只负责定位 node 并把参数原样转发给 scripts/dev.mjs，
# 所有业务逻辑都在 dev.mjs 里，避免两端脚本各自漂移。
#
# 用法:
#   bash scripts/dev.sh                  # 编译 + 校验 + 进入 REPL
#   bash scripts/dev.sh --no-verify       # 跳过校验
#   bash scripts/dev.sh -p "看看目录"      # 单次问答
#   ./scripts/dev.sh                      # 首次需 chmod +x scripts/dev.sh

set -euo pipefail

# 解析脚本自身所在目录（兼容符号链接，不依赖调用时的 cwd）
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

# Git Bash / Cygwin 下 pwd 返回 /f/Project/... 这类 POSIX 路径，
# 直接交给 node 会被解析成 F:\f\Project\...（多出一层盘符目录）。
# 优先让 node 自己解析，仅在 shell 层做 MSYS 路径转换。
if command -v cygpath >/dev/null 2>&1; then
  SCRIPT_DIR="$(cygpath -w "$SCRIPT_DIR")"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✘ 未检测到 node，请先安装 Node.js 18+。" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/dev.mjs" "$@"
