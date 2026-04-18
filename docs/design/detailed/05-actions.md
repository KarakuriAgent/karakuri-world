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
  duration_minutes?: number;
}
```

### 1.3 バリデーションルール

以下の順序で検証・分岐する。#1〜#3 は即時エラー、#4〜#5 は受理後の `action_rejected` 通知により結果を確定する。

| # | 検証内容 | 結果 |
|---|---------|------|
| 1 | エージェントが `idle` 状態であり、かつ受諾待ち（02-agent-lifecycle.md セクション4.4）でないこと | `409 Conflict` (`state_conflict`) |
| 2 | `action_id` が `MapConfig` 内に存在すること | `400 Bad Request` (`action_not_found`) |
| 3 | アクションの実行条件を満たしていること（1.1参照） | `400 Bad Request` (`action_not_available`) |
| 4 | `cost_money` がある場合、所持金が不足していないこと | API は受理し、後続 `action_rejected` で通知 |
| 5 | `required_items` がある場合、必要数量を所持していること | API は受理し、後続 `action_rejected` で通知 |

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

エージェントの現在位置で実行条件を満たすアクションの候補一覧は API/MCP で再取得を依頼する。この一覧はエージェントの状態（`idle` / `moving` 等）に関わらず、位置条件のみでフィルタリングされ、詳細結果は Discord 通知の `選択肢` ブロックおよび `get_available_actions` 通知で返る。実際にアクションを実行できるかどうかは、アクション実行リクエスト時の状態バリデーション（セクション1.3）で判定する。

API/MCP の即時レスポンス:

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

通知に含まれるアクション行の構造:

```text
- action: {name} (action_id: {action_id}, {duration_sec}秒) - {source.name}
```

可変時間アクションは以下の形式になる:

```text
- action: {name} (action_id: {action_id}, {min}〜{max}分, duration_minutes: 分数を指定) - {source.name}
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

バリデーション（状態チェック、アクション存在チェック、実行条件チェック）通過後、実効所要時間 `duration_ms` を解決する（固定時間アクションは `ActionConfig.duration_ms`、可変時間アクションは `duration_minutes * 60_000`）。`duration_minutes` の検証（必須チェック・範囲チェック）もこの段階で行い、所持金・必要アイテムチェックより先に確定させる。

続いて `cost_money` / `required_items` を検証し、不足している場合は API レスポンス自体は `NotificationAcceptedResponse` のまま受理しつつ、詳細結果は `action_rejected` イベントと後続通知で返す。利用可能アクション一覧には不足中の `required_items` 依存アクションも表示し、実行時にのみ拒否判定する。

実行処理:

1. `cost_money` があれば開始時に消費する
2. `required_items` があれば開始時に消費する
3. エージェント状態を `in_action` に遷移
4. `ActionTimer` を生成（03-world-engine.md セクション1.2参照。`fires_at = 現在時刻 + duration_ms`）
5. `ActionStartedEvent` を発行（03-world-engine.md セクション2.2参照）。`cost_money` / `items_consumed` があれば同イベントに含める。配信先は WebSocket・ログ・Discord #world-log（03-world-engine.md セクション4.2参照）
6. レスポンスを返却

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

### 3.2 シーケンス

```
Agent → API: POST /api/agents/action { action_id: "sleep-house-a", duration_minutes: 120 }
  API: バリデーション（状態チェック、アクション存在チェック、実行条件チェック、duration_minutes検証）
  API: 実効 duration_ms を解決
  API: cost_money / required_items を検証
  API: 開始時消費を適用
  API: 状態を in_action に遷移
  API: ActionTimer を生成
  API: action_started イベント発行
API → Agent: 200 OK { ok: true, message }

  ... 解決済み duration_ms 経過 ...

Timer 発火:
  Engine: reward_money / reward_items を適用
  Engine: 状態を idle に遷移
  Engine: action_completed イベント発行
  Engine: 通知配信（セクション4参照）
```

## 4. アクション完了時の処理

### 4.1 タイマー発火時の処理手順

`action` タイマー発火時、以下の順序で処理する:

1. `reward_money` があれば付与する
2. `reward_items` があれば付与する（`EconomyConfig.max_inventory_slots` と `ItemConfig.max_stack` に収まらない分は `items_dropped`）
3. 状態を `idle` に遷移
4. `action_completed` イベントを発行
5. 通知を配信

アクションはアクション名を含む完了通知に加え、設定されていれば経済副作用も反映する。`cost_money` / `required_items` は開始時、`reward_money` / `reward_items` は完了時に適用する。開始後に割り込まれた場合、開始時消費分は返却しない（01-data-model.md セクション5.4参照）。

### 4.2 イベント発行

`ActionCompletedEvent` を発行する（03-world-engine.md セクション2.2参照）。固有データ:

```typescript
{
  agent_id: string,
  action_id: string,
  action_name: string,
  cost_money?: number,
  reward_money?: number,
  money_balance?: number,
  items_granted?: AgentItem[],
  items_dropped?: AgentItem[],
}
```

`EventBase` のフィールド（`event_id`、`type`、`occurred_at`）は省略。

### 4.3 通知内容

#### エージェント専用チャンネル（#agent-{name}）

アクション完了通知として以下を含める:

- アクション名
- 消費 / 報酬があればその結果（所持金・アイテム）
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
| サーバーイベントウィンドウによる割り込み | アクションをキャンセルし `idle` に遷移 |
| logout | アクションをキャンセルしログアウト |

### 5.2 会話着信による割り込み

`in_action` 中に他エージェントから会話着信があった場合、エージェントは受諾/拒否を選択できる。

**受諾した場合:**

1. `action` タイマーをキャンセル
2. 状態を `in_conversation` に遷移
3. 会話フローに移行（詳細は 06-conversation.md）

アクション完了報酬は発生しない（タイマーがキャンセルされるため `action_completed` イベントは発行されない）。ただし開始時に消費済みの `cost_money` / `required_items` は返却しない。

**拒否した場合:**

アクションは中断されず、タイマーは継続する。

### 5.3 サーバーイベントウィンドウによる割り込み

`in_action` 中にサーバーイベントウィンドウが有効な状態でエージェントが move/action/wait を実行した場合:

1. `action` タイマーをキャンセル（`wait` タイマーも同様）
2. 状態を `idle` に遷移
3. 新しいコマンド（move/action/wait）を実行

アクション完了報酬は発生しない。開始時に消費済みの `cost_money` / `required_items` も返却しない。サーバーイベントウィンドウの詳細は 07-server-events.md で定義する。

サーバーイベントを無視した場合、アクションは中断されずタイマーは継続する。次の通知到達時にウィンドウはクリアされる。

### 5.4 logoutによる割り込み

`in_action` 中のlogout処理は 03-world-engine.md セクション6 のクリーンアップの一部として `action` タイマーがキャンセルされる。ログアウト処理の全体フローは 02-agent-lifecycle.md セクション3.2を参照。

## 6. アイテム使用

### 6.1 アイテム使用リクエスト

```typescript
interface ItemUseRequest {
  item_id: string;
}
```

`POST /api/agents/use-item` は所持アイテム 1 件を対象にした汎用使用コマンドである。`item_id` はエージェントが現在所持しているアイテム ID を指定する。

即時レスポンスはアクション一覧取得と同じ受理応答を返す。

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

詳細結果は後続のイベント/通知で確定し、通常使用時は `item_use_started` → `item_use_completed`、`venue` 型アイテムの汎用使用では `item_use_venue_rejected` が発行される。

### 6.2 バリデーションと分岐

以下の順序で検証・分岐する。

| # | 検証 / 分岐内容 | 結果 |
|---|----------------|------|
| 1 | エージェントが `idle` 状態であり、かつ受諾待ち（02-agent-lifecycle.md セクション4.4）でないこと | 失敗時 `409 Conflict` (`state_conflict`) |
| 2 | `item_id` を 1 件以上所持していること | 失敗時 `400 Bad Request` (`item_not_owned`) |
| 3 | 対象アイテムの `type` が `venue` か判定する | `venue` ならタイマーを生成せずセクション6.3.1へ、その他はセクション6.3.2へ進む |

バリデーション #1 の形式は 02-agent-lifecycle.md セクション5.2 の `StateConflictError` に従う。

バリデーション #2 のエラー形式:

```typescript
interface ItemUseValidationError {
  error: "item_not_owned";
  message: string;
}
```

`venue` 型は API エラーにせず、受理応答を返したうえで `item_use_venue_rejected` 通知により「汎用使用できない」ことと候補場所を伝える。アイテムは消費されず、状態遷移も発生しない。

### 6.3 処理フロー

#### 6.3.1 `venue` 型アイテムの汎用使用拒否

`venue` 型アイテムが指定された場合、サーバーは以下を行う。

1. `required_items` に対象 `item_id` を含むアクションを検索し、場所案内用の `venue_hints` を組み立てる
2. 状態を変えず、`item_use_venue_rejected` イベントを発行する
3. `NotificationAcceptedResponse` を返す

この分岐では `item_use` タイマーを生成しない。エージェントは通知に示された場所へ移動し、通常の `POST /api/agents/action` で該当アクションを実行する。

#### 6.3.2 通常アイテムの使用開始

`general` / `food` / `drink` 型アイテムでは以下の順で処理する。

1. エージェント状態を `in_action` に遷移
2. `ItemUseTimer` を生成（03-world-engine.md セクション1.2参照。`fires_at = 現在時刻 + EconomyConfig.item_use_duration_ms`）
3. `ItemUseStartedEvent` を発行する（03-world-engine.md セクション2.2参照）
4. `NotificationAcceptedResponse` を返す

`item_use_started` には `completes_at` を含める。アイテムは開始時にはまだ消費しない。

#### 6.3.3 シーケンス

```
Agent → API: POST /api/agents/use-item { item_id: "bread" }
  API: バリデーション（状態チェック、所持確認、item_type 判定）
  API: 状態を in_action に遷移
  API: ItemUseTimer を生成
  API: item_use_started イベント発行
API → Agent: 200 OK { ok: true, message }

  ... EconomyConfig.item_use_duration_ms 経過 ...

Timer 発火:
  Engine: 所持アイテムを1件消費
  Engine: 状態を idle に遷移
  Engine: item_use_completed イベント発行
```

`venue` 型では上記シーケンスの代わりに `item_use_venue_rejected` のみを発行し、タイマー発火処理へは進まない。

### 6.4 完了時の処理

`item_use` タイマー発火時、以下の順序で処理する。

1. 対象 `item_id` を所持品から 1 件消費する
2. 状態を `idle` に遷移する
3. `item_use_completed` イベントを発行する
4. 通知を配信する

通知文言は `item_type` ごとに切り替える。

| `item_type` | 完了通知の意味 |
|-------------|----------------|
| `general` | 使用しました |
| `food` | 食べました |
| `drink` | 飲みました |

アイテム使用完了通知には、通常のアクション完了通知と同様に知覚範囲内の情報と次の行動促進を含める。`venue` 型は本セクションの完了処理対象外である。

### 6.5 割り込み

`item_use` 進行中の割り込み規則は `action` と同様とする。

| 割り込み | 処理 |
|---------|------|
| 会話着信の受諾 | `item_use` タイマーをキャンセルし、`in_conversation` に遷移 |
| サーバーイベントウィンドウによる割り込み | `item_use` タイマーをキャンセルし、`idle` に戻して新しいコマンドを実行 |
| logout | `item_use` タイマーをキャンセルしてログアウト |

割り込み時は `item_use_completed` は発行されず、開始前提のままアイテム消費も行われない。
