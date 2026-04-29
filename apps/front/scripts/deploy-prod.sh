#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.toml}"

# ==== Validate wrangler config ====
if [ ! -f "$WRANGLER_CONFIG" ]; then
  echo "Error: $WRANGLER_CONFIG が存在しません。"
  echo "  cp wrangler.toml.example wrangler.toml で作成し、R2 バケット名を実値に書き換えてください。"
  exit 1
fi

if grep -qE 'replace-with-real-snapshot-bucket' "$WRANGLER_CONFIG"; then
  echo "Error: $WRANGLER_CONFIG にプレースホルダが残っています。"
  echo "  R2 bucket_name を実値に書き換えてから再実行してください。"
  exit 1
fi

# ==== Deploy ====
echo ""
echo "Worker をデプロイ中..."
DEPLOY_OUTPUT=$(npx -y wrangler deploy -c "$WRANGLER_CONFIG" 2>&1)
echo "$DEPLOY_OUTPUT"

# ==== Extract Worker URL ====
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^[:space:]]+\.workers\.dev' | head -1 || true)
if [ -z "$WORKER_URL" ]; then
  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^[:space:]]+' | head -1 || true)
fi

if [ -z "$WORKER_URL" ]; then
  echo ""
  echo "Warning: Worker URL を検出できませんでした。"
  echo "  wrangler deploy 自体は成功しています。必要であれば Cloudflare Dashboard / wrangler の出力から URL を確認してください。"
fi

echo ""
echo "===== Production deploy 完了 ====="
if [ -n "$WORKER_URL" ]; then
  echo "Worker: $WORKER_URL"
fi
