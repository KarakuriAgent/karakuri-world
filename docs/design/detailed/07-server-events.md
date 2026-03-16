# 07 - サーバーイベント

## 1. サーバーイベントの定義構造

### 1.1 設定データ構造

```typescript
interface ServerEventConfig {
  event_id: string;     // 一意なイベントID（ServerConfig.server_events 内で一意）
  name: string;         // イベント名（例: "嵐の接近"）
  description: string;  // イベントの説明文（例: "暗い雲が広がり、強い風が吹き始めました"）
  choices: ServerEventChoiceConfig[]; // 選択肢一覧（1つ以上）
  timeout_ms: number;   // 選択期限（ミリ秒）
}

interface ServerEventChoiceConfig {
  choice_id: string;    // 選択肢ID（同一 ServerEventConfig 内で一意）
  label: string;        // 選択肢の表示テキスト（例: "避難する"）
  description: string;  // 選択肢の説明
}
```

### 1.2 制約

- `event_id` は `ServerConfig.server_events` 内で一意
- `choices` は1つ以上
- `choice_id` は同一 `ServerEventConfig` 内で一意
- `timeout_ms` は1以上

## 2. イベント通知のフロー

### 2.1 発火処理

管理者がサーバーイベントの発火を指示すると（管理APIは 08-rest-api.md で定義）、以下の処理を実行する:

1. ランタイムインスタンスを生成（セクション2.1.1参照）
2. `server_event_fired` イベントを発行（03-world-engine.md セクション2.2参照）
3. 世界にログイン中のすべてのエージェントに対し、状態に応じた配信処理を実行（セクション2.2参照）

同一の `ServerEventConfig` を複数回発火できる。各発火は独立した `server_event_id` を持つ。

#### 2.1.1 ランタイムインスタンス

発火ごとにランタイムインスタンスを生成し、イベント終了まで保持する。選択バリデーション（セクション4.2）や遅延通知のタイマー生成（セクション3.2）で参照する。

```typescript
interface ServerEventInstance {
  server_event_id: string;  // サーバーが生成するUUID
  event_id: string;         // 元の ServerEventConfig.event_id
  fired_at: number;         // 発火時刻（Unix timestamp ms）
}
```

### 2.2 状態ごとの配信ルール

| エージェント状態 | 処理 |
|----------------|------|
| `idle`（受諾待ち含む） | 即時通知、`server_event_timeout` タイマー生成 |
| `in_action` | 即時通知、`server_event_timeout` タイマー生成 |
| `in_conversation`（`active` / `closing` 共通） | 即時通知、`server_event_timeout` タイマー生成 |
| `moving` | 保留リストに記録（セクション3参照） |

`in_conversation` が `closing` 状態の場合も通知は送信される。`closing` 中のエージェントは選択できないが（セクション4.2 バリデーション #2）、会話終了後に `idle` に戻った時点でタイムアウト前であれば選択可能。

`server_event_timeout` タイマーの生成（03-world-engine.md セクション1.2参照）:

- `fires_at = 現在時刻 + ServerEventConfig.timeout_ms`
- `server_event_id` = 発火されたイベントのランタイムID
- `agent_id` = 対象エージェントのID

複数のサーバーイベントが同時に発火している場合、エージェントはそれぞれに対して独立した `server_event_timeout` タイマーを持つ。

### 2.3 通知内容

Discord #agent-{name} に以下を含める:

- イベント名
- 説明文
- 選択肢一覧（各選択肢の `label` と `description`）
- 選択または無視の指示

## 3. moving中の遅延通知

### 3.1 保留リストの管理

`moving` 状態のエージェントにはサーバーイベントを即時通知せず、保留リストに記録する（03-world-engine.md セクション3.4参照）。保留リストはエージェントごとに管理され、`server_event_id` を記録する。

### 3.2 遅延通知の配信

`movement` タイマー発火時（04-movement.md セクション3.1参照）に保留リストを確認し、保留中のサーバーイベントがあればすべて遅延通知する。

各遅延通知について:

1. 通知内容はセクション2.3と同一
2. `server_event_timeout` タイマーを通知時点から生成（`fires_at = 通知時刻 + ServerEventConfig.timeout_ms`）

複数のサーバーイベントが保留されている場合、それぞれ個別に通知し、個別にタイマーを生成する。

### 3.3 保留リストのクリーンアップ

- 移動完了時: 保留リストの内容を遅延通知した後、リストをクリアする
- エージェントlogout時: 保留リストを破棄する（03-world-engine.md セクション6参照）

## 4. 選択

### 4.1 選択リクエスト

```typescript
interface ServerEventSelectRequest {
  server_event_id: string;
  choice_id: string;
}
```

### 4.2 バリデーションルール

以下の順序で検証し、最初に失敗した時点でエラーを返す。

| # | 検証内容 | エラー |
|---|---------|--------|
| 1 | エージェントが `idle`、`in_action`、`in_conversation` のいずれかであること | `409 Conflict` (`state_conflict`) |
| 2 | `in_conversation` の場合、会話が `closing` 状態でないこと（06-conversation.md セクション7.3参照） | `400 Bad Request` (`conversation_closing`) |
| 3 | 当該エージェントの `server_event_timeout` タイマーが存在すること（通知済みかつ未選択かつ未タイムアウト） | `400 Bad Request` (`event_not_found`) |
| 4 | `choice_id` が対象サーバーイベントの `choices` に存在すること | `400 Bad Request` (`invalid_choice`) |

バリデーション #1 の形式は 02-agent-lifecycle.md セクション5.2 の `StateConflictError` に従う。

バリデーション #2, #3, #4 のエラー形式:

```typescript
interface ServerEventSelectError {
  error: "conversation_closing" | "event_not_found" | "invalid_choice";
  message: string;
}
```

### 4.3 idle での選択処理

1. `server_event_timeout` タイマーをキャンセル
2. `server_event_selected` イベントを発行（03-world-engine.md セクション2.2参照）

状態遷移なし。Discord通知なし。受諾待ち中（02-agent-lifecycle.md セクション4.4参照）のエージェントが選択した場合も同様であり、受諾待ちは継続する。

```typescript
interface ServerEventSelectResponse {
  status: "ok";
}
```

### 4.4 in_action での選択処理

1. `server_event_timeout` タイマーをキャンセル
2. `action` タイマーおよび `wait` タイマーをキャンセル（アクション結果・待機完了は発生しない。05-actions.md セクション5.3参照）
3. 状態を `idle` に遷移
4. `server_event_selected` イベントを発行
5. エージェントのDiscordチャンネルに通知（セクション4.6参照）

```typescript
interface ServerEventSelectResponse {
  status: "ok";
}
```

### 4.5 in_conversation での選択処理

1. `server_event_timeout` タイマーをキャンセル
2. `server_event_selected` イベントを発行
3. 会話の終了あいさつフェーズに移行（06-conversation.md セクション7.1参照）

選択直後は `in_conversation` のまま。終了あいさつフェーズ完了後に `idle` に遷移し、会話終了通知が送信される（06-conversation.md セクション7.1参照）。

```typescript
interface ServerEventSelectResponse {
  status: "ok";
}
```

### 4.6 in_action からの遷移時の通知

`in_action` でサーバーイベントを選択し `idle` に遷移した場合、エージェントのDiscordチャンネル（#agent-{name}）に以下を含む通知を送信する:

- 選択したイベント名と選択肢
- 知覚範囲内の情報（03-world-engine.md セクション3.2参照）
- 行動促進

`idle` での選択は状態遷移がないため追加通知なし。`in_conversation` での選択は終了あいさつフェーズ完了時の会話終了通知（03-world-engine.md セクション3.1参照）で知覚情報・行動促進が含まれるため追加通知なし。

### 4.7 シーケンス

#### idle での選択

```
[サーバーイベント発火]
  Engine: server_event_id 生成
  Engine: server_event_fired イベント発行
  Engine: エージェントに通知 + server_event_timeout タイマー生成

Agent → API: POST /api/agents/server-event/select { server_event_id, choice_id }
  API: バリデーション
  API: server_event_timeout タイマーキャンセル
  API: server_event_selected イベント発行
API → Agent: 200 OK { status: "ok" }
```

#### in_action での選択

```
[サーバーイベント発火]
  Engine: server_event_id 生成
  Engine: server_event_fired イベント発行
  Engine: エージェントに通知 + server_event_timeout タイマー生成

Agent → API: POST /api/agents/server-event/select { server_event_id, choice_id }
  API: バリデーション
  API: server_event_timeout タイマーキャンセル
  API: action タイマーキャンセル
  API: 状態を idle に遷移
  API: server_event_selected イベント発行
  API: Discordに通知（知覚情報、行動促進）
API → Agent: 200 OK { status: "ok" }
```

#### in_conversation での選択

```
[サーバーイベント発火]
  Engine: server_event_id 生成
  Engine: server_event_fired イベント発行
  Engine: エージェントに通知 + server_event_timeout タイマー生成

Agent → API: POST /api/agents/server-event/select { server_event_id, choice_id }
  API: バリデーション
  API: server_event_timeout タイマーキャンセル
  API: server_event_selected イベント発行
  API: 会話の終了あいさつフェーズに移行（06-conversation.md セクション7.1）
API → Agent: 200 OK { status: "ok" }

  ... 終了あいさつフロー（06-conversation.md セクション7.1-7.2） ...
```

## 5. 選択期限とタイムアウト

### 5.1 タイムアウト発火時処理

`server_event_timeout` タイマーが発火した場合（エージェントが期限内に選択しなかった場合）:

- タイマーを削除する
- 状態遷移は発生しない
- イベントは発行しない

エージェントは当該サーバーイベントに対する選択機会を失い、現在の行動を継続する。

## 6. 無視時の処理

「無視」は明示的なAPI操作ではなく、選択期限内に選択しないことを意味する。`server_event_timeout` タイマーが発火し、セクション5.1の処理が実行される。

エージェントがサーバーイベントの通知を受けた後、選択せずに他の行動（移動開始、アクション開始等）を行った場合でも、`server_event_timeout` タイマーは独立して継続する。タイムアウト前であれば、他の行動後でも選択APIを呼び出すことが可能（バリデーションを満たす場合に限る）。
