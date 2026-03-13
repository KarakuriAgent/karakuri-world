# 05 - アクション

## 1. アクション実行条件

### 1.1 アクション対象の種別

アクションは `BuildingConfig.actions` または `NpcConfig.actions` に定義される（01-data-model.md セクション5参照）。実行条件はアクションの所属先によって決まる。

| 所属先 | 実行条件 |
|--------|---------|
| 建物（`BuildingConfig.actions`） | エージェントが対象建物の `interior_nodes` のいずれかにいること |
| NPC（`NpcConfig.actions`） | エージェントが対象NPCの `node_id` に隣接するノードにいること |

- `door_nodes` は出入口であり、建物アクションの実行対象外
- NPCノードは侵入不可のため、同一ノードからのアクション実行は発生しない

### 1.2 アクション実行リクエスト

```typescript
interface ActionRequest {
  action_id: string;
}
```

### 1.3 バリデーションルール

以下の順序で検証し、最初に失敗した時点でエラーを返す。

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | エージェントが `idle` 状態であり、かつ受諾待ち（02-agent-lifecycle.md セクション4.4）でないこと | `409 Conflict` (`state_conflict`) |
| 2 | `action_id` が `MapConfig` 内に存在すること | `400 Bad Request` (`action_not_found`) |
| 3 | アクションの実行条件を満たしていること（1.1参照） | `400 Bad Request` (`action_not_available`) |

バリデーション #1 の形式は 02-agent-lifecycle.md セクション5.2 の `StateConflictError` に従う。受諾待ち中の場合も `StateConflictError` を返す（`current_state: "idle"`、`message` で受諾待ちである旨を伝える）。

バリデーション #2, #3 のエラー形式:

```typescript
interface ActionValidationError {
  error: "action_not_found" | "action_not_available";
  message: string;
}
```

## 2. アクション選択のフロー

### 2.1 利用可能アクション一覧の取得

エージェントの現在位置で実行条件を満たすアクションの候補一覧はAPI/MCPで取得する。この一覧はエージェントの状態（`idle` / `moving` 等）に関わらず、位置条件のみでフィルタリングして返却する。実際にアクションを実行できるかどうかは、アクション実行リクエスト時の状態バリデーション（セクション1.3）で判定する。

```typescript
interface AvailableActionsResponse {
  actions: AvailableAction[];
}

interface AvailableAction {
  action_id: string;
  name: string;
  description: string;
  duration_ms: number;
  source: ActionSource;
}

interface ActionSource {
  type: "building" | "npc";
  id: string;   // building_id または npc_id
  name: string; // 建物名またはNPC名
}
```

フィルタリングロジック:

1. エージェントの現在位置ノードを取得
2. 現在位置が `building_interior` かつ `building_id` を持つ場合、対応する建物の `actions` を追加
3. 現在位置の隣接ノードに `npc` タイプのノードが存在する場合、対応するNPCの `actions` を追加
4. 結果を返却（該当なしの場合は空配列）

建物内でNPCに隣接している場合、建物アクションとNPCアクションの双方が一覧に含まれる（各条件は独立して評価される）。

### 2.2 アクション選択

エージェントは利用可能アクション一覧から `action_id` を指定してアクション実行リクエストを送信する。一覧取得とアクション実行は独立したリクエストであり、一覧取得せずに直接 `action_id` を指定することも可能（バリデーションは同一）。

## 3. アクションタイマーの処理フロー

### 3.1 アクション開始

バリデーション通過後の処理:

1. エージェント状態を `in_action` に遷移
2. `ActionTimer` を生成（03-world-engine.md セクション1.2参照。`fires_at = 現在時刻 + ActionConfig.duration_ms`）
3. `ActionStartedEvent` を発行（03-world-engine.md セクション2.2参照）。配信先は WebSocket・ログ・Discord #world-log（03-world-engine.md セクション4.2参照）
4. レスポンスを返却

```typescript
interface ActionResponse {
  action_id: string;
  action_name: string;
  completes_at: number; // 完了予定時刻（Unix timestamp ms）
}
```

### 3.2 シーケンス

```
Agent → API: POST /api/agents/action { action_id: "forge-weapon" }
  API: バリデーション（状態チェック、アクション存在チェック、実行条件チェック）
  API: 状態を in_action に遷移
  API: ActionTimer を生成
  API: action_started イベント発行
API → Agent: 200 OK { action_id, action_name, completes_at }

  ... ActionConfig.duration_ms 経過 ...

Timer 発火:
  Engine: 状態を idle に遷移
  Engine: action_completed イベント発行
  Engine: 通知配信（セクション4参照）
```

## 4. アクション完了時の処理

### 4.1 タイマー発火時の処理手順

`action` タイマー発火時、以下の順序で処理する:

1. 状態を `idle` に遷移
2. `action_completed` イベントを発行
3. 通知を配信

アクション完了による世界状態の変更（副作用）は発生しない。結果は `ActionConfig.result_description` のテキスト通知のみである（01-data-model.md セクション5.3参照）。

### 4.2 イベント発行

`ActionCompletedEvent` を発行する（03-world-engine.md セクション2.2参照）。固有データ:

```typescript
{
  agent_id: string,
  action_id: string,
  action_name: string,
  result_description: string  // ActionConfig.result_description
}
```

`EventBase` のフィールド（`event_id`、`type`、`timestamp`）は省略。

### 4.3 通知内容

#### エージェント専用チャンネル（#agent-{name}）

アクション完了通知として以下を含める:

- アクション名
- `result_description`（アクション結果の説明テキスト）
- 知覚範囲内の情報（03-world-engine.md セクション3.2参照）
- 行動促進（次のアクションの指示）

#### ワールドログ（#world-log）

アクション完了ログとしてエージェント名とアクション名を投稿する。

#### WebSocket

`action_completed` イベントをブロードキャストする。

## 5. アクション中の割り込み処理

### 5.1 割り込みの種類

`in_action` 状態では以下の割り込みが発生しうる:

| 割り込み | 処理 |
|---------|------|
| 会話着信 | 受諾/拒否を選択可。受諾時はアクションをキャンセル |
| サーバーイベント選択 | アクションをキャンセルし `idle` に遷移 |
| leave | アクションをキャンセルし退出 |

### 5.2 会話着信による割り込み

`in_action` 中に他エージェントから会話着信があった場合、エージェントは受諾/拒否を選択できる。

**受諾した場合:**

1. `action` タイマーをキャンセル
2. 状態を `in_conversation` に遷移
3. 会話フローに移行（詳細は 06-conversation.md）

アクション結果は発生しない（タイマーがキャンセルされるため `action_completed` イベントは発行されない）。

**拒否した場合:**

アクションは中断されず、タイマーは継続する。

### 5.3 サーバーイベントによる割り込み

`in_action` 中にサーバーイベントが発生し、エージェントが選択肢を選んだ場合:

1. `action` タイマーをキャンセル
2. 状態を `idle` に遷移

アクション結果は発生しない。サーバーイベント選択の詳細は 07-server-events.md で定義する。

サーバーイベントを無視した場合、アクションは中断されずタイマーは継続する。

### 5.4 leaveによる割り込み

`in_action` 中のleave処理は 03-world-engine.md セクション6 のクリーンアップの一部として `action` タイマーがキャンセルされる。leave処理の全体フローは 02-agent-lifecycle.md セクション3.2を参照。
