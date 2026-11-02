#!/usr/bin/env bash
# 批量：本地 MP4 -> m3u8(HLS,按剧ID) -> S3(东京桶)
#
# S3 输出结构（和 data/dramas.json 里 /media/imported/<id>/episode-N.mp4 一一对应）：
#   s3://duanju-h5-hls-473041657070/hls/<dramaId>/episode-<no>/index.m3u8
# 播放地址：
#   https://duanju-h5-hls-473041657070.s3.ap-northeast-1.amazonaws.com/hls/<dramaId>/episode-<no>/index.m3u8
#
# 用法：
#   bash scripts/batch-hls-upload-s3.sh [下载目录] [HLS输出目录]
#   DRY_RUN=1 bash scripts/batch-hls-upload-s3.sh   # 只列映射关系，不转码不上传
#   ONLY_TRANSCODE=1 bash scripts/batch-hls-upload-s3.sh  # 只转码不上传
#   ONLY_UPLOAD=1 bash scripts/batch-hls-upload-s3.sh     # 只上传不转码
#
# 前置：brew install ffmpeg awscli；凭证填在项目 .env（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY）。
set -euo pipefail

# 自动加载项目根目录 .env（调用方已显式设置的环境变量优先，不被 .env 覆盖）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  _prev_s3_bucket="${S3_BUCKET:-}"
  _prev_aws_region="${AWS_REGION:-}"
  _prev_s3_prefix="${S3_PREFIX:-}"
  _prev_aws_key="${AWS_ACCESS_KEY_ID:-}"
  _prev_aws_secret="${AWS_SECRET_ACCESS_KEY:-}"
  _prev_aws_token="${AWS_SESSION_TOKEN:-}"
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
  [[ -n "$_prev_s3_bucket" ]] && S3_BUCKET="$_prev_s3_bucket"
  [[ -n "$_prev_aws_region" ]] && AWS_REGION="$_prev_aws_region"
  [[ -n "$_prev_s3_prefix" ]] && S3_PREFIX="$_prev_s3_prefix"
  [[ -n "$_prev_aws_key" ]] && AWS_ACCESS_KEY_ID="$_prev_aws_key"
  [[ -n "$_prev_aws_secret" ]] && AWS_SECRET_ACCESS_KEY="$_prev_aws_secret"
  [[ -n "$_prev_aws_token" ]] && AWS_SESSION_TOKEN="$_prev_aws_token"
  unset _prev_s3_bucket _prev_aws_region _prev_s3_prefix _prev_aws_key _prev_aws_secret _prev_aws_token
fi

SRC="${1:-/Users/zhangchaoyin/zhangzhaoyin/go_items/go_test/downloads}"
OUT="${2:-./hls-output}"
S3_BUCKET="${S3_BUCKET:-duanju-h5-hls-473041657070}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
S3_PREFIX="${S3_PREFIX:-hls}"

echo "SRC=$SRC OUT=$OUT S3=s3://$S3_BUCKET/$S3_PREFIX REGION=$AWS_REGION"

if [[ -z "${ONLY_UPLOAD:-}" ]]; then
  command -v ffmpeg >/dev/null || { echo "需要 ffmpeg: brew install ffmpeg"; exit 1; }
fi
if [[ -z "${ONLY_TRANSCODE:-}" && -z "${DRY_RUN:-}" ]]; then
  command -v aws >/dev/null || { echo "需要 aws cli: brew install awscli"; exit 1; }
fi
[[ -d "$OUT" ]] || { echo "上传目录不存在：$OUT"; exit 1; }

if [[ -z "${ONLY_UPLOAD:-}" ]]; then
  [[ -d "$SRC" ]] || { echo "下载目录不存在：$SRC"; exit 1; }

  # 与 gen-import-manifest.mjs 同源：疑似未成年/年龄不明的不转码不上传。
  BLOCK_RE='鬼父|高三|童童|孩童|少年阿宾|魔头女儿|我的女友景甜|鹤棣|原神·人物志|夜神月|龙女奇遇|系统带我攻略弟弟|狐小六|瓜瓜干童童'

  LIST_FILE="$(mktemp -t hls-list)"
  find "$SRC" -type f -name '第*.mp4' | sort > "$LIST_FILE"
  total="$(wc -l < "$LIST_FILE" | tr -d ' ')"
  echo "共找到 $total 个 第*.mp4"

  count=0
  skipped=0
  blocked=0
  while IFS= read -r mp4; do
    [[ -z "$mp4" ]] && continue
    fname="$(basename "$mp4")"
    if [[ ! "$fname" =~ ^第([0-9]+)集\.mp4$ ]]; then
      echo "跳过（集号解析失败）：$mp4"
      continue
    fi
    no="${BASH_REMATCH[1]}"
    no_nolead="$(echo "$no" | sed 's/^0*//')"
    [[ -z "$no_nolead" ]] && no_nolead="0"
    workdir="$(dirname "$mp4")"
    work="$(basename "$workdir")"
    channel="$(basename "$(dirname "$workdir")")"
    relpath="$channel/$work/metadata.json"
    if echo "$channel/$work" | grep -Eq "$BLOCK_RE"; then
      blocked=$((blocked+1))
      [[ -n "${DRY_RUN:-}" ]] && echo "BLOCK 跳过：$channel/$work/$fname"
      continue
    fi
    # 用 manifest 规则反推 dramaId：local-<sha256(relativePath)[:16]>
    id_hash="$(printf '%s' "$relpath" | shasum -a 256 | cut -c1-16)"
    drama_id="local-$id_hash"
    dest="$OUT/$drama_id/episode-$no_nolead"

    if [[ -n "${DRY_RUN:-}" ]]; then
      echo "$relpath 第${no_nolead}集 -> $dest/index.m3u8"
      continue
    fi

    if [[ -f "$dest/index.m3u8" ]]; then
      skipped=$((skipped+1))
      continue
    fi
    count=$((count+1))
    echo "[$count] 转码 $channel/$work/$fname -> $drama_id/episode-$no_nolead"
    npm run hls -- "$mp4" "$dest" --silent
  done < "$LIST_FILE"
  rm -f "$LIST_FILE"

  if [[ -n "${DRY_RUN:-}" ]]; then
    echo "DRY_RUN 结束，共 ${total} 个文件 (blocked=${blocked})。确认映射无误后去掉 DRY_RUN=1 正式跑。"
    exit 0
  fi

  echo "转码完成 新增=${count} 跳过(已有index.m3u8)=${skipped} 拉黑跳过=${blocked}"

  if [[ -n "${ONLY_TRANSCODE:-}" ]]; then
    echo "ONLY_TRANSCODE=1，只转码不上传。输出目录：$OUT"
    exit 0
  fi
else
  echo "ONLY_UPLOAD=1：跳过转码，直接上传已有 $OUT"
fi

# 上传：分类型设 Content-Type 和 Cache-Control，和 server/index.js 本地策略对齐
# 凭证来自 .env 的 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY（source .env 时已 export 给 aws cli）。
if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  echo "缺 AWS 凭证：请先在 .env 里填 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY（IAM → 用户 → 安全凭证 → 创建访问密钥）"
  echo "填完直接重跑本脚本即可，无需 aws configure。"
  exit 1
fi
S3="s3://$S3_BUCKET/$S3_PREFIX"
echo "上传到 $S3 ..."
aws s3 sync "$OUT" "$S3" \
  --region "$AWS_REGION" \
  --delete \
  --exclude "*" --include "*.m3u8" \
  --content-type "application/vnd.apple.mpegurl" \
  --cache-control "public, max-age=10"

aws s3 sync "$OUT" "$S3" \
  --region "$AWS_REGION" \
  --exclude "*" --include "*.ts" \
  --content-type "video/mp2t" \
  --cache-control "public, max-age=31536000,immutable"

aws s3 sync "$OUT" "$S3" \
  --region "$AWS_REGION" \
  --exclude "*.m3u8" --exclude "*.ts"

echo
echo "完成。示例：https://$S3_BUCKET.s3.$AWS_REGION.amazonaws.com/$S3_PREFIX/<dramaId>/episode-1/index.m3u8"
echo "下一步：node scripts/point-dramas-to-s3.mjs --apply  把 data/dramas.json 的 src 批量指向 S3"
echo "注意：S3 直链无法走 server/access.js 的 403 拦截，API 层仍会给非会员隐藏第2集起的 src，但拿到直链就能裸播；要防分享请再套 CloudFront 签名 URL。"
