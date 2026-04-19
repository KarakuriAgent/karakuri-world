# karakuri-world-ui

観戦用 UI。Vite/React SPA（Cloudflare Pages）+ Cloudflare Worker（履歴 API・スナップショット配信）の 2 層構成。

## ローカル開発

`.env.local` を作成してから起動する：

```bash
VITE_SNAPSHOT_URL=https://snapshot.example.com/snapshot/latest.json
VITE_AUTH_MODE=public
VITE_API_BASE_URL=https://your-worker.workers.dev/api/history
```

```bash
cd karakuri-world-ui
npm install
npm run dev
```

必須環境変数が欠けていると `npm run dev` / `npm run build` は即座に停止する（fail-fast）。

### 環境変数一覧

| 変数 | 必須 | 説明 |
|------|------|------|
| `VITE_SNAPSHOT_URL` | ✓ | R2 カスタムドメインのスナップショット URL（`/api/snapshot` は不可） |
| `VITE_AUTH_MODE` | ✓ | `public` または `access` |
| `VITE_API_BASE_URL` | ✓ | Worker の `/api/history` までの完全な URL |
| `VITE_PHASE3_EFFECTS_ENABLED` | - | エフェクト機能全体の ON/OFF（既定 `false`） |
| `VITE_PHASE3_EFFECT_RAIN_ENABLED` など | - | 個別エフェクトフラグ（既定 `false`） |

## デプロイ手順

### 1. Cloudflare リソースを作成

```bash
# D1 データベース（履歴保存用）
npx wrangler d1 create karakuri-world-ui-history

# R2 バケット（スナップショット保存用）
npx wrangler r2 bucket create karakuri-world-ui-snapshot
npx wrangler r2 bucket create karakuri-world-ui-snapshot-preview
```

### 2. wrangler.toml を用意

```bash
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` 内のプレースホルダを実際の値に書き換える：

- `database_id` / `preview_database_id` → D1 作成時に返された ID
- `bucket_name` / `preview_bucket_name` → 作成した R2 バケット名

### 3. シークレットを設定（初回のみ）

```bash
npx wrangler secret put KW_ADMIN_KEY         # Karakuri World の管理キー
npx wrangler secret put KW_BASE_URL          # Karakuri World サーバーの URL
```

Pages と Worker がクロスオリジンの場合は CORS 許可も設定：

```bash
npx wrangler secret put HISTORY_CORS_ALLOWED_ORIGINS
# 例: https://your-pages.pages.dev,https://ui.example.com
```

### 4. R2 バケットの CORS を設定

Pages ドメインと R2 カスタムドメインがクロスオリジンの場合（通常はそう）、R2 バケットに CORS ルールを追加する：

```bash
cat > /tmp/cors.json << 'EOF'
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://your-pages-domain.example.com"],
        "methods": ["GET", "HEAD"],
        "headers": ["*"]
      },
      "maxAgeSeconds": 86400
    }
  ]
}
EOF
npx wrangler r2 bucket cors set karakuri-world-ui-snapshot --file /tmp/cors.json
```

`origins` は実際の Pages ドメイン（例: `https://karakuri-world.0235.app`）に書き換えること。設定確認は `npx wrangler r2 bucket cors list karakuri-world-ui-snapshot`。

### 6. Worker をデプロイ

```bash
npm run deploy:prod
```

このコマンドは順に：
1. `wrangler.toml` のプレースホルダ残存チェック（あれば停止）
2. D1 マイグレーション適用
3. `wrangler deploy`
4. Worker へのウォームアップリクエスト（スナップショット配信の起動）

> **注意**: ウォームアップが成功しないと R2 へのスナップショット発行が始まらない。

### 7. フロントエンドをデプロイ（Cloudflare Pages）

`.env.local` の `VITE_*` 変数をセットしてからビルド・デプロイ：

```bash
npm run build
npx wrangler pages deploy dist --project-name karakuri-world-ui-frontend \
  --commit-dirty=true --commit-message="deploy"
```

## 認証モード

### `AUTH_MODE=public`（推奨・シンプル）

Pages・Worker `/api/history`・R2 カスタムドメインがすべて公開アクセス可能。

### `AUTH_MODE=access`

Cloudflare Access でブラウザセッションを保護する場合。Pages・Worker・R2 の全エンドポイントを同一の Access ポリシー配下に置き、1 回ログインで全 Cookie を取得できる構成にする必要がある。

## デプロイ後の確認

1. `VITE_SNAPSHOT_URL` をブラウザで直接開き、JSON が返ること
2. `/api/history?agent_id=<id>&limit=1` を Worker に叩き、応答があること
3. UI を開いてスナップショットが定期更新されていること（60 秒以内）

## R2 キャッシュ設定

Cloudflare ダッシュボードでスナップショットパスに Cache Rule を追加する：

- **ルール**: `Cache Everything`
- **Edge TTL**: `5 seconds`

R2 側のオブジェクトには `Cache-Control: public, max-age=5` を設定する。

## テスト

```bash
npm test                       # フルスイート
npm run test:phase1-acceptance # UI 受入ゲートのみ
npm run relay:readiness        # アラート設定の検証
```

## 運用ファイル

| ファイル | 用途 |
|---------|------|
| `worker/ops/relay-alerting-spec.json` | アラートルール定義 |
| `worker/ops/relay-production-readiness.template.json` | 本番 sign-off テンプレ |
| `schema/history.sql` | D1 スキーマ |
| `migrations/0001_plan05_history_schema.sql` | Wrangler マイグレーション |
