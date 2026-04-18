# 14 - UI 履歴 API と D1 スキーマ

## 1. 目的

本書はエージェント詳細オーバーレイで使用する履歴取得 API と、その裏側の D1 永続化形式を定義する。current-state UI の primary path は 13-ui-relay-backend.md の polling + R2/CDN であり、本 API は detail overlay 向けの additive 機能として扱う。

## 2. 永続化対象イベント

### 2.1 保存対象

optional relay `/ws` ingest、publisher-side import/backfill、または同等の ingest pipeline が取り込めるイベントのうち、UI 表示に使うものを保存する。relay が無効で別 ingest も無い配備では D1 が空でも current-state UI の成立条件は変わらない。

| イベント種別 | 保存 | 備考 |
|-------------|------|------|
| `agent_logged_in`, `agent_logged_out` | する | `discord_channel_id` は除外 |
| `movement_started`, `movement_completed` | する | |
| `action_started`, `action_completed`, `action_rejected` | する | |
| `wait_started`, `wait_completed` | する | |
| `item_use_started`, `item_use_completed`, `item_use_venue_rejected` | する | |
| 会話系全種 | する | `conversation_requested` を含む |
| `server_event_fired` | する | |
| `idle_reminder_fired` | しない | `/ws` 非配信 |
| `map_info_requested`, `world_agents_info_requested`, `perception_requested`, `available_actions_requested` | しない | `/ws` 非配信 |

### 2.2 保持期間

- 保持期間: 180 日
- 毎日 1 回 cron で `world_events` から `occurred_at < now - 180 days` を削除する
- 同じ cron で `server_event_instances` から `first_occurred_at < now - 180 days` を削除する

## 3. D1 スキーマ

```sql
CREATE TABLE world_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  conversation_id TEXT,
  server_event_id TEXT,
  summary_emoji TEXT NOT NULL,
  summary_title TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX world_events_occurred_idx
  ON world_events (occurred_at DESC, event_id DESC);

CREATE TABLE server_event_instances (
  server_event_id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  first_occurred_at INTEGER NOT NULL,
  last_occurred_at INTEGER NOT NULL
);

CREATE INDEX server_event_instances_recent_idx
  ON server_event_instances (first_occurred_at DESC, server_event_id DESC);

CREATE TABLE world_event_agents (
  event_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (event_id, agent_id),
  FOREIGN KEY (event_id) REFERENCES world_events(event_id) ON DELETE CASCADE
);

CREATE INDEX world_event_agents_agent_timeline_idx
  ON world_event_agents (agent_id, occurred_at DESC, event_id DESC);

CREATE INDEX world_event_agents_agent_type_timeline_idx
  ON world_event_agents (agent_id, event_type, occurred_at DESC, event_id DESC);

CREATE TABLE world_event_conversations (
  event_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (event_id, conversation_id),
  FOREIGN KEY (event_id) REFERENCES world_events(event_id) ON DELETE CASCADE
);

CREATE INDEX world_event_conversations_timeline_idx
  ON world_event_conversations (conversation_id, occurred_at DESC, event_id DESC);

CREATE INDEX world_event_conversations_type_timeline_idx
  ON world_event_conversations (conversation_id, event_type, occurred_at DESC, event_id DESC);
```

`event_id` は UUID 系の非時系列 ID であり、`ORDER BY occurred_at DESC, event_id DESC` の第二キーにしか使えない。したがって `/api/history?agent_id=...` と `/api/history?conversation_id=...` の driver はそれぞれ `world_event_agents` / `world_event_conversations` とし、両リンク表に `occurred_at` を冗長保持して cursor 順序と一致する index を持たせる。

link 表側にも `event_type` を冗長保持し、`(scope_key, event_type, occurred_at DESC, event_id DESC)` 型の複合 index を別途用意する。これにより `types` フィルタつきクエリ（§5.3）でも join 後フィルタを避け、scope + 型で index 走査を完結できる。冗長保存される値は `world_events.event_type` と `world_events.occurred_at` のコピーであり、ingest はこの整合を §4 の D1 batch / トランザクション内で保証する。同 ingest 内で値がずれる場合は batch 全体を失敗扱いとする。

## 4. 取り込みルール

### 4.1 `summary_*` の役割

UI はまず `summary_emoji`, `summary_title`, `summary_text` を一覧表示し、必要時だけ `payload_json` の詳細を開く。これによりクライアント側のイベント種別分岐を最小化する。

### 4.2 agent 紐付け

`world_event_agents.role` は以下を使う。

- `subject`: 主体エージェント
- `target`: 対象エージェント
- `participant`: 会話参加者
- `delivered`: サーバーイベントを受け取ったエージェント
- `pending`: サーバーイベント保留中エージェント

`/api/history?agent_id=...` は各エージェントの正本タイムラインなので、ingest は **各 `(event_id, agent_id)` につき 1 行だけ** `world_event_agents` に保存する。1 人のエージェントが複数 role 候補に当てはまる場合は `subject > target > participant > delivered > pending` の優先順位で 1 つに正規化する。保存時の `occurred_at` は必ず `world_events.occurred_at` と同値にする。

通常イベントの例:

- `conversation_requested`: initiator=`subject`, target=`target`
- `conversation_accepted`: initiator=`subject`, 他の `participant_agent_ids`=`participant`
- `server_event_fired`: `delivered_agent_ids`, `pending_agent_ids` をそれぞれ対応 role で保存

#### 4.2.1 会話イベントの agent 紐付け

会話イベントは「その時点で会話に関与していた全エージェント」が各自の履歴で追えることを優先する。よって `conversation_*` の ingest では、下表の agent 集合を必ず link する。

| イベント種別 | link する agent と role |
|-------------|-------------------------|
| `conversation_requested` | `initiator_agent_id`=`subject`、`target_agent_id`=`target` |
| `conversation_accepted` | `initiator_agent_id`=`subject`、`participant_agent_ids` のうち initiator 以外=`participant`（acceptor も `participant_agent_ids` に必ず含まれる前提） |
| `conversation_rejected` | `initiator_agent_id`=`subject`、`target_agent_id`=`target` |
| `conversation_message` | `speaker_agent_id`=`subject`、`listener_agent_ids`=`participant` |
| `conversation_join` | `agent_id`=`subject`、`participant_agent_ids` のうち joiner 以外=`participant` |
| `conversation_leave` | `agent_id`=`subject`、`participant_agent_ids`=`participant` |
| `conversation_inactive_check` | `target_agent_ids`=`target`、同時点の会話参加者集合（target を除く）=`participant` |
| `conversation_interval_interrupted` | `speaker_agent_id`=`subject`、`participant_agent_ids` のうち speaker 以外=`participant` |
| `conversation_turn_started` | `current_speaker_agent_id`=`subject`、同時点の会話参加者集合（speaker を除く）=`participant` |
| `conversation_closing` | `current_speaker_agent_id`=`subject`、`participant_agent_ids` のうち speaker 以外=`participant` |
| `conversation_ended` | `final_speaker_agent_id` があればそれを `subject`、残りの `participant_agent_ids`=`participant`。`final_speaker_agent_id` がなければ `participant_agent_ids` 全員=`participant` |
| `conversation_pending_join_cancelled` | `agent_id`=`target` |

「同時点の会話参加者集合」は、イベント payload に完全な参加者一覧がない場合に ingest pipeline が保持する `conversation_mirror[conversation_id]`（13-ui-relay-backend.md §3.1 の `RelayConversationState` と同等で、optional `closing_reason` を含みうる mirror state）から解決する。seed source は 13-ui-relay-backend.md §3.3 のとおり `WorldSnapshot.conversations` であり、`latest_snapshot` はこの解決には使わない。

ingest 時の順序は以下で固定する。

1. 現在の `conversation_mirror[conversation_id]` を読み、incoming event を適用した **next state** をローカルに作る
2. agent link / conversation link の解決はこの next state を使う。したがって `conversation_turn_started` / `conversation_inactive_check` の participant 補完は「event 適用後」の authoritative 集合になる
3. `world_events` 1 行 + link 表（`world_event_agents` / `world_event_conversations`）+ `server_event_fired` 時の `server_event_instances` UPSERT を **同一の D1 batch / トランザクションで atomic に書き込む**。partial write を許容しない
4. D1 batch 成功後にだけ next state を `conversation_mirror` へ commit する。batch のいずれか 1 文でも失敗した場合は mirror 更新を破棄し、観測された失敗を 13-ui-relay-backend.md §9.1 のメトリクスへ記録したうえで次回 snapshot 再同期を待つ

next state の更新規則は次のとおり。

| イベント種別 | `conversation_mirror` への反映 |
|-------------|--------------------------------------|
| `conversation_requested` | `{ status: 'pending', initiator_agent_id, participant_agent_ids: [initiator_agent_id, target_agent_id] }` を作成/置換 |
| `conversation_accepted` | `{ status: 'active', initiator_agent_id, participant_agent_ids }` を作成/置換する。`current_speaker_agent_id` は既存値があれば維持し、なければ次の `conversation_turn_started` / snapshot 再同期で補正する |
| `conversation_rejected` | link 解決後に mirror から削除する |
| `conversation_message` | participant 集合は変更しない |
| `conversation_join` | payload の `participant_agent_ids` で participant 集合を置換し、`status: 'active'` を維持する |
| `conversation_leave` | payload の `participant_agent_ids` で participant 集合を置換する。`next_speaker_agent_id` があれば `current_speaker_agent_id` も更新する |
| `conversation_inactive_check` | participant 集合は変更しない。link 解決時だけ current mirror を参照する |
| `conversation_interval_interrupted` | payload の `participant_agent_ids` があれば participant 集合を同期し、`next_speaker_agent_id` を `current_speaker_agent_id` へ反映する。`closing: true` でも `status` / `closing_reason` の確定は後続の `conversation_closing` または `conversation_ended` を待つ |
| `conversation_turn_started` | participant 集合は維持したまま `current_speaker_agent_id` を更新する |
| `conversation_closing` | payload の `participant_agent_ids` で participant 集合を置換し、`status: 'closing'`, `current_speaker_agent_id`, `closing_reason` を更新する。`RelayConversationState.closing_reason` に入る `conversation_closing.reason` は `'ended_by_agent' \| 'max_turns' \| 'server_event'` の 3 値のみ |
| `conversation_ended` | mirror に存在すれば `status: 'closing'`, `closing_reason: event.reason` を **削除前の一時 state** として更新したうえで link を解決し、解決後に mirror から削除する。`conversation_ended.reason` は `ConversationClosureReason` 全 5 値（`'turn_timeout'` / `'participant_logged_out'` を含む）。これにより 13-ui-relay-backend.md §3.3 と同様、`conversation_closing` を経由しない直接終了経路でも `closing_reason` が観測できる |
| `conversation_pending_join_cancelled` | mirror 変更なし |

これにより `conversation_turn_started` や `conversation_inactive_check` も、直前 event の join / leave / closing がまだ `latest_snapshot` に反映されていなくても、正しい participant 集合で全参加者の agent timeline に現れる。mirror 実装の実体は Durable Object に限らず、relay worker・queue consumer・import job などでもよい。

### 4.3 `server_event_instances`

`server_event_fired` は UI sidebar 用の「直近 3 件」を cold start 時にも高速復元できるよう、`world_events` とは別に論理イベント単位の補助表 `server_event_instances` へも保存する。

- `server_event_id` を primary key とし、遅延再配信を 1 行へ畳み込む
- 初回発火時刻は `first_occurred_at = MIN(...)` で保持し、UI の並び順と一致させる
- 遅延再配信の監査用に `last_occurred_at = MAX(...)` を保持する
- description は同一 `server_event_id` 内で不変を前提とし、初回値をそのまま使う

投入時は以下の意味になる UPSERT を行う。

```sql
INSERT INTO server_event_instances (
  server_event_id,
  description,
  first_occurred_at,
  last_occurred_at
) VALUES (?, ?, ?, ?)
ON CONFLICT(server_event_id) DO UPDATE SET
  first_occurred_at = MIN(server_event_instances.first_occurred_at, excluded.first_occurred_at),
  last_occurred_at = MAX(server_event_instances.last_occurred_at, excluded.last_occurred_at);
```

ingest pipeline の cold start 復元は `server_event_instances_recent_idx` を使って `ORDER BY first_occurred_at DESC, server_event_id DESC LIMIT 3` を読む。これにより 180 日分の `world_events` に対する full scan / `GROUP BY server_event_id` を回避する。

### 4.4 `payload_json`

`payload_json` はサニタイズ済み JSON をそのまま保持する。除外規則は 12-spectator-snapshot.md §3.2 に従う。

とくに D1 / `/api/history` は「公開 allowlist のみ保持する」方針を採り、`payload_json` へ以下を保存しない。

- `discord_channel_id`
- `money`, `items`
- `cost_money`, `reward_money`, `required_items`, `reward_items`
- `money_balance`, `items_consumed`, `items_granted`, `items_dropped`

`HistoryEntry.detail` は `payload_json` を object 化したものにすぎないため、これらのフィールドを detail 側で復元・付加してはならない。イベント種別ごとの authoritative allowlist は 12-spectator-snapshot.md §5.3 を正本とする。

### 4.5 アクション絵文字の解決

`summary_emoji` はイベント payload の未定義フィールドへ依存させず、D1 取り込み時に `action_id` から解決する。解決順は以下とする。

1. 最新の `ActionConfig.emoji`
2. `action_started` の既定値 `✨`
3. `action_completed` の既定値 `✅`

`payload_json` はサニタイズ済みイベント契約をそのまま保持し、`action_emoji` の追加フィールドは前提にしない。

## 5. `/api/history`

### 5.1 クエリパラメータ

`agent_id` か `conversation_id` のどちらか **ちょうど 1 つ** が必須である。両方指定や両方欠落は不正リクエストとする。型は scope を discriminated union で表現する。

```typescript
interface HistoryQueryBase {
  types?: string;   // カンマ区切り
  cursor?: string;  // base64url(`${occurred_at}:${event_id}`)
  limit?: number;   // 1..100, default 20
}

type HistoryQuery =
  | (HistoryQueryBase & { agent_id: string; conversation_id?: never })
  | (HistoryQueryBase & { conversation_id: string; agent_id?: never });
```

実装は HTTP クエリ文字列を上記 union のどちらかに正規化し、両方欠落・両方指定はいずれも 400 `invalid_request` とする（§5.4 参照）。

### 5.2 レスポンス

```typescript
interface HistoryEntry {
  event_id: string;
  type: string;
  occurred_at: number;
  agent_ids: string[];
  conversation_id?: string;
  summary: {
    emoji: string;
    title: string;
    text: string;
  };
  detail: Record<string, unknown>; // payload_json を object 化したもの
}

interface HistoryResponse {
  items: HistoryEntry[];
  next_cursor?: string;
}
```

### 5.3 ソートとページング

- 並び順: `occurred_at DESC, event_id DESC`
- cursor は「この項目より古いデータ」を指す
- `next_cursor` がなければ終端

agent / conversation 履歴は link 表を先頭に読む。`event_id` 単独では時系列を表さないため、cursor 条件と sort 条件は必ず link 表の `occurred_at, event_id` に対して評価する。`types` フィルタも link 表側 `event_type` で評価し、複合 index `(scope_key, event_type, occurred_at DESC, event_id DESC)` を使う。

```sql
-- agent timeline (types フィルタなし: world_event_agents_agent_timeline_idx を使う)
SELECT we.*
FROM world_event_agents wea
JOIN world_events we ON we.event_id = wea.event_id
WHERE wea.agent_id = :agent_id
  AND (
    :cursor_occurred_at IS NULL
    OR wea.occurred_at < :cursor_occurred_at
    OR (wea.occurred_at = :cursor_occurred_at AND wea.event_id < :cursor_event_id)
  )
ORDER BY wea.occurred_at DESC, wea.event_id DESC
LIMIT :limit_plus_one;

-- agent timeline (types フィルタあり: world_event_agents_agent_type_timeline_idx を使う)
SELECT we.*
FROM world_event_agents wea
JOIN world_events we ON we.event_id = wea.event_id
WHERE wea.agent_id = :agent_id
  AND wea.event_type IN (...)
  AND (
    :cursor_occurred_at IS NULL
    OR wea.occurred_at < :cursor_occurred_at
    OR (wea.occurred_at = :cursor_occurred_at AND wea.event_id < :cursor_event_id)
  )
ORDER BY wea.occurred_at DESC, wea.event_id DESC
LIMIT :limit_plus_one;

-- conversation timeline (types フィルタあり: world_event_conversations_type_timeline_idx を使う)
SELECT we.*
FROM world_event_conversations wec
JOIN world_events we ON we.event_id = wec.event_id
WHERE wec.conversation_id = :conversation_id
  AND wec.event_type IN (...)
  AND (
    :cursor_occurred_at IS NULL
    OR wec.occurred_at < :cursor_occurred_at
    OR (wec.occurred_at = :cursor_occurred_at AND wec.event_id < :cursor_event_id)
  )
ORDER BY wec.occurred_at DESC, wec.event_id DESC
LIMIT :limit_plus_one;
```

`types` フィルタは link 表側 index で完結させ、`world_events` を `event_type` で全走査しないこと。クエリプランナで join 後フィルタになっていないかは ingest 時に意図したインデックスが選ばれるか EXPLAIN で確認する。

### 5.4 バリデーション

| ステータス | エラーコード | 条件 |
|-----------|-------------|------|
| 400 | `invalid_request` | `agent_id`, `conversation_id` の両方欠落 |
| 400 | `invalid_request` | `agent_id` と `conversation_id` の両方指定 |
| 400 | `invalid_request` | `limit` が範囲外 |
| 400 | `invalid_cursor` | cursor の decode 失敗 |

## 6. summary テンプレート

| イベント種別 | emoji | title | text |
|-------------|-------|-------|------|
| `agent_logged_in` | `👋` | `ログイン` | `{agent_name} が {node_id} にログイン` |
| `agent_logged_out` | `🚪` | `ログアウト` | `{agent_name} がログアウト` |
| `movement_started` | `🚶` | `移動開始` | `{from_node_id} → {to_node_id}` |
| `movement_completed` | `📍` | `移動完了` | `{node_id} に到着` |
| `action_started` | `resolveActionEmoji(action_id) ?? '✨'` | `アクション開始` | `{action_name} を開始` |
| `action_completed` | `resolveActionEmoji(action_id) ?? '✅'` | `アクション完了` | `{action_name} を完了` |
| `action_rejected` | `⚠️` | `アクション失敗` | `{action_name}: {rejection_reason}` |
| `wait_started` | `💤` | `待機開始` | `{duration_ms}ms の待機` |
| `wait_completed` | `⏰` | `待機完了` | `待機を終了` |
| `item_use_started` | `🧰` | `アイテム使用開始` | `{item_name} を使用開始` |
| `item_use_completed` | `🎒` | `アイテム使用完了` | `{item_name} を使用` |
| `item_use_venue_rejected` | `📍` | `場所が必要` | `{item_name} は専用アクションで使用` |
| `conversation_requested` | `💬` | `会話申請` | `会話を開始` |
| `conversation_accepted` | `🤝` | `会話開始` | `会話が成立` |
| `conversation_message` | `💬` | `発言` | `{message}` |
| `conversation_join` | `👥` | `会話参加` | `{agent_name} が参加` |
| `conversation_leave` | `↩️` | `会話離脱` | `{agent_name} が離脱` |
| `conversation_interval_interrupted` | `⏸️` | `会話中断` | `理由に応じて会話間隔が打ち切られた` |
| `conversation_closing` | `🔚` | `会話終了処理` | `理由: {reason}` |
| `conversation_ended` | `🛑` | `会話終了` | `理由: {reason}` |
| `conversation_rejected` | `🙅` | `会話拒否` | `理由: {reason}` |
| `conversation_inactive_check` | `❓` | `応答確認` | `inactive check を送信` |
| `conversation_turn_started` | `🎙️` | `発言ターン` | `次の話者: {current_speaker_agent_id}` |
| `conversation_pending_join_cancelled` | `🚫` | `参加取消` | `理由: {reason}` |
| `server_event_fired` | `📢` | `サーバーイベント` | `{description}` |

## 7. UI 利用方針

- エージェント詳細オーバーレイは `agent_id` 指定で取得する
- 会話ログ展開時は `conversation_id` 指定で追加取得してもよい
- 初回表示では `limit=20`
- 「さらに読み込む」では、現在 cache 済みの `next_cursor` をそのまま次回 `cursor` に渡して継続取得する
- 追加ページは既存一覧の末尾へ append し、`event_id` を key に重複排除して 1 本の降順タイムラインとして保持する
- append 後は最新取得レスポンスの `next_cursor` で cache を更新し、未定義になった時点で終端とみなす
