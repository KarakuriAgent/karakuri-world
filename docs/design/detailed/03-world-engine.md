# 03 - ワールドエンジン

## 1. タイマー管理

### 1.1 タイマー種別

| 種別 | 用途 | 期間の設定元 |
|------|------|------------|
| `movement` | 移動完了 | `MovementConfig.duration_ms` |
| `action` | アクション完了 | 固定時間アクションは `ActionConfig.duration_ms`、可変時間アクションは実行時に解決した `duration_minutes * 60_000` |
| `wait` | 待機完了 | リクエストの `duration`（`duration × WAIT_UNIT_MS` で変換） |
| `item_use` | アイテム使用完了 | `EconomyConfig.item_use_duration_ms`（未設定時は既定値） |
| `conversation_accept` | 会話受諾タイムアウト | `ConversationConfig.accept_timeout_ms` |
| `conversation_turn` | ターン応答タイムアウト | `ConversationConfig.turn_timeout_ms` |
| `conversation_interval` | ターン間インターバル | `ConversationConfig.interval_ms` |
| `conversation_inactive_check` | inactive_check 応答タイムアウト | `ConversationConfig.turn_timeout_ms` |
| `idle_reminder` | idle状態継続時の再通知 | `IdleReminderConfig.interval_ms` |

サーバーイベントは専用タイマーを持たず、`active_server_event_id` フラグでウィンドウを管理する。

### 1.2 タイマーデータ構造

```typescript
type TimerType =
  | "movement"
  | "action"
  | "wait"
  | "item_use"
  | "conversation_accept"
  | "conversation_turn"
  | "conversation_interval"
  | "conversation_inactive_check"
  | "idle_reminder";

interface TimerBase {
  timer_id: string;  // サーバーが生成するUUID
  type: TimerType;
  agent_ids: string[];  // タイマーに関連するエージェントのID一覧
  created_at: number;   // タイマー生成時刻（Unix timestamp ms）
  fires_at: number;     // 発火時刻（Unix timestamp ms）
}
```

各タイマー種別ごとのデータ:

```typescript
interface MovementTimer extends TimerBase {
  type: "movement";
  from_node_id: NodeId;
  to_node_id: NodeId;
  path: NodeId[]; // BFS最短経路（fromを含まず、toを含む）
}

interface ActionTimer extends TimerBase {
  type: "action";
  agent_id: string;
  action_id: string;
  action_name: string;
  duration_ms: number;
}

interface WaitTimer extends TimerBase {
  type: "wait";
  agent_id: string;
  duration_ms: number;
}

interface ItemUseTimer extends TimerBase {
  type: "item_use";
  agent_id: string;
  item_id: string;
  item_name: string;
  item_type: ItemType;
}

interface ConversationAcceptTimer extends TimerBase {
  type: "conversation_accept";
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
}

interface ConversationTurnTimer extends TimerBase {
  type: "conversation_turn";
  conversation_id: string;
  current_speaker_agent_id: string;
}

interface ConversationIntervalTimer extends TimerBase {
  type: "conversation_interval";
  conversation_id: string;
  speaker_agent_id: string;   // 発言者のID
  listener_agent_ids: string[];  // 配信先（聞き手）のID一覧
  next_speaker_agent_id: string;
  turn: number;
  message: string; // 配信する発言内容
}

interface ConversationInactiveCheckTimer extends TimerBase {
  type: "conversation_inactive_check";
  conversation_id: string;
  target_agent_ids: string[];
}

interface IdleReminderTimer extends TimerBase {
  type: "idle_reminder";
  agent_id: string;
  idle_since: number; // idle状態に入った時刻（経過時間算出用）
}

type Timer =
  | MovementTimer
  | ActionTimer
  | WaitTimer
  | ItemUseTimer
  | ConversationAcceptTimer
  | ConversationTurnTimer
  | ConversationIntervalTimer
  | ConversationInactiveCheckTimer
  | IdleReminderTimer;
```

### 1.3 タイマーの生成

| タイマー種別 | 生成タイミング | 参照 |
|------------|--------------|------|
| `movement` | 移動リクエスト受理時 | 04-movement.md |
| `action` | アクション実行リクエスト受理時 | 05-actions.md |
| `wait` | 待機リクエスト受理時 | — |
| `item_use` | `POST /api/agents/use-item` 受理時（`venue` 型の拒否時は生成しない） | 05-actions.md |
| `conversation_accept` | 会話開始リクエスト受理時 | 06-conversation.md |
| `conversation_turn` | 会話開始時（受諾後、ターゲットの応答期限として）、および `conversation_interval` タイマー発火時 | 06-conversation.md |
| `conversation_interval` | エージェントが発言した時 | 06-conversation.md |
| `conversation_inactive_check` | inactive_check 開始時 | 06-conversation.md |
| `idle_reminder` | idle状態に入った時（ログイン完了後、移動完了後、アクション完了後、待機完了後、会話終了後、会話拒否/タイムアウト後） | — |

### 1.4 タイマーのキャンセル

| タイマー種別 | キャンセル条件 |
|------------|--------------|
| `movement` | エージェントlogout |
| `action` | エージェントlogout、会話受諾（`in_action` からの遷移）、サーバーイベントウィンドウによる割り込み |
| `wait` | エージェントlogout、会話受諾（`in_action` からの遷移）、サーバーイベントウィンドウによる割り込み |
| `item_use` | エージェントlogout、会話受諾（`in_action` からの遷移）、サーバーイベントウィンドウによる割り込み |
| `conversation_accept` | 相手が受諾、相手が拒否、発信側logout、対象側logout |
| `conversation_turn` | 対象エージェントが発言、会話終了（max_turns到達、相手logout、サーバーイベントウィンドウによる割り込み） |
| `conversation_interval` | 会話終了（max_turns到達、相手logout、サーバーイベントウィンドウによる割り込み） |
| `conversation_inactive_check` | 対象エージェント全員が `stay` / `leave` で応答、会話終了、相手logout、サーバーイベントウィンドウによる割り込み |
| `idle_reminder` | エージェントがidle状態から離れる時（移動開始、アクション開始、待機開始、アイテム使用開始、会話開始、会話受諾）、エージェントlogout |

### 1.5 タイマー発火時処理

| タイマー種別 | 発火時処理 |
|------------|-----------|
| `movement` | エージェント位置を `to_node_id` に確定、状態を `idle` に遷移、`movement_completed` イベント発行。移動時間は `path.length × MovementConfig.duration_ms`。移動中の位置算出は 04-movement.md セクション4.1参照 |
| `action` | 状態を `idle` に遷移、`action_completed` イベント発行。タイマーには実行開始時に解決した `duration_ms` を保持する |
| `wait` | 状態を `idle` に遷移、`wait_completed` イベント発行 |
| `item_use` | 所持アイテムを1件消費し、状態を `idle` に遷移、`item_use_completed` イベント発行 |
| `conversation_accept` | 受諾待ちを解除、`conversation_rejected` イベント発行（`reason: "timeout"`） |
| `conversation_turn` | `active` 状態: 会話を終了、両者を `idle` に遷移、`conversation_ended` イベント発行（`reason: "turn_timeout"`）。`closing` 状態: 終了あいさつ未送信として会話を終了、`conversation_ended` イベント発行（`reason` は終了理由に応じて `"max_turns"`、`"server_event"`、または `"ended_by_agent"`）。詳細は 06-conversation.md セクション5.2、7.1、7.2 |
| `conversation_interval` | `active` 状態: 次の発言者にDiscordで発言を配信し、必要なら `inactive_check` へ移行したうえで `conversation_turn` タイマーを生成する。通常ターンへそのまま渡せない場合は `conversation_interval_interrupted` を発行する。turn が `ConversationConfig.max_turns` に到達した場合、または `closing_reason` が `"ended_by_agent"` の場合は終了あいさつフェーズに移行。`closing` 状態: 終了あいさつを配信し、参加者が残っていれば次の終了担当へターンを渡す。詳細は 06-conversation.md セクション5.2、6、7.1 |
| `conversation_inactive_check` | 未応答参加者を会話から離脱させ、残り参加者で継続または終了する。詳細は 06-conversation.md セクション6 |
| `idle_reminder` | エージェントがまだidle（`pending_conversation_id` なし）なら、同じ `idle_since` で新しいタイマーを再作成し、`idle_reminder_fired` イベントを発行。Discord通知で経過時間・知覚情報・選択肢付き行動促進テキストを送信 |

## 2. イベントシステム

### 2.1 イベント種別一覧

| イベント種別 | 説明 | 発生トリガー |
|------------|------|------------|
| `agent_logged_in` | エージェントログイン | login API |
| `agent_logged_out` | エージェントログアウト | logout API |
| `movement_started` | 移動開始 | 移動リクエスト受理 |
| `movement_completed` | 移動完了 | `movement` タイマー発火 |
| `action_started` | アクション開始 | アクション実行リクエスト受理 |
| `action_completed` | アクション完了 | `action` タイマー発火 |
| `action_rejected` | アクション実行拒否 | アクション前提不足（所持金不足・必要アイテム不足など）で開始できない時 |
| `wait_started` | 待機開始 | 待機リクエスト受理 |
| `wait_completed` | 待機完了 | `wait` タイマー発火 |
| `item_use_started` | アイテム使用開始 | `POST /api/agents/use-item` 受理 |
| `item_use_completed` | アイテム使用完了 | `item_use` タイマー発火 |
| `item_use_venue_rejected` | venue アイテムの汎用使用拒否 | `POST /api/agents/use-item` で `venue` 型アイテムを指定 |
| `conversation_requested` | 会話リクエスト | 会話開始リクエスト受理 |
| `conversation_accepted` | 会話受諾 | 受諾API |
| `conversation_rejected` | 会話拒否またはタイムアウト | 拒否APIまたは `conversation_accept` タイマー発火 |
| `conversation_message` | 会話発言 | 発言API |
| `conversation_join` | 会話参加反映 | 参加APIで保留された join の反映点（`conversation_interval` タイマー発火、inactive_check 解消、離脱後の継続） |
| `conversation_leave` | 会話離脱 | 離脱API、inactive_check タイムアウト、logout、サーバーイベント割り込み |
| `conversation_inactive_check` | inactive_check 通知 | `conversation_interval` タイマー発火 |
| `conversation_interval_interrupted` | 発言配信後の割り込み通知 | `conversation_interval` タイマー発火時に通常ターン継続へ進まず、closing / 参加者離脱後の再開へ移る時 |
| `conversation_turn_started` | 再開ターン開始通知 | inactive_check 解消後、logout 後の継続 |
| `conversation_closing` | 会話が終了あいさつフェーズに移行 | max_turns到達、サーバーイベントウィンドウによる割り込み、自発終了 |
| `conversation_ended` | 会話終了 | max_turns到達（終了あいさつ後）、ターンタイムアウト、サーバーイベントウィンドウによるclosing完了後、エージェントによる自発終了（終了あいさつ後）、相手logout |
| `conversation_pending_join_cancelled` | 保留中の参加取り消し通知 | 会話全体が終了する際、`pending_participant_agent_ids` に残っていた joiner 毎に1件発火 |
| `server_event_fired` | サーバーイベント発生 | 管理API `POST /api/admin/server-events/fire` |
| `idle_reminder_fired` | idle状態継続時の再通知 | `idle_reminder` タイマー発火 |
| `map_info_requested` | マップ情報取得依頼 | `get_map` API/MCP |
| `world_agents_info_requested` | エージェント一覧取得依頼 | `get_world_agents` API/MCP |
| `perception_requested` | 知覚情報再取得依頼 | `get_perception` API/MCP |
| `available_actions_requested` | 利用可能アクション再取得依頼 | `get_available_actions` API/MCP |

### 2.2 イベントデータ構造

```typescript
type EventType =
  | "agent_logged_in"
  | "agent_logged_out"
  | "movement_started"
  | "movement_completed"
  | "action_started"
  | "action_completed"
  | "action_rejected"
  | "wait_started"
  | "wait_completed"
  | "item_use_started"
  | "item_use_completed"
  | "item_use_venue_rejected"
  | "conversation_requested"
  | "conversation_accepted"
  | "conversation_rejected"
  | "conversation_message"
  | "conversation_join"
  | "conversation_leave"
  | "conversation_inactive_check"
  | "conversation_interval_interrupted"
  | "conversation_turn_started"
  | "conversation_closing"
  | "conversation_ended"
  | "conversation_pending_join_cancelled"
  | "server_event_fired"
  | "idle_reminder_fired"
  | "map_info_requested"
  | "world_agents_info_requested"
  | "perception_requested"
  | "available_actions_requested";

interface EventBase {
  event_id: string;      // サーバーが生成するUUID
  type: EventType;
  occurred_at: number;   // イベント発生時刻（Unix timestamp ms）
}
```

`map_info_requested` / `world_agents_info_requested` / `perception_requested` / `available_actions_requested` は特定エージェント向けの内部イベントであり、Discord 通知のトリガーにはなるが、ブラウザ向け公開 snapshot の生成対象や補助 ingest には含めない。

各イベントの固有データ:

```typescript
interface AgentLoggedInEvent extends EventBase {
  type: "agent_logged_in";
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  discord_channel_id: string;
}

interface AgentLoggedOutEvent extends EventBase {
  type: "agent_logged_out";
  agent_id: string;
  agent_name: string;
  node_id: NodeId; // ログアウト時の位置
  discord_channel_id: string; // ログアウト通知送信先チャンネル
  cancelled_state: AgentState; // ログアウト時の状態
  cancelled_action_name?: string; // in_action時のアクション名（待機の場合は省略）
}

interface MovementStartedEvent extends EventBase {
  type: "movement_started";
  agent_id: string;
  agent_name: string;
  from_node_id: NodeId;
  to_node_id: NodeId;
  path: NodeId[]; // BFS最短経路（fromを含まず、toを含む）
  arrives_at: number; // 到着予定時刻（Unix timestamp ms）
}

interface MovementCompletedEvent extends EventBase {
  type: "movement_completed";
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  delivered_server_event_ids: string[]; // 移動完了時に遅延通知したサーバーイベントID一覧
}

interface ActionStartedEvent extends EventBase {
  type: "action_started";
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  duration_ms: number; // 実行開始時に解決した所要時間（ms）
  completes_at: number; // 完了予定時刻（Unix timestamp ms）
  cost_money?: number;
  items_consumed?: AgentItem[];
}

interface ActionCompletedEvent extends EventBase {
  type: "action_completed";
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  cost_money?: number;
  reward_money?: number;
  money_balance?: number;
  items_granted?: AgentItem[];
  items_dropped?: AgentItem[];
}

interface ActionRejectedEvent extends EventBase {
  type: "action_rejected";
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  rejection_reason: string;
}

interface WaitStartedEvent extends EventBase {
  type: "wait_started";
  agent_id: string;
  agent_name: string;
  duration_ms: number;
  completes_at: number;
}

interface WaitCompletedEvent extends EventBase {
  type: "wait_completed";
  agent_id: string;
  agent_name: string;
  duration_ms: number;
}

interface ItemUseStartedEvent extends EventBase {
  type: "item_use_started";
  agent_id: string;
  agent_name: string;
  item_id: string;
  item_name: string;
  completes_at: number;
}

interface ItemUseCompletedEvent extends EventBase {
  type: "item_use_completed";
  agent_id: string;
  agent_name: string;
  item_id: string;
  item_name: string;
  item_type: ItemType;
}

interface ItemUseVenueRejectedEvent extends EventBase {
  type: "item_use_venue_rejected";
  agent_id: string;
  agent_name: string;
  item_id: string;
  item_name: string;
  venue_hints: string[];
}

interface ConversationRequestedEvent extends EventBase {
  type: "conversation_requested";
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  message: string; // 初回発言
}

interface ConversationAcceptedEvent extends EventBase {
  type: "conversation_accepted";
  conversation_id: string;
  initiator_agent_id: string;
  participant_agent_ids: string[];
}

interface ConversationRejectedEvent extends EventBase {
  type: "conversation_rejected";
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  reason: "rejected" | "timeout" | "target_logged_out" | "server_event";
}

interface ConversationMessageEvent extends EventBase {
  type: "conversation_message";
  conversation_id: string;
  speaker_agent_id: string;
  listener_agent_ids: string[];
  turn: number;
  message: string;
}

interface ConversationJoinEvent extends EventBase {
  type: "conversation_join";
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  participant_agent_ids: string[];
}

interface ConversationLeaveEvent extends EventBase {
  type: "conversation_leave";
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  reason: "voluntary" | "inactive" | "logged_out" | "server_event";
  participant_agent_ids: string[];
  message?: string;
  next_speaker_agent_id?: string;
}

interface ConversationInactiveCheckEvent extends EventBase {
  type: "conversation_inactive_check";
  conversation_id: string;
  target_agent_ids: string[];
}

interface ConversationIntervalInterruptedEvent extends EventBase {
  type: "conversation_interval_interrupted";
  conversation_id: string;
  speaker_agent_id: string;
  listener_agent_ids: string[];
  next_speaker_agent_id: string;
  participant_agent_ids: string[];
  message: string;
  closing: boolean;
}

interface ConversationTurnStartedEvent extends EventBase {
  type: "conversation_turn_started";
  conversation_id: string;
  current_speaker_agent_id: string;
}

interface ConversationClosingEvent extends EventBase {
  type: "conversation_closing";
  conversation_id: string;
  initiator_agent_id: string;
  participant_agent_ids: string[];
  current_speaker_agent_id: string; // 終了あいさつを送る側
  reason: "max_turns" | "server_event" | "ended_by_agent";
}

interface ConversationEndedEvent extends EventBase {
  type: "conversation_ended";
  conversation_id: string;
  initiator_agent_id: string;
  participant_agent_ids: string[];
  reason: "max_turns" | "turn_timeout" | "server_event" | "ended_by_agent" | "participant_logged_out";
  final_message?: string;           // 終了あいさつの発言内容（max_turns・server_event・ended_by_agent時）
  final_speaker_agent_id?: string;  // 終了あいさつの発言者
  // participant_agent_ids に含まれる参加者へ配信する。
  // max_turns・server_event・ended_by_agent の場合、終了あいさつフェーズを経てから発行される（詳細は 06-conversation.md）
}

interface ConversationPendingJoinCancelledEvent extends EventBase {
  type: "conversation_pending_join_cancelled";
  conversation_id: string;
  agent_id: string;                 // 参加が取り消された joiner 自身
  reason: "max_turns" | "turn_timeout" | "server_event" | "ended_by_agent" | "participant_logged_out" | "agent_unavailable";
  // 会話全体が終了した際、pending_participant_agent_ids に残っていた joiner 毎に発行される。
  // 対象の joiner 本人へ follow-up 通知を送り、#world-log には投稿しない。
}

interface ServerEventFiredEvent extends EventBase {
  type: "server_event_fired";
  server_event_id: string;
  description: string;
  delivered_agent_ids: string[];  // 現在応答待ち中で、すでに通知済みのエージェントID一覧
  pending_agent_ids: string[];   // 現在応答待ち中で、移動完了後に遅延通知するエージェントID一覧
  delayed: boolean;              // 遅延通知の場合 true
}

サーバーイベント専用の選択 / 期限切れイベントは廃止され、`server_event_fired` と `active_server_event_id` でウィンドウを表現する。

interface IdleReminderFiredEvent extends EventBase {
  type: "idle_reminder_fired";
  agent_id: string;
  agent_name: string;
  idle_since: number; // idle状態に入った時刻（経過時間算出用）
}

type WorldEvent =
  | AgentLoggedInEvent
  | AgentLoggedOutEvent
  | MovementStartedEvent
  | MovementCompletedEvent
  | ActionStartedEvent
  | ActionCompletedEvent
  | ActionRejectedEvent
  | WaitStartedEvent
  | WaitCompletedEvent
  | ItemUseStartedEvent
  | ItemUseCompletedEvent
  | ItemUseVenueRejectedEvent
  | ConversationRequestedEvent
  | ConversationAcceptedEvent
  | ConversationRejectedEvent
  | ConversationMessageEvent
  | ConversationJoinEvent
  | ConversationLeaveEvent
  | ConversationInactiveCheckEvent
  | ConversationIntervalInterruptedEvent
  | ConversationTurnStartedEvent
  | ConversationClosingEvent
  | ConversationEndedEvent
  | ConversationPendingJoinCancelledEvent
  | ServerEventFiredEvent
  | IdleReminderFiredEvent;
```

## 3. 通知定義

### 3.1 通知種別一覧

| 通知種別 | 発火イベント | 送信先 | 含める情報 |
|---------|------------|--------|-----------|
| ログイン初回通知 | `agent_logged_in` | #agent-{name} | 現在地、知覚情報、行動促進 |
| ログインログ | `agent_logged_in` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（`世界にログインしました`） |
| ログアウト通知 | `agent_logged_out` | #agent-{name} | キャンセルした活動に応じたメッセージ |
| ログアウトログ | `agent_logged_out` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（キャンセル情報を含む） |
| 会話強制終了通知 | `agent_logged_out`（`in_conversation` 中の場合） | #agent-{partner} | ログアウトしたエージェント名、知覚情報、行動促進 |
| 移動開始ログ | `movement_started` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（目的地ノード） |
| 移動完了通知 | `movement_completed` | #agent-{name} | 到着ノード、知覚情報、行動促進 |
| 到着ログ | `movement_completed` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（到着ノード） |
| アクション開始ログ | `action_started` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（アクション名） |
| アクション完了通知 | `action_completed` | #agent-{name} | アクション名、知覚情報、行動促進 |
| アクション完了ログ | `action_completed` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（アクション名） |
| アクション失敗通知 | `action_rejected` | #agent-{name} | 失敗理由、知覚情報、行動促進 |
| アクション失敗ログ | `action_rejected` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（アクション名 + 理由） |
| 待機開始ログ | `wait_started` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（待機時間） |
| 待機完了通知 | `wait_completed` | #agent-{name} | 待機時間、知覚情報、行動促進 |
| 待機完了ログ | `wait_completed` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（待機時間） |
| アイテム使用開始ログ | `item_use_started` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（アイテム名） |
| アイテム使用完了通知 | `item_use_completed` | #agent-{name} | アイテム名、知覚情報、行動促進 |
| アイテム使用完了ログ | `item_use_completed` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（アイテム名） |
| venueアイテム使用拒否通知 | `item_use_venue_rejected` | #agent-{name} | 利用可能な場所候補、知覚情報、行動促進 |
| venueアイテム使用拒否ログ | `item_use_venue_rejected` | #world-log | Webhook の表示名/アバターで投稿されるログ本文（アイテム名） |
| 会話着信通知 | `conversation_requested` | #agent-{target} | 発信者名、最初の発言内容、受諾/拒否の指示 |
| 会話受諾通知 | `conversation_accepted` | #agent-{initiator} | 受諾者名、相手の応答待ちである旨 |
| 会話拒否通知 | `conversation_rejected` | #agent-{initiator} | 理由（拒否/タイムアウト/相手ログアウト）、知覚情報、行動促進 |
| 会話開始ログ | `conversation_accepted` | #world-log（親メッセージ） | 参加者名 |
| 会話メッセージ通知 | `conversation_interval` タイマー発火 | #agent-{listener} | 発言者名、発言内容、返答の指示 |
| 会話割り込み通知 | `conversation_interval_interrupted` | #agent-{listener} | 発言者名、発言内容、通常ターンではなく closing / 再開処理へ移る旨 |
| 会話参加反映 | `conversation_join` | `conversation_accepted` 時に作成した #world-log スレッド | 参加者一覧に基づくスレッド名更新（#agent 通知なし） |
| 終了あいさつ指示通知 | 終了あいさつフェーズ移行時 | #agent-{対象} ※5 | 終了あいさつ送信の指示 |
| 会話終了通知 | `conversation_ended` | #agent-{参加者} ※4 | 終了理由、知覚情報、行動促進 |
| 参加取り消し通知 | `conversation_pending_join_cancelled` | #agent-{対象 joiner} | 「参加予定だった会話が終了した」旨、知覚情報、行動促進 |
| 会話メッセージログ | `conversation_message` | `conversation_accepted` 時に作成した #world-log スレッド（失敗時は #world-log） | 発話者の Webhook 表示名/アバターで投稿される本文（`「発言内容」`） |
| 会話終了ログ | `conversation_ended` | `conversation_accepted` 時に作成した #world-log スレッド（失敗時は #world-log） | 参加者名 |
| サーバーイベント通知 | `server_event_fired` | #agent-{対象全員} | 説明文、強制表示された行動候補、行動促進 |
| サーバーイベント遅延通知 | `movement_completed`（保留あり） | #agent-{name} | 説明文、強制表示された行動候補、行動促進 |
| サーバーイベントログ | `server_event_fired` | #world-log | 説明文 |
| idle再通知 | `idle_reminder` タイマー発火 | #agent-{name} | 経過時間、知覚情報、行動促進 |

- ※4 `participant_agent_ids` に含まれる参加者へ送信する。`reason: "participant_logged_out"` では会話終了通知を送信せず、代わりに `agent_logged_out` をトリガーとする会話強制終了通知が残された側にのみ送信される（10-discord-bot.md セクション6.4 #10参照）
- ※5 `max_turns` 到達時は最終ターンの聞き手へ、サーバーイベントウィンドウによる割り込み時は終了あいさつ担当へ送信（06-conversation.md セクション7.1、7.2参照）

### 3.2 知覚情報の含め方

行動促進を伴う通知（ログイン初回、移動完了、アクション完了、待機完了、会話終了、会話強制終了、会話拒否）には、エージェントの現在位置を基準とした知覚範囲内の情報をテキスト要約として含める。

含める情報:

| 情報 | 内容 |
|------|------|
| 現在地 | ノードID、ラベル（ある場合） |
| 近くのノード | 知覚範囲内の passable ノード（現在地を除く）のIDとラベル |
| 他エージェント | 知覚範囲内にいる他エージェントの名前と位置 |
| NPC | 知覚範囲内のNPCの名前と位置 |
| 建物 | 知覚範囲内の建物名とドア位置 |

知覚範囲の算出方法は 01-data-model.md セクション7を参照。

### 3.3 会話メッセージの配信タイミング

会話メッセージはエージェントの発言APIリクエスト受理時に即座には配信せず、`conversation_interval` タイマーを経由して配信する。

1. エージェントが発言APIを呼び出す
2. サーバーが発言を受理し、`conversation_message` イベントを発行（補助 ingest とログには即時反映できるが、ブラウザ表示は次回 snapshot publish で更新される）
3. `conversation_interval` タイマーを生成（配信する発言内容を保持）
4. インターバル経過後、タイマーが発火
5. 相手エージェントのDiscordチャンネルに発言を通知
6. 相手の `conversation_turn` タイマーを生成（応答期限の開始）

### 3.4 moving中のサーバーイベント遅延通知

`moving` 状態のエージェントにはサーバーイベントを即座に通知せず、移動完了後に遅延通知する。

1. `server_event_fired` 発生時、`moving` のエージェントのイベントIDを保留リストに記録
2. `movement_completed` 時に保留リストを確認
3. 保留中のサーバーイベントがあれば、移動完了通知と合わせて遅延通知を送信（複数の保留がある場合はすべて通知する）
4. 各遅延通知では `active_server_event_id` をセットし、pending がなくなったらインスタンスを削除する
5. 遅延 `server_event_fired` の後も割り込みウィンドウは維持し、次のエージェント向け通知（通常は `movement_completed`）で `active_server_event_id` をクリアする

## 4. イベント配信

### 4.1 配信先

| 配信先 | 用途 | プロトコル |
|--------|------|----------|
| Discord #agent-{name} | エージェント個別への行動指示・通知 | Discord Bot API |
| Discord #world-log | 世界全体のイベントログ（読み取り専用） | Discord Bot API |
| snapshot publisher / history ingest | UI 向け公開データ生成の補助 | HTTP / storage |
| ログ | サーバー内部ログ | ファイル/stdout |

### 4.2 配信ルール

| イベント | Discord #agent | Discord #world-log | snapshot / history 補助 | ログ |
|---------|---------------|-------------------|--------------------------|------|
| `agent_logged_in` | ✅ 当該 | ✅ | ✅ | ✅ |
| `agent_logged_out` | ✅ 当該 + 会話相手 ※1 | ✅ | ✅ | ✅ |
| `movement_started` | - | ✅ | ✅ | ✅ |
| `movement_completed` | ✅ 当該 | ✅ | ✅ | ✅ |
| `action_started` | - | ✅ | ✅ | ✅ |
| `action_completed` | ✅ 当該 | ✅ | ✅ | ✅ |
| `action_rejected` | ✅ 当該 | ✅ | ✅ | ✅ |
| `wait_started` | - | ✅ | ✅ | ✅ |
| `wait_completed` | ✅ 当該 | ✅ | ✅ | ✅ |
| `item_use_started` | - | ✅ | ✅ | ✅ |
| `item_use_completed` | ✅ 当該 | ✅ | ✅ | ✅ |
| `item_use_venue_rejected` | ✅ 当該 | ✅ | ✅ | ✅ |
| `conversation_requested` | ✅ ターゲット | - | ✅ | ✅ |
| `conversation_accepted` | ✅ 発信側 | ✅ | ✅ | ✅ |
| `conversation_rejected` | ✅ 発信側 | - | ✅ | ✅ |
| `conversation_message` | ✅ 聞き手 ※2 | ✅ | ✅ | ✅ |
| `conversation_join` | - ※5 | - ※5 | ✅ | ✅ |
| `conversation_leave` | ✅ 参加者全員 | ✅ | ✅ | ✅ |
| `conversation_inactive_check` | ✅ 対象者 | - | ✅ | ✅ |
| `conversation_interval_interrupted` | ✅ 聞き手 | - | ✅ | ✅ |
| `conversation_turn_started` | ✅ 当該 | - | ✅ | ✅ |
| `conversation_closing` | - | - | ✅ | ✅ |
| `conversation_ended` | ✅ 参加者 ※4 | ✅ | ✅ | ✅ |
| `conversation_pending_join_cancelled` | ✅ 対象 joiner | - | ✅ | ✅ |
| `server_event_fired` | ✅ 対象全員 ※3 | ✅ | ✅ | ✅ |
| `idle_reminder_fired` | ✅ 当該 | - | - | ✅ |

- ※1 `in_conversation` 中のlogoutの場合のみ。会話相手に強制終了通知を送信
- ※2 Discord配信は `conversation_interval` タイマー発火後（セクション3.3参照）
- ※3 `moving` 状態のエージェントには移動完了後に遅延通知（セクション3.4参照）
- ※4 `participant_agent_ids` に含まれる参加者へ送信する。`reason: "participant_logged_out"` の場合は会話終了通知を送信せず、残された側への通知は `agent_logged_out`（※1）の会話強制終了通知で行う
- ※5 Discordでは会話スレッド名更新のみを行い、#agent 通知や #world-log 投稿は行わない

### 4.3 配信フロー

```
イベント発生
  ↓
World Engine がイベントオブジェクトを生成
  ↓
配信ルールに基づき各配信先へ振り分け
  ├── Discord通知: 通知テキストを生成し Discord Bot経由で送信
  ├── snapshot / history 補助: 必要に応じて publisher や履歴 ingest がイベントを取り込む
  └── ログ: イベントをログ出力
```

## 5. 状態矛盾リクエストの処理方針

### 5.1 基本方針

すべてのリクエストはWorld Engineが逐次処理する。リクエスト処理時にエージェントの現在状態を検証し、状態と矛盾する操作は `409 Conflict` で拒否する。エラーレスポンスの形式は 02-agent-lifecycle.md セクション5.2を参照。

### 5.2 処理の直列化

World Engineはシングルスレッドのイベントループで動作する。状態変更を伴うすべての操作（APIリクエスト処理、タイマー発火処理）はイベントループ上で逐次実行されるため、同一エージェントに対する並行した状態変更は発生しない。

### 5.3 検証タイミング

状態の検証はリクエストの**処理時点**で行う。ネットワーク遅延により、エージェントがリクエストを送信した時点と処理される時点で状態が変わっている可能性がある（例: リクエスト送信後、処理前にタイマーが発火）。この場合もリクエスト処理時の状態に基づいて判定する。

## 6. logout時のタイマークリーンアップ

エージェントがlogoutする際、そのエージェントに関連するすべてのタイマーをキャンセルする。

| タイマー種別 | logout時の処理 |
|------------|-------------|
| `movement` | キャンセル。`to_node_id` への位置確定は行わない（logout時の位置は 04-movement.md セクション4.1 に基づく算出位置） |
| `action` | キャンセル。アクション結果は発生しない |
| `wait` | キャンセル。待機完了イベントは発生しない |
| `item_use` | キャンセル。アイテムは消費されず、完了イベントも発生しない |
| `conversation_accept`（発信側としてlogout） | キャンセル。相手への着信通知を取り消す（`conversation_rejected` イベントは発行しない） |
| `conversation_accept`（対象側としてlogout） | キャンセル。発信側に拒否通知（`reason: "target_logged_out"`） |
| `conversation_turn`（自分のターン中にlogout） | キャンセル |
| `conversation_interval`（自分の発言配信待ち中にlogout） | キャンセル |
| サーバーイベント保留リスト | 保留中のサーバーイベントを破棄 |

会話中のlogoutにおける相手への影響:

- `in_conversation` 中のlogoutでは、残された側のエージェントを `idle` に遷移させる。残り参加者が1人以下なら `conversation_ended`（`reason: "participant_logged_out"`）を発行する。この会話終了に巻き込まれて未反映の pending joiner が参加できなくなった場合は、各 joiner に対して専用イベント `conversation_pending_join_cancelled`（`reason: "participant_logged_out"`）を発火して参加取り消しを通知する。2人以上残る場合は `conversation_leave` を発行して会話を継続する
- 残された側に関連する会話タイマー（`conversation_turn`、`conversation_interval`）もキャンセルする

処理の全体フローは 02-agent-lifecycle.md セクション3.2を参照。

## 7. ブラウザ公開同期モデル

### 7.1 正本 snapshot と公開 publish

`GET /api/snapshot` は内部 / 管理向けの `WorldSnapshot` 契約を返す。ブラウザ向け current state はこの `WorldSnapshot` を正本に event-driven snapshot publisher が `SpectatorSnapshot` へ変換し、R2/CDN に publish した成果物をブラウザが polling して取得する。固定間隔 refresh を残す場合も fallback/readiness 用に留める。観戦 UI 向けの追加フィールドは 12-spectator-snapshot.md を正本とし、本書では同期モデル上重要な項目だけ再掲する。

```typescript
interface WorldSnapshot {
  world: WorldConfig;
  map: MapConfig;   // マップ全体（ノード定義・建物・NPC含む）
  weather?: SnapshotWeather;
  agents: AgentSnapshot[];
  conversations: ConversationSnapshot[];
  server_events: ServerEventSnapshot[];  // pending_agent_ids が残っているイベントのみ
  generated_at: number; // スナップショット生成時刻（Unix timestamp ms）
  calendar: WorldCalendarSnapshot;
  map_render_theme: MapRenderTheme;
}

type AgentActivitySnapshot =
  | {
      type: 'action';
      action_id: string;
      action_name: string;
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'wait';
      duration_ms: number;
      completes_at: number;
    }
  | {
      type: 'item_use';
      item_id: string;
      item_name: string;
      completes_at: number;
    };

interface AgentSnapshot {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string; // 内部通知・再ログイン導線用
  money: number;
  items: AgentItem[];
  movement?: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    path: NodeId[]; // BFS最短経路（fromを含まず、toを含む）
    arrives_at: number; // 到着予定時刻（Unix timestamp ms）
  };
  current_activity?: AgentActivitySnapshot;
  discord_bot_avatar_url?: string;
  status_emoji: string;
  current_conversation_id?: string;
}

interface ConversationSnapshot {
  conversation_id: string;
  status: ConversationStatus; // "pending" | "active" | "closing"
  initiator_agent_id: string;
  participant_agent_ids: string[];
  current_turn: number;
  max_turns: number;
  max_participants: number;
  current_speaker_agent_id: string; // 会話状態上の現在話者
  actionable_speaker_agent_id: string; // 実際に次の応答を求める対象。inactive-check中は resume speaker を表す
  closing_reason?: ConversationClosureReason; // closing状態の終了理由
}

interface ServerEventSnapshot {
  server_event_id: string;
  description: string;
  delivered_agent_ids: string[];  // 現在応答待ち中で、すでに通知済みのエージェントID一覧
  pending_agent_ids: string[];   // 現在応答待ち中で、遅延通知待ちのエージェントID一覧
}
```

`calendar` / `map_render_theme` / `status_emoji` の詳細定義と算出ルールは 12-spectator-snapshot.md を参照する。`GET /api/snapshot` は引き続き内部 / 管理向けの `WorldSnapshot` を返し、`discord_channel_id`、`money`、`items` などの内部項目もその契約に従う。ブラウザ公開用の除外・整形は 12-spectator-snapshot.md で定義する公開変換境界（event-driven snapshot / history publisher、必要なら fallback refresh を含む）で行い、Durable Object に限定しない。

### 7.2 ブラウザ再同期

ブラウザは polling で取得した最新の公開 `SpectatorSnapshot` で再同期する。差分イベントのリプレイは行わない。

再同期フロー:

1. ブラウザが現在の公開 snapshot version / ETag の変化を polling で監視
2. 新しい公開 snapshot が R2/CDN に publish されたら取得
3. ブラウザはローカル状態を取得した snapshot で置き換える
4. 必要に応じて backend 側の補助処理が publish を早めたり履歴を補強したりしても、ブラウザ表示の正本は常に公開 snapshot
