# 09 - MCPサーバー

## 1. MCPツール一覧

MCPサーバーは、ログイン/ログアウトを除くエージェント向けREST API（08-rest-api.md セクション3〜5）と1対1で対応するツールを提供する。管理API（セクション6）およびUI向けAPI（セクション7）はMCPツールとして提供しない。

### 1.1 対応表

| MCPツール名 | REST APIエンドポイント | 説明 |
|------------|----------------------|------|
| `move` | POST /api/agents/move | 移動 |
| `action` | POST /api/agents/action | アクション実行 |
| `wait` | POST /api/agents/wait | 待機 |
| `conversation_start` | POST /api/agents/conversation/start | 会話開始 |
| `conversation_accept` | POST /api/agents/conversation/accept | 会話受諾 |
| `conversation_reject` | POST /api/agents/conversation/reject | 会話拒否 |
| `conversation_speak` | POST /api/agents/conversation/speak | 会話発言 |
| `server_event_select` | POST /api/agents/server-event/select | サーバーイベント選択 |
| `get_available_actions` | GET /api/agents/actions | 利用可能アクション一覧取得 |
| `get_perception` | GET /api/agents/perception | 知覚情報取得 |
| `get_map` | GET /api/agents/map | マップ全体取得 |
| `get_world_agents` | GET /api/agents/world-agents | ログイン中エージェント一覧取得 |

ライフサイクル操作（`POST /api/agents/login`、`POST /api/agents/logout`）はユーザーまたは運用スクリプトが実行するため、MCPツールとして公開しない。

## 2. 各ツールのパラメータ定義

各ツールの `inputSchema` を定義する。バリデーションルールおよびエラー仕様はREST APIと同一であり、対応するセクションを参照すること。

### 2.1 move

```json
{
  "name": "move",
  "description": "指定した目的地ノードへ移動する。サーバーがBFSで最短経路を計算し、経路のマス数に応じた移動時間で一括移動する。idle状態でのみ実行可能。",
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
  "description": "アクションを実行する。idle状態でのみ実行可能。利用可能なアクションはget_available_actionsで確認できる。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action_id": {
        "type": "string",
        "description": "実行するアクションのID"
      }
    },
    "required": ["action_id"]
  }
}
```

### 2.3 wait

```json
{
  "name": "wait",
  "description": "指定した時間（ミリ秒）だけその場で待機する。idle状態でのみ実行可能。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "duration_ms": {
        "type": "integer",
        "minimum": 1,
        "maximum": 3600000,
        "description": "待機時間（ミリ秒、最大1時間）"
      }
    },
    "required": ["duration_ms"]
  }
}
```

### 2.4 conversation_start

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

### 2.5 conversation_accept

```json
{
  "name": "conversation_accept",
  "description": "会話の着信を受諾する。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversation_id": {
        "type": "string",
        "description": "受諾する会話のID"
      }
    },
    "required": ["conversation_id"]
  }
}
```

### 2.6 conversation_reject

```json
{
  "name": "conversation_reject",
  "description": "会話の着信を拒否する。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversation_id": {
        "type": "string",
        "description": "拒否する会話のID"
      }
    },
    "required": ["conversation_id"]
  }
}
```

### 2.7 conversation_speak

```json
{
  "name": "conversation_speak",
  "description": "会話中に発言する。in_conversation状態で自分のターンのときのみ実行可能。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "conversation_id": {
        "type": "string",
        "description": "発言する会話のID"
      },
      "message": {
        "type": "string",
        "minLength": 1,
        "description": "発言内容"
      }
    },
    "required": ["conversation_id", "message"]
  }
}
```

### 2.8 server_event_select

```json
{
  "name": "server_event_select",
  "description": "サーバーイベントの選択肢を選ぶ。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server_event_id": {
        "type": "string",
        "description": "対象のサーバーイベントID"
      },
      "choice_id": {
        "type": "string",
        "description": "選択する選択肢のID"
      }
    },
    "required": ["server_event_id", "choice_id"]
  }
}
```

### 2.9 get_available_actions

```json
{
  "name": "get_available_actions",
  "description": "現在位置で実行可能なアクションの一覧を取得する。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.10 get_perception

```json
{
  "name": "get_perception",
  "description": "現在位置の知覚範囲内の情報を取得する。周囲のノード、エージェント、NPC、建物の情報を含む。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.11 get_map

```json
{
  "name": "get_map",
  "description": "マップ全体の構造情報を取得する。ノード構成、建物、NPCの配置を含む。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.12 get_world_agents

```json
{
  "name": "get_world_agents",
  "description": "世界にログイン中のすべてのエージェントの位置と状態を取得する。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

## 3. ツールの実行結果

### 3.1 成功時

ツールの実行結果は、対応するREST APIのレスポンスボディをJSON文字列として返す。

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"from_node_id\":\"3-3\",\"to_node_id\":\"2-3\",\"arrives_at\":1700000000000}"
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

認証成功後、ログイン必須のツール（`move`、`action`、`conversation_*`、`server_event_select`、`get_*`）を未ログイン状態で呼び出した場合は、ツール実行エラー（セクション3.2）として `not_logged_in` エラーを返す。これはREST APIの `403 Forbidden`（08-rest-api.md セクション1.3）に相当する。
