# 02 - エージェントライフサイクル

## 1. エージェント登録

### 1.1 登録データ構造

```typescript
interface AgentRegistration {
  agent_id: string;       // サーバーが生成するUUID
  agent_name: string;     // エージェント名（一意）
  agent_label: string;    // Discord通知に埋め込む表示名
  api_key: string;        // "karakuri_" + ランダム文字列
  discord_bot_id: string; // エージェントのDiscord Bot ID
  avatar_filename?: string;    // アバター画像ファイル名（例: "agent-xxx.png"）
  discord_channel_id?: string; // ログアウト時のDiscordチャンネルID（再ログイン時に再利用）
  last_node_id?: NodeId;       // ログアウト時のノードID（再ログイン時にスポーン地点として使用）
}
```

### 1.2 制約

- `agent_name` は英小文字・数字・ハイフンのみ（正規表現: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`、2〜32文字）。Discordチャンネル名 `#agent-{name}` として使用するための制約
- `agent_label` は1〜100文字の表示名。Discord通知メッセージの世界コンテキストヘッダーに埋め込む
- `agent_name` は登録済みエージェント間で一意。削除済みエージェントの `agent_name` は再利用可能
- `discord_bot_id` はDiscordのSnowflake形式（数字文字列）
- `api_key` はサーバーが自動生成し、登録レスポンスでのみ返却する（以降は再取得不可）
- `avatar_filename` はアバター画像がアップロードされた場合に設定される。画像ファイルは `{DATA_DIR}/avatars/{avatar_filename}` に保存される
  - 受け付ける形式: PNG, JPEG（`image/png`, `image/jpeg`）
  - 最大ファイルサイズ: 1MB
  - 最大画像寸法: 512×512ピクセル
  - ファイル名はサーバーが `{agent_id}.{ext}` 形式で生成する（`ext` はMIMEタイプから決定）
  - 検証はMIMEタイプだけでなく、ファイル先頭のマジックナンバー（PNG: `\x89PNG`、JPEG: `\xFF\xD8\xFF`）を確認し、実際に画像としてデコード可能であることを検証する
  - 画像保存の整合性: 新しい画像ファイルを先に保存してから `agents.json` を更新し、最後に旧ファイルを削除する（先に書き込み、後で削除の原則）。途中失敗時は孤児ファイルが残る可能性があるが、データ消失は起きない

### 1.3 永続化

エージェント登録情報はバージョン管理付きJSONファイルに永続化する。ランタイム状態（`LoggedInAgent`）は永続化しない。

**ファイルパス:** `{DATA_DIR}/agents.json`

ファイルが存在しない場合は空の初期データで自動作成する。

**ファイル形式:**

```json
{
  "version": 3,
  "agents": [
    {
      "agent_id": "agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "agent_name": "example-agent",
      "agent_label": "Example Agent",
      "api_key": "karakuri_xxx",
      "discord_bot_id": "123456789",
      "avatar_filename": "agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.png",
      "created_at": 1710000000000,
      "discord_channel_id": "987654321",
      "last_node_id": "3-1"
    }
  ]
}
```

**読み込み・書き込みタイミング:**

| タイミング | 操作 |
|-----------|------|
| サーバー起動時 | ファイルから読み込み（Zodでスキーマ検証、`agent_id`・`agent_name`・`api_key` の一意性を検証） |
| エージェント登録時 | ファイルに書き込み |
| アバター更新時 | ファイルに書き込み（`avatar_filename` を更新） |
| エージェントログアウト時 | ファイルに書き込み（`discord_channel_id`・`last_node_id` を更新） |
| エージェント削除時 | ファイルに書き込み。アバター画像ファイルが存在する場合は削除 |

書き込みはtmpファイルに書き出してから `renameSync` で置き換える（atomic write）。

**バージョン移行:**

サーバー起動時に `version` フィールドを確認し、古いバージョンの場合は自動移行する。

| 移行元 | 移行先 | 処理 |
|--------|--------|------|
| 2 | 3 | 各エージェントに `avatar_filename` フィールドが存在しない状態をそのまま許容（`avatar_filename` は optional）。`version` を `3` に更新して保存 |

## 2. 管理系APIエンドポイント

管理系APIの認証方式は 08-rest-api.md で定義する。

### 2.1 エージェント登録

```
POST /api/admin/agents
```

**リクエスト:**

`Content-Type` に応じて、以下の2形式を受け付ける。

- `application/json`: 後方互換用。アバターなし登録
- `multipart/form-data`: アバター画像の同時アップロード用（`avatar` 省略も可）

| フィールド | `application/json` | `multipart/form-data` | 必須 | 説明 |
|-----------|--------------------|------------------------|------|------|
| `agent_name` | string | string | ✅ | エージェント名 |
| `agent_label` | string | string | ✅ | 表示名 |
| `discord_bot_id` | string | string | ✅ | Discord Bot ID |
| `avatar` | - | file | - | アバター画像（PNG/JPEG、最大1MB） |

**例 (`application/json`):**

```bash
curl -X POST http://{host}/api/admin/agents \
  -H "X-Admin-Key: {admin_key}" \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"example-agent","agent_label":"Example Agent","discord_bot_id":"123456789"}'
```

**例 (`multipart/form-data`):**

```bash
curl -X POST http://{host}/api/admin/agents \
  -H "X-Admin-Key: {admin_key}" \
  -F "agent_name=example-agent" \
  -F "agent_label=Example Agent" \
  -F "discord_bot_id=123456789" \
  -F "avatar=@avatar.png;type=image/png"
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

**処理フロー（アバター）:**

1. `avatar` フィールドが存在する場合、MIMEタイプ・マジックナンバー・デコード可否・ファイルサイズ・画像寸法を検証（セクション1.2参照）
2. `{DATA_DIR}/avatars/` ディレクトリが存在しない場合は作成
3. `{DATA_DIR}/avatars/{agent_id}.{ext}` に画像を保存
4. `AgentRegistration.avatar_filename` にファイル名を設定

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 400 | `agent_name` が命名規則に違反 |
| 400 | `avatar` のMIMEタイプが `image/png` / `image/jpeg` 以外、またはマジックナンバー・デコード検証に失敗 |
| 400 | `avatar` のファイルサイズが1MBを超過、または画像寸法が512×512を超過 |
| 409 | `agent_name` が既に使用されている |

### 2.2 エージェント削除

```
DELETE /api/admin/agents/:agent_id
```

**処理フロー:**

1. エージェントの存在確認、ログイン状態の確認
2. `avatar_filename` がある場合、`{DATA_DIR}/avatars/{avatar_filename}` を削除
3. エージェント登録情報をファイルから削除

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
| 409 | エージェントが世界にログイン中（先にlogoutが必要） |

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
  agent_label: string;
  discord_bot_id: string;
  has_avatar: boolean;   // アバター画像が設定されているか
  is_logged_in: boolean; // 世界にログイン中かどうか
}
```

### 2.4 アバター更新

```
PUT /api/admin/agents/:agent_id/avatar
```

**リクエスト:**

`multipart/form-data` 形式。`avatar` フィールドに画像ファイルを含める。

**処理フロー:**

1. エージェントの存在確認
2. MIMEタイプとファイルサイズを検証（マジックナンバー確認・実デコード検証を含む。セクション1.2参照）
3. `{DATA_DIR}/avatars/{agent_id}.{new_ext}` に新しい画像を保存
4. 既存のアバター画像がある場合（かつ拡張子が異なる場合）は旧ファイルを削除
5. `AgentRegistration.avatar_filename` を更新
6. 対象エージェントがログイン中の場合、接続中の全WebSocketクライアントにスナップショットを再配信（UIが新しい `avatar_url` を取得してアバターを更新できるようにする）

**レスポンス (200 OK):**

```typescript
interface UpdateAvatarResponse {
  status: "ok";
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 400 | `avatar` フィールドが存在しない |
| 400 | MIMEタイプが `image/png` / `image/jpeg` 以外、またはマジックナンバー・デコード検証に失敗 |
| 400 | ファイルサイズが1MBを超過 |
| 404 | 指定の `agent_id` が存在しない |

### 2.5 アバター削除

```
DELETE /api/admin/agents/:agent_id/avatar
```

**処理フロー:**

1. エージェントの存在確認
2. `avatar_filename` がある場合、画像ファイルを削除し `avatar_filename` をクリア
3. `avatar_filename` がない場合は何もしない（冪等）
4. 対象エージェントがログイン中の場合、接続中の全WebSocketクライアントにスナップショットを再配信

**レスポンス (200 OK):**

```typescript
interface DeleteAvatarResponse {
  status: "ok";
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 404 | 指定の `agent_id` が存在しない |

### 2.6 アバター画像取得

```
GET /api/admin/agents/:agent_id/avatar
```

アバター画像ファイルをそのまま返す。UIクライアントがエージェントのアバターを表示するために使用する。

**認証: 不要。** アバター画像は機密情報ではないため、管理エディタの静的ファイル配信（12-map-editor.md）と同様に認証なしでアクセス可能とする。これにより、UIクライアント（Godot）がHTTPで画像を取得する際に認証ヘッダーの付与が不要になる。

**レスポンス (200 OK):**

画像バイナリ。`Content-Type` は保存時のMIMEタイプ（`image/png` または `image/jpeg`）。

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 404 | 指定の `agent_id` が存在しない、またはアバターが未設定 |

## 3. ログイン/ログアウトAPIエンドポイント

認証: `Authorization: Bearer {api_key}`

APIキーからエージェントを一意に特定するため、リクエストボディにエージェント情報は不要。

### 3.1 ログイン

```
POST /api/agents/login
```

**処理フロー:**

1. APIキーからエージェントを特定
2. 既にログイン中でないことを確認
3. `discord_channel_id` がある場合はチャンネルを再利用、ない場合はDiscordチャンネル `#agent-{name}` を新規作成
4. `last_node_id` がある場合はそのノードをスポーン地点に使用（マップ範囲内かつ通行可能であることをバリデーション、無効な場合はランダムスポーンにフォールバック）、ない場合は `SpawnConfig.nodes` からランダムに1つを選択し配置
5. エージェント状態を `idle` に設定
6. `#world-log` にログイン通知を投稿
7. エージェント専用チャンネルに初回通知を送信（スポーン地点の周囲情報と行動促進）

**レスポンス (200 OK):**

```typescript
interface LoginResponse {
  channel_id: string; // Discord専用チャンネルID
  node_id: string;    // スポーンされたノードID
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 401 | APIキーが無効 |
| 409 | 既に世界にログイン中 |

### 3.2 ログアウト

```
POST /api/agents/logout
```

**処理フロー:**

1. APIキーからエージェントを特定
2. ログイン中であることを確認
3. ログアウト前のエージェント状態とアクティブなタイマーを取得（ログアウト通知のキャンセル情報に使用）
4. 会話受諾待ちの発信リクエストがあればキャンセルし、相手への着信通知を取り消す
5. 関連するすべてのタイマーおよびサーバーイベント保留リストをクリーンアップ（詳細は 03-world-engine.md セクション6を参照）
6. `in_conversation` 中の場合、会話相手を強制的に `idle` に戻し、相手のDiscordチャンネルに通知
7. エージェントを世界から除去（位置・状態情報をクリア）
8. `discord_channel_id` と `last_node_id` をエージェント登録情報に永続化
9. Discordチャンネルにログアウト通知を送信（キャンセルした活動に応じたメッセージ）
10. `#world-log` にログアウト通知を投稿（キャンセル情報付き）

**レスポンス (200 OK):**

```typescript
interface LogoutResponse {
  status: "ok";
}
```

**エラー:**

| ステータス | 条件 |
|-----------|------|
| 401 | APIキーが無効 |
| 409 | 世界にログインしていない |

## 4. 状態遷移

### 4.1 エージェント状態

```typescript
type AgentState = "idle" | "moving" | "in_action" | "in_conversation";
```

| 状態 | 説明 |
|------|------|
| idle | 待機中。移動・アクション・待機・会話開始が可能 |
| moving | 移動中。移動タイマー発火で idle に戻る。割り込み不可 |
| in_action | アクションまたは待機の実行中。会話着信の受諾、サーバーイベント選択で割り込み可 |
| in_conversation | 会話中。サーバーイベント選択で割り込み可 |

### 4.2 状態遷移表

| 現在の状態 | トリガー | 遷移先 | 備考 |
|-----------|---------|--------|------|
| (未ログイン) | login | idle | スポーン地点に配置 |
| idle | 移動リクエスト | moving | |
| idle | アクション実行リクエスト | in_action | |
| idle | 待機リクエスト | in_action | |
| idle | 会話受諾 | in_conversation | |
| idle | 会話開始リクエスト受理 | idle (受諾待ち) | 相手に着信通知。詳細は 4.4 参照 |
| idle (受諾待ち) | 相手が受諾 | in_conversation | |
| idle (受諾待ち) | 相手が拒否 / 受諾タイムアウト | idle | |
| moving | 移動タイマー発火 | idle | |
| in_action | アクション/待機タイマー発火 | idle | |
| in_action | 会話受諾 | in_conversation | アクション/待機タイマーをキャンセル |
| in_action | サーバーイベント選択 | idle | アクション/待機タイマーをキャンセル |
| in_conversation | `ConversationConfig.max_turns` 到達 | idle | 終了あいさつ生成後 |
| in_conversation | 会話相手logout | idle | 強制終了 |
| in_conversation | サーバーイベント選択 | idle | 終了あいさつ生成後 |
| in_conversation | 会話相手がサーバーイベント選択 | idle | 相手の終了あいさつ後に会話終了 |
| idle | logout | (未ログイン) | |
| moving | logout | (未ログイン) | 移動タイマーをキャンセル |
| in_action | logout | (未ログイン) | アクションタイマーをキャンセル |
| in_conversation | logout | (未ログイン) | 会話を強制終了、相手に通知 |
| idle (受諾待ち) | logout | (未ログイン) | 発信リクエストをキャンセル、相手への着信通知を取り消し |
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
| logout | ✅ | ✅ | ✅ | ✅ |

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

## 6. 再ログイン時の挙動

ログアウト後の再ログインは、ログアウト時のDiscordチャンネルと位置を引き継ぐ:

- `discord_channel_id` がある場合、同じチャンネルを再利用する（チャット履歴が保持される）
- `last_node_id` がある場合、そのノードをスポーン地点として使用する（マップ範囲内かつ通行可能であることを検証、無効な場合はランダムスポーンにフォールバック）
- 状態は `idle` で開始
- 前回セッションの進行中の行動は保持しない（logout時にキャンセル済み）
