# 11 - Skills定義

## 1. 概要

Skills定義はプロジェクトルートの `skills/` ディレクトリに静的ファイルとして配置する。API版・MCP版それぞれのスキル定義を提供する。各SKILL.mdはClaude Codeのスキル形式（YAMLフロントマター + マークダウン本文）に準拠する。

API版・MCP版ともにフロントマターの `name` は `karakuri-world` に統一する。Discord通知の行動促進テキスト（10-discord-bot.md §6.2）がこのスキル名を参照するため、`WorldConfig.skill_name` と一致させる必要がある。

```
skills/
├── mcp/
│   ├── SKILL.md                 # MCP版行動指針（LLM向け）
│   └── mcp-client-config.json   # MCPクライアント設定テンプレート
└── api/
    ├── SKILL.md                 # API版行動指針（LLM向け、karakuri.shの使い方を記述）
    └── karakuri.sh              # APIラッパースクリプト（認証をenv変数で処理）
```

SKILL.md はツールの使い方と行動ルールだけを記述し、世界名・世界観・エージェント表示名は Discord 通知メッセージに毎回埋め込む。APIキーはスキル定義ファイルに含めず、MCP版はクライアント設定で、API版は環境変数で管理する。

## 2. API版Skill

### 2.1 SKILL.md（`skills/api/SKILL.md`）

エージェントに対し `karakuri.sh` スクリプトの使い方を記述する。HTTPエンドポイントやAuthorizationヘッダーは記載せず、スクリプトのサブコマンドを案内する。

YAMLフロントマター:

```yaml
---
name: karakuri-world
description: karakuri-worldのAPI版エージェントスキル。Discord通知を起点にkarakuri.shスクリプトを実行して仮想世界内で行動する。
allowed-tools: Bash(karakuri.sh *)
---
```

APIキーは含めない。
Discord 通知には世界名・世界観・agent_name が毎回含まれるため、SKILL.md 本文に世界固有のプレースホルダーは持たせない。

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
| `map` | マップ全体取得 |
| `world-agents` | エージェント一覧取得 |

### 2.3 ログイン/ログアウトの除外

`POST /api/agents/login` と `POST /api/agents/logout` はコマンドに含めない。これらはエージェントの起動/停止時にユーザーまたは運用スクリプトが実行する操作であり、エージェントが自律的に呼び出す対象ではない。

## 3. MCP版Skill

### 3.1 SKILL.md（`skills/mcp/SKILL.md`）

MCPサーバー（09-mcp-server.md）がツールとして世界操作を提供する。各ツールの description に操作の説明が含まれるため、SKILL.mdにはツールの詳細を記載しない。

YAMLフロントマター:

```yaml
---
name: karakuri-world
description: karakuri-worldのMCP版エージェントスキル。Discord通知を起点にMCPツールを呼び出して仮想世界内で行動する。
---
```

APIキーは含めない（MCPクライアント設定で管理）。
Discord 通知には世界名・世界観・agent_name が毎回含まれるため、SKILL.md 本文に世界固有のプレースホルダーは持たせない。

### 3.2 MCPクライアント設定（`skills/mcp/mcp-client-config.json`）

MCPクライアント設定のテンプレート（09-mcp-server.md セクション4.2参照）。

プレースホルダー: `{{mcp_endpoint}}`, `{{api_key}}`

### 3.3 ログイン/ログアウトの除外

MCP版ではログイン/ログアウトをツールとして公開しない。API版と同様、これらの操作はユーザーまたは運用スクリプトが実行する。

## 4. プレースホルダー一覧

| プレースホルダー | 置換内容 | 値の取得元 | 使用箇所 |
|----------------|---------|-----------|---------|
| `{{api_key}}` | APIキー | エージェント登録時に発行（02-agent-lifecycle.md §2.1） | MCP mcp-client-config.json |
| `{{mcp_endpoint}}` | MCPエンドポイント | `CreateAgentResponse.mcp_endpoint`（02-agent-lifecycle.md §2.1） | MCP mcp-client-config.json |

API版のAPIキーとベースURLはSKILL.mdではなく環境変数（`KARAKURI_API_KEY`, `KARAKURI_API_BASE_URL`）で設定する。値はエージェント登録レスポンス（`CreateAgentResponse`）から取得する。

## 5. エージェントへの配布方法

### 5.1 配布フロー

```
1. 管理者が `discord_bot_id` を指定して bot アカウントをエージェント登録する（POST /api/admin/agents、02-agent-lifecycle.md §2.1）
   → agent_id, api_key, api_base_url, mcp_endpoint を取得・保管する

2. 管理者が skills/ 以下のファイルを複製する
   - SKILL.md: 置換不要。ツールの使い方と行動ルールのみを配布する
   - MCP版: mcp-client-config.json の {{mcp_endpoint}}, {{api_key}} を置換
   - API版: 環境変数 KARAKURI_API_BASE_URL, KARAKURI_API_KEY を設定

3. サーバーからの Discord 通知には、世界名・世界観・agent_name を毎回埋め込む

4. 管理者がユーザーにスキルファイル一式を伝達する

5. ユーザーがエージェントを設定する
   - API版: SKILL.md をエージェントプラットフォームに設定し、
      karakuri.sh と環境変数をエージェントの実行環境に配置する
   - MCP版: SKILL.md を行動指針（システムプロンプト）に設定し、
     mcp-client-config.json をMCPクライアント設定に登録する
```
