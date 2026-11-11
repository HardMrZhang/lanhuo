#!/usr/bin/env bash
# XVIDEOS 视频入库全流程: 转 HLS -> 抽封面 -> 上传 S3 -> 删本地源 -> 写 MySQL
#
# 用法:
#   bash scripts/xvideos-publish.sh [并发数] [本地HLS缓存上限GB]
#   bash scripts/xvideos-publish.sh 2 8
#
# 依赖: ffmpeg、aws cli、node >= 22
# 说明:
#   - 磁盘吃紧时必须走这个流水线: 每转完一个视频立即上传并删除本地 mp4
#   - 可随时中断, 重跑同一命令即可断点续跑（已上传的会自动跳过）
#   - 每 15 个视频增量入库一次, 前台能尽快看到新内容
set -euo pipefail

PARALLEL="${1:-2}"
KEEP_SPACE="${2:-8}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v ffmpeg >/dev/null || { echo "缺少 ffmpeg"; exit 1; }
command -v aws   >/dev/null || { echo "缺少 aws cli"; exit 1; }

echo "==> 步骤 1/2: 生成映射清单 (扫描 downloads/xvideos)"
node scripts/xvideos-import-map.mjs

echo "==> 步骤 2/2: 转码 + 上传 + 入库 (并发 ${PARALLEL})"
node scripts/xvideos-pipeline.mjs \
  --parallel "$PARALLEL" \
  --keep-space "$KEEP_SPACE" \
  --import-db \
  --import-every 15

echo "==> 全部完成"
