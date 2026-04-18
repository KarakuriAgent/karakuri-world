# karakuri-world-ui

## 観戦 UI の開発・ビルド環境

この Vite アプリは fail-fast 方針で、必要なブラウザ側の環境変数が揃っていない場合は `npm run dev` / `npm run build` が即座に停止する。

`karakuri-world-ui/.env.local`（または他の Vite env ファイル）を作成する：

```bash
VITE_SNAPSHOT_URL=https://snapshots.example.com/snapshot/latest.json
VITE_AUTH_MODE=public
VITE_API_BASE_URL=https://history.example.com/api/history
VITE_PHASE3_EFFECTS_ENABLED=false
VITE_PHASE3_EFFECT_RAIN_ENABLED=false
VITE_PHASE3_EFFECT_SNOW_ENABLED=false
VITE_PHASE3_EFFECT_FOG_ENABLED=false
VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED=false
VITE_PHASE3_EFFECT_MOTION_ENABLED=false
VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED=false
```

### 必須項目

- `VITE_SNAPSHOT_URL`: ブラウザから直接 fetch できるスナップショット公開 URL の絶対パス。plan12 以降は R2 カスタムドメイン配下のオブジェクト URL を指す。ブラウザバンドルに同梱される値なので、`http` / `https` のみ、かつ認証情報・クエリ・フラグメントを含めてはならない。`/api/snapshot` を指してはならず、ブラウザは常に R2 カスタムドメイン配下のオブジェクト URL を直接ポーリングする。
- `VITE_AUTH_MODE`: `public` または `access` のいずれか。
- `VITE_API_BASE_URL`: Worker history API の絶対 URL。必ず `/api/history` までを含む完全な URL とし、Worker オリジンだけ / 親パス `/api` だけでは不可。こちらもブラウザ公開値のため、認証情報・クエリ・フラグメントは禁止。
- `VITE_PHASE3_EFFECTS_ENABLED`（任意）: `true` / `false`。既定値 `false`。意図的に Phase 3 エフェクトを検証するとき以外は OFF のままにする。
- `VITE_PHASE3_EFFECT_RAIN_ENABLED` / `VITE_PHASE3_EFFECT_SNOW_ENABLED` / `VITE_PHASE3_EFFECT_FOG_ENABLED` / `VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED`（任意）: 個別エフェクトの rollout フラグ。既定値はすべて `false` で、`VITE_PHASE3_EFFECTS_ENABLED=true` のときにのみ有効。rain / snow / fog / day-night を Phase 3 基盤を残したまま個別にロールバック可能。
- `VITE_PHASE3_EFFECT_MOTION_ENABLED` / `VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED`（任意）: 移動補間と `current_activity.emoji` ベースの軽量パーティクルの rollout フラグ。既定値 `false`、かつ `VITE_PHASE3_EFFECTS_ENABLED=true` のときのみ有効。段階 rollout / ロールバック時は Phase 1 の静的ノード描画がフォールバックとして残る。

### ローカル検証

```bash
cd karakuri-world-ui
npm run dev
npm run build
npm run test:phase1-acceptance
```

## Phase 1 受入ゲート

`npm run test:phase1-acceptance` は観戦 UI の Phase 1 振る舞いに絞った受入ゲート。Unit 28 以降の配信経路転換は Unit 29+ で整理されているが、実務的な UI の go/no-go チェックとしてこのコマンドを使う。

自動ゲートが保証する項目：

- デスクトップ / モバイル初期シェルが同一 map host を共有して描画される
- 100 エージェントのスナップショット反映が Phase 1 の 15 秒予算内に収まる
- `/api/history` が空 or 劣化していても、選択中エージェント詳細の一貫性が保たれる
- `/api/history?agent_id=...&limit=20` が取得できる場合は会話ログ展開が加算的に動く
- 静穏期の鮮度（`generated_at` の更新で 60 秒閾値に達する前に stale 化しないこと）
- **Unit 29/32 との整合**: sub-minute 可能な publisher トリガで駆動される定周期スナップショット発行＋直接 R2 ポーリングが、15 秒予算を守ること

フルスイートは `npm test`、Phase 1 ゲートのみを回すなら `npm run test:phase1-acceptance`。

## Phase 2 認証モード別デプロイガイド

1 つのデプロイで選べる認証モードは `AUTH_MODE=public` または `AUTH_MODE=access` のいずれか 1 つ。Pages / Worker `/api/history` / R2 `snapshot_url` のすべてが同じモードで構成されたときのみデプロイ成立。

- `AUTH_MODE=public`: Pages・Worker `/api/history`・R2 カスタムドメインがすべて公開。
- `AUTH_MODE=access`: Pages・Worker `/api/history`・R2 カスタムドメインがすべて Cloudflare Access で保護され、ブラウザは `snapshot_url` / `/api/history` 双方を `credentials: 'include'` で fetch する。
- Pages と Worker `/api/history` がクロスオリジンの場合、Worker の `HISTORY_CORS_ALLOWED_ORIGINS` に許可する Pages オリジンをカンマ区切りで指定する（例: `https://ui.example.com,https://preview-ui.example.com`）。Worker は設定済みオリジンのみエコーし、`AUTH_MODE=access` では `Access-Control-Allow-Credentials: true` も返すため `*` では代替不可。

1 デプロイ内でモードを混在させないこと。また `AUTH_MODE=access` の前提が満たされない場合でも Worker/Pages によるスナップショットプロキシをフォールバックとして追加してはならない。Access Cookie の共有 / 事前 seed が確約できない場合は `/api` 経由で中継せず、`AUTH_MODE=public` に切り替える。

### R2 カスタムドメインの必須セットアップ

`snapshot_url` は常に「R2 カスタムドメイン + `SNAPSHOT_OBJECT_KEY`」（既定キーなら `https://snapshot.example.com/snapshot/latest.json`）。ブラウザは両認証モードとも同 URL を直接 fetch する。

運用側の設定：

1. バケットを Cloudflare カスタムドメイン経由で公開する。
2. スナップショットオブジェクトパスに `Cache Everything` の Cache Rule を追加。
3. Edge TTL を `5 seconds` に固定。
4. オリジン側の `Cache-Control: public, max-age=5` と整合させる。
5. Pages と R2 カスタムドメインがクロスオリジンなら、両モードとも Pages オリジンを R2 CORS で許可する。`AUTH_MODE=access` ではさらに `Access-Control-Allow-Credentials: true` を許可。

### `AUTH_MODE=access` の絶対要件

`AUTH_MODE=access` が有効なのは、SPA が `snapshot_url` のポーリングを開始する前に、Pages オリジン・R2 カスタムドメイン双方で利用可能な Access セッションをブラウザが既に持っているときに限る。

- 推奨: Pages / Worker `/api/history` / R2 カスタムドメインを 1 つの Access アプリ（または同等の複数ドメインポリシー）配下に置き、1 回ログインで双方の Cookie を事前に seed する。
- 許容される代替策: R2 カスタムドメイン向け Cookie を明示的に事前 seed する（専用 R2 訪問 / サイレント事前 seed フロー）。
- 不可: CORS のみに依存する / R2 Access Cookie が無い場合に同一オリジン Worker・Pages のスナップショットプロキシへフォールバックする。

### public/access スモークチェックリスト

デプロイ後・認証モード変更後に必ず実施：

1. デプロイ済み UI を開き、選択モード以外が混在していないこと。
2. `VITE_SNAPSHOT_URL` を直接ブラウザで叩く：
   - `AUTH_MODE=public`: Access ログイン無しで 200。
   - `AUTH_MODE=access`: Pages / R2 双方で Access セッションが確立されてからのみ 200。Pages ログイン済なのに R2 で Access challenge が残る場合はデプロイ未完了。
3. 返答が `/api/snapshot` ではなく R2 カスタムドメインオブジェクトパスから来ていること。
4. 同じリクエストを再実行し、`Cache Everything` + `Edge TTL = 5 seconds` により edge キャッシュ HIT（`CF-Cache-Status: HIT` 等）となること。
5. `/api/history?agent_id=<known-agent>&limit=1` をデプロイ済 Worker に叩く：
   - `AUTH_MODE=public`: Access ログイン無しで成功。
   - `AUTH_MODE=access`: ログイン前は Access challenge / 失敗、ログイン後に成功。
6. Pages と Worker `/api/history` がクロスオリジンなら、preflight / GET 応答に `Access-Control-Allow-Origin: <Pages オリジン>` が含まれ、`AUTH_MODE=access` では `Access-Control-Allow-Credentials: true` および credentialed fetch 成功も確認。
7. Pages と R2 がクロスオリジンなら、`AUTH_MODE=access` で `Access-Control-Allow-Credentials: true` と credentialed fetch 成功も確認。
8. 上記が `AUTH_MODE=access` で満たせない場合は Access Cookie 共有 / 事前 seed を直すか `AUTH_MODE=public` を選択。プロキシフォールバックは禁止。

### 運用側に残る手動チェック項目

以下は staging / preview インフラが必要で、ローカル Vitest だけでは証明できない：

1. **R2 カスタムドメインの edge キャッシュ（両認証モード共通）**
    - スナップショットオブジェクトパスに `Cache Everything` + `Edge TTL = 5 seconds` を適用。
    - 同じオブジェクトを 2 回 fetch し、2 回目が edge HIT (`CF-Cache-Status: HIT` 等) になること（cached age は 5 秒 TTL 内）。
    - TTL 経過後は `generated_at` / `published_at` が更新された新しいボディを返し、鮮度予算を破らないこと。

2. **`AUTH_MODE=access` の Cookie 共有 / 事前 seed**
    - Pages へのログインが R2 カスタムドメインの Access セッションも確立するか、事前 seed フローが確実に動くこと。
    - SPA ポーリング前に、ブラウザから `snapshot_url` へ直接 `credentials: 'include'` で fetch して成功すること。
    - R2 ドメイン側でリダイレクト / challenge が残る場合はデプロイ無効扱い。プロキシ追加禁止。

3. **定周期パブリッシュ継続シナリオ**
    - デプロイ済 Worker + UI を開いた状態で、静穏期に 3 周期以上連続で publish が走り、sub-minute 可能なトリガ（Durable Object alarm / 外部 cron / 常駐スケジューラ等）によって `generated_at` が更新され続けることを観測。
    - R2 オブジェクトが 5 秒刻みで更新され続けるあいだ、UI が前フレームを保持し 60 秒閾値まで stale 化しないこと。
    - 日次 Worker `scheduled()` cron は retention 専用で、この publisher トリガではないこと（単独では 5 秒鮮度を満たさない）。

## Cloudflare Worker デプロイ

`wrangler.toml` は git-ignore 済み。トラック済テンプレ `wrangler.toml.example` からローカル生成する：

```bash
cd karakuri-world-ui
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml.example` にはデプロイ不能なプレースホルダが入っている：

- `database_id = "00000000-0000-0000-0000-000000000000"`
- `preview_database_id = "00000000-0000-0000-0000-000000000000"`

R2 バケットも同様：

- `bucket_name = "replace-with-real-snapshot-bucket"`
- `preview_bucket_name = "replace-with-real-snapshot-bucket-preview"`

本番デプロイ前に、UI history 用 D1 を作成または特定し、Wrangler が返した ID でローカル `wrangler.toml` の 2 箇所を置き換える。

テンプレには Worker `scheduled()` ハンドラを 1 日 1 回 `03:00 UTC` に回す cron も入っている（D1 history retention 用）。本番でもこの cron（または同等の日次スケジュール）は維持する。

この日次 cron は **retention 専用**で、スナップショット publisher ではない。本番 readiness にはさらに、静穏期でも publish を継続できる **sub-minute 可能な 5 秒トリガ**（Durable Object alarm / 外部 cron / 常駐スケジューラ等）が必須。

例：

```bash
cd karakuri-world-ui
npx wrangler d1 create karakuri-world-ui-history
npx wrangler r2 bucket create <real-snapshot-bucket>
npx wrangler r2 bucket create <real-snapshot-bucket-preview>
```

その後 `wrangler.toml` に返された `database_id` / `preview_database_id` と実 R2 バケット名を反映し、必要なシークレット（初回のみ）を設定してからデプロイ：

```bash
npx wrangler secret put KW_ADMIN_KEY
npm run deploy:prod
```

`deploy:prod` は以下を順に実行するラッパ：

1. `wrangler.toml` にプレースホルダ値（`00000000-...` / `replace-with-real-...`）が残っていたら fail-closed で停止。
2. `npx wrangler d1 migrations apply HISTORY_DB --remote` で D1 マイグレーションを適用。
3. `npx wrangler deploy` でデプロイ。
4. Worker URL に対して 1 回 `curl` を打ち、DO の `boot()` → `refreshSnapshot('boot')` → `rescheduleAlarm()` をトリガ。ウォームアップが `HTTP 200/204` 以外を返した場合はスクリプトを **失敗扱いで exit** し、snapshot publisher が休眠したままになることを防ぐ。

この 4 つ目のウォームアップを踏まないと、次に誰かが Worker を叩くまで R2 への publish が始まらない。ウォームアップ後は DO alarm 自身が 5 秒間隔の publisher トリガとして自走するため、外部 cron を追加配線する必要はない。

最低限、`KW_BASE_URL` と Worker で使う非既定のスナップショット publisher 設定も必要。Pages と Worker `/api/history` がクロスオリジンなら `HISTORY_CORS_ALLOWED_ORIGINS` に Pages オリジンリストも設定する。`HISTORY_RETENTION_DAYS` は任意で既定 `180`、上書きする場合は Worker と cron で同じ retention ポリシーにする。

リポジトリ管理の D1 スキーマは `schema/history.sql`、デプロイ用 Wrangler マイグレーションは `migrations/0001_plan05_history_schema.sql`。

## Relay アラート配線と readiness ゲート

Unit 32 で relay `/ws` は完全に廃止された。readiness は polling + R2/CDN の鮮度、定周期スナップショット発行、認証モードの整合性のみで構成される。relay アラート成果物（`relay-alerting-spec.json` 等）は `ui.*` と `relay.r2.*` シグナルだけをカバーし、relay WebSocket シグナルは残っていない。

リポジトリ管理の正本成果物：

- `worker/ops/relay-alerting-spec.json`: アラートルール / 配信ルート / clear 条件 / 認証系とネットワーク系のルート分割。
- `worker/ops/relay-synthetic-drills.json`: staging ドリルカタログ＋期待アラート経路に到達する合成メトリックタイムライン。
- `worker/ops/relay-production-readiness.template.json`: 本番 sign-off テンプレ（実ルート / 受信ログ / ドリル証跡 / sign-off 時刻が埋まるまで fail-closed）。
- `worker/ops/relay-production-readiness.example.json`: レビュー / テスト用の passing 例。

検証コマンド：

```bash
cd karakuri-world-ui
npm run relay:readiness
npm run relay:readiness -- --target=production --manifest worker/ops/relay-production-readiness.example.json --wrangler worker/test/fixtures/wrangler.production.example.toml
```

`npm run relay:readiness` 単体はリポ内カタログ / ドリル成果物を検証。primary の polling / R2 readiness は上記手動チェック＋ Unit 29+ の手順が別途必要。本番 relay 検証は manifest が埋まるまで fail-closed のまま。

relay ゲートが満たすべき条件：

- readiness アラートは Unit 10/29+ の primary メトリクスセットを使う: `ui.snapshot.refresh_failure_total{reason}`、`ui.snapshot.generated_age_ms`、`ui.snapshot.published_age_ms`、`ui.r2.publish_failure_total`、`ui.r2.publish_failure_streak`、`ui.d1.retention_run_total{result=success}`、`ui.d1.retention_deleted_rows`。
- sustained outage の pager ルートが実本番配信先に解決できること。
- retention cron サイレンス（`ui.d1.retention_run_total{result=success}` が 2 日不在）、retention バックログ肥大（`ui.d1.retention_deleted_rows` がレビュー閾値超過）、R2 retry brake 飽和（`ui.r2.publish_failure_streak >= 5`、60 秒 cap に合致）が明示ゲート項目。
- 即時（auth/config）pager ルートと sustained outage pager ルートは別の本番配信先に解決されること。
- 本番 manifest は実通知先 / provider ルール参照 / 要求される全アラート経路の staging ドリル証跡（observed alert ID & observed route ID）/ 事前 sign-off を含むこと。
- `wrangler.toml` に `HISTORY_DB` / `SNAPSHOT_BUCKET` バインドが無い、プレースホルダ D1/R2 のまま、日次 `03:00 UTC` retention cron が無い場合も本番検証は失敗扱い。
