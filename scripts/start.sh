#!/usr/bin/env bash
# EQS 一键启动脚本（Linux / macOS）
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装 22 或更高版本：https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ 需要 Node.js 22+，当前为 $(node -v)"
  exit 1
fi

[ -d data ] || mkdir -p data

echo "🚀 启动 EQS…（数据目录：$(pwd)/data）"
exec node server/index.js
