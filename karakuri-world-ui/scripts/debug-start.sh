#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

DEBUG_STATE=".debug-state"
DEBUG_WRANGLER="wrangler.debug.toml"
WORKER_NAME="karakuri-world-ui-debug"
D1_NAME="karakuri-world-ui-debug-history"
R2_NAME="karakuri-world-ui-debug-snapshot"

# ==== Step 1: Create Cloudflare resources (first time only) ====
if [ ! -f "$DEBUG_STATE" ]; then
  echo "===== デバッグ環境の初期セットアップ (Step 1/2) ====="
  echo ""

  read -rp "本体サーバーの URL (例: https://kw.example.com): " KW_BASE_URL
  if [ -z "$KW_BASE_URL" ]; then
    echo "Error: KW_BASE_URL は必須です"
    exit 1
  fi

  # ---- D1 ----
  echo ""
  echo "D1 データベースを作成中..."
  D1_OUTPUT=$(npx -y wrangler d1 create "$D1_NAME" 2>&1) || true
  echo "$D1_OUTPUT"
  D1_ID=$(echo "$D1_OUTPUT" | grep -oP 'database_id = "\K[^"]+' | head -1 || true)

  if [ -z "$D1_ID" ]; then
    echo "既存の D1 を検索中..."
    D1_ID=$(npx -y wrangler d1 list --json 2>/dev/null | node -e "
      let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
        const db=JSON.parse(buf).find(d=>d.name==='$D1_NAME');
        if(db)process.stdout.write(db.uuid);
      });" 2>/dev/null) || true
  fi

  if [ -z "$D1_ID" ]; then
    echo "Error: D1 データベースの作成・検出に失敗しました"
    exit 1
  fi
  echo "D1 ID: $D1_ID"

  # ---- R2 ----
  echo ""
  echo "R2 バケットを作成中..."
  R2_OUTPUT=$(npx -y wrangler r2 bucket create "$R2_NAME" 2>&1) || true
  echo "$R2_OUTPUT"

  # Verify R2 bucket exists
  if ! npx -y wrangler r2 bucket list 2>/dev/null | grep -q "$R2_NAME"; then
    echo "Error: R2 バケット '$R2_NAME' の作成・検出に失敗しました"
    exit 1
  fi
  echo "R2 バケット '$R2_NAME' を確認しました"

  # ---- R2 CORS (debug のみワイルドカード許可) ----
  echo ""
  echo "R2 バケットに CORS ルールを適用中 (debug: AllowedOrigins=*)..."
  npx -y wrangler r2 bucket cors set "$R2_NAME" --file scripts/r2-cors-debug.json --force

  # ---- Save state ----
  cat > "$DEBUG_STATE" <<EOF
KW_BASE_URL=$KW_BASE_URL
D1_DATABASE_ID=$D1_ID
D1_NAME=$D1_NAME
R2_NAME=$R2_NAME
WORKER_NAME=$WORKER_NAME
SETUP_PHASE=resources_created
EOF

  echo ""
  echo "===== Cloudflare リソースの作成が完了しました ====="
  echo ""
  echo "次に Cloudflare ダッシュボードで以下を設定してください:"
  echo "  1. R2 バケット '$R2_NAME' にカスタムドメインを接続"
  echo "  2. スナップショットパスに Cache Rules を設定:"
  echo "     - Cache Everything on snapshot/latest.json"
  echo "     - Edge TTL: 5 seconds"
  echo ""
  echo "設定が完了したら、再度 npm run debug:start を実行してください。"
  exit 0
fi

# ==== Load state ====
# shellcheck disable=SC1090
source "$DEBUG_STATE"

# ==== Step 2: Configure snapshot URL (after R2 custom domain setup) ====
if [ "${SETUP_PHASE:-}" = "resources_created" ]; then
  echo "===== デバッグ環境の初期セットアップ (Step 2/2) ====="
  echo ""

  read -rp "R2 スナップショットの公開 URL (例: https://snapshot.example.com/snapshot/latest.json): " SNAPSHOT_URL
  if [ -z "$SNAPSHOT_URL" ]; then
    echo "Error: SNAPSHOT_URL は必須です"
    exit 1
  fi

  sed -i '/^SETUP_PHASE=/d' "$DEBUG_STATE"
  echo "SNAPSHOT_URL=$SNAPSHOT_URL" >> "$DEBUG_STATE"
  echo "SETUP_PHASE=configured" >> "$DEBUG_STATE"

  # Re-source
  # shellcheck disable=SC1090
  source "$DEBUG_STATE"
fi

# ==== Check required state ====
if [ -z "${SNAPSHOT_URL:-}" ]; then
  echo "Error: SNAPSHOT_URL が未設定です。.debug-state を削除して debug:start をやり直してください。"
  exit 1
fi

# ==== Build CORS allowed origins for Vite dev ====
# Vite dev が bind する localhost / 127.0.0.1 / LAN IP × 候補ポートを自動生成。
# 追加で許可したい origin があれば DEBUG_CORS_EXTRA_ORIGINS にカンマ区切りで指定する。
VITE_DEV_PORTS="${DEBUG_VITE_PORTS:-5173 5174}"
LAN_IPS=$(node -e "const os=require('os');const a=Object.values(os.networkInterfaces()).flat().filter(n=>n&&n.family==='IPv4'&&!n.internal).map(n=>n.address);process.stdout.write(a.join(' '))" 2>/dev/null || true)

CORS_ORIGINS=""
append_origin() {
  if [ -z "$1" ]; then return; fi
  if [ -n "$CORS_ORIGINS" ]; then CORS_ORIGINS="$CORS_ORIGINS,"; fi
  CORS_ORIGINS="${CORS_ORIGINS}$1"
}
for port in $VITE_DEV_PORTS; do
  append_origin "http://localhost:$port"
  append_origin "http://127.0.0.1:$port"
  for ip in $LAN_IPS; do
    append_origin "http://$ip:$port"
  done
done
if [ -n "${DEBUG_CORS_EXTRA_ORIGINS:-}" ]; then
  append_origin "$DEBUG_CORS_EXTRA_ORIGINS"
fi

# ==== Generate wrangler.debug.toml ====
cat > "$DEBUG_WRANGLER" <<EOF
name = "$WORKER_NAME"
main = "worker/src/index.ts"
compatibility_date = "2025-04-14"

[vars]
KW_BASE_URL = "$KW_BASE_URL"
AUTH_MODE = "public"
HISTORY_CORS_ALLOWED_ORIGINS = "$CORS_ORIGINS"

[triggers]
crons = ["0 3 * * *"]

[[durable_objects.bindings]]
name = "UI_BRIDGE"
class_name = "UIBridgeDurableObject"

[[migrations]]
tag = "plan04-ui-bridge"
new_sqlite_classes = ["UIBridgeDurableObject"]

[[d1_databases]]
binding = "HISTORY_DB"
database_name = "$D1_NAME"
database_id = "$D1_DATABASE_ID"

[[r2_buckets]]
binding = "SNAPSHOT_BUCKET"
bucket_name = "$R2_NAME"
EOF

# ==== D1 migrations ====
echo ""
echo "D1 マイグレーションを適用中..."
npx -y wrangler d1 migrations apply HISTORY_DB --remote -c "$DEBUG_WRANGLER" || true

# ==== Secrets (first time only) ====
if ! grep -q "^SECRETS_SET=true$" "$DEBUG_STATE" 2>/dev/null; then
  echo ""
  echo "KW_ADMIN_KEY シークレットを設定してください:"
  npx -y wrangler secret put KW_ADMIN_KEY -c "$DEBUG_WRANGLER"
  echo "SECRETS_SET=true" >> "$DEBUG_STATE"
fi

# ==== Deploy Worker ====
echo ""
echo "Worker をデプロイ中..."
DEPLOY_OUTPUT=$(npx -y wrangler deploy -c "$DEBUG_WRANGLER" 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract Worker URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[^\s]+\.workers\.dev' | head -1 || true)
if [ -n "$WORKER_URL" ]; then
  sed -i '/^WORKER_URL=/d' "$DEBUG_STATE" 2>/dev/null || true
  echo "WORKER_URL=$WORKER_URL" >> "$DEBUG_STATE"
fi

# ==== Write .env.local for Vite ====
# Re-source to pick up WORKER_URL
# shellcheck disable=SC1090
source "$DEBUG_STATE"

if [ -z "${WORKER_URL:-}" ]; then
  echo ""
  echo "Warning: Worker URL を検出できませんでした"
  echo ".debug-state に WORKER_URL=https://... を手動で追記してから再実行してください"
  exit 1
fi

cat > .env.local <<EOF
# Generated by debug:start — do not edit manually
VITE_SNAPSHOT_URL=$SNAPSHOT_URL
VITE_AUTH_MODE=public
VITE_API_BASE_URL=${WORKER_URL}/api/history
VITE_PHASE3_EFFECTS_ENABLED=false
EOF

# ==== Warm up Worker DO so snapshot publishing alarms start ====
# 初回 fetch で DO の boot() → refreshSnapshot('boot') → rescheduleAlarm() が走る。
# これを踏まないと curl を手動で叩くまで R2 への publish が始まらない。
echo ""
echo "Worker DO をウォームアップ中 ($WORKER_URL)..."
WARMUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "$WORKER_URL/" || echo "000")
if [ "$WARMUP_STATUS" = "204" ] || [ "$WARMUP_STATUS" = "200" ]; then
  echo "Worker DO ウォームアップ完了 (HTTP $WARMUP_STATUS)"
else
  echo "Warning: Worker DO ウォームアップの応答が想定外でした (HTTP $WARMUP_STATUS)"
  echo "  R2 への初回 publish が遅延する場合があります。"
fi

echo ""
echo "===== デバッグ環境の準備完了 ====="
echo "Worker:   $WORKER_URL"
echo "Snapshot: $SNAPSHOT_URL"
echo ""
echo "Vite dev server を起動します..."
echo ""

npx -y vite
