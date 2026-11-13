#!/usr/bin/env bash
# 手动备份：打包 data 目录（数据库 + 全部上传文件）
set -e
cd "$(dirname "$0")/.."
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
tar -czf "backups/eqs-backup-$TS.tar.gz" data
echo "✅ 已备份到 backups/eqs-backup-$TS.tar.gz"
