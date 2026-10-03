#!/usr/bin/env bash
#
# 启动 goclip DSH 视频剪辑助手（Linux / macOS）
#
# 参数会原样转给启动器，例如在云主机上监听全部地址：
#   ./start.sh --host 0.0.0.0 --port 6006 --no-open

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for cmd in node ffmpeg; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "找不到 $cmd" >&2
    exit 1
  fi
done

export DSH_HOME="$ROOT/runtime/home"
export GOCLIP_RUNTIME="$ROOT/runtime"

ENV_FILE="$ROOT/runtime/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE —— 按部署手册 §3.4 填写" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

exec node "$ROOT/runtime/start-dsh.mjs" "$@"
