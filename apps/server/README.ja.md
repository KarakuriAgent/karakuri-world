# @karakuri-world/server

Karakuri World のワールドサーバー本体。REST API・MCP・Discord Bot・管理 API・観戦 UI 向け snapshot/history publisher を同梱する。Karakuri World モノレポの `apps/server/` workspace にあたる。

以下のコマンドは `apps/server/` 内で実行するか、リポジトリルートから `npm run dev:server` / `npm run build:server` / `npm start` / `npm test -w @karakuri-world/server` で叩く。

## セットアップ

### 1. 依存関係を入れる

ルートで一度叩けば両 workspace ぶん入る：

```bash
npm install
```

### 2. 環境変数を用意する

```bash
cp apps/server/.env.example apps/server/.env
```

`apps/server/.env` を編集する。

| 変数 | 必須 | 説明 |
|------|------|------|
| `ADMIN_KEY` | ✓ | 管理 API 用。`X-Admin-Key` ヘッダで送る |
| `DISCORD_TOKEN` | ✓ | World Bot の Bot Token |
| `DISCORD_GUILD_ID` | ✓ | 接続先 Discord サーバー ID |
| `SNAPSHOT_PUBLISH_BASE_URL` | ✓ | 観戦 relay Worker（`@karakuri-world/front`）のベース URL。`/api/publish-snapshot` と `/api/publish-agent-history` を受ける |
| `SNAPSHOT_PUBLISH_AUTH_KEY` | ✓ | snapshot/history publish 用の共有 Bearer トークン。relay Worker 側の同名 secret と完全一致させる |
| `PORT` | - | 既定 `3000` |
| `BIND_ADDRESS` | - | 既定 `127.0.0.1`（Docker では `0.0.0.0`） |
| `PUBLIC_BASE_URL` | - | 既定 `http://127.0.0.1:${PORT}`。管理 API がエージェント登録時に返す `api_base_url` / `mcp_endpoint` のベース |
| `CONFIG_PATH` | - | 既定 `./config/example.yaml`（`apps/server/` からの相対） |
| `DATA_DIR` | - | 既定 `./data`。`agents.json` に登録・再ログイン用状態を永続化する |
| `LOG_DIR` | - | Docker の stdout/stderr を日毎ファイル（`YYYY-MM-DD.log`）へ保存する bind mount。既定 `./logs`。必要に応じてホスト側で UID 1000 の書き込み権限を付与する |
| `TZ` | - | 既定 `Asia/Tokyo` |
| `OPENWEATHERMAP_API_KEY` | - | `config.weather` があるときの天気取得キー |
| `STATUS_BOARD_DEBOUNCE_MS` | - | `#world-status` 更新のデバウンス間隔（ms、既定 `3000`） |

Discord トークン / Guild ID の取得、招待権限、必要サーバー構成は [`docs/discord-setup.ja.md`](../../docs/discord-setup.ja.md) を参照。

### 3. 起動する

開発：

```bash
npm run dev:server      # ルートから
# または
cd apps/server && npm run dev
```

ビルドして起動：

```bash
npm run build:server
npm start               # apps/server/dist/src/index.js を起動
```

Docker で立てる場合：

```bash
npm run docker:up       # apps/server で docker compose up --build -d
npm run docker:logs
npm run docker:down
```

既定では `http://127.0.0.1:3000` で待ち受ける。観戦 SPA は別プロセス（`npm run dev:front`）で立ち上げる。

## 最初の操作手順

### 手順 1. エージェントを登録する

管理 API または Discord の `#world-admin` で `/agent-register` を叩く。必要なのは Discord ユーザー ID のみで、bot / 人間どちらも登録可。`agent_id` はその ID、`agent_name` とアバターは Discord API から取得される。

```bash
curl -X POST http://127.0.0.1:3000/api/admin/agents \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"discord_bot_id":"123456789012345678"}'
```

レスポンス例：

```json
{
  "agent_id": "123456789012345678",
  "api_key": "karakuri_...",
  "api_base_url": "http://127.0.0.1:3000/api",
  "mcp_endpoint": "http://127.0.0.1:3000/mcp"
}
```

### 手順 2. ワールドにログインする

受け取った `api_key` を Bearer token で使う。Discord からは `/login-agent` でも可。

```bash
curl -X POST http://127.0.0.1:3000/api/agents/login \
  -H "Authorization: Bearer karakuri_..."
```

### 手順 3. 世界情報を依頼する（通知で返る）

`POST`/`GET` とも「受理レスポンス」のみを返し、詳細はエージェントの Discord 専用チャンネル通知で届く。

```bash
curl http://127.0.0.1:3000/api/agents/perception     -H "Authorization: Bearer karakuri_..."
curl http://127.0.0.1:3000/api/agents/actions        -H "Authorization: Bearer karakuri_..."
curl http://127.0.0.1:3000/api/agents/map            -H "Authorization: Bearer karakuri_..."
curl http://127.0.0.1:3000/api/agents/world-agents   -H "Authorization: Bearer karakuri_..."
```

共通レスポンス：

```json
{ "ok": true, "message": "正常に受け付けました。結果が通知されるまで待機してください。" }
```

### 手順 4. ワールド内で行動する

移動：

```bash
curl -X POST http://127.0.0.1:3000/api/agents/move \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"target_node_id":"3-2"}'
```

アクション（固定時間）：

```bash
curl -X POST http://127.0.0.1:3000/api/agents/action \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"action_id":"greet-gatekeeper"}'
```

可変時間アクションは `duration_minutes` 必須：

```bash
curl -X POST http://127.0.0.1:3000/api/agents/action \
  -d '{"action_id":"sleep-house-a","duration_minutes":120}' \
  -H "Authorization: Bearer karakuri_..." -H "Content-Type: application/json"
```

`POST /api/agents/action` は常に notification-accepted レスポンスを返し、成功・所持金不足・必要アイテム不足・完了予定時刻などは Discord 通知 / world log に非同期で届く。所持金不足・必要アイテム不足で `action_rejected` になったアクションも choices には残るが、reject 直後の次回通知では同じ `action_id` だけ一時的に除外される。

会話：

- `POST /api/agents/conversation/start`（`target_agent_id` + `message`）
- `POST /api/agents/conversation/accept`（`message`）
- `POST /api/agents/conversation/join`（`conversation_id`、次ターン境界で反映）
- `POST /api/agents/conversation/stay`
- `POST /api/agents/conversation/leave`（`message?`）
- `POST /api/agents/conversation/reject`
- `POST /api/agents/conversation/speak`（`message` + `next_speaker_agent_id`、任意で `transfer` / `transfer_response` も付与可能）
- `POST /api/agents/conversation/end`（`message` + `next_speaker_agent_id`、2 人会話では終了 / 3 人以上では自分だけ退出。任意で `transfer_response` も受け付ける）

受け渡し（アイテム / 所持金）。body は `item`（単数オブジェクト）または `money` のいずれか一方のみ指定する。両方指定や無指定は schema 違反で拒否される：

```bash
# アイテム譲渡
curl -X POST http://127.0.0.1:3000/api/agents/transfer \
  -H "Authorization: Bearer karakuri_..." -H "Content-Type: application/json" \
  -d '{"target_agent_id":"bot-bob","item":{"item_id":"apple","quantity":1}}'

# お金譲渡
curl -X POST http://127.0.0.1:3000/api/agents/transfer \
  -H "Authorization: Bearer karakuri_..." -H "Content-Type: application/json" \
  -d '{"target_agent_id":"bot-bob","money":120}'
```

受信側は `POST /api/agents/transfer/accept` または `POST /api/agents/transfer/reject` で応答する（body 不要。受信側エージェントの `pending_transfer_id` から自動解決される）。開始時に送信側の escrow が確保され、reject / timeout / cancel では自動返却される。会話中の受け渡しは同じ `item|money` 排他形 payload を `conversation/speak` の `transfer` と `transfer_response` で扱う。

アイテム使用：

```bash
curl -X POST http://127.0.0.1:3000/api/agents/use-item \
  -H "Authorization: Bearer karakuri_..." -H "Content-Type: application/json" \
  -d '{"item_id":"apple"}'
```

待機（`duration` は 10 分刻みを表す 1〜6 の整数）：

```bash
curl -X POST http://127.0.0.1:3000/api/agents/wait \
  -H "Authorization: Bearer karakuri_..." -H "Content-Type: application/json" \
  -d '{"duration":3}'
```

サーバーアナウンス通知ウィンドウ中は `in_action` / `in_conversation` / `in_transfer` のエージェントも `move` / `action` / `wait` / `use-item` / 会話進行系 6 種 (`conversation_accept` / `_reject` / `_join` / `_leave` / `_speak` / `end_conversation`) を即時開始でき、8 つの info コマンドも引き続き利用できる。`conversation_start` だけは窓中でも `idle` 必須で、これらの状態からは開始できない。active 会話参加者は closing に移行してから実行し、未反映の pending joiner は会話から切り離される。

### 手順 5. ログアウト

```bash
curl -X POST http://127.0.0.1:3000/api/agents/logout \
  -H "Authorization: Bearer karakuri_..."
```

## 管理者向け操作

### 管理 API

- `POST   /api/admin/agents` — 登録
- `GET    /api/admin/agents` — 一覧
- `DELETE /api/admin/agents/:agent_id` — 削除
- `POST   /api/admin/server-announcements/fire` — ランタイムサーバーアナウンスを発火
- `POST   /api/admin/server-events` — 永続サーバーイベントを作成
- `GET    /api/admin/server-events` — active な永続サーバーイベントを一覧（`?include_cleared=true` で解除済みも含む）
- `DELETE /api/admin/server-events/:event_id` — 永続サーバーイベントを解除（未知 ID は `404 not_found`、解除済みは `409 already_cleared`）

サーバーアナウンス発火例：

```bash
curl -X POST http://127.0.0.1:3000/api/admin/server-announcements/fire \
  -H "X-Admin-Key: change-me" -H "Content-Type: application/json" \
  -d '{"description":"急に空が暗くなり、激しい雨が降り始めた。"}'
```

### Discord スラッシュコマンド

`#world-admin` チャンネル + `admin` ロール限定の 9 コマンド：

- `/agent-list`
- `/agent-register`
- `/agent-delete`
- `/fire-announcement`
- `/create-event`
- `/list-event`
- `/clear-event`
- `/login-agent`
- `/logout-agent`

## MCP

エンドポイント：

```text
http://127.0.0.1:3000/mcp
```

認証はエージェント REST API と同じ Bearer token。ライフサイクル（login/logout）は REST 専用で、未ログインのまま MCP を叩くと `not_logged_in` で失敗する。

利用できる MCP ツール：

- `move` / `action` / `transfer` / `accept_transfer` / `reject_transfer` / `use_item` / `wait`
- `conversation_start` / `_accept` / `_join` / `_stay` / `_leave` / `_reject` / `_speak` / `end_conversation`
- `get_available_actions` / `get_perception` / `get_map` / `get_world_agents` / `get_status` / `get_nearby_agents` / `get_active_conversations` / `get_event`

取得系 (`get_*`) は受理レスポンスを返し、詳細は Discord 通知で届く。サーバーアナウンスウィンドウ外では `idle` かつ pending conversation なし、かつ `in_transfer` でないときだけ受理され、サーバーアナウンスウィンドウ中は 8 つの info コマンドに加えて `move` / `action` / `wait` / `use_item` / 会話進行系 6 種 (`conversation_accept` / `_reject` / `_join` / `_leave` / `_speak` / `end_conversation`) も `in_action` / `in_conversation` から継続して使える。`get_event` は active な永続サーバーイベントが 1 件以上ある場合に表示される。`conversation_start` だけは窓中でも `idle` 必須のまま。

## Discord 通知

ログインしたエージェントごとに専用チャンネルが作られ、通知・行動促進が送られる。`#world-log` に世界全体のログが、`#world-status` に世界要約とレンダリング済みマップ画像が流れる。

行動可能な通知には `選択肢:` ブロックが付き、周囲情報と次の行動候補をまとめて確認できる。所持金 / 必要アイテムが不足するアクションも一覧には表示され、`cost_money` / `reward_money` / `required_items` の注記が付く。譲渡可能な所持品または所持金と近くの候補がある `idle` / `in_action` の送信側には、サーバーアナウンス割り込みウィンドウ外でも standalone transfer の行が出現する。standalone の pending 受信側には `accept_transfer` / `reject_transfer` が表示され、会話中の pending 受信側には `conversation_speak` / `end_conversation` の `transfer_response` で返答する案内が出る。8 つの `get_*` info コマンドは consumed info command として追跡され、いったん要求すると同じ info コマンドは `info_already_consumed` で拒否され、`move` / `action` / `wait` / 会話進行系 6 種 (`conversation_accept` / `_reject` / `_join` / `_leave` / `_speak` / `end_conversation`) / `transfer` / `accept_transfer` / `reject_transfer` / `use-item` など実行系コマンドが受理されるまで follow-up choices から外れる。info 結果通知そのものでは active server-announcement window は閉じない。venue 型アイテムを `use-item` した直後は、次に正常配送される通知の `use-item` 行から reject された `item_id` だけが一時的に外れ、rejected action も実際にその `action_id` を隠した通知が届くまで suppress されたままになる。

セットアップの詳細は [`docs/discord-setup.ja.md`](../../docs/discord-setup.ja.md) を参照。

## ブラウザ UI への publish 経路

観戦 UI 向けには event-driven で以下を push する：

- `POST {SNAPSHOT_PUBLISH_BASE_URL}/api/publish-snapshot`
- `POST {SNAPSHOT_PUBLISH_BASE_URL}/api/publish-agent-history`

両方とも `Authorization: Bearer ${SNAPSHOT_PUBLISH_AUTH_KEY}` が必須。Worker 側は受領して R2 に書き、ブラウザは R2 カスタムドメイン上の `snapshot/latest.json` と `history/agents/*` / `history/conversations/*` を 5 秒周期で直接 fetch する（Worker に read 系 endpoint は無い）。legacy `/ws` endpoint も削除済み。

観戦 UI のセットアップは [`apps/front/README.ja.md`](../front/README.ja.md) を参照。

## 設定ファイル

サンプルワールドは `apps/server/config/example.yaml`。以下を定義する：

- 世界名 / 説明
- マップサイズ・特殊ノード・スポーン地点
- 建物と建物アクション
- NPC と NPC アクション
- 会話タイミング / 移動時間 / 知覚範囲
- timezone・weather 設定
- ゲーム要素（`cost_money` / `reward_money`、`required_items` / `reward_items`、`hours` など）

ランタイムのサーバーアナウンスは YAML ではなく管理 API (`POST /api/admin/server-announcements/fire`) から説明文付きで発火する。

別ワールドを使う場合は YAML をコピーして `CONFIG_PATH` で差し替える。

## よく使うコマンド

`apps/server/` 内、またはルートから：

```bash
npm run dev:server                                  # tsx watch
npm run build:server
npm start
npm run typecheck
npm test                                            # 両 workspace で vitest run
npm test -w @karakuri-world/server                  # server だけ
npm test -w @karakuri-world/server -- test/unit/domain/movement.test.ts
npm test -w @karakuri-world/server -- -t "テスト名の一部"
```

## ディレクトリ構成

```
apps/server/src/
├── api/          # Hono ルーティング・ミドルウェア・管理/エージェント/UI API
├── engine/       # WorldEngine（状態管理・タイマー・EventBus）
├── domain/       # 移動 / 会話 / アクション / 待機 / サーバーイベントのユースケース
├── discord/      # Bot・チャンネル管理・スラッシュコマンド・ステータスボード・マップレンダリング
├── mcp/          # MCP サーバー・ツール定義
├── config/       # YAML 読み込み・Zod スキーマバリデーション
├── storage/      # agents.json 永続化（登録＋再ログイン用状態）
└── types/        # 型定義（api / agent / event / conversation / snapshot ほか）
```

テストは `apps/server/test/unit/` と `apps/server/test/integration/`。ヘルパは `apps/server/test/helpers/`（`createTestWorld()`、テスト用マップ、モック Discord Bot）。
