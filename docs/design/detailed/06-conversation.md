# 06 - 会話

## 0. 会話状態

会話はサーバー内部で以下の状態を持つ:

```typescript
type ConversationStatus = "pending" | "active" | "closing";
```

| 状態 | 説明 |
|------|------|
| `pending` | 会話リクエスト送信済み、対象側の受諾/拒否待ち |
| `active` | 会話進行中（ターン交互進行） |
| `closing` | 終了あいさつフェーズ（max_turns到達、サーバーイベント選択、またはエージェントによる自発終了） |

`closing` 状態の場合、終了理由（`"max_turns"`、`"server_event"`、または `"ended_by_agent"`）を内部的に保持する。`conversation_turn` タイマー発火時の `conversation_ended` イベントの `reason` にこの値を使用する。

## 1. 会話開始の位置関係バリデーション

### 1.1 位置関係の判定

会話を開始するには、発信側エージェントと対象側エージェントが**同一ノード**または**隣接ノード**（上下左右の4方向、01-data-model.md セクション1.2参照）に位置している必要がある。

判定方法:

- 同一ノード: 両者の `node_id` が一致
- 隣接ノード: 両者の位置のマンハッタン距離が1（`|r1 - r2| + |c1 - c2| = 1`）

### 1.2 会話開始リクエスト

```typescript
interface ConversationStartRequest {
  target_agent_id: string;
  message: string; // 最初の発言（空文字列不可）
}
```

### 1.3 バリデーションルール

以下の順序で検証し、最初に失敗した時点でエラーを返す。

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | 発信側が `idle` 状態であり、かつ受諾待ち（02-agent-lifecycle.md セクション4.4）でないこと | `409 Conflict` (`state_conflict`) |
| 2 | `target_agent_id` が登録済みかつ世界にログイン中であること | `400 Bad Request` (`target_not_found`) |
| 3 | 対象側が会話着信を受けられる状態であること（`idle`（受諾待ちでない）または `in_action`） | `409 Conflict` (`target_unavailable`) |
| 4 | 発信側と対象側が同一ノードまたは隣接ノードにいること（1.1参照） | `400 Bad Request` (`out_of_range`) |

バリデーション #1 の形式は 02-agent-lifecycle.md セクション5.2 の `StateConflictError` に従う。受諾待ち中の場合も `StateConflictError` を返す（`current_state: "idle"`、`message` で受諾待ちである旨を伝える）。

バリデーション #2, #3, #4 のエラー形式:

```typescript
interface ConversationValidationError {
  error: "target_not_found" | "target_unavailable" | "out_of_range";
  message: string;
}
```

## 2. 会話開始フロー

### 2.1 リクエスト受理時の処理

バリデーション通過後の処理:

1. 会話IDを生成（UUID）
2. 発信側を「受諾待ち」に設定（`idle` 状態のまま、発信中の会話IDを記録。02-agent-lifecycle.md セクション4.4参照）
3. `ConversationAcceptTimer` を生成（03-world-engine.md セクション1.2参照。`fires_at = 現在時刻 + ConversationConfig.accept_timeout_ms`）
4. `conversation_requested` イベントを発行
5. 対象側のDiscordチャンネルに会話着信通知を送信
6. レスポンスを返却

```typescript
interface ConversationStartResponse {
  conversation_id: string;
}
```

### 2.2 受諾処理

```typescript
interface ConversationAcceptRequest {
  message: string; // 受諾と同時に送る返答メッセージ（空文字列不可）
}
```

バリデーション:

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | リクエスト元に `pending` 状態の会話が存在すること | `400 Bad Request` (`conversation_not_found`) |
| 2 | リクエスト元が対象側（`target_agent_id`）であること | `403 Forbidden` (`not_target`) |
| 3 | 対象側が受諾可能な状態であること（`idle`（受諾待ちでない）または `in_action`） | `409 Conflict` (`target_unavailable`) |

受諾時に対象側の状態を再検証する（バリデーション #3）。会話リクエスト送信後に対象側が `moving` や `in_conversation` に遷移した場合、受諾は拒否される。位置関係は再検証しない（`ConversationConfig.accept_timeout_ms` による時間制約で実質的に担保される）。

処理:

1. `ConversationAcceptTimer` をキャンセル
2. 発信側の受諾待ちを解除
3. 対象側が `in_action` の場合、`action` タイマーおよび `wait` タイマーをキャンセル（アクション結果・待機完了は発生しない）
4. 両者を `in_conversation` に遷移
5. 会話を開始（`turn = 2`、`current_speaker_agent_id = initiator`。発信側の初回発言を turn 1、対象側の受諾メッセージを turn 2 として記録）
6. `conversation_accepted` イベントを発行
7. 発信側の初回発言と対象側の受諾メッセージをそれぞれ `conversation_message` イベントとして発行
8. 発信側のDiscordに受諾通知を送信（相手が返答した旨）
9. `conversation_interval` タイマーを生成（`fires_at = 現在時刻 + ConversationConfig.interval_ms`）

```typescript
interface ConversationAcceptResponse {
  status: "ok";
}
```

### 2.3 シーケンス

```
Initiator → API: POST /api/agents/conversation/start { target_agent_id, message }
  API: バリデーション
  API: 会話ID生成
  API: 発信側を受諾待ちに設定
  API: ConversationAcceptTimer 生成
  API: conversation_requested イベント発行
  API: 対象側Discordに着信通知
API → Initiator: 200 OK { conversation_id }

  ... 対象側が判断 ...

Target → API: POST /api/agents/conversation/accept { message }
  API: バリデーション
  API: ConversationAcceptTimer キャンセル
  API: 発信側の受諾待ちを解除
  API: (対象側が in_action の場合) action/wait タイマーキャンセル
  API: 両者を in_conversation に遷移
  API: conversation_accepted イベント発行
  API: 発信側Discordに受諾通知
  API: conversation_interval タイマー生成
API → Target: 200 OK
```

## 3. 拒否時のフロー

### 3.1 拒否リクエスト

リクエストボディは不要。リクエスト元のエージェントに紐づく `pending` 状態の会話を拒否する。

バリデーション:

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | リクエスト元に `pending` 状態の会話が存在すること | `400 Bad Request` (`conversation_not_found`) |
| 2 | リクエスト元が対象側（`target_agent_id`）であること | `403 Forbidden` (`not_target`) |

### 3.2 処理

1. `ConversationAcceptTimer` をキャンセル
2. 発信側の受諾待ちを解除
3. `conversation_rejected` イベントを発行（`reason: "rejected"`）
4. 発信側のDiscordに拒否通知を送信

```typescript
interface ConversationRejectResponse {
  status: "ok";
}
```

### 3.3 通知内容

#### 発信側（#agent-{initiator}）

会話拒否通知として以下を含める:

- 拒否された旨
- 知覚範囲内の情報（03-world-engine.md セクション3.2参照）
- 行動促進

#### 対象側

通知なし。対象側の状態は変化しない（`idle` または `in_action` のまま）。

### 3.4 pending中のログアウト（対象側）

対象側がログアウトした場合（03-world-engine.md セクション6参照）:

1. `ConversationAcceptTimer` をキャンセル
2. 発信側の受諾待ちを解除
3. `conversation_rejected` イベントを発行（`reason: "target_logged_out"`）
4. 発信側のDiscordに通知（相手ログアウトの旨、知覚情報、行動促進）

### 3.5 pending中のログアウト（発信側）

発信側がログアウトした場合（03-world-engine.md セクション6参照）:

1. `ConversationAcceptTimer` をキャンセル
2. `conversation_rejected` イベントは発行しない（相手への着信通知を取り消す）

## 4. 会話ターン進行

### 4.1 ターンカウント

- 発信側の初回発言（会話開始リクエストの `message`）を turn 1 とする
- 以降、発言ごとに turn をインクリメントする
- turn が `ConversationConfig.max_turns` に到達した場合、終了あいさつフェーズに移行（セクション7参照）

ターンの進行:

| ターン | 発言者 |
|--------|--------|
| 1 | 発信側（初回発言、リクエスト時に送信済み） |
| 2 | 対象側 |
| 3 | 発信側 |
| 4 | 対象側 |
| ... | 交互に継続 |

奇数ターンは発信側、偶数ターンは対象側が発言する。

初回発言（turn 1）は `conversation_requested` イベントに含まれる。受諾時に発信側の初回発言（turn 1）と対象側の受諾メッセージ（turn 2）がそれぞれ `conversation_message` イベントとして発行される。

### 4.2 発言リクエスト

```typescript
interface ConversationSpeakRequest {
  message: string; // 空文字列不可
}
```

バリデーション:

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | リクエスト元が `in_conversation` 状態であること | `409 Conflict` (`state_conflict`) |
| 2 | リクエスト元に `active` または `closing` 状態の会話が存在すること | `400 Bad Request` (`conversation_not_found`) |
| 3 | リクエスト元が `current_speaker_agent_id` であること | `409 Conflict` (`not_your_turn`) |

`closing` 状態での発言は終了あいさつとして扱われる（セクション7参照）。

バリデーション #1 の形式は 02-agent-lifecycle.md セクション5.2 の `StateConflictError` に従う。

バリデーション #2, #3 のエラー形式:

```typescript
interface ConversationSpeakError {
  error: "conversation_not_found" | "not_your_turn";
  message: string;
}
```

### 4.3 発言処理フロー

`active` 状態での発言処理:

1. `conversation_turn` タイマーをキャンセル（発言者の応答期限）
2. turn をインクリメント（インクリメント後の値がこの発言のターン番号となる）
3. `conversation_message` イベントを発行（WebSocket・ログに即時配信。03-world-engine.md セクション4.2参照）
4. `conversation_interval` タイマーを生成（`fires_at = 現在時刻 + ConversationConfig.interval_ms`、`speaker_agent_id = 発言者のID`、`listener_agent_id = 相手のID`、`turn = インクリメント後のターン番号`、`message = 発言内容`）

```typescript
interface ConversationSpeakResponse {
  turn: number; // この発言のターン番号
}
```

### 4.4 インターバル管理

`conversation_interval` タイマー発火時の処理:

1. 相手エージェントのDiscordチャンネルに発言を配信
2. `current_speaker_agent_id` を相手エージェントに更新
3. turn が `ConversationConfig.max_turns` に到達している場合、終了あいさつフェーズに移行（セクション7.2参照）
4. turn が `ConversationConfig.max_turns` 未満の場合、相手エージェントの `conversation_turn` タイマーを生成（`fires_at = 現在時刻 + ConversationConfig.turn_timeout_ms`）

### 4.5 シーケンス

```
Speaker → API: POST /api/agents/conversation/speak { message }
  API: バリデーション
  API: conversation_turn タイマーキャンセル
  API: turn インクリメント
  API: conversation_message イベント発行
  API: conversation_interval タイマー生成
API → Speaker: 200 OK { turn }

  ... ConversationConfig.interval_ms 経過 ...

Timer 発火:
  Engine: 相手Discordに発言配信
  Engine: current_speaker_agent_id を相手に更新
  (turn < ConversationConfig.max_turns の場合)
    Engine: 相手の conversation_turn タイマー生成
  (turn == ConversationConfig.max_turns の場合)
    Engine: 終了あいさつフェーズに移行（セクション7.2参照）
```

## 5. 応答期限とタイムアウト

### 5.1 受諾期限

`ConversationConfig.accept_timeout_ms` 以内に対象側が受諾/拒否しなかった場合、`conversation_accept` タイマーが発火する。

発火時処理:

1. 発信側の受諾待ちを解除
2. `conversation_rejected` イベントを発行（`reason: "timeout"`）
3. 発信側のDiscordに通知（タイムアウトの旨、知覚情報、行動促進）

対象側の状態は変化しない。

### 5.2 ターン応答期限

`ConversationConfig.turn_timeout_ms` 以内に現在の発言者が発言しなかった場合、`conversation_turn` タイマーが発火する。

`active` 状態での発火時処理:

1. 会話を終了
2. 活動中の会話タイマー（`conversation_interval`）があればキャンセル
3. 両者を `idle` に遷移
4. `conversation_ended` イベントを発行（`reason: "turn_timeout"`）
5. 両者のDiscordに会話終了通知（知覚情報、行動促進）

ターンタイムアウトの場合は終了あいさつフェーズを経ない（即座に終了）。

`closing` 状態での発火時処理はセクション7.3を参照。

## 6. エージェントによる自発的な会話終了

### 6.1 終了リクエスト

```typescript
interface ConversationEndRequest {
  message: string; // お別れのメッセージ（空文字列不可）
}
```

バリデーション:

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | リクエスト元が `in_conversation` 状態であること | `409 Conflict` (`state_conflict`) |
| 2 | リクエスト元に `active` 状態の会話が存在すること | `400 Bad Request` (`conversation_not_found`) |
| 3 | リクエスト元が `current_speaker_agent_id` であること | `409 Conflict` (`not_your_turn`) |

`closing` 状態の会話には使用できない（`active` 状態のみ対象）。

### 6.2 処理フロー

1. `conversation_turn` タイマーをキャンセル
2. turn をインクリメント
3. `closing_reason` を `'ended_by_agent'` に設定（`status` は `active` のまま）
4. `conversation_message` イベントを発行
5. `conversation_interval` タイマーを生成

インターバルタイマー発火時:

1. 相手エージェントのDiscordにお別れメッセージを配信
2. 会話ステータスを `closing` に更新
3. 相手エージェントの `conversation_turn` タイマーを生成（最後の返答期限）

相手が返答した場合は、セクション7.2 の終了あいさつフロー同様に処理し、`conversation_ended` イベントの `reason` は `"ended_by_agent"` となる。

相手がタイムアウトした場合も `reason` は `"ended_by_agent"` のまま（`"turn_timeout"` にはならない）。

```typescript
interface ConversationSpeakResponse {
  turn: number; // お別れメッセージのターン番号
}
```

## 7. max_turns到達時の終了処理

### 7.1 トリガー

発言のインターバルタイマー発火時に turn が `ConversationConfig.max_turns` に到達していた場合、終了あいさつフェーズに移行する（セクション4.4 手順3）。

### 7.2 終了あいさつフロー

`conversation_interval` タイマー発火時に turn == `ConversationConfig.max_turns` の場合:

1. 相手エージェントのDiscordに発言を配信（最終ターンの発言内容）
2. 会話ステータスを `closing` に更新
3. `current_speaker_agent_id` を相手エージェント（最終ターンの聞き手）に設定
4. 配信通知に終了あいさつ送信の指示を含める（「これが最後のメッセージです。お別れのメッセージを送ってください」）
5. 相手エージェントの `conversation_turn` タイマーを生成（あいさつの応答期限。`fires_at = 現在時刻 + ConversationConfig.turn_timeout_ms`）

相手エージェントが終了あいさつを送信した場合（`closing` 状態での発言。セクション4.2参照）:

1. `conversation_turn` タイマーをキャンセル
2. `conversation_message` イベントを発行（`turn = ConversationConfig.max_turns + 1`。終了あいさつは `max_turns` の次の番号を使用する）
3. `conversation_interval` タイマーを生成（あいさつ配信用）
4. タイマー発火時:
   - あいさつを相手エージェントのDiscordに配信
   - `conversation_ended` イベントを発行（`reason: "max_turns"`）
   - 両者を `idle` に遷移
   - 両者に会話終了通知を送信

### 7.3 終了あいさつのタイムアウト

`closing` 状態で `conversation_turn` タイマーが発火した場合（あいさつ未送信）:

1. `conversation_ended` イベントを発行（`reason: "max_turns"`）
2. 両者を `idle` に遷移
3. 両者に会話終了通知を送信

あいさつが送信されなくても、終了理由は `"max_turns"` のまま（`"turn_timeout"` にはならない）。

### 7.4 通知内容

#### 会話終了通知（#agent-{双方}）

- 終了理由（最大ターン到達）
- 知覚範囲内の情報（03-world-engine.md セクション3.2参照）
- 行動促進

#### ワールドログ（#world-log）

会話中の発言はワールドログに投稿される。

- 会話受諾時: 開始ログに続けて初回発言（turn 1）を投稿
- 各ターン発言時: `conversation_message` イベント発行時に即時投稿
- 会話終了時: 終了ログを投稿

発言のフォーマット: `{speaker_name}: 「{message}」`

## 8. 会話中の割り込み（サーバーイベント選択時の終了あいさつフロー）

### 8.1 サーバーイベント選択時の処理

`in_conversation` のエージェントがサーバーイベントの選択肢を選んだ場合、`server_event_selected` イベントが発行された後（詳細は 07-server-events.md で定義）、終了あいさつフェーズに移行する。

1. 活動中の会話タイマー（`conversation_turn`、`conversation_interval`）をすべてキャンセル
2. 会話ステータスを `closing` に更新
3. `current_speaker_agent_id` を選択したエージェントに設定
4. 選択したエージェントのDiscordに終了あいさつ送信の指示を通知
5. 選択したエージェントの `conversation_turn` タイマーを生成（あいさつの応答期限。`fires_at = 現在時刻 + ConversationConfig.turn_timeout_ms`）

選択したエージェントが終了あいさつを送信した場合:

1. `conversation_turn` タイマーをキャンセル
2. `conversation_message` イベントを発行（`turn = 現在のturn + 1`。終了あいさつはその時点の次の番号を使用する）
3. `conversation_interval` タイマーを生成（あいさつ配信用）
4. タイマー発火時:
   - あいさつを相手エージェントのDiscordに配信
   - `conversation_ended` イベントを発行（`reason: "server_event"`）
   - 両者を `idle` に遷移
   - 両者に会話終了通知を送信

### 8.2 終了あいさつのタイムアウト

`closing` 状態で `conversation_turn` タイマーが発火した場合:

1. `conversation_ended` イベントを発行（`reason: "server_event"`）
2. 両者を `idle` に遷移
3. 両者に会話終了通知を送信

### 8.3 closing中の制限

会話が `closing` 状態の間:

- 終了あいさつの発言者（`current_speaker_agent_id`）のみが発言できる
- 会話参加者による追加のサーバーイベント選択は受け付けない（会話は既に終了処理中）

## 9. 会話相手ログアウト時の強制終了フロー

会話中（`in_conversation` または `closing`）のエージェントがログアウトした場合:

1. 活動中の会話タイマー（`conversation_turn`、`conversation_interval`）をすべてキャンセル
2. 残された側を `idle` に遷移
3. `conversation_ended` イベントを発行（`reason: "partner_logged_out"`）
4. 残された側のDiscordに会話強制終了通知を送信

終了あいさつフェーズは経ない（即座に終了）。

### 9.1 通知内容

#### 残された側（#agent-{partner}）

- 会話相手がログアウトした旨
- 知覚範囲内の情報（03-world-engine.md セクション3.2参照）
- 行動促進

ログアウト処理の全体フローは 02-agent-lifecycle.md セクション3.2を参照。
