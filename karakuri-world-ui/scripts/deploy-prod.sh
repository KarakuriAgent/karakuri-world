#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.toml}"

# ==== Validate wrangler config ====
if [ ! -f "$WRANGLER_CONFIG" ]; then
  echo "Error: $WRANGLER_CONFIG が存在しません。"
  echo "  cp wrangler.toml.example wrangler.toml で作成し、D1 ID と R2 バケット名を実値に書き換えてください。"
  exit 1
fi

if grep -qE '00000000-0000-0000-0000-000000000000|replace-with-real-snapshot-bucket' "$WRANGLER_CONFIG"; then
  echo "Error: $WRANGLER_CONFIG にプレースホルダが残っています。"
  echo "  D1 database_id / R2 bucket_name を実値に書き換えてから再実行してください。"
  exit 1
fi

# ==== D1 migrations (idempotent) ====
echo "D1 マイグレーションを適用中..."
npx -y wrangler d1 migrations apply HISTORY_DB --remote -c "$WRANGLER_CONFIG"

# ==== Deploy ====
echo ""
echo "Worker をデプロイ中..."
DEPLOY_OUTPUT=$(npx -y wrangler deploy -c "$WRANGLER_CONFIG" 2>&1)
echo "$DEPLOY_OUTPUT"

# ==== Extract Worker URL ====
# 既定の *.workers.dev を優先し、見つからなければ output 中の最初の https URL を fallback として使う。
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^[:space:]]+\.workers\.dev' | head -1 || true)
if [ -z "$WORKER_URL" ]; then
  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^[:space:]]+' | head -1 || true)
fi

if [ -z "$WORKER_URL" ]; then
  echo ""
  echo "Warning: Worker URL を検出できませんでした。"
  echo "  手動で curl -i <WORKER_URL>/ を実行して DO の初回 boot をトリガしてください。"
  exit 0
fi

# ==== Warm up Worker DO so snapshot publishing alarms start ====
# 初回 fetch で DO の boot() → refreshSnapshot('boot') → rescheduleAlarm() が走る。
# これを踏まないと次に誰かが Worker を叩くまで R2 への publish が始まらない。
echo ""
echo "Worker DO をウォームアップ中 ($WORKER_URL)..."
WARMUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "$WORKER_URL/" || echo "000")
if [ "$WARMUP_STATUS" = "204" ] || [ "$WARMUP_STATUS" = "200" ]; then
  echo "Worker DO ウォームアップ完了 (HTTP $WARMUP_STATUS)"
else
  echo "Error: Worker DO ウォームアップの応答が想定外でした (HTTP $WARMUP_STATUS)"
  echo "  DO の alarm 連鎖が起動しないまま snapshot publisher が休眠状態となるため、デプロイを失敗扱いにします。"
  echo "  原因を解消したうえで再実行するか、手動で curl -i $WORKER_URL/ を成功させてから利用してください。"
  exit 1
fi

echo ""
echo "===== Production deploy 完了 ====="
echo "Worker: $WORKER_URL"
