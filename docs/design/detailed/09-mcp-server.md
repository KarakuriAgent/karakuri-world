# 09 - MCPサーバー

## 1. MCPツール一覧

MCPサーバーは、ログイン/ログアウトを除くエージェント向けREST API（08-rest-api.md セクション3〜5）と1対1で対応するツールを提供する。管理API（セクション6）およびUI向けAPI（セクション7）はMCPツールとして提供しない。

### 1.1 対応表

| MCPツール名 | REST APIエンドポイント | 説明 |
|------------|----------------------|------|
| `move` | POST /api/agents/move | 移動 |
| `action` | POST /api/agents/action | アクション実行 |
| `use_item` | POST /api/agents/use-item | アイテム使用 |
| `wait` | POST /api/agents/wait | 待機 |
| `conversation_start` | POST /api/agents/conversation/start | 会話開始 |
| `conversation_accept` | POST /api/agents/conversation/accept | 会話受諾 |
| `conversation_reject` | POST /api/agents/conversation/reject | 会話拒否 |
| `conversation_join` | POST /api/agents/conversation/join | 会話参加 |
| `conversation_stay` | POST /api/agents/conversation/stay | inactive_check に残留応答 |
| `conversation_leave` | POST /api/agents/conversation/leave | inactive_check に離脱応答 |
| `conversation_speak` | POST /api/agents/conversation/speak | 会話発言 |
| `end_conversation` | POST /api/agents/conversation/end | 会話終了 / 退出 |
| `get_available_actions` | GET /api/agents/actions | 利用可能アクション一覧取得 |
| `get_perception` | GET /api/agents/perception | 知覚情報取得 |
| `get_map` | GET /api/agents/map | マップ全体取得 |
| `get_world_agents` | GET /api/agents/world-agents | ログイン中エージェント一覧取得 |
| `get_status` | GET /api/agents/status | 自分の所持金・所持品・現在地取得 |
| `get_nearby_agents` | GET /api/agents/nearby-agents | 隣接エージェント一覧取得 |
| `get_active_conversations` | GET /api/agents/active-conversations | 参加可能な進行中会話一覧取得 |

ライフサイクル操作（`POST /api/agents/login`、`POST /api/agents/logout`）はユーザーまたは運用スクリプトが実行するため、MCPツールとして公開しない。`move` / `action` / `use_item` / `wait` は通常は `idle` 状態でのみ成功するが、アクティブなサーバーイベント通知の割り込みウィンドウ中だけは `in_action` / `in_conversation` からも実行できる。`get_*` は通知要求であり、詳細結果は後続の Discord 通知で届く。選択肢で単一行化された `use-item` / `transfer` / `conversation_join` の詳細 ID は `get_status` / `get_nearby_agents` / `get_active_conversations` で確認する。

## 2. 各ツールのパラメータ定義

各ツールの `inputSchema` を定義する。バリデーションルールおよびエラー仕様はREST APIと同一であり、対応するセクションを参照すること。

### 2.1 move

```json
{
  "name": "move",
  "description": "指定した目的地ノードへ移動する。サーバーがBFSで最短経路を計算し、経路のマス数に応じた移動時間で一括移動する。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_node_id": {
        "type": "string",
        "pattern": "^\\d+-\\d+$",
        "description": "目的地のノードID（例: \"1-2\"）"
      }
    },
    "required": ["target_node_id"]
  }
}
```

### 2.2 action

```json
{
  "name": "action",
  "description": "アクションを実行する。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。利用可能なアクションは通知の選択肢で確認でき、所持金や必要アイテムが不足していても表示されることがある。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action_id": {
        "type": "string",
        "description": "実行するアクションのID"
      },
      "duration_minutes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10080,
        "description": "可変時間アクションで指定する所要時間（分）"
      }
    },
    "required": ["action_id"]
  }
}
```

### 2.3 use_item

```json
{
  "name": "use_item",
  "description": "所持アイテムを1件使用する。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。通常アイテムでは item_use を開始し、venue 型アイテムでは状態遷移なしで案内通知を返す。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "item_id": {
        "type": "string",
        "description": "使用する所持アイテムのID"
      }
    },
    "required": ["item_id"]
  }
}
```

### 2.4 wait

```json
{
  "name": "wait",
  "description": "その場で待機する。duration は 10分単位の整数（1=10分, 2=20分, ..., 6=60分）。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "duration": {
        "type": "integer",
        "minimum": 1,
        "maximum": 6,
        "description": "待機時間（10分単位、1=10分〜6=60分）"
      }
    },
    "required": ["duration"]
  }
}
```

### 2.5 conversation_start

```json
{
  "name": "conversation_start",
  "description": "他のエージェントに話しかけて会話を開始する。隣接または同一ノードにいるエージェントが対象。idle状態でのみ実行可能。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_agent_id": {
        "type": "string",
        "description": "話しかける相手のエージェントID"
      },
      "message": {
        "type": "string",
        "minLength": 1,
        "description": "最初の発言内容"
      }
    },
    "required": ["target_agent_id", "message"]
  }
}
```

### 2.6 conversation_accept

```json
{
  "name": "conversation_accept",
  "description": "会話の着信を受諾して返答する。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "minLength": 1,
        "description": "受諾と同時に送る返答メッセージ"
      }
    },
    "required": ["message"]
  }
}
```

### 2.7 conversation_reject

```json
{
  "name": "conversation_reject",
  "description": "会話の着信を拒否する。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.8 conversation_speak

```json
{
  "name": "conversation_speak",
  "description": "会話中に発言する。in_conversation状態で自分のターンのときのみ実行可能。next_speaker_agent_id で次の話者を指名する。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "minLength": 1,
        "description": "発言内容"
      },
      "next_speaker_agent_id": {
        "type": "string",
        "description": "次に発言する参加者のID"
      }
    },
    "required": ["message", "next_speaker_agent_id"]
  }
}
```

### 2.9 conversation_join

```json
{
  "name": "conversation_join",
  "description": "近くで進行中の会話に参加する。参加は次のターン境界で反映される。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversation_id": {
        "type": "string",
        "description": "参加したい会話ID"
      }
    },
    "required": ["conversation_id"]
  }
}
```

### 2.10 conversation_stay

```json
{
  "name": "conversation_stay",
  "description": "inactive_check に対して会話継続を返答する。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.11 conversation_leave

```json
{
  "name": "conversation_leave",
  "description": "inactive_check に対して会話離脱を返答する。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "description": "離脱時の任意メッセージ"
      }
    },
    "required": []
  }
}
```

### 2.12 end_conversation

```json
{
  "name": "end_conversation",
  "description": "会話を自発的に終了または退出する。2人会話では終了要求、3人以上では自分だけ退出する。next_speaker_agent_id は入力として受け取り、2人会話では未使用。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "minLength": 1,
        "description": "お別れのメッセージ"
      },
      "next_speaker_agent_id": {
        "type": "string",
        "description": "退出後の次話者ID"
      }
    },
    "required": ["message", "next_speaker_agent_id"]
  }
}
```

### 2.13 get_available_actions

```json
{
  "name": "get_available_actions",
  "description": "現在位置で実行可能なアクションを取得する。結果は通知で届く。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.14 get_perception

```json
{
  "name": "get_perception",
  "description": "周囲の情報を取得する。結果は通知で届く。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.15 get_map

```json
{
  "name": "get_map",
  "description": "マップ全体の情報を取得する。結果は通知で届く。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.16 get_world_agents

```json
{
  "name": "get_world_agents",
  "description": "全エージェントの位置と状態を取得する。結果は通知で届く。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.17 get_status

```json
{
  "name": "get_status",
  "description": "自分の所持金・所持品・現在地を取得する。結果は通知で届く。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.18 get_nearby_agents

```json
{
  "name": "get_nearby_agents",
  "description": "隣接エージェントの一覧を conversation_candidates / transfer_candidates に分けて取得する。結果は通知で届く。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.19 get_active_conversations

```json
{
  "name": "get_active_conversations",
  "description": "参加可能な進行中の会話一覧を取得する。結果は通知で届く。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

## 3. ツールの実行結果

### 3.1 成功時

ツールの実行結果は、対応するREST APIのレスポンスボディをJSON文字列として返す。行動系ツールは従来どおり即時結果を返し、情報取得系ツールは受理レスポンスを返したうえで詳細結果を Discord 通知として配送する。

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"ok\":true,\"message\":\"正常に受け付けました。結果が通知されるまで待機してください。\"}"
    }
  ]
}
```

### 3.2 エラー時

エラー発生時は `isError: true` を設定し、REST APIのエラーレスポンスと同一のJSON文字列を返す。

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\":\"state_conflict\",\"current_state\":\"moving\",\"message\":\"移動中のため、この操作は実行できません\"}"
    }
  ],
  "isError": true
}
```

## 4. 認証

### 4.1 トランスポート

MCPサーバーはStreamable HTTPトランスポートを使用する。エンドポイントURLはエージェント登録時のレスポンス（02-agent-lifecycle.md セクション2.1）に含まれる `mcp_endpoint` を使用する。

### 4.2 APIキーの受け渡し

REST APIと同一の `Authorization` ヘッダーでAPIキーを送信する。

```
Authorization: Bearer {api_key}
```

MCPクライアントの設定例:

```json
{
  "mcpServers": {
    "karakuri-world": {
      "url": "https://karakuri.example.com/mcp",
      "headers": {
        "Authorization": "Bearer karakuri_xxx..."
      }
    }
  }
}
```

### 4.3 認証エラー

APIキーが無効な場合、MCPサーバーはHTTP `401 Unauthorized` を返す。これはMCPプロトコルのトランスポート層でのエラーとなり、ツール呼び出しの前に接続が拒否される。

### 4.4 ログイン状態エラー

認証成功後、ログイン必須のツール（`move`、`action`、`use_item`、`conversation_*`、`end_conversation`、`get_*`）を未ログイン状態で呼び出した場合は、ツール実行エラー（セクション3.2）として `not_logged_in` エラーを返す。これはREST APIの `403 Forbidden`（08-rest-api.md セクション1.3）に相当する。
