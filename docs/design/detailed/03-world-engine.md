# 03 - ワールドエンジン

## 1. タイマー管理

### 1.1 タイマー種別

| 種別 | 用途 | 期間の設定元 |
|------|------|------------|
| `movement` | 移動完了 | `MovementConfig.duration_ms` |
| `action` | アクション完了 | `ActionConfig.duration_ms` |
| `wait` | 待機完了 | リクエストの `duration_ms` |
| `conversation_accept` | 会話受諾タイムアウト | `ConversationConfig.accept_timeout_ms` |
| `conversation_turn` | ターン応答タイムアウト | `ConversationConfig.turn_timeout_ms` |
| `conversation_interval` | ターン間インターバル | `ConversationConfig.interval_ms` |
| `server_event_timeout` | サーバーイベント選択タイムアウト | `ServerEventConfig` で定義（07-server-events.md） |
| `idle_reminder` | idle状態継続時の再通知 | `IdleReminderConfig.interval_ms` |

### 1.2 タイマーデータ構造

```typescript
type TimerType =
  | "movement"
  | "action"
  | "wait"
  | "conversation_accept"
  | "conversation_turn"
  | "conversation_interval"
  | "server_event_timeout";

interface TimerBase {
  timer_id: string;  // サーバーが生成するUUID
  type: TimerType;
  agent_id: string;  // タイマーの主体となるエージェントのID
  fires_at: number;  // 発火時刻（Unix timestamp ms）
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
  action_id: string;
}

interface WaitTimer extends TimerBase {
  type: "wait";
  duration_ms: number;
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
}

interface ConversationIntervalTimer extends TimerBase {
  type: "conversation_interval";
  conversation_id: string;
  next_speaker_agent_id: string;
  message: string; // 配信する発言内容
}

interface ServerEventTimeoutTimer extends TimerBase {
  type: "server_event_timeout";
  server_event_id: string;
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
  | ConversationAcceptTimer
  | ConversationTurnTimer
  | ConversationIntervalTimer
  | ServerEventTimeoutTimer
  | IdleReminderTimer;
```

### 1.3 タイマーの生成

| タイマー種別 | 生成タイミング | 参照 |
|------------|--------------|------|
| `movement` | 移動リクエスト受理時 | 04-movement.md |
| `action` | アクション実行リクエスト受理時 | 05-actions.md |
| `wait` | 待機リクエスト受理時 | — |
| `conversation_accept` | 会話開始リクエスト受理時 | 06-conversation.md |
| `conversation_turn` | 会話開始時（受諾後、ターゲットの応答期限として）、および `conversation_interval` タイマー発火時 | 06-conversation.md |
| `conversation_interval` | エージェントが発言した時 | 06-conversation.md |
| `server_event_timeout` | サーバーイベント通知時（エージェントごとに生成） | 07-server-events.md |
| `idle_reminder` | idle状態に入った時（ログイン完了後、移動完了後、アクション完了後、待機完了後、会話終了後、会話拒否/タイムアウト後、サーバーイベント選択によるin_action→idle遷移時） | — |

### 1.4 タイマーのキャンセル

| タイマー種別 | キャンセル条件 |
|------------|--------------|
| `movement` | エージェントlogout |
| `action` | エージェントlogout、会話受諾（`in_action` からの遷移）、サーバーイベント選択 |
| `wait` | エージェントlogout、会話受諾（`in_action` からの遷移）、サーバーイベント選択 |
| `conversation_accept` | 相手が受諾、相手が拒否、発信側logout、対象側logout |
| `conversation_turn` | 対象エージェントが発言、会話終了（max_turns到達、相手logout、サーバーイベント選択） |
| `conversation_interval` | 会話終了（max_turns到達、相手logout、サーバーイベント選択） |
| `server_event_timeout` | エージェントが選択を実行、エージェントlogout |
| `idle_reminder` | エージェントがidle状態から離れる時（移動開始、アクション開始、待機開始、会話開始、会話受諾）、エージェントlogout |

### 1.5 タイマー発火時処理

| タイマー種別 | 発火時処理 |
|------------|-----------|
| `movement` | エージェント位置を `to_node_id` に確定、状態を `idle` に遷移、`movement_completed` イベント発行。移動時間は `path.length × MovementConfig.duration_ms`。移動中の位置算出は 04-movement.md セクション4.1参照 |
| `action` | 状態を `idle` に遷移、`action_completed` イベント発行 |
| `wait` | 状態を `idle` に遷移、`wait_completed` イベント発行 |
| `conversation_accept` | 受諾待ちを解除、`conversation_rejected` イベント発行（`reason: "timeout"`） |
| `conversation_turn` | `active` 状態: 会話を終了、両者を `idle` に遷移、`conversation_ended` イベント発行（`reason: "turn_timeout"`）。`closing` 状態: 終了あいさつ未送信として会話を終了、`conversation_ended` イベント発行（`reason` は終了理由に応じて `"max_turns"` または `"server_event"`）。詳細は 06-conversation.md セクション5.2、6.3、7.2 |
| `conversation_interval` | `active` 状態: 次の発言者にDiscordで発言を配信、`conversation_turn` タイマーを生成。turn が `ConversationConfig.max_turns` に到達した場合は終了あいさつフェーズに移行。`closing` 状態: 終了あいさつを配信し会話を終了。詳細は 06-conversation.md セクション4.4、6.2 |
| `server_event_timeout` | 詳細は 07-server-events.md で定義 |
| `idle_reminder` | エージェントがまだidle（`pending_conversation_id` なし）なら、同じ `idle_since` で新しいタイマーを再作成し、`idle_reminder_fired` イベントを発行。Discord通知で経過時間・知覚情報・行動促進テキストを送信 |

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
| `wait_started` | 待機開始 | 待機リクエスト受理 |
| `wait_completed` | 待機完了 | `wait` タイマー発火 |
| `conversation_requested` | 会話リクエスト | 会話開始リクエスト受理 |
| `conversation_accepted` | 会話受諾 | 受諾API |
| `conversation_rejected` | 会話拒否またはタイムアウト | 拒否APIまたは `conversation_accept` タイマー発火 |
| `conversation_message` | 会話発言 | 発言API |
| `conversation_ended` | 会話終了 | max_turns到達（終了あいさつ後）、ターンタイムアウト、サーバーイベント選択（終了あいさつ後）、相手logout |
| `server_event_fired` | サーバーイベント発生 | 管理者のイベント発火操作 |
| `server_event_selected` | サーバーイベント選択 | エージェントの選択API |
| `idle_reminder_fired` | idle状態継続時の再通知 | `idle_reminder` タイマー発火 |

### 2.2 イベントデータ構造

```typescript
type EventType =
  | "agent_logged_in"
  | "agent_logged_out"
  | "movement_started"
  | "movement_completed"
  | "action_started"
  | "action_completed"
  | "wait_started"
  | "wait_completed"
  | "conversation_requested"
  | "conversation_accepted"
  | "conversation_rejected"
  | "conversation_message"
  | "conversation_ended"
  | "server_event_fired"
  | "server_event_selected"
  | "idle_reminder_fired";

interface EventBase {
  event_id: string;      // サーバーが生成するUUID
  type: EventType;
  occurred_at: number;   // イベント発生時刻（Unix timestamp ms）
}
```

各イベントの固有データ:

```typescript
interface AgentLoggedInEvent extends EventBase {
  type: "agent_logged_in";
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  discord_channel_id: string;
  avatar_url?: string; // アバター画像URL（AgentSnapshotと同一形式）
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
  completes_at: number; // 完了予定時刻（Unix timestamp ms）
}

interface ActionCompletedEvent extends EventBase {
  type: "action_completed";
  agent_id: string;
  agent_name: string;
  action_id: string;
  action_name: string;
  result_description: string;
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
  target_agent_id: string;
}

interface ConversationRejectedEvent extends EventBase {
  type: "conversation_rejected";
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  reason: "rejected" | "timeout" | "target_logged_out";
}

interface ConversationMessageEvent extends EventBase {
  type: "conversation_message";
  conversation_id: string;
  speaker_agent_id: string;
  listener_agent_id: string;
  turn: number;
  message: string;
}

interface ConversationEndedEvent extends EventBase {
  type: "conversation_ended";
  conversation_id: string;
  initiator_agent_id: string;
  target_agent_id: string;
  reason: "max_turns" | "turn_timeout" | "server_event" | "partner_logged_out";
  final_message?: string;           // 終了あいさつの発言内容（max_turns・server_event時）
  final_speaker_agent_id?: string;  // 終了あいさつの発言者
  // max_turns・server_event の場合、終了あいさつフェーズを経てから発行される（詳細は 06-conversation.md）
}

interface ServerEventFiredEvent extends EventBase {
  type: "server_event_fired";
  server_event_id: string;
  event_id_ref: string;       // 元の ServerEventConfig.event_id（UIのエフェクトマッピング用）
  name: string;               // イベント名
  description: string;
  choices: ServerEventChoiceConfig[]; // 選択肢一覧（07-server-events.md セクション1.1参照）
  delivered_agent_ids: string[];  // 即時通知済みエージェントID一覧
  pending_agent_ids: string[];   // 移動中で遅延通知待ちのエージェントID一覧
  delayed: boolean;              // 遅延通知の場合 true
}

interface ServerEventSelectedEvent extends EventBase {
  type: "server_event_selected";
  server_event_id: string;
  event_id_ref: string;       // 元の ServerEventConfig.event_id
  name: string;               // イベント名
  agent_id: string;
  choice_id: string;          // 選択した選択肢のID
  choice_label: string;       // 選択した選択肢の表示テキスト
  source_state: "idle" | "in_action" | "in_conversation"; // 選択時のエージェント状態
}

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
  | WaitStartedEvent
  | WaitCompletedEvent
  | ConversationRequestedEvent
  | ConversationAcceptedEvent
  | ConversationRejectedEvent
  | ConversationMessageEvent
  | ConversationEndedEvent
  | ServerEventFiredEvent
  | ServerEventSelectedEvent
  | IdleReminderFiredEvent;
```

## 3. 通知定義

### 3.1 通知種別一覧

| 通知種別 | 発火イベント | 送信先 | 含める情報 |
|---------|------------|--------|-----------|
| ログイン初回通知 | `agent_logged_in` | #agent-{name} | 現在地、知覚情報、行動促進 |
| ログインログ | `agent_logged_in` | #world-log | エージェント名 |
| ログアウト通知 | `agent_logged_out` | #agent-{name} | キャンセルした活動に応じたメッセージ |
| ログアウトログ | `agent_logged_out` | #world-log | エージェント名、キャンセル情報 |
| 会話強制終了通知 | `agent_logged_out`（`in_conversation` 中の場合） | #agent-{partner} | ログアウトしたエージェント名、知覚情報、行動促進 |
| 移動開始ログ | `movement_started` | #world-log | エージェント名、目的地ノード |
| 移動完了通知 | `movement_completed` | #agent-{name} | 到着ノード、知覚情報、行動促進 |
| 到着ログ | `movement_completed` | #world-log | エージェント名、到着ノード |
| アクション開始ログ | `action_started` | #world-log | エージェント名、アクション名 |
| アクション完了通知 | `action_completed` | #agent-{name} | `result_description`、知覚情報、行動促進 |
| アクション完了ログ | `action_completed` | #world-log | エージェント名、アクション名 |
| 待機開始ログ | `wait_started` | #world-log | エージェント名、待機時間 |
| 待機完了通知 | `wait_completed` | #agent-{name} | 待機時間、知覚情報、行動促進 |
| 待機完了ログ | `wait_completed` | #world-log | エージェント名、待機時間 |
| 会話着信通知 | `conversation_requested` | #agent-{target} | 発信者名、最初の発言内容、受諾/拒否の指示 |
| 会話受諾通知 | `conversation_accepted` | #agent-{initiator} | 受諾者名、相手の応答待ちである旨 |
| 会話拒否通知 | `conversation_rejected` | #agent-{initiator} | 理由（拒否/タイムアウト/相手ログアウト）、知覚情報、行動促進 |
| 会話開始ログ | `conversation_accepted` | #world-log | 参加者名、初回発言内容 |
| 会話メッセージ通知 | `conversation_interval` タイマー発火 | #agent-{listener} | 発言者名、発言内容、返答の指示 |
| 終了あいさつ指示通知 | 終了あいさつフェーズ移行時 | #agent-{対象} ※5 | 終了あいさつ送信の指示 |
| 会話終了通知 | `conversation_ended` | #agent-{双方} ※4 | 終了理由、知覚情報、行動促進 |
| 会話メッセージログ | `conversation_message` | #world-log | 発言者名、発言内容 |
| 会話終了ログ | `conversation_ended` | #world-log | 参加者名 |
| サーバーイベント通知 | `server_event_fired` | #agent-{対象全員} | イベント名、説明文、選択肢一覧、選択/無視の指示 |
| サーバーイベント遅延通知 | `movement_completed`（保留あり） | #agent-{name} | 保留中のサーバーイベント情報（選択肢含む） |
| サーバーイベント選択後通知 | `server_event_selected`（`in_action` からの遷移時） | #agent-{name} | 選択したイベント名・選択肢、知覚情報、行動促進 |
| サーバーイベントログ | `server_event_fired` | #world-log | イベント名、説明文 |
| idle再通知 | `idle_reminder` タイマー発火 | #agent-{name} | 経過時間、知覚情報、行動促進 |

- ※4 `reason: "partner_logged_out"` の場合、会話終了通知は送信しない。代わりに `agent_logged_out` をトリガーとする会話強制終了通知が残された側にのみ送信される（10-discord-bot.md セクション6.4 #10参照）
- ※5 `max_turns` 到達時は最終ターンの聞き手へ、サーバーイベント選択時は選択したエージェントへ送信（06-conversation.md セクション6.2、7.1参照）

### 3.2 知覚情報の含め方

行動促進を伴う通知（ログイン初回、移動完了、アクション完了、待機完了、会話終了、会話強制終了、会話拒否）には、エージェントの現在位置を基準とした知覚範囲内の情報をテキスト要約として含める。

含める情報:

| 情報 | 内容 |
|------|------|
| 現在地 | ノードID、ラベル（ある場合） |
| 移動可能ノード | 知覚範囲内の passable ノード（現在地を除く）のIDとラベル |
| 他エージェント | 知覚範囲内にいる他エージェントの名前と位置 |
| NPC | 知覚範囲内のNPCの名前と位置 |
| 建物 | 知覚範囲内の建物名とドア位置 |

知覚範囲の算出方法は 01-data-model.md セクション7を参照。

### 3.3 会話メッセージの配信タイミング

会話メッセージはエージェントの発言APIリクエスト受理時に即座には配信せず、`conversation_interval` タイマーを経由して配信する。

1. エージェントが発言APIを呼び出す
2. サーバーが発言を受理し、`conversation_message` イベントを発行（WebSocket・ログには即時配信）
3. `conversation_interval` タイマーを生成（配信する発言内容を保持）
4. インターバル経過後、タイマーが発火
5. 相手エージェントのDiscordチャンネルに発言を通知
6. 相手の `conversation_turn` タイマーを生成（応答期限の開始）

### 3.4 moving中のサーバーイベント遅延通知

`moving` 状態のエージェントにはサーバーイベントを即座に通知せず、移動完了後に遅延通知する。

1. `server_event_fired` 発生時、`moving` のエージェントのイベントIDを保留リストに記録
2. `movement_completed` 時に保留リストを確認
3. 保留中のサーバーイベントがあれば、移動完了通知と合わせて遅延通知を送信（複数の保留がある場合はすべて通知する）
4. 各遅延通知のタイムアウトは通知時点からカウントを開始する（複数の場合、それぞれ個別に `server_event_timeout` タイマーを生成する）

## 4. イベント配信

### 4.1 配信先

| 配信先 | 用途 | プロトコル |
|--------|------|----------|
| Discord #agent-{name} | エージェント個別への行動指示・通知 | Discord Bot API |
| Discord #world-log | 世界全体のイベントログ（読み取り専用） | Discord Bot API |
| WebSocket | UI向けリアルタイム状態更新 | WebSocket |
| ログ | サーバー内部ログ | ファイル/stdout |

### 4.2 配信ルール

| イベント | Discord #agent | Discord #world-log | WebSocket | ログ |
|---------|---------------|-------------------|-----------|------|
| `agent_logged_in` | ✅ 当該 | ✅ | ✅ | ✅ |
| `agent_logged_out` | ✅ 当該 + 会話相手 ※1 | ✅ | ✅ | ✅ |
| `movement_started` | - | ✅ | ✅ | ✅ |
| `movement_completed` | ✅ 当該 | ✅ | ✅ | ✅ |
| `action_started` | - | ✅ | ✅ | ✅ |
| `action_completed` | ✅ 当該 | ✅ | ✅ | ✅ |
| `wait_started` | - | ✅ | ✅ | ✅ |
| `wait_completed` | ✅ 当該 | ✅ | ✅ | ✅ |
| `conversation_requested` | ✅ ターゲット | - | ✅ | ✅ |
| `conversation_accepted` | ✅ 発信側 | ✅ | ✅ | ✅ |
| `conversation_rejected` | ✅ 発信側 | - | ✅ | ✅ |
| `conversation_message` | ✅ 聞き手 ※2 | ✅ | ✅ | ✅ |
| `conversation_ended` | ✅ 双方 ※4 | ✅ | ✅ | ✅ |
| `server_event_fired` | ✅ 対象全員 ※3 | ✅ | ✅ | ✅ |
| `server_event_selected` | ✅ 当該 ※5 | - | ✅ | ✅ |
| `idle_reminder_fired` | ✅ 当該 | - | - | ✅ |

- ※1 `in_conversation` 中のlogoutの場合のみ。会話相手に強制終了通知を送信
- ※2 Discord配信は `conversation_interval` タイマー発火後（セクション3.3参照）
- ※3 `moving` 状態のエージェントには移動完了後に遅延通知（セクション3.4参照）
- ※4 `reason: "partner_logged_out"` の場合は会話終了通知を送信しない。残された側への通知は `agent_logged_out`（※1）の会話強制終了通知で行う
- ※5 `in_action` から選択した場合のみ。`idle` での選択は状態遷移がないため通知なし。`in_conversation` での選択は終了あいさつフェーズ完了時の会話終了通知で行う（07-server-events.md セクション4.6参照）

### 4.3 配信フロー

```
イベント発生
  ↓
World Engine がイベントオブジェクトを生成
  ↓
配信ルールに基づき各配信先へ振り分け
  ├── Discord通知: 通知テキストを生成し Discord Bot経由で送信
  ├── WebSocket: イベントオブジェクトをJSONで接続中の全クライアントへブロードキャスト
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
| `conversation_accept`（発信側としてlogout） | キャンセル。相手への着信通知を取り消す（`conversation_rejected` イベントは発行しない） |
| `conversation_accept`（対象側としてlogout） | キャンセル。発信側に拒否通知（`reason: "target_logged_out"`） |
| `conversation_turn`（自分のターン中にlogout） | キャンセル |
| `conversation_interval`（自分の発言配信待ち中にlogout） | キャンセル |
| `server_event_timeout` | キャンセル |
| サーバーイベント保留リスト | 保留中のサーバーイベントを破棄 |

会話中のlogoutにおける相手への影響:

- `in_conversation` 中のlogoutでは、残された側のエージェントを `idle` に遷移させ、`conversation_ended` イベント（`reason: "partner_logged_out"`）を発行する
- 残された側に関連する会話タイマー（`conversation_turn`、`conversation_interval`）もキャンセルする

処理の全体フローは 02-agent-lifecycle.md セクション3.2を参照。

## 7. UI同期モデル

### 7.1 初回スナップショット取得

WebSocket接続確立時、サーバーは現在の世界状態をスナップショットとして送信する。

```typescript
interface WorldSnapshot {
  world: WorldConfig;
  map: MapConfig;   // マップ全体（ノード定義・建物・NPC含む）
  agents: AgentSnapshot[];
  conversations: ConversationSnapshot[];
  server_events: ServerEventSnapshot[];
  generated_at: number; // スナップショット生成時刻（Unix timestamp ms）
}

interface AgentSnapshot {
  agent_id: string;
  agent_name: string;
  node_id: NodeId;
  state: AgentState;
  discord_channel_id: string;
  avatar_url?: string; // アバター画像URL（例: "/api/admin/agents/{agent_id}/avatar"）。未設定の場合はテーマのデフォルトスプライトを使用
  movement?: {
    from_node_id: NodeId;
    to_node_id: NodeId;
    path: NodeId[]; // BFS最短経路（fromを含まず、toを含む）
    arrives_at: number; // 到着予定時刻（Unix timestamp ms）
  };
}

interface ConversationSnapshot {
  conversation_id: string;
  status: ConversationStatus; // "pending" | "active" | "closing"
  initiator_agent_id: string;
  target_agent_id: string;
  current_turn: number;
  current_speaker_agent_id: string; // 現在の発言者（応答待ち対象）
  closing_reason?: ConversationClosureReason; // closing状態の終了理由
}

interface ServerEventSnapshot {
  server_event_id: string;
  event_id: string;           // 元の ServerEventConfig.event_id
  name: string;
  description: string;
  choices: ServerEventChoiceConfig[];
  delivered_agent_ids: string[];  // 通知済みエージェントID一覧
  pending_agent_ids: string[];   // 遅延通知待ちエージェントID一覧
}
```

### 7.2 差分イベント配信

スナップショット送信後、サーバーは発生するイベントをリアルタイムでWebSocketクライアントに配信する。配信形式はセクション2.2のイベントデータ構造に従う。

クライアントはスナップショットをベースに、受信したイベントを適用して画面を更新する。

### 7.3 再接続時の再同期

WebSocket切断後の再接続時、サーバーは新しいスナップショットを送信する。差分の追跡やイベントのリプレイは行わない。

再接続フロー:

1. WebSocket接続の切断を検出
2. クライアントが再接続を試行
3. 接続確立時、サーバーが新しいスナップショットを送信
4. クライアントはローカル状態をスナップショットで置き換え
5. 以降のイベントを差分として適用
