# Karakuri World 実装プラン

## Context

LLMエージェントが参加できるMMO的な仮想世界システム「Karakuri World」の実装プラン。
概要設計2本 + 詳細設計11本の設計ドキュメントが完成済みで、実装コードは未着手。
本プランでは設計ドキュメントに基づき、段階的に全コンポーネントを実装する。

## 技術スタック

| カテゴリ | 技術 |
|---------|------|
| 言語 | TypeScript (strict) |
| ランタイム | Node.js >= 20 |
| HTTP | Hono + @hono/node-server |
| WebSocket | @hono/node-ws |
| Discord | discord.js >= 14 |
| MCP | @modelcontextprotocol/sdk (Streamable HTTP) |
| テスト | vitest |
| バリデーション | zod |
| 設定ファイル | YAML (js-yaml) |
| パッケージマネージャー | npm |
| ビルド | tsx (開発) + tsc (ビルド) |

## ディレクトリ構造

```
karakuri-world/
├── docs/design/                        # 既存の設計ドキュメント
├── src/
│   ├── index.ts                        # エントリーポイント
│   ├── config/
│   │   ├── index.ts                    # YAML設定読み込み
│   │   ├── schema.ts                   # ServerConfig の Zod スキーマ
│   │   └── validation.ts              # マップトポロジバリデーション
│   ├── types/
│   │   ├── data-model.ts              # 01: MapConfig, NodeConfig, BuildingConfig 等
│   │   ├── agent.ts                    # 02: AgentRegistration, AgentState 等
│   │   ├── timer.ts                    # 03: Timer 共用体型、各タイマー型
│   │   ├── event.ts                    # 03: WorldEvent 共用体型、各イベント型
│   │   ├── conversation.ts            # 06: ConversationData, ConversationStatus
│   │   ├── server-event.ts            # 07: ServerEventInstance
│   │   ├── api.ts                      # 08: リクエスト/レスポンス/エラー型
│   │   └── snapshot.ts                # 03§7: WorldSnapshot, AgentSnapshot
│   ├── engine/
│   │   ├── world-engine.ts            # World Engine メインクラス
│   │   ├── timer-manager.ts           # タイマー管理 (setTimeout ラップ)
│   │   ├── event-bus.ts               # イベント発行・リスナー管理
│   │   └── state/
│   │       ├── world-state.ts         # 世界状態ファサード
│   │       ├── agent-state.ts         # エージェント登録・参加・状態管理
│   │       ├── conversation-state.ts  # 会話データ管理
│   │       └── server-event-state.ts  # サーバーイベントランタイム管理
│   ├── domain/
│   │   ├── map-utils.ts               # 隣接計算、距離、範囲、建物/NPC検索
│   │   ├── perception.ts              # 知覚情報構築 (構造化データ + テキスト要約)
│   │   ├── movement.ts               # 移動バリデーション・処理
│   │   ├── actions.ts                 # アクションバリデーション・処理
│   │   ├── conversation.ts            # 会話開始/受諾/拒否/発言/終了処理
│   │   └── server-events.ts          # サーバーイベント発火/選択/遅延通知
│   ├── api/
│   │   ├── app.ts                     # Hono アプリケーション設定
│   │   ├── middleware/
│   │   │   ├── auth.ts                # Agent認証 (Bearer) + Admin認証 (X-Admin-Key)
│   │   │   ├── joined.ts             # 参加状態チェック
│   │   │   └── validate.ts           # Zodバリデーション共通
│   │   ├── routes/
│   │   │   ├── admin.ts               # /api/admin/*
│   │   │   ├── agent-lifecycle.ts     # /api/agents/join, leave
│   │   │   ├── agent-actions.ts       # /api/agents/move, action, actions
│   │   │   ├── agent-conversation.ts  # /api/agents/conversation/*
│   │   │   ├── agent-info.ts          # /api/agents/perception, map, world-agents
│   │   │   ├── agent-server-event.ts  # /api/agents/server-event/select
│   │   │   └── ui.ts                  # /api/snapshot
│   │   └── websocket.ts              # WebSocket接続管理・ブロードキャスト
│   ├── mcp/
│   │   ├── server.ts                  # MCPサーバー設定 (Streamable HTTP)
│   │   └── tools.ts                   # 13個のMCPツール定義
│   ├── discord/
│   │   ├── bot.ts                     # Discord Bot初期化 (送信専用)
│   │   ├── channel-manager.ts        # チャンネル動的作成/削除 + Permission Overwrites
│   │   ├── notification.ts           # 通知メッセージフォーマット (12種 agent + 7種 world-log)
│   │   └── event-handler.ts          # EventBusリスナー → Discord配信
│   └── skills/
│       └── template.ts               # SKILL.md テンプレート生成
├── config/
│   └── example.yaml                   # サーバー設定ファイルの例
├── test/
│   ├── unit/
│   │   ├── config/validation.test.ts
│   │   ├── domain/
│   │   │   ├── map-utils.test.ts
│   │   │   ├── perception.test.ts
│   │   │   ├── movement.test.ts
│   │   │   ├── actions.test.ts
│   │   │   ├── conversation.test.ts
│   │   │   └── server-events.test.ts
│   │   ├── engine/
│   │   │   ├── timer-manager.test.ts
│   │   │   └── event-bus.test.ts
│   │   ├── discord/
│   │   │   ├── notification.test.ts
│   │   │   ├── event-handler.test.ts
│   │   │   └── channel-manager.test.ts
│   │   ├── mcp/tools.test.ts
│   │   └── skills/template.test.ts
│   ├── integration/
│   │   ├── lifecycle.test.ts
│   │   ├── movement.test.ts
│   │   ├── actions.test.ts
│   │   ├── conversation.test.ts
│   │   ├── server-events.test.ts
│   │   ├── api.test.ts
│   │   └── websocket.test.ts
│   └── helpers/
│       ├── test-world.ts              # テスト用WorldEngine構築
│       ├── test-map.ts               # テスト用MapConfig (3x5, 建物1, NPC1)
│       └── mock-discord.ts           # Discord Botモック
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## フェーズ0: プロジェクトスキャフォールド

### 作成ファイル
- `package.json` — 依存: hono, @hono/node-server, @hono/node-ws, discord.js, @modelcontextprotocol/sdk, zod, js-yaml, ws; dev: typescript, tsx, vitest, @types/*
- `tsconfig.json` — target: ES2022, module: NodeNext, strict: true
- `vitest.config.ts`
- `.env.example` — ADMIN_KEY, DISCORD_TOKEN, DISCORD_GUILD_ID, PORT, CONFIG_PATH, PUBLIC_BASE_URL（`api_base_url` / `mcp_endpoint` 生成用。例: `https://karakuri.example.com`）
- `.gitignore` — node_modules, dist, .env
- `src/index.ts` — 最小限のエントリーポイント

### 完了基準
- `npm install` 成功
- `npm run typecheck` 成功
- `npm test` 実行可能

---

## フェーズ1: 型定義 + データモデル + マップユーティリティ

**設計書参照: 01-data-model.md**

### 作成ファイル

**型定義** (`src/types/`)
- `data-model.ts` — NodeId, NodeType, Direction, NodeConfig, MapConfig, BuildingConfig, NpcConfig, ActionConfig, ServerConfig, WorldConfig, MovementConfig, ConversationConfig, PerceptionConfig, SpawnConfig
- `agent.ts` — AgentState, AgentRegistration
- `timer.ts` — TimerType, TimerBase, MovementTimer, ActionTimer, ConversationAcceptTimer, ConversationTurnTimer, ConversationIntervalTimer, ServerEventTimeoutTimer, Timer共用体
- `event.ts` — EventType, EventBase, 13種のイベント型, WorldEvent共用体
- `conversation.ts` — ConversationStatus, ConversationData (conversation_id, status, initiator_agent_id, target_agent_id, current_turn, current_speaker_agent_id, closing_reason?, initial_message)
- `server-event.ts` — ServerEventConfig, ServerEventChoiceConfig, ServerEventInstance
- `api.ts` — 全エンドポイントのRequest/Response型, ErrorResponse, 各種バリデーションエラー型
- `snapshot.ts` — WorldSnapshot, AgentSnapshot, ConversationSnapshot

**マップユーティリティ** (`src/domain/`)
- `map-utils.ts`
  - `parseNodeId(nodeId)` — "行-列" → { row, col }
  - `toNodeId(row, col)` — { row, col } → "行-列"
  - `getAdjacentNodeId(nodeId, direction, mapConfig)` — 方向→隣接NodeId (範囲外はnull)
  - `getNodeConfig(nodeId, mapConfig)` — ノード設定取得 (未定義はnormal)
  - `isPassable(nodeType)` — normal, door, building_interior → true
  - `manhattanDistance(a, b)` — マンハッタン距離
  - `getNodesInRange(center, range, mapConfig)` — 知覚範囲内ノード一覧
  - `findBuildingByInteriorNode(nodeId, mapConfig)` — 建物内ノード→建物特定 (アクション判定用)
  - `findBuildingsInNodes(nodeIds, mapConfig)` — ノード集合に含まれる建物一覧 (知覚情報構築用)
  - `findAdjacentNpcs(nodeId, mapConfig)` — 隣接NPC検索
- `perception.ts` — 参加中エージェント一覧は引数として受け取る純粋関数として設計 (エージェント管理はフェーズ2)
  - `buildPerceptionData(...)` — 構造化知覚データ (API/MCPレスポンス用)
  - `buildPerceptionText(...)` — テキスト要約 (Discord通知用)

**設定** (`src/config/`)
- `schema.ts` — ServerConfig の Zod スキーマ
- `validation.ts` — マップトポロジバリデーション (壁/interior/doorの整合性、action_id一意性、スポーンノードの移動可能性) + サーバーイベントバリデーション (event_id一意性、choice_id一意性、choices最小1件、timeout_ms >= 1)
- `index.ts` — YAML読み込み + パース + バリデーション

**設定ファイル例**
- `config/example.yaml` — ServerConfig の全フィールドを含むサンプル設定ファイル

**テストヘルパー** (`test/helpers/`)
- `test-map.ts` — 3x5マップ (建物1, NPC1, 壁数個)

### テスト
- `test/unit/domain/map-utils.test.ts`
- `test/unit/domain/perception.test.ts`
- `test/unit/config/validation.test.ts`

### 完了基準
- 全型定義コンパイル通過
- map-utils 全関数テストパス
- perception テストパス
- config validation テストパス (正常 + 各種制約違反)

---

## フェーズ2: World Engine コア + エージェントライフサイクル

**設計書参照: 02-agent-lifecycle.md, 03-world-engine.md**

### 作成ファイル

**エンジン** (`src/engine/`)
- `timer-manager.ts` — TimerManager クラス
  - `create(timer)` — setTimeout設定、timer_id発行
  - `cancel(timerId)` — clearTimeout
  - `cancelByAgent(agentId)` — エージェントの全タイマーキャンセル
  - `cancelByType(agentId, type)` — 種別指定キャンセル
  - `getByAgent(agentId)` — 全タイマー取得
  - タイマー発火時コールバック: `onFire(type, handler)`
- `event-bus.ts` — EventBus クラス
  - `emit(event)` — イベント発行（全イベントをstdoutにJSON形式でログ出力）
  - `on(type, handler)` — 特定イベントリスナー
  - `onAny(handler)` — 全イベントリスナー（Discord配信・WebSocketブロードキャスト用）

**状態管理** (`src/engine/state/`)
- `agent-state.ts` — JoinedAgent型定義 (agent_id, agent_name, node_id, state, discord_channel_id, pending_conversation_id, pending_server_events[])
- `conversation-state.ts` — 会話データのCRUD
- `server-event-state.ts` — サーバーイベントランタイム管理
- `world-state.ts` — WorldState クラス (ファサード)
  - エージェント登録管理: register, delete, getByApiKey, getById, list
  - 参加管理: join, leave, getJoined, isJoined
  - 状態管理: setState, setNode
  - スナップショット: getSnapshot()
  - conversations, serverEvents プロパティで委譲

**メインエンジン**
- `world-engine.ts` — WorldEngine クラス
  - constructor(config, discordBot | null)
  - ライフサイクル: registerAgent, deleteAgent, joinAgent, leaveAgent
  - 世界操作メソッド (スタブ、フェーズ3で実装): move, executeAction, startConversation, acceptConversation, rejectConversation, speak, selectServerEvent, fireServerEvent
  - 情報取得: getAvailableActions, getPerception, getMap, getWorldAgents, getSnapshot

### テスト
- `test/unit/engine/timer-manager.test.ts` — vi.useFakeTimers() 使用
- `test/unit/engine/event-bus.test.ts`
- `test/integration/lifecycle.test.ts` — 登録→join→leave→再joinフロー
- `test/helpers/test-world.ts` — テスト用WorldEngine構築
- `test/helpers/mock-discord.ts` — Discord Botモック (メッセージ記録)

### 完了基準
- TimerManager テストパス (生成/キャンセル/発火)
- EventBus テストパス
- ライフサイクル結合テストパス (join時スポーン配置、leave時クリーンアップ)
- スナップショット生成テストパス

---

## フェーズ3: ドメインロジック (移動・アクション・会話・サーバーイベント)

**設計書参照: 04-movement.md, 05-actions.md, 06-conversation.md, 07-server-events.md**

### 3-A: 移動 (04-movement.md)

`src/domain/movement.ts`
- `validateMove(agent, request, mapConfig)` — 状態idle+受諾待ちなし、グリッド範囲内、移動可能ノード
- `executeMove(...)` — moving遷移、MovementTimer生成、movement_startedイベント
- `handleMovementCompleted(timer, ...)` — 位置更新、idle遷移、movement_completedイベント、保留サーバーイベント遅延通知

テスト: 4方向正常移動、グリッド外(400)、壁/NPC(400)、idle以外(409)、受諾待ち(409)、タイマー発火後idle遷移

### 3-B: アクション (05-actions.md)

`src/domain/actions.ts`
- `getAvailableActions(agent, mapConfig)` — 位置ベースフィルタリング (建物interior内 + NPC隣接)
- `validateAction(agent, request, mapConfig)` — 状態+action_id存在+実行条件
- `executeAction(...)` — in_action遷移、ActionTimer生成、action_startedイベント
- `handleActionCompleted(timer, ...)` — idle遷移、action_completedイベント

テスト: 建物内アクション、NPC隣接アクション、doorでの不可、存在しないaction_id(400)、条件未達(400)、割り込み(会話受諾・サーバーイベント選択)

### 3-C: 会話 (06-conversation.md) — 最も複雑

`src/domain/conversation.ts`
- `validateConversationStart(...)` — 状態、対象存在・参加中、対象受信可能(idle/in_action)、位置関係(同一or隣接)
- `startConversation(...)` — 会話ID生成、受諾待ち設定、ConversationAcceptTimer、conversation_requestedイベント
- `acceptConversation(...)` — in_conversation遷移(両者)、ConversationTurnTimer(target)、in_actionならアクションキャンセル
- `rejectConversation(...)` — 受諾待ち解除、conversation_rejectedイベント
- `handleAcceptTimeout(...)` — 受諾タイムアウト → 受諾待ち解除
- `speak(...)` — active時: turnインクリメント、ConversationIntervalTimer。closing時: 終了あいさつ
- `handleConversationInterval(timer, ...)` — 発言配信、max_turnsチェック、closing移行 or ConversationTurnTimer生成
- `handleTurnTimeout(timer, ...)` — active: 即座終了。closing: あいさつなし終了
- `endConversation(...)` — idle遷移(両者)、conversation_endedイベント
- `cancelPendingConversation(agentId, ...)` — leave時のpending会話キャンセル (発信側leave: イベント発行なし、対象側leave: reason "target_left" で conversation_rejected)
- `forceEndConversation(...)` — leave時のin_conversation/closing強制終了

テスト: 完全フロー(開始→受諾→10ターン→終了あいさつ→終了)、拒否、受諾タイムアウト、ターンタイムアウト(active/closing)、partner_leave、in_actionからの受諾、pending中のleave(発信側/対象側)

### 3-D: サーバーイベント (07-server-events.md)

`src/domain/server-events.ts`
- `fireServerEvent(eventId, ...)` — ランタイムインスタンス生成、状態別配信(idle/in_action/in_conversation→即時、moving→保留)
- `selectServerEvent(agent, request, ...)` — idle: タイマー削除のみ。in_action: アクションキャンセル+idle遷移。in_conversation: 終了あいさつフェーズ移行
- `handlePendingServerEvents(agentId, ...)` — 移動完了後の遅延通知配信
- `handleServerEventTimeout(timer, ...)` — タイマー削除のみ

テスト: 各状態での選択、moving中遅延通知、タイムアウト、複数同時イベント、closing中の選択拒否(400 conversation_closing)

### World Engineへの統合

WorldEngineのコンストラクタでTimerManager.onFire()を各タイマー種別の処理関数に接続。

### 完了基準
- 全ドメインの単体+結合テストパス
- WorldEngine直接操作で全シナリオ動作確認

---

## フェーズ4: REST API + WebSocket

**設計書参照: 08-rest-api.md**

### Discord/MCP未接続での運用

フェーズ4時点ではDiscord Bot（フェーズ5）とMCPサーバー（フェーズ5）は未実装である。以下の方針で対応する:

- **join レスポンスの `channel_id`**: WorldEngineはDiscord Botが `null` の場合、チャンネル作成をスキップし `channel_id` にプレースホルダー値（空文字列）を返す。フェーズ5でDiscord Bot接続時に実際の値を返すようになる
- **admin 登録レスポンスの `mcp_endpoint`**: サーバー設定から静的に生成する（MCPサーバーの起動有無に依存しない）
- **通知配信**: EventBusにリスナーが未登録の場合、イベントは発行されるが配信先がないため自然に無視される

### 作成ファイル

**ミドルウェア** (`src/api/middleware/`)
- `auth.ts` — agentAuth: Bearerトークン→エージェント特定。adminAuth: X-Admin-Key検証
- `joined.ts` — requireJoined: 参加状態チェック (403 not_joined)
- `validate.ts` — validateBody(zodSchema): リクエストボディバリデーション (400 invalid_request)

**ルート** (`src/api/routes/`) — 全18 HTTPエンドポイント + WebSocket
- `admin.ts` — POST/DELETE/GET /api/admin/agents, POST /api/admin/server-events/:event_id/fire
- `agent-lifecycle.ts` — POST /api/agents/join, POST /api/agents/leave
- `agent-actions.ts` — POST /api/agents/move, POST /api/agents/action, GET /api/agents/actions
- `agent-conversation.ts` — POST /api/agents/conversation/{start,accept,reject,speak}
- `agent-info.ts` — GET /api/agents/{perception,map,world-agents}
- `agent-server-event.ts` — POST /api/agents/server-event/select
- `ui.ts` — GET /api/snapshot

**WebSocket**
- `websocket.ts` — WebSocketManager: /ws 接続管理、スナップショット送信、イベントブロードキャスト

**Honoアプリ**
- `app.ts` — createApp(engine): ルート登録、WebSocket upgradeハンドリング

### テスト
- `test/integration/api.test.ts` — 全エンドポイントのHTTPテスト (正常系 + 401/403/400/404/409)
- `test/integration/websocket.test.ts` — WebSocket接続・初回スナップショット受信・イベントブロードキャスト・切断時クリーンアップ

### 完了基準
- 全エンドポイントのHTTPテストパス
- WebSocketテストパス（スナップショット受信+イベントブロードキャスト）
- `npm run dev` でサーバー起動、cURLで操作可能

---

## フェーズ5: MCPサーバー + Discord Bot + Skills

**設計書参照: 09-mcp-server.md, 10-discord-bot.md, 11-skills.md**

### 5-A: Discord Bot (10-discord-bot.md)

- `src/discord/bot.ts` — DiscordBot クラス: 初期化(Guilds Intent のみ)、送信専用
- `src/discord/channel-manager.ts` — ChannelManager: createAgentChannel(Permission Overwrites設定)、deleteAgentChannel、getWorldLogChannel
- `src/discord/notification.ts` — 12種の#agent通知 + 7種の#world-logフォーマット関数
- `src/discord/event-handler.ts` — DiscordEventHandler: EventBusリスナー → 配信ルール(03§4.2)に基づくDiscord送信

### 5-B: MCPサーバー (09-mcp-server.md)

- `src/mcp/server.ts` — createMcpServer(engine): Streamable HTTP、Authorization ヘッダー認証
- `src/mcp/tools.ts` — 13ツール定義 (join, leave, move, action, conversation_*, server_event_select, get_*)

### 5-C: Skills (11-skills.md)

- `src/skills/template.ts` — generateApiSkill(), generateMcpGuideline(), generateMcpClientConfig()

### エントリーポイント統合

`src/index.ts` — 起動フロー:
1. YAML設定読み込み + バリデーション
2. Discord Bot初期化 (DISCORD_TOKENがあれば。未設定時は警告ログを出力しDiscordなしモードで起動)
3. Discord Bot初期化時: DISCORD_GUILD_ID 必須チェック、静的チャンネル (#world-log, agents/admin カテゴリ) の存在検証。不備があればfail-fast
4. WorldEngine初期化
5. Hono + WebSocketサーバー起動
6. Discord EventHandler登録
7. MCPサーバー起動 (/mcp エンドポイント)

### テスト
- `test/unit/discord/notification.test.ts` — 全通知フォーマット検証
- `test/unit/discord/event-handler.test.ts` — 配信ルール検証 (03§4.2: イベント種別ごとの送信先・通知種別の対応。Discord Botモック使用)
- `test/unit/discord/channel-manager.test.ts` — チャンネル作成/削除・Permission Overwrites設定 (Discord.jsモック使用)
- `test/unit/mcp/tools.test.ts` — 13ツールのスキーマ検証・認証エラー(401)・参加状態エラー(403)・各ツールの正常系レスポンス
- `test/unit/skills/template.test.ts` — テンプレート生成出力検証

### 完了基準
- 通知フォーマットテストパス
- Discord Bot起動 + チャンネル作成/削除 (手動確認)
- MCPクライアントからツール呼び出し可能 (手動確認)
- E2Eフロー: join→move→action→conversation→leave (Discord通知含む)

---

## テスト戦略

| レベル | 対象 | ツール | 重要ポイント |
|--------|------|------|-------------|
| 単体 | domain/, config/, discord/notification | vitest | 各関数の入出力検証。fake timers使用 |
| 結合 | WorldEngine直接操作シナリオ | vitest + fake timers | 状態遷移パスの網羅的テスト |
| API結合 | HTTP全エンドポイント | vitest | 認証/認可/バリデーション全パターン |
| 手動 | Discord連携, MCP接続 | cURL, MCPクライアント | E2Eフロー確認 |

各テストで新しいWorldEngineインスタンスを生成し、テスト間の状態汚染を防止。
Discord Botは全テストでモック化。

---

## 実装上の注意事項

1. **逐次処理の保証**: World EngineはNode.jsイベントループ上で同期的に状態変更。async/awaitはDiscord API呼び出しなど外部通信のみ
2. **会話ロジックの複雑性**: active/closing状態 × 割り込み(サーバーイベント/leave) のテスト組み合わせを網羅的に作成
3. **タイマーとリクエストの競合**: 処理時点の状態で判定 (03§5.3)
4. **leave時クリーンアップ**: 全タイマーキャンセル + 会話相手通知 + 保留リストクリア (03§6)
5. **Discord API制限**: discord.jsビルトインのレートリミット対応を利用
