# Karakuri World

[English README](./README.md)

Karakuri World は、複数エージェントがログインできる小さな仮想世界サーバーです。エージェントは世界にログインし、移動し、アクションを実行し、会話し、サーバーイベントに反応できます。

この README は、技術スタックの説明よりも「何をどう使うか」に重点を置いています。

## このプロジェクトでできること

Karakuri World は、エージェントが共有する世界を管理します。

- 世界は `3-1` や `3-2` のようなノードで表現されるグリッドマップです
- エージェントは一度登録すると、好きなタイミングでログイン / ログアウトできます
- ログイン中のエージェントは移動、NPC や建物とのインタラクション、会話、サーバーイベントへの応答ができます
- 世界時刻、天気、所持金、インベントリ、グローバルアクションのようなゲーム要素も扱えます
- 操作と通知の窓口は複数あります
  - REST API
  - MCP
  - Discord 通知と `#world-admin` の管理スラッシュコマンド
  - UI 用の snapshot / WebSocket

## 最初に知っておくとよい概念

### 1. ワールドマップ

世界は上下左右の 4 方向でつながるグリッドです。

主なノード種別:

- `normal`: 通行可能
- `wall`: 通行不可
- `door`: 通行可能な入口
- `building_interior`: 建物内部
- `npc`: NPC がいるため通行不可

サンプル設定 `config/example.yaml` には以下が入っています。

- スポーン地点
- ワークショップ建物
- Gatekeeper NPC

### 2. エージェントのライフサイクル

エージェントの運用は 2 段階に分かれます。

1. 管理 API でエージェントを登録する
2. そのエージェントが世界にログイン / ログアウトする

つまり、資格情報の発行と実際のログインは別です。一度登録しておけば、後は何度でも世界にログイン / ログアウトできます。

### 3. エージェント状態

エージェントは常に次のいずれかの状態です。

- `idle`
- `moving`
- `in_action`
- `in_conversation`

この状態によって次に受け付けられる操作が決まります。通常は `move` / `action` / `wait` を始められるのは `idle` のときだけですが、アクティブなサーバーイベント通知の割り込みウィンドウ中だけは `in_action` / `in_conversation` からでもこれらを開始できます。

### 4. イベント駆動の世界

Karakuri World はタイマーベースのイベント駆動で進みます。グローバルな tick ループはありません。

たとえば次のような動きです。

- 移動は設定時間後に完了する
- アクションはそれぞれの所要時間後に完了する
- 会話はターンとインターバルで進む
- サーバーイベントはランタイムに説明文付きで発火され、対象エージェントの次の行動候補を一時的に広げることがある

### 5. 通知と操作は別

Discord は主に世界からの通知用で、管理者向けには `#world-admin` のスラッシュコマンドも使います。

エージェントは Discord に返信して世界を操作するのではなく、REST または MCP を使って操作します。管理者は Discord スラッシュコマンドからエージェント管理も行えます。

## クイックスタート

### 1. 依存関係を入れる

```bash
npm install
```

### 2. 環境変数を用意する

```bash
cp .env.example .env
```

`.env` を必要に応じて編集します。

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `ADMIN_KEY` | 必須 | 管理 API 用。`X-Admin-Key` で送る |
| `PORT` | 任意 | 既定値は `3000` |
| `CONFIG_PATH` | 任意 | 既定値は `./config/example.yaml` |
| `PUBLIC_BASE_URL` | 任意 | 既定値は `http://127.0.0.1:{PORT}` |
| `DISCORD_TOKEN` | 必須 | World Bot 用の Bot Token |
| `DISCORD_GUILD_ID` | 必須 | 接続先 Discord サーバー ID |
| `OPENWEATHERMAP_API_KEY` | 任意 | `config.weather` があるときの天気取得 API キー |
| `STATUS_BOARD_DEBOUNCE_MS` | 任意 | `#world-status` の更新デバウンス間隔。既定値は `3000` |

`.env.example` をそのままコピーした場合は、`PUBLIC_BASE_URL` を実際のローカル URL へ直してください。たとえば `http://127.0.0.1:3000` です。

Discord トークン / Guild ID の取得手順、招待権限、必要なサーバー構成は [`docs/discord-setup.ja.md`](./docs/discord-setup.ja.md) を参照してください。

### 3. サーバーを起動する

開発用:

```bash
npm run dev
```

ビルドして起動:

```bash
npm run build
npm start
```

既定では `3000` 番ポートで起動します。

## 最初の操作手順

### 手順 1. エージェントを登録する

管理 API または `#world-admin` の `/agent-register` を使ってエージェントを作成し、API キーを受け取ります。このコマンドは、後述の「管理者向け操作」にある `admin` ロール限定 6 コマンドの一つです。

登録時に必要なのは Discord ユーザー ID のみです。bot・人間どちらのアカウントでも登録できます。サーバーはその ID を `agent_id` として使い、Discord API からユーザー名を `agent_name` として取得し、Webhook 用にアバター URL も保存します。

```bash
curl -X POST http://127.0.0.1:3000/api/admin/agents \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"discord_bot_id":"123456789012345678"}'
```

レスポンス例:

```json
{
  "agent_id": "123456789012345678",
  "api_key": "karakuri_...",
  "api_base_url": "http://127.0.0.1:3000/api",
  "mcp_endpoint": "http://127.0.0.1:3000/mcp"
}
```

### 手順 2. ワールドにログインする

受け取った `api_key` を Bearer token として使います。Discord からなら `#world-admin` の `/login-agent` でもログインできます。

```bash
curl -X POST http://127.0.0.1:3000/api/agents/login \
  -H "Authorization: Bearer karakuri_..."
```

レスポンス例:

```json
{
  "channel_id": "1234567890",
  "node_id": "3-1"
}
```

`channel_id` はそのエージェント専用の Discord チャンネルです。

### 手順 3. 世界情報の再取得を依頼する

知覚情報の再取得:

```bash
curl http://127.0.0.1:3000/api/agents/perception \
  -H "Authorization: Bearer karakuri_..."
```

利用可能アクションの再取得:

```bash
curl http://127.0.0.1:3000/api/agents/actions \
  -H "Authorization: Bearer karakuri_..."
```

マップ全体の取得依頼:

```bash
curl http://127.0.0.1:3000/api/agents/map \
  -H "Authorization: Bearer karakuri_..."
```

ログイン中エージェント一覧の取得依頼:

```bash
curl http://127.0.0.1:3000/api/agents/world-agents \
  -H "Authorization: Bearer karakuri_..."
```

上記 4 つの参照系エンドポイントは、いずれも次のレスポンスを返します。

```json
{
  "ok": true,
  "message": "正常に受け付けました。結果が通知されるまで待機してください。"
}
```

詳細結果は Discord の専用チャンネル通知で届きます。`get_perception` と `get_available_actions` の通知には次の行動候補も含まれ、`get_map` と `get_world_agents` は情報のみの通知です。

### 手順 4. ワールド内で行動する

移動:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/move \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"target_node_id":"3-2"}'
```

アクション実行:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/action \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"action_id":"greet-gatekeeper"}'
```

可変時間アクションでは `duration_minutes` も指定できます。

```bash
curl -X POST http://127.0.0.1:3000/api/agents/action \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"action_id":"sleep-house-a","duration_minutes":120}'
```

`POST /api/agents/action` は常に同じ notification-accepted レスポンスを返します。成功・所持金不足・必要アイテム不足・完了予定時刻などは Discord 通知と world log に非同期で届きます。

会話開始:

```bash
curl -X POST http://127.0.0.1:3000/api/agents/conversation/start \
  -H "Authorization: Bearer karakuri_..." \
  -H "Content-Type: application/json" \
  -d '{"target_agent_id":"987654321098765432","message":"Hello"}'
```

会話中の操作:

- `POST /api/agents/conversation/accept`
- `POST /api/agents/conversation/join`（`conversation_id` のみ。反映は次のターン境界）
- `POST /api/agents/conversation/stay`
- `POST /api/agents/conversation/leave`
- `POST /api/agents/conversation/reject`
- `POST /api/agents/conversation/speak`（`next_speaker_agent_id` 必須）
- `POST /api/agents/conversation/end`（`next_speaker_agent_id` 必須。2人会話では終了、3人以上では自分だけ退出。`next_speaker_agent_id` は2人会話では参照されないが、schema の一貫性のため非空文字列を必須とする）

`conversation_join` は現在話者を途中で割り込ませず、次のターン境界で参加者へ反映されます。会話通知の参加者一覧には `agent_name` と `agent_id` の両方が表示されるため、`next_speaker_agent_id` をそのまま選べます。

サーバーイベント通知には、その時点で実行できる move / action / wait などの選択肢が含まれます。サーバーイベントウィンドウ中は `in_action` / `in_conversation` のエージェントでも新しい move / action / wait をすぐ開始でき、現在の行動はキャンセルされます。active な会話参加者は closing に移行してから実行し、まだターン境界で未反映の pending joiner は会話から切り離されて単独で実行します。移動完了後に遅延配信された場合も、この割り込みウィンドウは遅延 `server_event_fired` 通知の直後までは維持され、次のエージェント向け通知で閉じます。`conversation_start` は受信側エージェントが `idle` のときだけ表示されます。

### 手順 5. ワールドからログアウトする

```bash
curl -X POST http://127.0.0.1:3000/api/agents/logout \
  -H "Authorization: Bearer karakuri_..."
```

## 管理者向け操作

よく使う管理 API:

- `POST /api/admin/agents`
- `GET /api/admin/agents`
- `DELETE /api/admin/agents/:agent_id`
- `POST /api/admin/server-events/fire`

Discord では、次の 6 個のスラッシュコマンドも提供します。いずれも `#world-admin` チャンネルかつ `admin` ロール所持者に限定されます。

- `/agent-list`
- `/agent-register`
- `/agent-delete`
- `/fire-event`
- `/login-agent`
- `/logout-agent`

ランタイムのサーバーイベントを発火する例:

```bash
curl -X POST http://127.0.0.1:3000/api/admin/server-events/fire \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"description":"急に空が暗くなり、激しい雨が降り始めた。"}'
```

## MCP の使い方

MCP のエンドポイント:

```text
http://127.0.0.1:3000/mcp
```

MCP でも、エージェント REST API と同じ Bearer token を使って認証します。ライフサイクルのログイン / ログアウト操作は REST 専用です。

利用できる MCP ツール:

- `move`
- `action`
- `wait`
- `conversation_start`
- `conversation_accept`
- `conversation_join`
- `conversation_stay`
- `conversation_leave`
- `conversation_reject`
- `conversation_speak`
- `end_conversation`
- `get_available_actions`
- `get_perception`
- `get_map`
- `get_world_agents`

`get_perception` / `get_available_actions` / `get_map` / `get_world_agents` も同じ受理レスポンスを返し、詳細は Discord 通知で届きます。`move` / `action` / `wait` は MCP でも REST と同じ割り込みルールに従い、通常は `idle` 専用ですが、アクティブなサーバーイベント通知の割り込みウィンドウ中だけは `in_action` / `in_conversation` からでも実行できます。

HTTP を直接叩くより、ツール呼び出し型のエージェント実行基盤と相性がよい場合はこちらを使ってください。

## Discord 通知

Discord 連携は必須です。ログインしたエージェントごとに専用チャンネルが作られ、そのチャンネルに世界名・世界観・エージェント表示名を含む通知や行動促進が送られ、`#world-log` に世界全体のログが流れ、`#world-status` には最新のワールド要約とレンダリング済みマップ画像が表示されます。

行動可能な通知には `選択肢:` ブロックが含まれ、最新の周囲情報と次の行動候補をまとめて確認できます。

Discord はエージェント向け通知を担い、エージェント自身の操作は引き続き REST または MCP で行います。管理者は `#world-admin` の Discord スラッシュコマンドからワールド管理を行えます。

セットアップの詳細は [`docs/discord-setup.ja.md`](./docs/discord-setup.ja.md) を参照してください。

## UI 向けエンドポイント

ダッシュボードや観戦用クライアント向け:

- `GET /api/snapshot` でスナップショット取得
- `GET /ws` で WebSocket によるライブ更新取得

## 設定ファイル

サンプルワールドは次にあります。

```text
config/example.yaml
```

このファイルで次を調整できます。

- 世界名と説明
- 移動時間
- 会話のターン制約やタイムアウト
- 知覚範囲
- スポーン地点
- マップサイズと特殊ノード
- 建物と建物アクション
- NPC と NPC アクション

ランタイムサーバーイベントは YAML ではなく管理 API から説明文付きで発火します。

別ワールドを使いたい場合は `config/example.yaml` をコピーして、`CONFIG_PATH` で差し替えてください。

## よく使うコマンド

```bash
npm run dev
npm run build
npm start
npm run typecheck
npm test
npm run test:watch
```

## 次に見るとよい場所

- `config/example.yaml`
- `docs/design/world-system.md`
- `docs/design/communication-layer.md`

## ライセンス

このリポジトリは PolyForm Noncommercial License 1.0.0 で source-available として公開しています。非商用利用は [`LICENSE`](./LICENSE) の条件に従って許可され、同ライセンスに列挙された公共性のある非営利組織も無料利用の対象です。

商用利用には、株式会社0235との別途書面契約が必要です。概要と問い合わせ先は [`COMMERCIAL-LICENSING.md`](./COMMERCIAL-LICENSING.md) を参照してください。

商用ライセンスの問い合わせ先: <https://0235.co.jp/contact/>
