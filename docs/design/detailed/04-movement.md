# 04 - 移動

## 1. 移動リクエストのバリデーション

### 1.1 前提条件

移動リクエストは目的地ノードID（`target_node_id`）を指定する。サーバーがBFS（幅優先探索）で現在地から目的地への最短経路を計算し、経路のマス数に応じた移動時間で一括移動する。

```typescript
interface MoveRequest {
  target_node_id: NodeId;
}
```

### 1.2 BFS経路探索

現在地から目的地への最短経路をBFS（幅優先探索）で算出する。

#### アルゴリズム

1. 現在地をキューに追加し、visited集合に登録する
2. キューからノードを取り出し、4方向（north / south / east / west）の隣接ノードを展開する
3. 隣接ノードが通行可能（`isPassable`、01-data-model.md セクション2.1参照）かつ未訪問であればキューに追加する
4. 目的地に到達したら経路を復元して返却する
5. キューが空になった場合は到達不能（`null`）とする

#### 関数仕様

```typescript
findPath(from: NodeId, to: NodeId, mapConfig: MapConfig): NodeId[] | null
```

- **引数**: 現在地（`from`）、目的地（`to`）、マップ設定
- **戻り値**: `from` を含まず `to` を含むノードID配列。到達不能の場合は `null`
- 隣接ノードの展開には既存の `getAdjacentNodeId` を使用し、通行可否判定には `isPassable` を使用する

### 1.3 バリデーションルール

以下の順序で検証し、最初に失敗した時点でエラーを返す。

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | エージェントが `idle` 状態であり、かつ受諾待ち（02-agent-lifecycle.md セクション4.4）でないこと | `409 Conflict` (`state_conflict`) |
| 2 | 目的地ノードがグリッド範囲内であること（`1 ≤ row ≤ rows` かつ `1 ≤ col ≤ cols`） | `400 Bad Request` (`out_of_bounds`) |
| 3 | 目的地ノードが移動可能であること（01-data-model.md セクション2.1参照） | `400 Bad Request` (`impassable_node`) |
| 4 | 目的地ノードが現在地と異なること | `400 Bad Request` (`same_node`) |
| 5 | BFS経路が存在すること（到達可能であること） | `400 Bad Request` (`no_path`) |

移動先ノードに他エージェントが存在するかどうかはバリデーション対象外とする（エージェント同士は同一ノードに重なることができる）。

バリデーション #1 の形式は 02-agent-lifecycle.md セクション5.2 の `StateConflictError` に従う。受諾待ち中の場合も `StateConflictError` を返す（`current_state: "idle"`、`message` で受諾待ちである旨を伝える）。

バリデーション #2〜#5 のエラー形式:

```typescript
interface MoveValidationError {
  error: "out_of_bounds" | "impassable_node" | "same_node" | "no_path";
  message: string;
}
```

## 2. 移動タイマーの処理フロー

### 2.1 移動開始

バリデーション通過後の処理:

1. BFS経路探索で最短経路（`path`）を算出
2. エージェント状態を `moving` に遷移
3. `MovementTimer` を生成（03-world-engine.md セクション1.2参照。`fires_at = 現在時刻 + path.length × MovementConfig.duration_ms`（01-data-model.md セクション6.3））
4. `MovementStartedEvent` を発行（03-world-engine.md セクション2.2参照）。配信先は snapshot publisher 補助・ログ・Discord #world-log（03-world-engine.md セクション4.2参照）
5. レスポンスを返却

```typescript
interface MoveResponse {
  from_node_id: NodeId;
  to_node_id: NodeId;
  arrives_at: number; // 到着予定時刻（Unix timestamp ms）
}
```

### 2.2 シーケンス

```
Agent → API: POST /api/agents/move { target_node_id: "1-2" }
  API: バリデーション（状態チェック、範囲内・移動可能・同一ノード・到達可能チェック）
  API: BFS経路探索 → path = ["2-1", "1-1", "1-2"]（例: 3ステップ）
  API: 状態を moving に遷移
  API: MovementTimer を生成（fires_at = now + 3 × duration_ms）
  API: movement_started イベント発行
API → Agent: 200 OK { from_node_id, to_node_id, arrives_at }

  ... path.length × MovementConfig.duration_ms 経過 ...

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
3. 保留中のサーバーイベントを確認し、存在する場合はすべて遅延通知する（03-world-engine.md セクション3.4参照）
4. `movement_completed` イベントを発行
5. 通知を配信

### 3.2 イベント発行

`MovementCompletedEvent` を発行する（03-world-engine.md セクション2.2参照）。固有データ:

```typescript
{
  agent_id: string,
  node_id: NodeId  // 到着したノード（= MovementTimer.to_node_id）
}
```

`EventBase` のフィールド（`event_id`、`type`、`occurred_at`）は省略。

### 3.3 通知内容

#### エージェント専用チャンネル（#agent-{name}）

移動完了通知として以下を含める:

- 到着ノードのID・ラベル
- 知覚範囲内の情報（03-world-engine.md セクション3.2参照）
- 行動促進（次のアクションの指示）

保留中のサーバーイベントがある場合、サーバーイベントの遅延通知を先に送信し、その直後に移動完了通知を送信する。両方とも同一エージェント内では順序を保って配信し、`active_server_event_id` は移動完了通知の配信後にクリアする（03-world-engine.md セクション3.4参照）。

#### ワールドログ（#world-log）

到着ログとしてエージェント名と到着ノードを投稿する。

## 4. 移動中のエージェント位置

移動中（`moving` 状態）のエージェントの位置は、内部状態（`LoggedInAgent.node_id`）を直接更新するのではなく、タイマー情報から参照時に算出する。中間地点への到着に対する Discord 通知や追加イベントは発行しない（`movement_started` は移動開始時に発行される）。

### 4.1 位置の算出

移動中のエージェントの現在位置は、タイマーの情報から算出する:

```
started_at = MovementTimer.fires_at - path.length × MovementConfig.duration_ms
elapsed = 現在時刻 - started_at
steps_completed = floor(elapsed / MovementConfig.duration_ms)
```

- `steps_completed = 0`: 出発地点（`from_node_id`）に位置する
- `1 ≤ steps_completed < path.length`: `path[steps_completed - 1]` に位置する
- `steps_completed ≥ path.length`: 目的地（`to_node_id`）に位置する（タイマー発火直前）

### 4.2 影響範囲

- `get_perception` / `get_world_agents` / `get_available_actions` は移動中でもセクション4.1に基づく現在位置で情報取得を受け付け、詳細結果は Discord 通知で返す
- スナップショット（`GET /api/snapshot`）も同様にセクション4.1に基づく現在位置を返す
- サーバーイベントは移動完了後に遅延通知される（03-world-engine.md セクション3.4参照）

## 5. 移動中のログアウト処理

`moving` 状態のエージェントがlogoutした場合、03-world-engine.md セクション6 のクリーンアップの一部として以下が実行される:

1. `movement` タイマーをキャンセル
2. サーバーイベント保留リストを破棄

ログアウト処理の全体フローは 02-agent-lifecycle.md セクション3.2を参照。

`AgentLoggedOutEvent.node_id` にはセクション4.1に基づく現在位置が設定される。
