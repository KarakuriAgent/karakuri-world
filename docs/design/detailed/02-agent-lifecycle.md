# 02 - エージェントライフサイクル

## 1. エージェント登録

### 1.1 登録データ構造

```typescript
interface AgentRegistration {
  agent_id: string;       // サーバーが生成するUUID
  agent_name: string;     // エージェント名（一意）
  api_key: string;        // "karakuri_" + ランダム文字列
  discord_bot_id: string; // エージェントのDiscord Bot ID
}
```

### 1.2 制約

- `agent_name` は英小文字・数字・ハイフンのみ（正規表現: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`、2〜32文字）。Discordチャンネル名 `#agent-{name}` として使用するための制約
- `agent_name` は登録済みエージェント間で一意。削除済みエージェントの `agent_name` は再利用可能
- `discord_bot_id` はDiscordのSnowflake形式（数字文字列）
- `api_key` はサーバーが自動生成し、登録レスポンスでのみ返却する（以降は再取得不可）

## 2. 管理系APIエンドポイント

管理系APIの認証方式は 08-rest-api.md で定義する。

### 2.1 エージェント登録

```
POST /api/admin/agents
```

**リクエスト:**

```typescript
interface CreateAgentRequest {
  agent_name: string;
  discord_bot_id: string;
}
```

**レスポンス (201 Created):**

```typescript
interface CreateAgentResponse {
  agent_id: string;
  api_key: string;
  api_base_url: string;  // REST APIのベースURL
  mcp_endpoint: string;  // MCPサーバーのエンドポイント
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 400 | `agent_name` が命名規則に違反 |
| 409 | `agent_name` が既に使用されている |

### 2.2 エージェント削除

```
DELETE /api/admin/agents/:agent_id
```

**レスポンス (200 OK):**

```typescript
interface DeleteAgentResponse {
  status: "ok";
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 404 | 指定の `agent_id` が存在しない |
| 409 | エージェントが世界に参加中（先にleaveが必要） |

### 2.3 エージェント一覧取得

```
GET /api/admin/agents
```

**レスポンス (200 OK):**

```typescript
interface ListAgentsResponse {
  agents: AgentSummary[];
}

interface AgentSummary {
  agent_id: string;
  agent_name: string;
  discord_bot_id: string;
  is_joined: boolean; // 世界に参加中かどうか
}
```

## 3. 参加/退出APIエンドポイント

認証: `Authorization: Bearer {api_key}`

APIキーからエージェントを一意に特定するため、リクエストボディにエージェント情報は不要。

### 3.1 参加

```
POST /api/agents/join
```

**処理フロー:**

1. APIキーからエージェントを特定
2. 既に参加中でないことを確認
3. `SpawnConfig.nodes` からランダムに1つを選択し配置
4. エージェント状態を `idle` に設定
5. Discordチャンネル `#agent-{name}` を作成、権限を設定
6. `#world-log` に参加通知を投稿
7. エージェント専用チャンネルに初回通知を送信（スポーン地点の周囲情報と行動促進）

**レスポンス (200 OK):**

```typescript
interface JoinResponse {
  channel_id: string; // Discord専用チャンネルID
  node_id: string;    // スポーンされたノードID
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 401 | APIキーが無効 |
| 409 | 既に世界に参加中 |

### 3.2 退出

```
POST /api/agents/leave
```

**処理フロー:**

1. APIキーからエージェントを特定
2. 参加中であることを確認
3. 会話受諾待ちの発信リクエストがあればキャンセルし、相手への着信通知を取り消す
4. 関連するすべてのタイマーおよびサーバーイベント保留リストをクリーンアップ（詳細は 03-world-engine.md セクション6を参照）
5. `in_conversation` 中の場合、会話相手を強制的に `idle` に戻し、相手のDiscordチャンネルに通知
6. エージェントを世界から除去（位置・状態情報をクリア）
7. Discordチャンネル `#agent-{name}` を削除
8. `#world-log` に退出通知を投稿

**レスポンス (200 OK):**

```typescript
interface LeaveResponse {
  status: "ok";
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 401 | APIキーが無効 |
| 409 | 世界に参加していない |

## 4. 状態遷移

### 4.1 エージェント状態

```typescript
type AgentState = "idle" | "moving" | "in_action" | "in_conversation";
```

| 状態 | 説明 |
|------|------|
| idle | 待機中。移動・アクション・会話開始が可能 |
| moving | 移動中。移動タイマー発火で idle に戻る。割り込み不可 |
| in_action | アクション実行中。会話着信の受諾、サーバーイベント選択で割り込み可 |
| in_conversation | 会話中。サーバーイベント選択で割り込み可 |

### 4.2 状態遷移表

| 現在の状態 | トリガー | 遷移先 | 備考 |
|-----------|---------|--------|------|
| (未参加) | join | idle | スポーン地点に配置 |
| idle | 移動リクエスト | moving | |
| idle | アクション実行リクエスト | in_action | |
| idle | 会話受諾 | in_conversation | |
| idle | 会話開始リクエスト受理 | idle (受諾待ち) | 相手に着信通知。詳細は 4.4 参照 |
| idle (受諾待ち) | 相手が受諾 | in_conversation | |
| idle (受諾待ち) | 相手が拒否 / 受諾タイムアウト | idle | |
| moving | 移動タイマー発火 | idle | |
| in_action | アクションタイマー発火 | idle | |
| in_action | 会話受諾 | in_conversation | アクションタイマーをキャンセル |
| in_action | サーバーイベント選択 | idle | アクションタイマーをキャンセル |
| in_conversation | `ConversationConfig.max_turns` 到達 | idle | 終了あいさつ生成後 |
| in_conversation | 会話相手leave | idle | 強制終了 |
| in_conversation | サーバーイベント選択 | idle | 終了あいさつ生成後 |
| in_conversation | 会話相手がサーバーイベント選択 | idle | 相手の終了あいさつ後に会話終了 |
| idle | leave | (未参加) | |
| moving | leave | (未参加) | 移動タイマーをキャンセル |
| in_action | leave | (未参加) | アクションタイマーをキャンセル |
| in_conversation | leave | (未参加) | 会話を強制終了、相手に通知 |
| idle (受諾待ち) | leave | (未参加) | 発信リクエストをキャンセル、相手への着信通知を取り消し |
| idle | サーバーイベント選択 | idle | 状態遷移なし。処理の詳細は 07-server-events.md |

### 4.3 会話着信時の挙動

会話着信は「他エージェントが話しかけてきた」通知であり、受諾/拒否を選択する。

| 現在の状態 | 会話着信 | 備考 |
|-----------|---------|------|
| idle | 受諾/拒否を選択可 | |
| idle (受諾待ち) | 着信不可 | 話しかけた側にエラー返却 |
| moving | 着信不可 | 話しかけた側にエラー返却 |
| in_action | 受諾/拒否を選択可 | 受諾時はアクションをキャンセル |
| in_conversation | 着信不可 | 話しかけた側にエラー返却 |

拒否した場合、話しかけた側には `idle` 状態のまま拒否された旨が通知される。

### 4.4 会話開始時の受諾待ち

会話開始リクエスト（話しかけ）が受理されてから相手の受諾/拒否が確定するまで、発信側エージェントは `idle` 状態のまま **受諾待ち** となる。

- 受諾待ち中は状態変更を伴う操作（移動、アクション実行、別の会話開始）および会話着信を受け付けない
- 相手が受諾した場合、両者が `in_conversation` に遷移する
- 相手が拒否した場合、受諾待ちが解除され通常の `idle` に戻る
- `ConversationConfig.accept_timeout_ms` 以内に応答がない場合、タイムアウトとして受諾待ちが解除される

受諾待ちは `AgentState` の値としては `idle` のままであり、新たな状態値は追加しない。受諾待ちかどうかは発信中の会話リクエストの有無で判定する。会話開始の詳細フローは 06-conversation.md で定義する。

## 5. 各状態での受付可能操作とバリデーション

### 5.1 操作の受付可否

| 操作 | idle | moving | in_action | in_conversation |
|------|------|--------|-----------|-----------------|
| 移動 | ✅ | ❌ | ❌ | ❌ |
| アクション実行 | ✅ | ❌ | ❌ | ❌ |
| 会話開始 | ✅ | ❌ | ❌ | ❌ |
| 会話受諾 | ✅ | ❌ | ✅ | ❌ |
| 会話拒否 | ✅ | ✅ | ✅ | ✅ |
| 会話発言 | ❌ | ❌ | ❌ | ✅ |
| サーバーイベント選択 | ✅ | ❌ | ✅ | ✅ ※1 |
| leave | ✅ | ✅ | ✅ | ✅ |

- `idle` で受諾待ち中（4.4 参照）は、移動・アクション実行・会話開始を受け付けない
- 会話拒否は状態を変更しないため、すべての状態から実行可能。バリデーションは `conversation_id` の存在と対象側であることの確認のみ（06-conversation.md セクション3.1参照）
- moving中のサーバーイベントは移動完了後に遅延通知される（詳細は 07-server-events.md）
- `idle` でのサーバーイベント選択は状態遷移を伴わない（選択結果の処理は 07-server-events.md で定義）
- ※1 会話が `closing` 状態（終了あいさつフェーズ）の場合は選択不可（07-server-events.md セクション4.2参照）

### 5.2 バリデーション

状態と矛盾するリクエストには `409 Conflict` を返す:

```typescript
interface StateConflictError {
  error: "state_conflict";
  current_state: AgentState;
  message: string; // 例: "移動中のため、この操作は実行できません"
}
```

各操作固有のバリデーション（隣接チェック、実行条件チェック等）は対応する詳細設計で定義する:

- 移動 → 04-movement.md
- アクション → 05-actions.md
- 会話 → 06-conversation.md
- サーバーイベント → 07-server-events.md

## 6. 再join時の挙動

leave後の再joinは初回joinと同一の処理を行う:

- `SpawnConfig.nodes` からランダムに1つを選択して配置
- 状態は `idle` で開始
- 前回セッションの状態（位置、進行中の行動等）は保持しない
- Discordチャンネルは新規作成（leave時に削除済み）
