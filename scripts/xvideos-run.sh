#!/usr/bin/env bash
# XVIDEOS 首页前 N 部视频一键下载: 登录 -> 抓清单 -> 下载(高清, 带标题)
#
# 用法:
#   bash scripts/xvideos-run.sh [数量] [下载目录] [并发数]
#   bash scripts/xvideos-run.sh 1000 downloads/xvideos 5
#
# 依赖: node >= 22、yt-dlp、ffmpeg
set -euo pipefail

LIMIT="${1:-1000}"
OUT_DIR="${2:-downloads/xvideos}"
CONCURRENCY="${3:-5}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COOKIE="data/xvideos/cookies.txt"
PLAYLIST="data/xvideos/playlist.json"

command -v yt-dlp >/dev/null || { echo "缺少 yt-dlp, 请先安装"; exit 1; }
command -v ffmpeg  >/dev/null || { echo "缺少 ffmpeg, 请先安装"; exit 1; }

echo "==> 步骤 1/3: 登录 XVIDEOS - 浏览器窗口会弹出, 请手动输入账号密码并通过验证码"
if [ ! -f "$COOKIE" ]; then
  node scripts/xvideos-login.mjs --out "$COOKIE"
else
  echo "Cookie 已存在, 跳过登录. 如需重新登录请执行: rm ${COOKIE}"
fi

echo "==> 步骤 2/3: 抓取首页前 ${LIMIT} 个视频链接"
node scripts/xvideos-crawl.mjs --limit "$LIMIT" --out "$PLAYLIST"

echo "==> 步骤 3/3: 下载视频 - 最高可用清晰度, 文件名带标题"
node scripts/xvideos-download.mjs \
  --playlist "$PLAYLIST" \
  --cookie "$COOKIE" \
  --outDir "$OUT_DIR" \
  --concurrency "$CONCURRENCY" \
  --quality best

echo "==> 全部完成, 文件在: ${OUT_DIR}"
