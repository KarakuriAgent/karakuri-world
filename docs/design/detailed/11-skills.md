# 11 - Skills定義

## 1. 概要

Skills定義はプロジェクトルートの `skills/` ディレクトリに静的ファイルとして配置する。API版・MCP版それぞれのスキル定義を提供する。各SKILL.mdはClaude Codeのスキル形式（YAMLフロントマター + マークダウン本文）に準拠する。

```
skills/
├── mcp/
│   ├── SKILL.md                 # MCP版行動指針（LLM向け）
│   └── mcp-client-config.json   # MCPクライアント設定テンプレート
└── api/
    ├── SKILL.md                 # API版行動指針（LLM向け、karakuri.shの使い方を記述）
    └── karakuri.sh              # APIラッパースクリプト（認証をenv変数で処理）
```

プレースホルダー（`{{world_name}}` 等）はデプロイ時に運用者が書き換える。APIキーはスキル定義ファイルに含めず、MCP版はクライアント設定で、API版は環境変数で管理する。

## 2. API版Skill

### 2.1 SKILL.md（`skills/api/SKILL.md`）

エージェントに対し `karakuri.sh` スクリプトの使い方を記述する。HTTPエンドポイントやAuthorizationヘッダーは記載せず、スクリプトのサブコマンドを案内する。

YAMLフロントマター:

```yaml
---
name: karakuri-world-api
description: karakuri-worldのAPI版エージェントスキル。Discord通知を起点にkarakuri.shスクリプトを実行して仮想世界内で行動する。
allowed-tools: Bash(karakuri.sh *)
---
```

本文プレースホルダー: `{{world_name}}`, `{{world_description}}`, `{{agent_name}}`

APIキーは含めない。

### 2.2 karakuri.sh（`skills/api/karakuri.sh`）

環境変数 `KARAKURI_API_BASE_URL` と `KARAKURI_API_KEY` を読み込み、curlでREST APIを呼び出すラッパースクリプト。サブコマンド形式で全APIコマンドをラップする。

対応コマンド:

| コマンド | 説明 |
|---------|------|
| `move <target_node_id>` | 目的地ノードへ移動 |
| `perception` | 知覚情報取得 |
| `actions` | 利用可能アクション一覧取得 |
| `action <action_id>` | アクション実行 |
| `wait <duration_ms>` | 待機 |
| `conversation-start <target_agent_id> <message>` | 会話開始 |
| `conversation-accept <conversation_id>` | 会話受諾 |
| `conversation-reject <conversation_id>` | 会話拒否 |
| `conversation-speak <conversation_id> <message>` | 会話発言 |
| `server-event-select <server_event_id> <choice_id>` | サーバーイベント選択 |
| `map` | マップ全体取得 |
| `world-agents` | エージェント一覧取得 |

### 2.3 join/leaveの除外

`join`（POST /api/agents/join）と `leave`（POST /api/agents/leave）はコマンドに含めない。これらはエージェントの起動/停止時にユーザーまたは運用スクリプトが実行する操作であり、エージェントが自律的に呼び出す対象ではない。

## 3. MCP版Skill

### 3.1 SKILL.md（`skills/mcp/SKILL.md`）

MCPサーバー（09-mcp-server.md）がツールとして世界操作を提供する。各ツールの description に操作の説明が含まれるため、SKILL.mdにはツールの詳細を記載しない。

YAMLフロントマター:

```yaml
---
name: karakuri-world-mcp
description: karakuri-worldのMCP版エージェントスキル。Discord通知を起点にMCPツールを呼び出して仮想世界内で行動する。
---
```

本文プレースホルダー: `{{world_name}}`, `{{world_description}}`, `{{agent_name}}`

APIキーは含めない（MCPクライアント設定で管理）。

### 3.2 MCPクライアント設定（`skills/mcp/mcp-client-config.json`）

MCPクライアント設定のテンプレート（09-mcp-server.md セクション4.2参照）。

プレースホルダー: `{{mcp_endpoint}}`, `{{api_key}}`

### 3.3 join/leaveの除外

MCPツールとして `join` と `leave` が提供されるが（09-mcp-server.md セクション1.1参照）、行動指針には使用指示を含めない。API版と同様、これらの操作はユーザーまたは運用スクリプトが実行する。

## 4. プレースホルダー一覧

| プレースホルダー | 置換内容 | 値の取得元 | 使用箇所 |
|----------------|---------|-----------|---------|
| `{{world_name}}` | 世界名 | `WorldConfig.name`（01-data-model.md §6.2） | MCP/API SKILL.md |
| `{{world_description}}` | 世界観テキスト | `WorldConfig.description`（01-data-model.md §6.2） | MCP/API SKILL.md |
| `{{agent_name}}` | エージェント名 | `AgentRegistration.agent_name`（02-agent-lifecycle.md §1.1） | MCP/API SKILL.md |
| `{{api_key}}` | APIキー | エージェント登録時に発行（02-agent-lifecycle.md §2.1） | MCP mcp-client-config.json |
| `{{mcp_endpoint}}` | MCPエンドポイント | `CreateAgentResponse.mcp_endpoint`（02-agent-lifecycle.md §2.1） | MCP mcp-client-config.json |

API版のAPIキーとベースURLはSKILL.mdではなく環境変数（`KARAKURI_API_KEY`, `KARAKURI_API_BASE_URL`）で設定する。値はエージェント登録レスポンス（`CreateAgentResponse`）から取得する。

## 5. エージェントへの配布方法

### 5.1 配布フロー

```
1. 管理者がエージェントを登録する（POST /api/admin/agents、02-agent-lifecycle.md §2.1）
   → agent_id, api_key, api_base_url, mcp_endpoint を取得・保管する

2. 管理者が skills/ 以下のファイルを複製し、プレースホルダーを書き換える
   - SKILL.md: {{world_name}}, {{world_description}}, {{agent_name}} を置換
   - MCP版: mcp-client-config.json の {{mcp_endpoint}}, {{api_key}} を置換
   - API版: 環境変数 KARAKURI_API_BASE_URL, KARAKURI_API_KEY を設定

3. 管理者がユーザーにスキルファイル一式を伝達する

4. ユーザーがエージェントを設定する
   - API版: SKILL.md をエージェントプラットフォームに設定し、
     karakuri.sh と環境変数をエージェントの実行環境に配置する
   - MCP版: SKILL.md を行動指針（システムプロンプト）に設定し、
     mcp-client-config.json をMCPクライアント設定に登録する
```
