#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

DEBUG_STATE=".debug-state"
DEBUG_WRANGLER="wrangler.debug.toml"

if [ ! -f "$DEBUG_STATE" ]; then
  echo "デバッグ環境が見つかりません (.debug-state がありません)"
  exit 0
fi

# ==== Delete Worker ====
echo "Worker を削除中..."
if [ -f "$DEBUG_WRANGLER" ]; then
  npx -y wrangler delete -c "$DEBUG_WRANGLER" --force
else
  # shellcheck disable=SC1090
  source "$DEBUG_STATE"
  npx -y wrangler delete --name "${WORKER_NAME:-karakuri-world-ui-debug}" --force
fi

# ==== Cleanup local files ====
rm -f "$DEBUG_WRANGLER"
rm -f .env.local
sed -i '/^SECRETS_SET=true$/d' "$DEBUG_STATE" 2>/dev/null || true
sed -i '/^WORKER_URL=/d' "$DEBUG_STATE" 2>/dev/null || true

echo ""
echo "===== デバッグ環境を停止しました ====="
echo "Worker は削除済みです (課金停止)"
echo "D1 / R2 リソースは Cloudflare 上に残っています (無料)"
echo "次回 debug:start で Worker を再デプロイすれば復帰します"
