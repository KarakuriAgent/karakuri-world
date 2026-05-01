# @karakuri-world/front

観戦用 UI。Vite/React SPA（Cloudflare Pages）+ Cloudflare Worker（Durable Object による snapshot/history publish）の 2 層構成で、Karakuri World モノレポの `apps/front/` workspace にあたる。

以下のコマンドは `apps/front/` 内で実行するか、リポジトリルートから `npm run dev:front` / `npm run build:front` / `npm test -w @karakuri-world/front` で叩く。

## ローカル開発

`.env.local` を作成してから起動する：

```bash
VITE_SNAPSHOT_URL=https://snapshot.example.com/snapshot/latest.json
VITE_AUTH_MODE=public
```

```bash
cd apps/front
npm install
npm run dev
```

必須環境変数が欠けていると `npm run dev` / `npm run build` は即座に停止する（fail-fast）。

### 環境変数一覧

| 変数 | 必須 | 説明 |
|------|------|------|
| `VITE_SNAPSHOT_URL` | ✓ | R2 カスタムドメイン上の snapshot alias URL（既定キー: `snapshot/latest.json`）。ブラウザから直接 fetch する。`http` / `https` のみ、認証情報・クエリ・フラグメント不可 |
| `VITE_AUTH_MODE` | ✓ | `public` または `access` |
| `VITE_PHASE3_EFFECTS_ENABLED` | - | エフェクト機能全体の ON/OFF（既定 `false`） |
| `VITE_PHASE3_EFFECT_RAIN_ENABLED` / `_SNOW_` / `_FOG_` / `_DAY_NIGHT_` | - | 天候・時間帯エフェクトの個別 rollout フラグ（既定 `false`、`VITE_PHASE3_EFFECTS_ENABLED=true` のときのみ有効） |
| `VITE_PHASE3_EFFECT_MOTION_ENABLED` / `_ACTION_PARTICLES_` | - | 移動補間・`current_activity.emoji` パーティクルの個別 rollout フラグ（既定 `false`、同条件） |

history オブジェクト（`history/agents/{agent_id}.json` / `history/conversations/{conversation_id}.json`）は `VITE_SNAPSHOT_URL` と同 origin から派生する。Worker 側に read endpoint はないため `VITE_API_BASE_URL` は不要。

## デプロイ手順

### 1. Cloudflare リソースを作成

```bash
# snapshot / history を同居させる R2 バケット
npx wrangler r2 bucket create <real-snapshot-bucket>
npx wrangler r2 bucket create <real-snapshot-bucket-preview>
```

### 2. wrangler.toml を用意

`wrangler.toml` は git-ignore 済み。トラック済みテンプレからローカル生成する：

```bash
cd apps/front
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` 内のプレースホルダ R2 バケット名（`replace-with-real-snapshot-bucket` / `...-preview`）を、作成した実バケット名に書き換える。

### 3. シークレットを設定（初回のみ）

```bash
npx wrangler secret put SNAPSHOT_PUBLISH_AUTH_KEY
```

`SNAPSHOT_PUBLISH_AUTH_KEY` は本体サーバー（`@karakuri-world/server`）が `/api/publish-snapshot` / `/api/publish-agent-history` を叩くときに使う共有 Bearer トークン。本体側 `.env` の同名変数と完全一致させる。空文字・空白のみは Worker 起動時の env parse で失敗するので不可。未設定なら publish endpoint は default-deny の `503` のままとなる。

対話式デバッグフロー（`npm run debug:start`）では、本体サーバーで使っている値と同じ共有キーを入力する。

### 4. R2 バケットの CORS を設定

Pages ドメインと R2 カスタムドメインがクロスオリジンの場合、`snapshot/*` と `history/*` の両 prefix について Pages オリジンを許可する：

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
npx wrangler r2 bucket cors set <real-snapshot-bucket> --file /tmp/cors.json
```

`origins` は実際の Pages ドメインに書き換える。`AUTH_MODE=access` ではさらに `Access-Control-Allow-Credentials: true` も許可する必要がある。設定確認は `npx wrangler r2 bucket cors list <real-snapshot-bucket>`。

### 5. Worker をデプロイ

```bash
npm run deploy:prod
```

`deploy:prod` は以下を順に実行するラッパ：

1. `wrangler.toml` にプレースホルダ R2 バケット名が残っていたら fail-closed で停止
2. `npx wrangler deploy` でデプロイ

デプロイ後のウォームアップリクエストは不要。relay Durable Object は、backend から最初の認証済み `POST /api/publish-snapshot` または `POST /api/publish-agent-history` が届いた時点で自動的に起動する。

### 6. フロントエンドをデプロイ（Cloudflare Pages）

`.env.local` の `VITE_*` 変数をセットしてからビルド・デプロイ：

```bash
npm run build
npx wrangler pages deploy dist --project-name karakuri-world-ui-frontend \
  --commit-dirty=true --commit-message="deploy"
```

## 認証モード

1 デプロイで選べるのは `AUTH_MODE=public` または `AUTH_MODE=access` のいずれか 1 つ。Pages と R2 カスタムドメイン（`snapshot/latest.json` と `history/*` を配信する）が同じモードで構成されたときのみデプロイ成立。

### `AUTH_MODE=public`（推奨・シンプル）

Pages・R2 カスタムドメインがすべて公開アクセス可能。

### `AUTH_MODE=access`

Pages と R2 カスタムドメインを 1 つの Access アプリ（または同等の複数ドメインポリシー）配下に置き、1 回ログインで双方の Cookie を事前に seed する構成が前提。ブラウザは snapshot / history オブジェクトを `credentials: 'include'` で fetch する。

Access Cookie の共有 / 事前 seed が確約できない場合は、Worker/Pages でのスナップショットプロキシをフォールバックとして追加してはならない。代わりに `AUTH_MODE=public` へ切り替える。

## デプロイ後の確認

1. `VITE_SNAPSHOT_URL` をブラウザで直接開き、JSON が返ること（`AUTH_MODE=access` では Access セッション確立後のみ 200）
2. 同じ URL を再 fetch し、`Cache Everything` + `Edge TTL = 5 seconds` により `CF-Cache-Status: HIT` になること
3. `history/agents/<known-agent>.json` を同じ R2 origin から直接取得できること
4. Pages と R2 がクロスオリジンなら、`snapshot/*` と `history/*` の preflight / GET に期待どおりの CORS ヘッダが付き、`AUTH_MODE=access` では `Access-Control-Allow-Credentials: true` と credentialed fetch 成功も確認
5. UI を開いてスナップショットが定期更新されていること（publish-health メタデータが失敗を示さない限り stale バナーが出ないこと、出た場合も成功 publish か 3 分 fallback resync で解消されること）

`AUTH_MODE=access` で上記が満たせない場合は Access Cookie 共有 / 事前 seed を直すか `AUTH_MODE=public` を選択。プロキシフォールバックは禁止。

## R2 キャッシュ設定

Cloudflare ダッシュボードで `snapshot/latest.json` と `history/*` の両方に Cache Rule を追加する：

- **ルール**: `Cache Everything`
- **Edge TTL**: `5 seconds`

R2 側のオブジェクトには `Cache-Control: public, max-age=5` を設定し、オリジンと edge の TTL を揃える。

## テスト

```bash
npm test                       # フルスイート
npm run test:phase1-acceptance # Phase 1 受入ゲートのみ
npm run relay:readiness        # relay アラート設定の検証
```

`npm run test:phase1-acceptance` は観戦 UI の Phase 1 go/no-go チェックで、以下を保証する：

- デスクトップ / モバイル初期シェルが同一 map host を共有して描画される
- 100 エージェントのスナップショット反映が Phase 1 の 15 秒予算内に収まる
- history オブジェクトが空 / 劣化していても選択中エージェント詳細の一貫性が保たれる
- `history/agents/{agent_id}.json` があれば会話ログ展開が加算的に動く
- stale は publish-health メタデータ（`last_publish_error_at`）で決まり、成功 publish または 3 分 fallback resync で回復する
- event-driven な snapshot/history 配信を primary とし、静穏期経路は sub-minute heartbeat ではなく 3 分 fallback resync のみ

## Relay readiness ゲート

Unit 32 で relay `/ws` は primary path から外れ、バックエンドの legacy `/ws` endpoint も削除済み。Worker 側も `/ws` を `404` で fail-close する。readiness は polling + R2/CDN 鮮度、alias オブジェクト（snapshot / history 双方）への直接 fetch、event-driven な publish、認証モード整合性で構成され、静穏期経路は 3 分 fallback resync のみ。relay アラート成果物は `ui.*` / `relay.r2.*` シグナルに限定される（relay WebSocket シグナルは残っていない）。

relay ゲートが満たすべき条件：

- readiness アラートは primary メトリクスセット `ui.snapshot.refresh_failure_total{reason}` / `ui.snapshot.generated_age_ms` / `ui.snapshot.published_age_ms` / `ui.r2.publish_failure_total` / `ui.r2.publish_failure_streak` を使う
- `ui.snapshot.refresh_failure_total{reason}` の `reason` は Worker が実際に emit する `boot` / `fallback-refresh` / `world-event` / `manual` / `external-request` を使う
- R2 retry brake 飽和（`ui.r2.publish_failure_streak >= 5`、60 秒 cap）が明示ゲート項目
- 即時（auth/config）pager ルートと sustained outage pager ルートは別の本番配信先に解決されること
- 本番 manifest は実通知先 / provider ルール参照 / 要求される全アラート経路の staging ドリル証跡 / 事前 sign-off を含むこと
- `wrangler.toml` に必須の `SNAPSHOT_BUCKET` バインドが無い、またはプレースホルダ R2 のままの場合は本番検証失敗

`npm run relay:readiness` 単体はリポ内カタログ / ドリル成果物のみ検証。本番 relay 検証は manifest が埋まるまで fail-closed のまま。

## 運用ファイル

| ファイル | 用途 |
|---------|------|
| `worker/ops/relay-alerting-spec.json` | アラートルール / 配信ルート / clear 条件 |
| `worker/ops/relay-synthetic-drills.json` | staging ドリルカタログ＋合成メトリックタイムライン |
| `worker/ops/relay-production-readiness.template.json` | 本番 sign-off テンプレ（fail-closed） |
| `worker/ops/relay-production-readiness.example.json` | レビュー / テスト用の passing 例 |
