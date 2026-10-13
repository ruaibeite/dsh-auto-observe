#!/bin/sh
# 把本插件装进某个 dsh profile。
#
# 走官方 bundle 通道：package.json 里的 `dsh.bundle` 声明会让 `dsh plugin add`
# 自动把包装进 profile 的 dsh.profile.bundles，并在启动时合并本仓库根的
# cordis.patch.yml —— 不需要手工编辑 profile 里的任何文件。
#
# 用法：
#   ./install.sh                        # 装进 desktop profile（桌面 App 用的那个）
#   PROFILE_NAME=web ./install.sh       # 装进别的 profile
#   DSH_BIN=/path/to/dsh ./install.sh   # 指定 dsh 可执行文件
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE_NAME="${PROFILE_NAME:-desktop}"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
DESKTOP_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

if [ -z "$DSH_BIN" ] && [ -x "$DESKTOP_CLI" ]; then
  DSH_BIN="$DESKTOP_CLI"
  echo "未找到 PATH 里的 dsh，改用桌面版自带的 CLI：$DSH_BIN"
fi

if [ -z "$DSH_BIN" ]; then
  echo "找不到 dsh 可执行文件。" >&2
  echo "请先安装 DeepSeek Harness，或用 DSH_BIN=/path/to/dsh 指定。" >&2
  exit 1
fi

echo "==> 安装 @ruaibeite/dsh-auto-observe 到 profile：$PROFILE_NAME"
"$DSH_BIN" plugin --profile "$PROFILE_NAME" add "$HERE"

echo
echo "==> 完成。重启 Harness 后生效（宿主插件不热重载）。"
echo "    确认挂载：$DSH_BIN --profile $PROFILE_NAME --dump-config | grep -A3 fs-auto-observe"
