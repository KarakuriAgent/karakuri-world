# 14 - UI 履歴配信（R2-backed recent history）

## 1. 目的

Issue #60 / #64 以降、観戦 UI の履歴は **backend / Worker が event-driven に publish した R2 上の recent history documents** を、UI が R2 CDN から直接取得する構成に統一されている。読み出し側の Worker endpoint（旧 `GET /api/history`）は撤廃済みで、D1 / retention job は前提にしない。

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
- 各 bucket は `occurred_at` DESC / `event_id` DESC で保持し、同一 `event_id` は 1 回だけ保存する（各 bucket 100 件 cap）

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

### 3.3 HTTP メタデータ

publish 時に以下を付与する:

- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: public, max-age=5`

snapshot alias (`snapshot/latest.json`) と同じ TTL で edge cache されるため、観戦者数が増えても R2 origin への GET は線形に増えない。

## 4. publish ルール

- backend は `AgentHistoryManager.recordEvent()` で対象 event を同期的に buffer へ積む
- Worker への送信は append-only (`{ agent_id, events }`) とし、R2 の read-modify-write は DO 側で serialize する
- Node 側 publish failure では buffer に残し、**以降に新規 event が届かなくても指数バックオフで自動リトライ**（`retryMaxAttempts` 回数上限。上限到達で `gaveUp` 状態に入り、次の `recordEvent` で復帰）
- buffer overflow は log を残したうえで最古から捨てる
- 同一 `event_id` の重複送信は許容し、R2 merge 時に dedupe する

## 5. 観戦 UI からの取得

### 5.1 URL の組み立て

UI は環境変数 `VITE_SNAPSHOT_URL`（例: `https://snapshot.example.com/snapshot/latest.json`）の origin から以下を派生させて直接 fetch する。

- agent スコープ: `${origin}/history/agents/{encodeURIComponent(agent_id)}.json`
- conversation スコープ: `${origin}/history/conversations/{encodeURIComponent(conversation_id)}.json`

Worker は read 系 endpoint を持たないため、履歴アクセスは **100% R2 / CDN 直接 fetch** で完結する。

### 5.2 取得タイミング

- agent 選択時 / 会話展開時に 1 回 fetch
- 以降は snapshot polling (5 秒周期) 成功時に、選択中 agent と展開中の全 conversation に対して自動再取得（`refreshActiveHistoryScopes`）

UI は 100 件 cap 済みの静的ドキュメントを丸ごと取得し、クライアント側で必要なフィルタ / 先頭切り出しを行う。ページング / cursor は存在しない。

### 5.3 エラーハンドリング

| HTTP ステータス | 扱い |
|----------------|------|
| `200` | `AgentHistoryDocument` / `ConversationHistoryDocument` を zod でパースし、`items` / `recent_actions` / `recent_conversations` を `event_id` で dedupe してから `occurred_at` DESC に整列 |
| `404` | 空ドキュメント扱い (`{ items: [] }`)。scope ごとに 1 回だけ `console.warn` を出し key-scheme drift に気付けるようにする |
| その他 `!ok` | `status: 'error'` に遷移。直前の `response` は保持し、UI は warning chip + retry ボタンで復帰可能 |
| zod parse 失敗 | `console.error` にスコープ / URL / issues を出してから error に遷移（transient failure と区別できるよう loud log を必須とする） |

### 5.4 ライフサイクル

- polling 停止（`stopPolling`）時は in-flight history fetch も `HISTORY_STOP_ABORT_REASON` で中断する
- 選択解除 / conversation 畳み込みで対象から外れた scope は次回の `refreshActiveHistoryScopes` から自動的に消える

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
- history object は event-driven に更新され、edge cache TTL が 5 秒なので、UI から見た最悪レイテンシは snapshot と同じ約 10 秒（publish 直後の cache 満了 + 次 poll）
- R2 custom domain の CORS / Cache Rules は `snapshot/*` と `history/*` の両 prefix を対象にする（`apps/front/README.md` §Phase 2 認証モード別デプロイガイド 参照）
