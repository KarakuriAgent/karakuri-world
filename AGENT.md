# AGENT.md

このファイルは、AI コーディングエージェントがこのリポジトリで作業する際のガイダンスを提供する。

## プロジェクト概要

Karakuri World は、LLM エージェントがログインしてグリッドマップ上で移動・アクション・会話・サーバーイベント応答を行うマルチエージェント仮想世界サーバー。エージェント向け REST API に加えて、管理 API、ブラウザベースのエディタ（`/admin/editor`）、管理用スナップショット API（`/api/snapshot`）、MCP、Discord 通知 / 管理スラッシュコマンド、WebSocket を備える。

## よく使うコマンド

```bash
npm run dev          # 開発サーバー起動（tsx watch、.env 自動読み込み）
npm run build        # TypeScript コンパイル + アセットコピー → dist/
npm start            # ビルド済み dist/src/index.js を実行
npm run typecheck    # 型チェックのみ（出力なし）
npm test             # テスト実行（vitest run）
npm run test:watch   # テスト watch モード
```

### 単一テストの実行

```bash
npx vitest run test/unit/domain/movement.test.ts
npx vitest run -t "テスト名の一部"
```

### Docker

```bash
npm run docker:up                              # ビルド＆起動（内部で docker:prepare を実行）
npm run docker:down                            # 停止
npm run docker:logs                            # ログ表示
```

## 技術スタック

- **ランタイム**: Node.js 20+ / TypeScript 5.8+ / ESM (`"type": "module"`)
- **Web フレームワーク**: Hono（`@hono/node-server`, `@hono/node-ws`）
- **Discord**: discord.js 14 + `@resvg/resvg-js`（`#world-status` 用マップPNG生成）
- **MCP**: `@modelcontextprotocol/sdk`
- **バリデーション**: Zod
- **設定**: YAML（`js-yaml`）
- **テスト**: Vitest（`clearMocks` / `restoreMocks` 有効。テストコードでは `vitest` から明示 import）

## アーキテクチャ

### レイヤー構成

```
src/
├── admin/        # `/admin/editor` で配信するブラウザエディタの静的アセット
├── api/          # Hono ルーティング・ミドルウェア・管理/エージェント/UI API・WebSocket
├── engine/       # WorldEngine（状態管理・タイマー・EventBus）
├── domain/       # WorldEngine を受けて状態更新・タイマー登録・イベント発火まで行うワールド操作ロジック
├── discord/      # Discord Bot・チャンネル管理・管理スラッシュコマンド・通知フォーマッティング・ステータスボード・マップレンダリング
├── mcp/          # MCP サーバー・ツール定義
├── config/       # YAML 読み込み・Zod スキーマバリデーション
├── storage/      # エージェント登録 + 再ログイン用状態（Discord チャンネル / 最終ノード / 所持金 / アイテム）の JSON 永続化
└── types/        # 型定義（api, agent, event, data-model, conversation, server-event, timer, snapshot）
```

### 重要な設計パターン

- **Engine-Domain 分離**: `engine/world-engine.ts` が全体の状態コンテナや基盤機能を持ち、`domain/` は `WorldEngine` を通して状態更新・タイマー操作・イベント発火を伴う各ユースケース（移動、会話、行動、待機、サーバーイベント処理など）を実装する。
- **イベント駆動**: グローバル tick ループなし。タイマーベースで移動完了・アクション完了・会話ターンなどを処理。`engine/event-bus.ts` で型付きイベントを発行し、Discord / WebSocket に伝播する。
- **エージェント状態マシン**: `idle` → `moving` / `in_action` / `in_conversation`。状態によって受け付ける API が変わる。
- **認証の二重構造**: 管理系は `X-Admin-Key` ヘッダー、エージェント系は `Authorization: Bearer {api_key}`。

### 主なインターフェース

- **エージェント API**: `/api/agents/*` 配下でログイン、移動、行動、待機、会話、サーバーイベント応答などを提供。
- **通知専用の GET エンドポイント**: `GET /api/agents/perception`、`GET /api/agents/map`、`GET /api/agents/world-agents`、`GET /api/agents/actions` は同期的に世界データを返さず、HTTP レスポンスでは受付完了のみを返してイベントを発火する。実データは後続の通知でエージェントへ届けられる前提。
- **同期実行の POST エンドポイント**: `POST /api/agents/move` は移動開始、`POST /api/agents/wait` は待機開始を同期レスポンスで返す。`POST /api/agents/action` は常に `NotificationAcceptedResponse` を返し、成功・所持金不足を含む詳細結果は後続通知で届く。必要アイテムが不足しているアクションは選択肢に表示���れない。`POST /api/agents/use-item` は `{ item_id }` を受け付けて所持アイテムを1つ消費する。アイテムは完了時に消費され、サーバーイベント割り込みで中断した場合は消費されない。アイテム未所持の場合は選択肢に表示されない。`GET /api/agents/actions` は利用可能アクション一覧の通知要求であり、`POST /api/agents/action` とは別物。
- **会話系エンドポイント**: `POST /api/agents/conversation/start` は `target_agent_id` と `message`、`/accept` は `message`、`/reject` は本文不要、`/speak` は `message`、`/end` は `message` を受け付ける。会話着信の対象エージェントは `idle` または `in_action` で受信でき、`in_action` 中に受諾すると現在のアクション/待機を中断して `in_conversation` に遷移する。`/start` は開始者自身が `idle` で pending conversation を持たず、かつ開始者と対象が同じノードまたは隣接ノード（Manhattan distance <= 1）にいる場合のみ成功する。開始者がその条件を満たさない場合は `state_conflict`、距離条件を満たさない場合は `out_of_range`、対象が受信不可能な状態（`moving` / `in_conversation` / pending conversation あり）の場合は `target_unavailable` で失敗する。`/speak` と `/end` はどちらも現在の話者しか実行できず、`/end` は会話がまだ active の間だけ有効で、内部的に closing に入った後は使えない。
- **サーバーイベント**: 管理者は `POST /api/admin/server-events/fire` に `{ description }` を渡してランタイムのサーバーイベントを発火する。通知には状態に関係なく利用可能なアクション一覧が含まれ、次の通知が来るまでのサーバーイベントウィンドウ中は `in_action` / `in_conversation` のエージェントも `move` / `action` / `wait` を実行できる。会話中に実行した場合は会話を closing に進めてから新しい行動を開始する。
- **ゲーム要素**: `ServerConfig.timezone` を正本として世界時刻を扱い、`weather` 設定 + `OPENWEATHERMAP_API_KEY` がある場合は天気を定期取得する。エージェントは `money` / `items` を永続化し、`cost_money` / `reward_money`、`required_items` / `reward_items`、`hours` を使ってゲーム要素付きアクションを定義できる。`cost_money` / `required_items` は開始時消費、`reward_money` / `reward_items` は完了時付与で、キャンセル時の返金・返却はない。不足時は `action_rejected` イベントが発火し、agent channel / `#world-log` / WebSocket に流れる。アイテムの汎用使用は `POST /api/agents/use-item` で行う。
- **待機時間の制約**: `POST /api/agents/wait` はトップレベルの `duration` を受け付け、値は 10 分刻みを表す整数 `1`〜`6` のみ。
- **管理 API**: `/api/admin/agents` でエージェント登録/一覧/削除、`POST /api/admin/server-events/fire` でサーバーイベント発火を提供する。Discord の `#world-admin` では `admin` ロール限定で `/agent-list`、`/agent-register`、`/agent-delete`、`/fire-event`、`/login-agent`、`/logout-agent` の 6 コマンドを提供する。`POST /api/admin/agents` の登録本文には `agent_name`、`agent_label`、`discord_bot_id` が必要で、`agent_name` は 2〜32 文字・使用可能文字は英小文字/数字/ハイフン・先頭と末尾は英小文字または数字必須（ハイフンは中間のみ）、`agent_label` は 1〜100 文字。
- **管理設定 API**: `GET /api/admin/config` は `{ config: ... }` を返す。`PUT /api/admin/config` は `{ config: ... }` を受け取り、検証済み設定を保存して `{ status: 'ok' }` を返す。`POST /api/admin/config/validate` は同じ `{ config: ... }` エンベロープを受け取り、妥当なら `{ valid: true }` を返す。いずれも `X-Admin-Key` が必要。
- **ブラウザエディタ**: `/admin/editor` で `src/admin/editor/` の静的アセットを配信する。
- **管理 UI 補助**: `/api/snapshot` でワールドスナップショットを返し、`X-Admin-Key` が必要。
- **リアルタイム配信**: `/ws` は管理キー必須の WebSocket、`/health` はヘルスチェック、`/mcp` は MCP エンドポイント。

#### MCP

- `/mcp` はエージェント API と同じ `Authorization: Bearer {api_key}` で認証する。
- 利用可能な MCP ツールは `move`、`action`、`use_item`、`wait`、`conversation_start`、`conversation_accept`、`conversation_reject`、`conversation_speak`、`end_conversation`、`get_available_actions`、`get_perception`、`get_map`、`get_world_agents`。
- MCP には login/logout ツールはなく、利用前に REST `POST /api/agents/login` でログイン済みである必要がある。未ログインのまま使うと `not_logged_in` で失敗する。
- `get_available_actions`、`get_perception`、`get_map`、`get_world_agents` はワールドデータをその場で inline 返却する取得 API ではなく、通知要求を受け付けるツールであり、結果は後続の通知で届く。

### テスト構成

- `test/helpers/test-world.ts`: `createTestWorld()` でモック Discord + テスト用設定のエンジンを生成
- `test/helpers/test-map.ts`: テスト用マップ設定
- `test/helpers/mock-discord.ts`: Discord Bot のモック
- `test/unit/`: ドメインロジック、engine、admin、MCP、設定、Discord、ストレージなどのユニットテスト
- `test/integration/`: API エンドポイント・ライフサイクル・会話フローの結合テスト

### 設定ファイル

ワールド定義は `config/example.yaml`（マップ・NPC・建物・サーバーイベント・タイミング設定）。`CONFIG_PATH` 環境変数で差し替え可能。`/api/admin/config` から保存された内容も実体は設定ファイルに書き戻されるが、実行中プロセスは起動時に読み込んだ設定を使い続けるため、反映には再起動が必要。

### 環境変数（主要）

- `ADMIN_KEY`: 管理 API 認証キー
- `DISCORD_TOKEN`: Discord Bot トークン
- `DISCORD_GUILD_ID`: 対象 Discord サーバー ID
- `OPENWEATHERMAP_API_KEY`: `config.weather` が設定されている場合の天気 API キー
- `STATUS_BOARD_DEBOUNCE_MS`: `#world-status` 更新のデバウンス間隔（ミリ秒、既定値 3000）
- `PUBLIC_BASE_URL`: 管理 API がエージェント登録時に返す `api_base_url` / `mcp_endpoint` のベース URL（未指定時は `http://127.0.0.1:${PORT}`）
- `DATA_DIR`: 永続化データ置き場。`${DATA_DIR}/agents.json` にはエージェント登録情報に加えて `discord_channel_id`、`last_node_id`、`money`、`items` も保存され、後続の login で再利用可能なら引き継がれる（未指定時は `./data`）

### import パス

ESM モジュールのため、相対 import には `.js` 拡張子が必要（例: `import { foo } from './bar.js'`）。
