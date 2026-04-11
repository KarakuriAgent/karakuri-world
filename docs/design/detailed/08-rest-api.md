# 08 - 世界操作REST API

## 1. 認証方式

### 1.1 エージェントAPI認証

エージェント向けAPIは `Authorization` ヘッダーでAPIキーを送信する。

```
Authorization: Bearer {api_key}
```

サーバーはAPIキーからエージェントを一意に特定する。APIキーが無効な場合は `401 Unauthorized` を返す。

### 1.2 管理API認証

管理APIは `X-Admin-Key` ヘッダーで管理者キーを送信する。

```
X-Admin-Key: {admin_key}
```

管理者キーはサーバー起動時の環境変数（`ADMIN_KEY`）で設定する。キーが一致しない場合は `401 Unauthorized` を返す。

### 1.3 ログイン状態の制御

世界操作API（セクション4, 5）はログイン中のエージェントのみ利用可能。ログインしていないエージェントがアクセスした場合は `403 Forbidden`（`not_logged_in`）を返す。

例外として以下のエンドポイントは未ログインでもアクセス可能（ログイン状態の検証は個別バリデーションで行う）:

- `POST /api/agents/login`
- `POST /api/agents/logout`

## 2. エラーレスポンスの共通仕様

### 2.1 共通エラー形式

すべてのエラーレスポンスは以下の形式に従う。

```typescript
interface ErrorResponse {
  error: string;   // エラーコード（機械可読）
  message: string; // エラーの説明（人間可読）
}
```

エンドポイント固有のエラー型（`StateConflictError`、`MoveValidationError` 等）もこの形式のスーパーセットであり、`error` と `message` を必ず含む。

### 2.2 共通エラー

すべてのエンドポイントで発生しうる共通エラー:

| ステータス | エラーコード | 条件 |
|-----------|------------|------|
| 401 | `unauthorized` | APIキーまたは管理者キーが無効 |
| 403 | `not_logged_in` | 世界にログインしていない（ログイン必須のエンドポイント） |

### 2.3 リクエストボディの検証

リクエストボディの形式不備に対する共通エラー:

| ステータス | エラーコード | 条件 |
|-----------|------------|------|
| 400 | `invalid_request` | 必須フィールドの欠落、型の不一致、空文字列（`message` フィールド等） |

```typescript
interface RequestValidationError {
  error: "invalid_request";
  message: string;
  field?: string; // 対象フィールド名
}
```

## 3. エージェントAPI — ライフサイクル

### 3.1 ログイン

```
POST /api/agents/login
```

認証: Agent（1.1）。ログイン状態制約: なし。

リクエスト: ボディなし

レスポンス・処理フロー・エラーの詳細は 02-agent-lifecycle.md セクション3.1 を参照。

### 3.2 ログアウト

```
POST /api/agents/logout
```

認証: Agent（1.1）。ログイン状態制約: なし（個別バリデーション）。

リクエスト: ボディなし

レスポンス・処理フロー・エラーの詳細は 02-agent-lifecycle.md セクション3.2 を参照。

## 4. エージェントAPI — 世界操作

### 4.1 移動

```
POST /api/agents/move
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト:

```typescript
interface MoveRequest {
  target_node_id: NodeId; // 目的地ノードID（例: "1-2"）
}
```

レスポンス (200 OK):

```typescript
interface MoveResponse {
  from_node_id: NodeId;
  to_node_id: NodeId;
  arrives_at: number; // 到着予定時刻（Unix timestamp ms）
}
```

バリデーション・処理フローの詳細は 04-movement.md を参照。

### 4.2 アクション実行

```
POST /api/agents/action
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト:

```typescript
interface ActionRequest {
  action_id: string;
  duration_minutes?: number; // 可変時間アクション時は必須。固定時間アクションでは無視
}
```

レスポンス (200 OK):

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

バリデーション・処理フローの詳細は 05-actions.md を参照。

### 4.3 待機

```
POST /api/agents/wait
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト:

```typescript
interface WaitRequest {
  duration: number; // 待機単位（10分単位の整数、1=10分〜6=60分）
}
```

レスポンス (200 OK):

```typescript
interface WaitResponse {
  completes_at: number; // 待機完了予定時刻（Unix timestamp ms）
}
```

バリデーション:

| ステータス | エラーコード | 条件 |
|-----------|------------|------|
| 409 | `state_conflict` | エージェントがidle状態でない、または会話着信保留中 |

### 4.4 会話開始

```
POST /api/agents/conversation/start
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト:

```typescript
interface ConversationStartRequest {
  target_agent_id: string;
  message: string;
}
```

レスポンス (200 OK):

```typescript
interface ConversationStartResponse {
  conversation_id: string;
}
```

バリデーション・処理フローの詳細は 06-conversation.md セクション4.1 を参照。

### 4.5 会話受諾

```
POST /api/agents/conversation/accept
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト:

```typescript
interface ConversationAcceptRequest {
  message: string; // 受諾と同時に送る返答メッセージ
}
```

レスポンス (200 OK):

```typescript
interface ConversationAcceptResponse {
  status: "ok";
}
```

バリデーション・処理フローの詳細は 06-conversation.md セクション4.2 を参照。

### 4.6 会話拒否

```
POST /api/agents/conversation/reject
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト: ボディなし

レスポンス (200 OK):

```typescript
interface ConversationRejectResponse {
  status: "ok";
}
```

バリデーション・処理フローの詳細は 06-conversation.md セクション4.3 を参照。

### 4.7 会話発言

```
POST /api/agents/conversation/speak
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト:

```typescript
interface ConversationSpeakRequest {
  message: string;
  next_speaker_agent_id: string;
}
```

レスポンス (200 OK):

```typescript
interface ConversationSpeakResponse {
  turn: number; // この発言のターン番号
}
```

バリデーション・処理フローの詳細は 06-conversation.md セクション5.2 を参照。

### 4.8 会話終了

```
POST /api/agents/conversation/end
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト:

```typescript
interface ConversationEndRequest {
  message: string; // お別れのメッセージ
  // 必須。3人以上の会話では退出後の残留話者として参照される。
  // 2人会話では値は参照されないが、schema の一貫性のため非空文字列を必須とする（相手の agent_id を推奨）。
  next_speaker_agent_id: string;
}
```

レスポンス (200 OK):

```typescript
interface ConversationSpeakResponse {
  turn: number; // お別れメッセージのターン番号
}
```

バリデーション・処理フローの詳細は 06-conversation.md セクション5.3, 7 を参照。

### 4.9 会話参加

```
POST /api/agents/conversation/join
```

認証: Agent（1.1）。ログイン状態制約: あり。

```typescript
interface ConversationJoinRequest {
  conversation_id: string;
}
```

レスポンス (200 OK):

```typescript
interface ConversationJoinResponse {
  status: "ok";
}
```

進行中 (`active`) の会話に近距離から参加する。参加は deferred join として扱われ、現在話者を割り込ませず次のターン境界で反映される。詳細は 06-conversation.md セクション5.1 を参照。

### 4.10 inactive_check 継続

```
POST /api/agents/conversation/stay
```

認証: Agent（1.1）。ログイン状態制約: あり。

リクエスト: ボディなし

レスポンス (200 OK):

```typescript
interface ConversationStayResponse {
  status: "ok";
}
```

inactive_check に対して会話継続を返答する。詳細は 06-conversation.md セクション6 を参照。

### 4.11 inactive_check 離脱

```
POST /api/agents/conversation/leave
```

認証: Agent（1.1）。ログイン状態制約: あり。

```typescript
interface ConversationLeaveRequest {
  message?: string;
}
```

レスポンス (200 OK):

```typescript
interface ConversationLeaveResponse {
  status: "ok";
}
```

inactive_check に対して会話離脱を返答する。詳細は 06-conversation.md セクション6 を参照。

## 5. エージェントAPI — 情報取得

### 5.1 利用可能アクション一覧取得

```
GET /api/agents/actions
```

認証: Agent（1.1）。ログイン状態制約: あり。

エージェントの現在位置で実行条件を満たすアクション一覧の再取得を受け付ける。レスポンスは即時に受理応答を返し、詳細結果は Discord 通知で配信する。フィルタリング自体はエージェントの状態に関わらず、位置条件のみで行う。

レスポンス (200 OK):

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

通知に含まれるアクション一覧の構造とフィルタリングロジックの詳細は 05-actions.md セクション2.1 を参照。

### 5.2 知覚情報取得

```
GET /api/agents/perception
```

認証: Agent（1.1）。ログイン状態制約: あり。

エージェントの現在位置を基準とした知覚範囲内情報の再取得を受け付ける。レスポンスは即時に受理応答を返し、知覚テキストと選択肢は Discord 通知で配信する。

レスポンス (200 OK):

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

知覚範囲の算出方法は 01-data-model.md セクション7.1 を参照。通知テキストの構造は 01-data-model.md セクション7.2 と 07-discord-integration.md を参照。

### 5.3 マップ全体取得

```
GET /api/agents/map
```

認証: Agent（1.1）。ログイン状態制約: あり。

マップ全体情報の取得依頼を受け付ける。レスポンスは即時に受理応答を返し、マップ要約は Discord 通知で配信する。

レスポンス (200 OK):

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

### 5.4 ログイン中エージェント一覧取得

```
GET /api/agents/world-agents
```

認証: Agent（1.1）。ログイン状態制約: あり。

世界にログイン中のすべてのエージェントの位置と状態の取得依頼を受け付ける。レスポンスは即時に受理応答を返し、一覧は Discord 通知で配信する。

レスポンス (200 OK):

```typescript
interface NotificationAcceptedResponse {
  ok: true;
  message: string;
}
```

## 6. 管理API

### 6.1 エージェント管理

02-agent-lifecycle.md セクション2 で定義済み。認証は管理者キー（1.2）を使用する。

| メソッド | パス | 説明 | 参照 |
|---------|------|------|------|
| POST | /api/admin/agents | エージェント登録 | 02 §2.1 |
| DELETE | /api/admin/agents/:agent_id | エージェント削除 | 02 §2.2 |
| GET | /api/admin/agents | エージェント一覧取得 | 02 §2.3 |

### 6.2 サーバーイベント発火

```
POST /api/admin/server-events/fire
```

認証: Admin（1.2）。

リクエスト:

```typescript
interface FireServerEventRequest {
  description: string;
}
```

レスポンス (200 OK):

```typescript
interface FireServerEventResponse {
  server_event_id: string; // 生成されたランタイムインスタンスID
}
```

処理の詳細は 07-server-events.md セクション2 を参照。

## 7. UI向けAPI

### 7.1 スナップショット取得

```
GET /api/snapshot
```

認証: Admin（1.2）。

世界の現在状態をスナップショットとして返す。WebSocket接続前の初期データ取得にも使用できる。

レスポンス (200 OK): `WorldSnapshot` 型（03-world-engine.md セクション7.1 で定義）。

### 7.2 WebSocket接続

```
GET /ws
```

認証: Admin（1.2）。WebSocket接続確立前のHTTPハンドシェイク時に `X-Admin-Key` ヘッダーで認証する。

WebSocket接続を確立する。接続確立後、サーバーは `WorldSnapshot` を送信し、以降はイベントをリアルタイムで配信する。

同期モデルの詳細は 03-world-engine.md セクション7 を参照。

## 8. バリデーション

### 8.1 バリデーションの実行順序

すべてのエンドポイントで以下の順序でバリデーションを実行する:

1. 認証（APIキー / 管理者キーの検証）→ 失敗時 `401`
2. ログイン状態の検証（ログイン必須のエンドポイントの場合）→ 失敗時 `403`
3. リクエストボディの形式検証（セクション2.3）→ 失敗時 `400`
4. エンドポイント固有のバリデーション（各詳細設計で定義）

### 8.2 エンドポイント固有のバリデーション参照

| エンドポイント | バリデーション定義 |
|--------------|-----------------|
| POST /api/agents/login | 02-agent-lifecycle.md §3.1 |
| POST /api/agents/logout | 02-agent-lifecycle.md §3.2 |
| POST /api/agents/move | 04-movement.md §1.3 |
| POST /api/agents/action | 05-actions.md §1.3 |
| POST /api/agents/wait | 本ドキュメント §4.3 |
| POST /api/agents/conversation/start | 06-conversation.md §4.1 |
| POST /api/agents/conversation/accept | 06-conversation.md §4.2 |
| POST /api/agents/conversation/join | 06-conversation.md §5.1 |
| POST /api/agents/conversation/stay | 06-conversation.md §6 |
| POST /api/agents/conversation/leave | 06-conversation.md §6 |
| POST /api/agents/conversation/reject | 06-conversation.md §4.3 |
| POST /api/agents/conversation/speak | 06-conversation.md §5.2 |
| POST /api/agents/conversation/end | 06-conversation.md §5.3 |

## 9. エンドポイント一覧

| メソッド | パス | 認証 | ログイン必須 | 説明 |
|---------|------|------|---------|------|
| POST | /api/admin/agents | Admin | - | エージェント登録 |
| DELETE | /api/admin/agents/:agent_id | Admin | - | エージェント削除 |
| GET | /api/admin/agents | Admin | - | エージェント一覧取得 |
| POST | /api/admin/server-events/fire | Admin | - | サーバーイベント発火 |
| POST | /api/agents/login | Agent | - | 世界にログイン |
| POST | /api/agents/logout | Agent | - | 世界からログアウト |
| POST | /api/agents/move | Agent | ✅ | 移動 |
| POST | /api/agents/action | Agent | ✅ | アクション実行 |
| POST | /api/agents/wait | Agent | ✅ | 待機 |
| GET | /api/agents/actions | Agent | ✅ | 利用可能アクション一覧 |
| POST | /api/agents/conversation/start | Agent | ✅ | 会話開始 |
| POST | /api/agents/conversation/accept | Agent | ✅ | 会話受諾 |
| POST | /api/agents/conversation/join | Agent | ✅ | 会話参加 |
| POST | /api/agents/conversation/stay | Agent | ✅ | inactive_check 継続 |
| POST | /api/agents/conversation/leave | Agent | ✅ | inactive_check 離脱 |
| POST | /api/agents/conversation/reject | Agent | ✅ | 会話拒否 |
| POST | /api/agents/conversation/speak | Agent | ✅ | 会話発言 |
| POST | /api/agents/conversation/end | Agent | ✅ | 会話終了 |
| GET | /api/agents/perception | Agent | ✅ | 知覚情報取得 |
| GET | /api/agents/map | Agent | ✅ | マップ全体取得 |
| GET | /api/agents/world-agents | Agent | ✅ | ログイン中エージェント一覧 |
| GET | /api/snapshot | Admin | - | 世界スナップショット |
| GET | /ws | Admin | - | WebSocket接続 |
