# 04 - 移動

## 1. 移動リクエストのバリデーション

### 1.1 前提条件

移動リクエストは方向（`north` / `south` / `east` / `west`）を指定する。方向指定により移動先は常に隣接ノードとなるため、隣接チェックは入力モデルで担保される。

```typescript
type Direction = "north" | "south" | "east" | "west";

interface MoveRequest {
  direction: Direction;
}
```

### 1.2 方向からノードIDの解決

エージェントの現在位置 `r-c` に対し、方向から移動先ノードIDを算出する。

| 方向 | 移動先 |
|------|--------|
| `north` | `(r-1)-c` |
| `south` | `(r+1)-c` |
| `east` | `r-(c+1)` |
| `west` | `r-(c-1)` |

### 1.3 バリデーションルール

以下の順序で検証し、最初に失敗した時点でエラーを返す。

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | エージェントが `idle` 状態であり、かつ受諾待ち（02-agent-lifecycle.md セクション4.4）でないこと | `409 Conflict` (`state_conflict`) |
| 2 | 移動先ノードがグリッド範囲内であること（`1 ≤ row ≤ rows` かつ `1 ≤ col ≤ cols`） | `400 Bad Request` (`out_of_bounds`) |
| 3 | 移動先ノードが移動可能であること（01-data-model.md セクション2.1参照） | `400 Bad Request` (`impassable_node`) |

移動先ノードに他エージェントが存在するかどうかはバリデーション対象外とする（エージェント同士は同一ノードに重なることができる）。

バリデーション #1 の形式は 02-agent-lifecycle.md セクション5.2 の `StateConflictError` に従う。受諾待ち中の場合も `StateConflictError` を返す（`current_state: "idle"`、`message` で受諾待ちである旨を伝える）。

バリデーション #2, #3 のエラー形式:

```typescript
interface MoveValidationError {
  error: "out_of_bounds" | "impassable_node";
  message: string;
}
```

## 2. 移動タイマーの処理フロー

### 2.1 移動開始

バリデーション通過後の処理:

1. エージェント状態を `moving` に遷移
2. `MovementTimer` を生成（03-world-engine.md セクション1.2参照。`fires_at = 現在時刻 + MovementConfig.duration_ms`（01-data-model.md セクション6.3））
3. `MovementStartedEvent` を発行（03-world-engine.md セクション2.2参照）。配信先は WebSocket・ログのみ（Discord通知なし。03-world-engine.md セクション4.2参照）
4. レスポンスを返却

```typescript
interface MoveResponse {
  from_node_id: NodeId;
  to_node_id: NodeId;
  arrives_at: number; // 到着予定時刻（Unix timestamp ms）
}
```

### 2.2 シーケンス

```
Agent → API: POST /api/agents/move { direction: "north" }
  API: バリデーション（状態チェック、隣接・移動可能チェック）
  API: 状態を moving に遷移
  API: MovementTimer を生成
  API: movement_started イベント発行
API → Agent: 200 OK { from_node_id, to_node_id, arrives_at }

  ... MovementConfig.duration_ms 経過 ...

Timer 発火:
  Engine: エージェント位置を to_node_id に更新
  Engine: 状態を idle に遷移
  Engine: movement_completed イベント発行
  Engine: 通知配信（セクション3参照）
```

## 3. 到着時の処理

### 3.1 タイマー発火時の処理手順

`movement` タイマー発火時、以下の順序で処理する:

1. エージェントの位置を `MovementTimer.to_node_id` に更新
2. 状態を `idle` に遷移
3. `movement_completed` イベントを発行
4. 保留中のサーバーイベントを確認し、存在する場合はすべて遅延通知する（03-world-engine.md セクション3.4参照）
5. 通知を配信

### 3.2 イベント発行

`MovementCompletedEvent` を発行する（03-world-engine.md セクション2.2参照）。固有データ:

```typescript
{
  agent_id: string,
  node_id: NodeId  // 到着したノード（= MovementTimer.to_node_id）
}
```

`EventBase` のフィールド（`event_id`、`type`、`timestamp`）は省略。

### 3.3 通知内容

#### エージェント専用チャンネル（#agent-{name}）

移動完了通知として以下を含める:

- 到着ノードのID・ラベル
- 知覚範囲内の情報（03-world-engine.md セクション3.2参照）
- 行動促進（次のアクションの指示）

保留中のサーバーイベントがある場合、移動完了通知に続けてサーバーイベントの遅延通知を送信する（03-world-engine.md セクション3.4参照）。

#### ワールドログ（#world-log）

到着ログとしてエージェント名と到着ノードを投稿する。

#### WebSocket

`movement_completed` イベントをブロードキャストする。

## 4. 移動中のleave処理

`moving` 状態のエージェントがleaveした場合、03-world-engine.md セクション6 のクリーンアップの一部として以下が実行される:

1. `movement` タイマーをキャンセル（位置更新は行わない）
2. サーバーイベント保留リストを破棄

leave処理の全体フローは 02-agent-lifecycle.md セクション3.2を参照。

移動中のleaveでは位置更新を行わないため、`AgentLeftEvent.node_id` には移動開始前のノード（`MovementTimer.from_node_id`）が設定される。
