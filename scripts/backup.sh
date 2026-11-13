#!/usr/bin/env bash
# 手动备份：打包 data 目录（数据库 + 全部上传文件）
# WAL 模式下数据可能还没写进 eqs.db 主文件。服务在跑时直接 tar 会拿到一个空壳库，
# 所以这里用 SQLite 自己的 backup 接口导出一份一致的快照再打包。
set -euo pipefail
cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
OUT="backups/eqs-backup-$TS.tar.gz"
mkdir -p backups
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/data"

node --input-type=module - "$STAGE/data/eqs.db" <<'NODE'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
const src = process.env.EQS_DB_FILE || path.join(process.env.EQS_DATA_DIR || './data', 'eqs.db')
const dest = process.argv[2]
if (!fs.existsSync(src)) { console.log('未找到数据库 ' + src + '，跳过快照'); process.exit(0) }
const db = new DatabaseSync(src)
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
db.close()
NODE

if [ ! -f "$STAGE/data/eqs.db" ]; then
  echo "❌ 没有可备份的数据库（$PWD/data/eqs.db），请先启动一次 EQS 或检查 EQS_DATA_DIR"
  exit 1
fi
if [ -d data/files ]; then cp -a data/files "$STAGE/data/files"; fi
tar -czf "$OUT" -C "$STAGE" data
echo "✅ 已备份到 $OUT（$(du -h "$OUT" | cut -f1)）"
