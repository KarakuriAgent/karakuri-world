# @karakuri-world/front

このパッケージは観戦 SPA（`app/`）と Cloudflare Worker relay（`worker/`）を含む。Karakuri World モノレポの `apps/front/` workspace にあたる。以下のコマンドは `apps/front/` 内で実行するか、リポジトリルートから `npm run dev:front` / `npm run build:front` / `npm test -w @karakuri-world/front` で叩く。

## 観戦 UI の開発・ビルド環境

この Vite アプリは fail-fast 方針で、必要なブラウザ側の環境変数が揃っていない場合は `npm run dev` / `npm run build` が即座に停止する。

`apps/front/.env.local`（または他の Vite env ファイル）を作成する：

```bash
VITE_SNAPSHOT_URL=https://snapshots.example.com/snapshot/latest.json
VITE_AUTH_MODE=public
VITE_PHASE3_EFFECTS_ENABLED=false
VITE_PHASE3_EFFECT_RAIN_ENABLED=false
VITE_PHASE3_EFFECT_SNOW_ENABLED=false
VITE_PHASE3_EFFECT_FOG_ENABLED=false
VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED=false
VITE_PHASE3_EFFECT_MOTION_ENABLED=false
VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED=false
```

### 必須項目

- `VITE_SNAPSHOT_URL`: ブラウザから直接 fetch できるスナップショット alias URL（R2/CDN の `snapshot/latest.json`）の絶対パス。ブラウザはこのオブジェクトを 5 秒周期で polling し、edge は `Cache-Control: public, max-age=5` で同期する。history オブジェクト (`history/agents/{agent_id}.json` / `history/conversations/{conversation_id}.json`) は同じ origin から派生して取得されるため、別 URL は不要。ブラウザバンドルに同梱される値なので、`http` / `https` のみ、かつ認証情報・クエリ・フラグメントを含めてはならない。
- `VITE_AUTH_MODE`: `public` または `access` のいずれか。
- `VITE_PHASE3_EFFECTS_ENABLED`（任意）: `true` / `false`。既定値 `false`。意図的に Phase 3 エフェクトを検証するとき以外は OFF のままにする。
- `VITE_PHASE3_EFFECT_RAIN_ENABLED` / `VITE_PHASE3_EFFECT_SNOW_ENABLED` / `VITE_PHASE3_EFFECT_FOG_ENABLED` / `VITE_PHASE3_EFFECT_DAY_NIGHT_ENABLED`（任意）: 個別エフェクトの rollout フラグ。既定値はすべて `false` で、`VITE_PHASE3_EFFECTS_ENABLED=true` のときにのみ有効。rain / snow / fog / day-night を Phase 3 基盤を残したまま個別にロールバック可能。
- `VITE_PHASE3_EFFECT_MOTION_ENABLED` / `VITE_PHASE3_EFFECT_ACTION_PARTICLES_ENABLED`（任意）: 移動補間と `current_activity.emoji` ベースの軽量パーティクルの rollout フラグ。既定値 `false`、かつ `VITE_PHASE3_EFFECTS_ENABLED=true` のときのみ有効。段階 rollout / ロールバック時は Phase 1 の静的ノード描画がフォールバックとして残る。

### ローカル検証

```bash
cd apps/front
npm run dev
npm run build
npm run test:phase1-acceptance
```

## Phase 1 受入ゲート

`npm run test:phase1-acceptance` は観戦 UI の Phase 1 振る舞いに絞った受入ゲート。Unit 28 以降の配信経路転換は Unit 29+ で整理されているが、実務的な UI の go/no-go チェックとしてこのコマンドを使う。

自動ゲートが保証する項目：

- デスクトップ / モバイル初期シェルが同一 map host を共有して描画される
- 100 エージェントのスナップショット反映が Phase 1 の 15 秒予算内に収まる
- history オブジェクトが空 or 劣化していても、選択中エージェント詳細の一貫性が保たれる
- `history/agents/{agent_id}.json` が取得できる場合は会話ログ展開が加算的に動く
- stale が quiet period の経過時間ではなく publish health メタデータ（`last_publish_error_at`）で決まり、その後の成功 publish または 3 分 fallback resync で回復できること
- **Unit 29/32 との整合**: event-driven な snapshot/history 配信を primary とし、静穏期経路は sub-minute heartbeat ではなく **3 分 fallback resync** のみとすること

フルスイートは `npm test`、Phase 1 ゲートのみを回すなら `npm run test:phase1-acceptance`。

## Phase 2 認証モード別デプロイガイド

1 つのデプロイで選べる認証モードは `AUTH_MODE=public` または `AUTH_MODE=access` のいずれか 1 つ。Pages と R2 カスタムドメイン（`snapshot/latest.json` と `history/*` を配信する）が同じモードで構成されたときのみデプロイ成立。

- `AUTH_MODE=public`: Pages・R2 カスタムドメインがすべて公開。
- `AUTH_MODE=access`: Pages・R2 カスタムドメインがすべて Cloudflare Access で保護され、ブラウザは snapshot / history オブジェクトを `credentials: 'include'` で fetch する。

1 デプロイ内でモードを混在させないこと。また `AUTH_MODE=access` の前提が満たされない場合でも Worker/Pages によるスナップショットプロキシをフォールバックとして追加してはならない。Access Cookie の共有 / 事前 seed が確約できない場合は `AUTH_MODE=public` に切り替える。

### R2 カスタムドメインの必須セットアップ

`snapshot_url` は公開 R2 カスタムドメイン上の alias URL（既定値: `https://snapshot.example.com/snapshot/latest.json`）。ブラウザはこのオブジェクトを 5 秒周期で直接 fetch し、history オブジェクト (`history/agents/{agent_id}.json` / `history/conversations/{conversation_id}.json`) も同じ origin から同周期で取得する。

運用側の設定：

1. バケットを Cloudflare カスタムドメイン経由で公開する。
2. `snapshot/latest.json` と `history/*` の両方に `Cache Everything` の Cache Rule を追加。
3. それぞれの Edge TTL を `5 seconds` に固定。
4. オリジン側の `Cache-Control: public, max-age=5` と整合させる。
5. Pages と R2 カスタムドメインがクロスオリジンなら、`snapshot/*` と `history/*` の両 prefix について Pages オリジンを R2 CORS で許可する。`AUTH_MODE=access` ではさらに `Access-Control-Allow-Credentials: true` を許可。

### `AUTH_MODE=access` の絶対要件

`AUTH_MODE=access` が有効なのは、SPA が `snapshot_url` のポーリングを開始する前に、Pages オリジン・R2 カスタムドメイン双方で利用可能な Access セッションをブラウザが既に持っているときに限る。

- 推奨: Pages と R2 カスタムドメインを 1 つの Access アプリ（または同等の複数ドメインポリシー）配下に置き、1 回ログインで双方の Cookie を事前に seed する。
- 許容される代替策: R2 カスタムドメイン向け Cookie を明示的に事前 seed する（専用 R2 訪問 / サイレント事前 seed フロー）。
- 不可: CORS のみに依存する / R2 Access Cookie が無い場合に同一オリジン Worker・Pages のスナップショットプロキシへフォールバックする。

### public/access スモークチェックリスト

デプロイ後・認証モード変更後に必ず実施：

1. デプロイ済み UI を開き、選択モード以外が混在していないこと。
2. `VITE_SNAPSHOT_URL` を直接ブラウザで叩く：
   - `AUTH_MODE=public`: Access ログイン無しで 200。
   - `AUTH_MODE=access`: Pages / R2 双方で Access セッションが確立されてからのみ 200。Pages ログイン済なのに R2 で Access challenge が残る場合はデプロイ未完了。
3. 返答が R2 カスタムドメイン上の `snapshot/latest.json` から来ていること（Worker には read 系 endpoint が存在しない）。
4. 同じリクエストを再実行し、`Cache Everything` + `Edge TTL = 5 seconds` により edge キャッシュ HIT（`CF-Cache-Status: HIT` 等）となること。
5. `history/agents/<known-agent>.json` を同じ R2 origin から直接取得する：
   - `AUTH_MODE=public`: Access ログイン無しで成功。
   - `AUTH_MODE=access`: ログイン前は Access challenge / 失敗、ログイン後に成功。
6. Pages と R2 がクロスオリジンなら、`snapshot/*` と `history/*` の両方について preflight / GET 応答が期待どおりの CORS ヘッダを返し、`AUTH_MODE=access` では `Access-Control-Allow-Credentials: true` と credentialed fetch 成功も確認。
7. 上記が `AUTH_MODE=access` で満たせない場合は Access Cookie 共有 / 事前 seed を直すか `AUTH_MODE=public` を選択。プロキシフォールバックは禁止。

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

3. **event-driven primary path + 静穏期フォールバック**
    - 代表的な world event を発生させ、Worker がそれを history に ingest しつつ更新済み snapshot を速やかに publish することを確認する。readiness の primary path はこの event-driven 配信。
    - その後デプロイ済 Worker + UI をアイドル状態で開いたままにし、quiet period だけでは stale バナーが出ないことを確認する。代わりに publish health メタデータが失敗を示したときだけ stale が出て、その後の成功 publish または 3 分 fallback resync で解消されることを観測する。

## Cloudflare Worker デプロイ

`wrangler.toml` は git-ignore 済み。トラック済テンプレ `wrangler.toml.example` からローカル生成する：

```bash
cd apps/front
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml.example` には snapshot/history 共有バケット向けのプレースホルダ R2 バケット名が入っている：

- `bucket_name = "replace-with-real-snapshot-bucket"`
- `preview_bucket_name = "replace-with-real-snapshot-bucket-preview"`

本番デプロイ前に、スナップショットオブジェクトと history オブジェクトの両方を保存する R2 バケットを作成または特定し、ローカル `wrangler.toml` の値を実名へ置き換える。

例：

```bash
cd apps/front
npx wrangler r2 bucket create <real-snapshot-bucket>
npx wrangler r2 bucket create <real-snapshot-bucket-preview>
```

その後、必要なシークレット（初回のみ）を設定してからデプロイ：

```bash
npx wrangler secret put SNAPSHOT_PUBLISH_AUTH_KEY
npm run deploy:prod
```

対話式デバッグフロー（`npm run debug:start`）でも、同じ 2 つの Worker secret を入力するようになった。`SNAPSHOT_PUBLISH_AUTH_KEY` には本体サーバーで使っている値と同じ共有キーを設定すること。空文字は不可で、未設定なら Worker の `/api/publish-snapshot` / `/api/publish-agent-history` は default-deny の `503` のまま、空文字・空白だけの secret を設定した場合は Worker 起動時の env parse で失敗する。

`deploy:prod` は以下を順に実行するラッパ：

1. `wrangler.toml` にプレースホルダ R2 バケット名が残っていたら fail-closed で停止。
2. `npx wrangler deploy` でデプロイ。
3. Worker URL に対して 1 回 `curl` を打ち、`UIBridgeDurableObject.boot()` を即時起動して静穏期 alarm 経路を立ち上げる。

最低限、バックエンドが `/api/publish-snapshot` / `/api/publish-agent-history` を叩くときに使う共有シークレット `SNAPSHOT_PUBLISH_AUTH_KEY` が必要。Worker 側には read endpoint が無くなったので `HISTORY_CORS_ALLOWED_ORIGINS` の設定は不要。

共有 R2 バケットには snapshot alias (`snapshot/latest.json`) と history オブジェクト（`history/agents/{agent_id}.json`、`history/conversations/{conversation_id}.json`）が同居し、観戦 UI は R2 カスタムドメインから直接読む。

## Relay アラート配線と readiness ゲート

Unit 32 で relay `/ws` は primary path から外れ、バックエンドの legacy `/ws` endpoint も削除済み。Worker 側も `/ws` を Durable Object fallback に流さず `404` で fail-close する。readiness は polling + R2/CDN の鮮度、alias オブジェクト（snapshot / history 双方）への直接 fetch、event-driven な snapshot/history 配信、認証モードの整合性を中心に構成され、静穏期に残る periodic path は 3 分 fallback resync のみ。relay アラート成果物（`relay-alerting-spec.json` 等）は `ui.*` と `relay.r2.*` シグナルだけをカバーし、relay WebSocket シグナルは残っていない。

リポジトリ管理の正本成果物：

- `worker/ops/relay-alerting-spec.json`: アラートルール / 配信ルート / clear 条件 / 認証系とネットワーク系のルート分割。
- `worker/ops/relay-synthetic-drills.json`: staging ドリルカタログ＋期待アラート経路に到達する合成メトリックタイムライン。
- `worker/ops/relay-production-readiness.template.json`: 本番 sign-off テンプレ（実ルート / 受信ログ / ドリル証跡 / sign-off 時刻が埋まるまで fail-closed）。
- `worker/ops/relay-production-readiness.example.json`: レビュー / テスト用の passing 例。

検証コマンド：

```bash
cd apps/front
npm run relay:readiness
npm run relay:readiness -- --target=production --manifest worker/ops/relay-production-readiness.example.json --wrangler worker/test/fixtures/wrangler.production.example.toml
```

`npm run relay:readiness` 単体はリポ内カタログ / ドリル成果物を検証。primary の event-driven + 静穏期 fallback / R2 readiness は上記手動チェック＋ Unit 29+ の手順が別途必要。本番 relay 検証は manifest が埋まるまで fail-closed のまま。

relay ゲートが満たすべき条件：

- readiness アラートは Unit 10/29+ の primary メトリクスセットを使う: `ui.snapshot.refresh_failure_total{reason}`、`ui.snapshot.generated_age_ms`、`ui.snapshot.published_age_ms`、`ui.r2.publish_failure_total`、`ui.r2.publish_failure_streak`。
- `ui.snapshot.refresh_failure_total{reason}` の `reason` には、Phase 8 の Worker が実際に emit する `boot` / `fallback-refresh` / `world-event` / `manual` / `external-request` を使う。
- sustained outage の pager ルートが実本番配信先に解決できること。
- R2 retry brake 飽和（`ui.r2.publish_failure_streak >= 5`、60 秒 cap に合致）が明示ゲート項目。
- 即時（auth/config）pager ルートと sustained outage pager ルートは別の本番配信先に解決されること。
- 本番 manifest は実通知先 / provider ルール参照 / 要求される全アラート経路の staging ドリル証跡（observed alert ID & observed route ID）/ 事前 sign-off を含むこと。
- `wrangler.toml` に必須の `SNAPSHOT_BUCKET` バインドが無い、またはプレースホルダ R2 のままの場合も本番検証は失敗扱い。
