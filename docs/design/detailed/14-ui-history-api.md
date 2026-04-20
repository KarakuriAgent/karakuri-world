# 14 - UI 履歴 API（R2-backed recent history）

## 1. 目的

Issue #60 以降の `/api/history` は、backend / Worker が event-driven に publish した **R2 上の recent history documents** を detail overlay 向けに読む API である。D1 や retention job は前提にしない。

## 2. 保存対象

UI 履歴へ残すのは次のイベントだけとする。

- `agent_logged_in`, `agent_logged_out`
- `movement_started`, `movement_completed`
- `action_started`, `action_completed`, `action_rejected`
- `wait_started`, `wait_completed`
- `item_use_started`, `item_use_completed`, `item_use_venue_rejected`
- 会話系イベント（`conversation_*`）
- `server_event_fired`

保存しないイベント:

- `idle_reminder_fired`
- `map_info_requested`
- `world_agents_info_requested`
- `perception_requested`
- `available_actions_requested`

## 3. 永続化形式

### 3.1 agent document

キー: `history/agents/{agent_id}.json`

```ts
interface AgentHistoryDocument {
  agent_id: string;
  updated_at: number;
  items: PersistedHistoryEntry[];
  recent_actions: PersistedHistoryEntry[];
  recent_conversations: PersistedHistoryEntry[];
}
```

- `items`: action / conversation を除く一般 timeline
- `recent_actions`: action 系の直近履歴
- `recent_conversations`: conversation 系の直近履歴
- 各 bucket は occurred_at DESC / event_id DESC で保持し、同一 `event_id` は 1 回だけ保存する

### 3.2 conversation document

キー: `history/conversations/{conversation_id}.json`

```ts
interface ConversationHistoryDocument {
  conversation_id: string;
  updated_at: number;
  items: PersistedHistoryEntry[];
}
```

Worker DO は agent append の副作用として conversation document も更新する。

## 4. publish ルール

- backend は `AgentHistoryManager.recordEvent()` で対象 event を同期的に buffer へ積む
- Worker への送信は append-only (`{ agent_id, events }`) とし、R2 の read-modify-write は DO 側で serialize する
- Node 側 publish failure ではメモリ buffer に残し、次回成功時にまとめて再送する
- buffer overflow は log を残したうえで最古から捨てる
- 同一 `event_id` の重複送信は許容し、R2 merge 時に dedupe する

## 5. `/api/history`

### 5.1 クエリ

```ts
type HistoryQuery =
  | { agent_id: string; conversation_id?: never; types?: string; cursor?: string; limit?: number }
  | { conversation_id: string; agent_id?: never; types?: string; cursor?: string; limit?: number };
```

- `agent_id` と `conversation_id` はちょうど 1 つ必須
- `types` はカンマ区切り。未知の type は 400 `invalid_request`
- `cursor` は `base64url("${occurred_at}:${event_id}")`
- `limit` は `1..100`、既定 20

### 5.2 レスポンス

```ts
interface HistoryResponse {
  items: HistoryEntry[];
  next_cursor?: string;
  hydration?: 'never-recorded';
}
```

- R2 miss: `{ items: [], hydration: 'never-recorded' }`
- R2 read/parse failure: 5xx `internal_error`
- conversation scope は conversation document の `items` を返す
- agent scope は `items + recent_actions + recent_conversations` を merge/dedupe/filter して返す

## 6. 公開可能フィールド

`detail` は公開 allowlist のみ保持する。少なくとも次は保存しない。

- `discord_channel_id`
- `money`, `items`
- `cost_money`, `reward_money`
- `required_items`, `reward_items`
- `money_balance`, `items_consumed`, `items_granted`, `items_dropped`

UI は `summary` を一次表示に使い、必要時のみ `detail` を開く。

## 7. 運用上の注意

- history は current-state rendering の primary dependency ではない
- history publish failure があっても snapshot publish は止めない
