# AGENT.md

このファイルは、AI コーディングエージェントがこのリポジトリで作業する際のガイダンスを提供する。

## プロジェクト概要

Karakuri World は、LLM エージェントがログインしてグリッドマップ上で移動・アクション・会話・サーバーイベント応答を行うマルチエージェント仮想世界サーバー。エージェント向け REST API に加えて、管理 API、MCP、Discord 通知 / 管理スラッシュコマンドを備える。観戦 UI 向け publish は event-driven snapshot / history 配信（POST body push）へ統一しており、legacy `/ws` endpoint は削除済み。

## リポジトリ構成

npm workspaces による monorepo で、`apps/` 配下に 2 つのパッケージを持つ。

```
./
├── apps/
│   ├── server/      # @karakuri-world/server  ワールドサーバー本体（REST / MCP / Discord Bot）
│   └── front/       # @karakuri-world/front   観戦 SPA + Cloudflare Worker relay
├── docs/
├── skills/
└── package.json     # workspaces 定義 + パッケージ横断スクリプト
```

## よく使うコマンド

ルートから workspace パススルースクリプトで叩くのが基本。

```bash
npm install                    # ルートで一度叩けば全 workspace の依存が入る
npm run dev:server             # ワールドサーバー起動（tsx watch、apps/server/.env 自動読み込み）
npm run dev:front              # 観戦 SPA 起動（Vite）
npm run build                  # 両パッケージを順に build
npm run build:server           # サーバーだけ build（apps/server/dist/）
npm run build:front            # フロントだけ build
npm start                      # @karakuri-world/server の dist/src/index.js を起動
npm run typecheck              # 両パッケージの型チェック
npm test                       # 両パッケージの vitest run を順に実行
npm run docker:up              # apps/server で docker compose up --build -d
npm run docker:down            # apps/server で docker compose down
npm run docker:logs            # apps/server で docker compose logs -f
```

各パッケージ内で直接叩きたい場合は `cd apps/server && npm run dev`、`cd apps/front && npm run dev`。

### 単一テストの実行

```bash
npm test -w @karakuri-world/server -- test/unit/domain/movement.test.ts
npm test -w @karakuri-world/server -- -t "テスト名の一部"
npm test -w @karakuri-world/front  -- app/test/app-shell.test.tsx
```

## 技術スタック

- **ランタイム**: Node.js 20+ / TypeScript 5.8+ / ESM (`"type": "module"`)
- **Web フレームワーク**: Hono（`@hono/node-server`）
- **Discord**: discord.js 14 + `@resvg/resvg-js`（`#world-status` 用マップPNG生成）
- **MCP**: `@modelcontextprotocol/sdk`
- **バリデーション**: Zod
- **設定**: YAML（`js-yaml`）
- **テスト**: Vitest（`clearMocks` / `restoreMocks` 有効。テストコードでは `vitest` から明示 import）
- **フロント**: React 19 + Vite 7 + Pixi.js v8（`@pixi/react`）+ Tailwind CSS + Zustand
- **Worker relay**: Cloudflare Workers（Hono + Durable Object + R2）

## アーキテクチャ

### レイヤー構成（`apps/server/src/`）

```
apps/server/src/
├── api/          # Hono ルーティング・ミドルウェア・管理/エージェント/UI API
├── engine/       # WorldEngine（状態管理・タイマー・EventBus）
├── domain/       # WorldEngine を受けて状態更新・タイマー登録・イベント発火まで行うワールド操作ロジック
├── discord/      # Discord Bot・チャンネル管理・管理スラッシュコマンド・通知フォーマッティング・ステータスボード・マップレンダリング
├── mcp/          # MCP サーバー・ツール定義
├── config/       # YAML 読み込み・Zod スキーマバリデーション
├── storage/      # エージェント登録 + 再ログイン用状態（Discord チャンネル / 最終ノード / 所持金 / アイテム）の JSON 永続化
└── types/        # 型定義（api, agent, event, data-model, conversation, server-event, timer, snapshot）
```

### フロント構成（`apps/front/`）

```
apps/front/
├── app/          # React SPA（Vite）。components/ layout/ map/ overlay/ common/、store/、lib/、test/
└── worker/       # Cloudflare Worker relay（Hono + Durable Object）。contracts/、history/、relay/
```

### 重要な設計パターン

- **Engine-Domain 分離**: `apps/server/src/engine/world-engine.ts` が全体の状態コンテナや基盤機能を持ち、`apps/server/src/domain/` は `WorldEngine` を通して状態更新・タイマー操作・イベント発火を伴う各ユースケース（移動、会話、行動、待機、サーバーイベント処理など）を実装する。
- **イベント駆動**: グローバル tick ループなし。タイマーベースで移動完了・アクション完了・会話ターンなどを処理。`apps/server/src/engine/event-bus.ts` で型付きイベントを発行し、Discord や event-driven snapshot / history publisher 連携に伝播する。
- **エージェント状態マシン**: `idle` → `moving` / `in_action` / `in_conversation`。状態によって受け付ける API が変わる。
- **認証の二重構造**: 管理系は `X-Admin-Key` ヘッダー、エージェント系は `Authorization: Bearer {api_key}`。

### 主なインターフェース

- **エージェント API**: `/api/agents/*` 配下でログイン、移動、行動、待機、会話、サーバーイベント応答などを提供。
- **通知専用の GET エンドポイント**: `GET /api/agents/perception`、`GET /api/agents/map`、`GET /api/agents/world-agents`、`GET /api/agents/status`、`GET /api/agents/nearby-agents`、`GET /api/agents/active-conversations`、`GET /api/agents/actions` は同期的に世界データを返さず、HTTP レスポンスでは受付完了のみを返してイベントを発火する。実データは後続の通知でエージェントへ届けられる前提。
- **同期実行の POST エンドポイント**: `POST /api/agents/move` は移動開始、`POST /api/agents/wait` は待機開始を同期レスポンスで返す。`POST /api/agents/action` は `{ action_id, duration_minutes? }` を受け付け、常に `NotificationAcceptedResponse` を返す。可変時間アクションでは `duration_minutes` が必須で、固定時間アクションでは無視される。成功・所持金不足を含む詳細結果は後続通知で届き、`action_started` / snapshot / timer には解決済み `duration_ms` が保持される。必要アイテムが不足していても選択肢に表示され、実行時に `action_rejected` イベントで通知される。reject 直後の次回 choices では同じ `action_id` だけ一時的に除外して self-loop を防ぐ。`POST /api/agents/use-item` は `{ item_id }` を受け付けて所持アイテムを1つ消費する。アイテムは `type`（`general` / `food` / `drink` / `venue`）を持ち、完了メッセージがタイプ別に切り替わる（使用しました / 食べました / 飲みました）。`venue` タイプのアイテムは汎用使用できず、`required_items` を参照するアクションの場所名を案内する通知が返る。アイテムは完了時に消費され、サーバーイベント割り込みで中断した場合は消費されない。アイテム未所持の場合は選択肢に表示されない。`use-item` は選択肢上では単一行で表示され、使用する `item_id` は `get_status` で確認する。venue reject 直後は同じ `item_id` の再呼び出し自体は可能だが、次回の perception 所持品カウントと `get_status` の所持品一覧から 1 サイクル分だけ伏せられる。`GET /api/agents/actions` は利用可能アクション一覧の通知要求であり、`POST /api/agents/action` とは別物。
- **会話系エンドポイント**: `POST /api/agents/conversation/start` は `target_agent_id` と `message`、`/accept` は `message`、`/join` は `{ conversation_id }`、`/stay` は本文不要、`/leave` は `{ message? }`、`/reject` は本文不要、`/speak` と `/end` は `{ message, next_speaker_agent_id }` を受け付ける。`/join` は即時に会話スレッドへ割り込まず、次のターン境界で反映される deferred join。会話通知の参加者一覧は `agent_name` に加えて `agent_id` も併記する。会話は `participant_agent_ids` ベースで管理され、進行中の会話には近くの `idle` / `in_action` エージェントが参加でき、選択肢では `conversation_join` は単一行で表示される。参加可能な `conversation_id` は `get_active_conversations` で確認する。`conversation_speak` は常に `next_speaker_agent_id` 指名付きで使う前提で、`/end` は2人会話では終了、3人以上では自分だけ退出する。一定ターン未関与の参加者には inactive_check 通知が飛び、`/stay` か `/leave` で応答する。ログアウトによる終了理由は `participant_logged_out`。
- **サーバーイベント**: 管理者は `POST /api/admin/server-events/fire` に `{ description }` を渡してランタイムのサーバーイベントを発火する。通知には状態に関係なく利用可能なアクション一覧が含まれ、次の実行系コマンドが受理されるまでのサーバーイベントウィンドウ中は `in_action` / `in_conversation` のエージェントも `move` / `action` / `wait` / `use-item` / 会話進行系 6 種 (`conversation_accept` / `_reject` / `_join` / `_leave` / `_speak` / `end_conversation`) と 7 つの info コマンドを実行できる。`conversation_start` だけは窓中でも `idle` 必須で緩和されない。info 結果通知そのものでは active server-event window は閉じない。実行系コマンドはエンジンで受理された時点でウィンドウを閉じ、`action_rejected` / `item_use_venue_rejected` のように後続で reject されるケースもウィンドウを消費する。会話中に実行した場合、active な会話参加者は会話を closing に進めてから新しい行動を開始し、まだターン境界で未反映の pending joiner は会話から切り離されて単独で新しい行動を始める。
- **ゲーム要素**: `ServerConfig.timezone` を正本として世界時刻を扱い、`weather` 設定 + `OPENWEATHERMAP_API_KEY` がある場合は天気を定期取得する。エージェントは `money` / `items` を永続化し、`cost_money` / `reward_money`、`required_items` / `reward_items`、`hours` を使ってゲーム要素付きアクションを定義できる。`cost_money` / `required_items` は開始時消費、`reward_money` / `reward_items` は完了時付与で、キャンセル時の返金・返却はない。不足時は `action_rejected` イベントが発火し、agent channel / `#world-log` / snapshot publisher 連携へ流れる。アイテムの汎用使用は `POST /api/agents/use-item` で行う。`transfer` は選択肢上では単一行で表示され、譲渡相手は `get_nearby_agents`、譲渡対象アイテムは `get_status` で確認する。
- **待機時間の制約**: `POST /api/agents/wait` はトップレベルの `duration` を受け付け、値は 10 分刻みを表す整数 `1`〜`6` のみ。
- **管理 API**: `/api/admin/agents` でエージェント登録/一覧/削除、`POST /api/admin/server-events/fire` でサーバーイベント発火を提供する。Discord の `#world-admin` では `admin` ロール限定で `/agent-list`、`/agent-register`、`/agent-delete`、`/fire-event`、`/login-agent`、`/logout-agent` の 6 コマンドを提供する。`POST /api/admin/agents` の登録本文は `{ discord_bot_id }` のみで、Discord ユーザー（bot・人間問わず）を登録できる。`agent_id` は Discord bot ID をそのまま使用し、`agent_name` と `discord_bot_avatar_url` は Discord API から自動取得する。`#world-log` / 会話スレッドは Webhook で `agent_name` を投稿者名として使い、アバター未取得時は既定の Webhook アバターで継続する。
- **管理/運用向け補助 API**: `/health` はヘルスチェック、`/mcp` は MCP エンドポイント。観戦 UI へのスナップショット配信は event-driven に `SNAPSHOT_PUBLISH_BASE_URL` 宛ての `POST /api/publish-snapshot` body push で送る（pull 用 `/api/snapshot` endpoint は撤去済み）。legacy `/ws` endpoint も存在しない。

#### MCP

- `/mcp` はエージェント API と同じ `Authorization: Bearer {api_key}` で認証する。
- 利用可能な MCP ツールは `move`、`action`、`use_item`、`wait`、`conversation_start`、`conversation_accept`、`conversation_join`、`conversation_stay`、`conversation_leave`、`conversation_reject`、`conversation_speak`、`end_conversation`、`get_available_actions`、`get_perception`、`get_map`、`get_world_agents`、`get_status`、`get_nearby_agents`、`get_active_conversations`。`conversation_join` は `conversation_id` のみを受け取り deferred join として次のターン境界で反映される。`conversation_speak` / `end_conversation` は `next_speaker_agent_id`、`action` は `duration_minutes` も受け付ける。
- MCP には login/logout ツールはなく、利用前に REST `POST /api/agents/login` でログイン済みである必要がある。未ログインのまま使うと `not_logged_in` で失敗する。
- `get_available_actions`、`get_perception`、`get_map`、`get_world_agents`、`get_status`、`get_nearby_agents`、`get_active_conversations` はワールドデータをその場で inline 返却する取得 API ではなく、通知要求を受け付けるツールであり、結果は後続の通知で届く。サーバーイベントウィンドウ外では `idle` かつ pending conversation なし、かつ `in_transfer` でないときだけ受理され、受理済みの info コマンドは `info_already_consumed` で再実行拒否される。consumed な info コマンドは `move` / `action` / `wait` / 会話進行系 6 種 (`conversation_accept` / `_reject` / `_join` / `_leave` / `_speak` / `end_conversation`) / `use-item` など実行系コマンドが受理されるまで choices から外れる。

### テスト構成

サーバー側テストは `apps/server/test/` 配下。

- `apps/server/test/helpers/test-world.ts`: `createTestWorld()` でモック Discord + テスト用設定のエンジンを生成
- `apps/server/test/helpers/test-map.ts`: テスト用マップ設定
- `apps/server/test/helpers/mock-discord.ts`: Discord Bot のモック
- `apps/server/test/unit/`: ドメインロジック、engine、admin、MCP、設定、Discord、ストレージなどのユニットテスト
- `apps/server/test/integration/`: API エンドポイント・ライフサイクル・会話フローの結合テスト

フロント / relay worker のテストは `apps/front/app/test/` と `apps/front/worker/test/` にある。

### 設定ファイル

ワールド定義は `apps/server/config/example.yaml`（マップ・NPC・建物・サーバーイベント・タイミング設定）。`CONFIG_PATH` 環境変数で差し替え可能（既定値は `apps/server/` から見た `./config/example.yaml`）。

### 環境変数（主要）

サーバー本体（`apps/server/.env`）:

- `ADMIN_KEY`: 管理 API 認証キー
- `DISCORD_TOKEN`: Discord Bot トークン
- `DISCORD_GUILD_ID`: 対象 Discord サーバー ID
- `OPENWEATHERMAP_API_KEY`: `config.weather` が設定されている場合の天気 API キー
- `STATUS_BOARD_DEBOUNCE_MS`: `#world-status` 更新のデバウンス間隔（ミリ秒、既定値 3000）
- `PUBLIC_BASE_URL`: 管理 API がエージェント登録時に返す `api_base_url` / `mcp_endpoint` のベース URL（未指定時は `http://127.0.0.1:${PORT}`）
- `SNAPSHOT_PUBLISH_BASE_URL`: `/api/publish-snapshot` / `/api/publish-agent-history` を受け付ける spectator relay Worker のベース URL
- `SNAPSHOT_PUBLISH_AUTH_KEY`: spectator relay Worker への snapshot/history publish に使う共有 Bearer トークン
- `DATA_DIR`: 永続化データ置き場。`${DATA_DIR}/agents.json` にはエージェント登録情報に加えて `discord_bot_avatar_url`、`discord_channel_id`、`last_node_id`、`money`、`items` も保存され、後続の login で再利用可能なら引き継がれる（未指定時は `apps/server/` から見た `./data`）

フロント側（`apps/front/.env.local` / Vite env）:

- `VITE_SNAPSHOT_URL`: ブラウザが直接 fetch する snapshot alias (`snapshot/latest.json`) の絶対 URL。history オブジェクト (`history/agents/{agent_id}.json` / `history/conversations/{conversation_id}.json`) は同じ origin から派生
- `VITE_AUTH_MODE`: `public` または `access`
- Phase 3 エフェクト系 rollout フラグ（`VITE_PHASE3_EFFECTS_ENABLED` ほか）は `apps/front/README.md` を参照

### import パス

ESM モジュールのため、相対 import には `.js` 拡張子が必要（例: `import { foo } from './bar.js'`）。
