# karakuri-world-agent

`karakuri-world-agent` は、Discord 上で動くエージェント実装です。
Vercel Chat SDK と AI SDK を使い、`karakuri-world` の MCP サーバーへ接続してワールド内を行動します。

このディレクトリはルートのワールドサーバー本体とは別の独立パッケージです。
会話状態は Chat SDK のインメモリ state を使いつつ、会話履歴そのものは `data/sessions/` に JSON 永続化します。

## できること

- Discord の通常メッセージやメンションに応答する

同じチャンネルに短時間で複数メッセージが届いた場合は、チャンネル単位で順番に処理します。
先に届いたメッセージの応答が終わってから次のメッセージを会話履歴へ反映するため、応答順が入れ替わらないようにしています。
- `karakuri-world` の MCP ツールを自動取得して行動する
- チャンネルごとに会話履歴を永続化する
- 日記 (`data/diary/`) と重要記憶 (`data/memories/`) を JSON で保存する
- Discord Gateway listener と webhook サーバーを同一プロセスで動かす

## 前提条件

- Node.js 20 以上
- 起動済みの `karakuri-world` サーバー
- Discord application / bot の資格情報
- OpenAI 互換 API の資格情報

必要になる代表的な情報:

- `karakuri-world` 管理 API で発行したエージェント API キー
- `karakuri-world` の MCP エンドポイント URL
- Discord bot token
- Discord public key
- Discord application ID

## セットアップ手順

### 1. 依存関係をインストールする

```bash
cd karakuri-world-agent
npm install
```

### 2. サンプル環境変数をコピーする

ローカル起動では `.env.example` を `.env` にコピーして使います。
`.env.example` と `.env.compose.example` は項目名をそろえてあり、
ローカル起動では単一 agent 用の無接頭辞版、Docker Compose では `ADVENTURER_*` / `SCHOLAR_*` 付きで同じ項目を設定します。

```bash
cp .env.example .env
```

`.env` と後述の `.env.compose` は `.gitignore` 済みです。

### 3. エージェント設定ディレクトリを用意する

同梱の `agents/adventurer/` と `agents/scholar/` は、そのまま編集して使えるスターターです。
`personality.md` と `SKILL.md` の組を増やせば、新しい agent を作れます。
`SKILL.md` は callable skill tool として読み込まれ、モデルには名前と説明だけを先に見せます。
一方で MCP tool 自体は最初から公開されますが、MCP クライアントへの接続と実際のツール解決は、最初の MCP tool 実行時まで遅延します。

```text
agents/
  adventurer/
    personality.md
    SKILL.md
  scholar/
    personality.md
    SKILL.md
```

別名で増やす場合の例:

```bash
cp -R agents/adventurer agents/my-agent
```

スターターを編集してもよいですし、必要ならルートリポジトリの `skills/` から内容を抜粋して `SKILL.md` を拡張してください。

### 4. karakuri-world にエージェントを登録する

ルートの `karakuri-world` サーバーを起動したうえで、管理 API からエージェントを登録します。

```bash
curl -X POST http://127.0.0.1:3000/api/admin/agents \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"adventurer","discord_bot_id":"123456789012345678"}'
```

ここで返る `api_key` を `KARAKURI_API_KEY` に設定します。
`discord_bot_id` には、この agent 用 Discord bot の user ID を指定してください。

### 5. `.env` を編集する

`.env.example` にはローカル起動用のひな形を入れてあります。
`.env.compose.example` と対応するように、共通設定と単一 agent 設定を同じ粒度で並べています。
最低限、以下は実値に置き換えてください。

```bash
OPENAI_API_KEY=your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
KARAKURI_MCP_URL=http://127.0.0.1:3000/mcp

DISCORD_TOKEN=your-discord-bot-token
DISCORD_PUBLIC_KEY=your-discord-public-key
DISCORD_APPLICATION_ID=your-discord-application-id
DISCORD_MENTION_ROLE_IDS=1234567890,0987654321
KARAKURI_API_KEY=karakuri_...
OPENAI_MODEL=gpt-4o

BOT_NAME=adventurer
AGENT_DIR=./agents/adventurer
DATA_DIR=./data
PORT=3001
```

主な変数:

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` or `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `DISCORD_PUBLIC_KEY` | Yes | Discord Interactions 用公開鍵 |
| `DISCORD_APPLICATION_ID` | Yes | Discord application ID |
| `DISCORD_MENTION_ROLE_IDS` | No | メンション対象にしたいロール ID 一覧 |
| `OPENAI_API_KEY` | Yes | OpenAI 互換 API のキー |
| `OPENAI_BASE_URL` | No | OpenAI 互換 API の base URL |
| `OPENAI_MODEL` | No | 使用モデル |
| `KARAKURI_MCP_URL` | Yes | `karakuri-world` の MCP URL |
| `KARAKURI_API_KEY` | Yes | 管理 API で発行した agent API key |
| `AGENT_DIR` | Yes | `personality.md` と `SKILL.md` を置いたディレクトリ |
| `BOT_NAME` | No | Chat SDK 上の bot 名 |
| `DATA_DIR` | No | 日記・記憶・セッションの保存先 |
| `PORT` | No | webhook サーバー待受ポート |

`AGENT_DIR=./agents/adventurer` のまま始めれば、同梱のスターター設定でまず起動確認できます。

### 6. 起動する

開発用:

```bash
npm run dev
```

本番相当:

```bash
npm run build
npm start
```

起動すると次が立ち上がります。

- Discord Gateway listener
- `POST /webhooks/discord`
- `GET /healthz`

### 7. Discord 側を設定する

最低限、Discord bot 側では以下を有効にしてください。

- Message Content Intent
- 必要なサーバーへの bot 招待

通常メッセージの受信自体は内蔵 Gateway listener が担当します。
一方で slash command や button interaction も使う場合は、公開 URL で `POST /webhooks/discord` を到達可能にし、Discord Developer Portal の Interactions Endpoint URL に設定してください。

## Docker Compose で起動する

同梱の `docker-compose.yml` には `adventurer` / `scholar` のサンプルが入っています。
各 service は agent ごとの設定ディレクトリを `/app/agent` に read-only bind mount し、永続データを `/app/data` に bind mount します。

例:

```bash
npm run docker:prepare
cp .env.compose.example .env.compose
$EDITOR .env.compose
docker compose --env-file .env.compose -f docker-compose.yml up --build
```

単体で image だけ作る場合も同じで、事前に成果物を用意してから `docker build` します。

```bash
npm run docker:prepare
docker build -t karakuri-world-agent .
```

`npm run docker:prepare` は `.docker-build/` を作成し、通常の `node:24-slim` コンテナ内で
`npm ci --include=dev` → `npm run build` → `npm prune --omit=dev` を実行して、
Docker image にその成果物を取り込める状態にします。
依存関係や `src/` を変更したら、`docker build` / `docker compose up --build` の前に再実行してください。

`.env.compose.example` では、`.env.example` と同じ粒度の設定を `ADVENTURER_*` / `SCHOLAR_*` に分けて指定します。

- `KARAKURI_MCP_URL`
- `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- `ADVENTURER_*` と `SCHOLAR_*` の Discord / Karakuri / OpenAI model 設定
- `ADVENTURER_BOT_NAME` / `SCHOLAR_BOT_NAME`
- `ADVENTURER_AGENT_DIR` / `SCHOLAR_AGENT_DIR`
- `ADVENTURER_DATA_DIR` / `SCHOLAR_DATA_DIR`
- `ADVENTURER_PORT` / `SCHOLAR_PORT`

デフォルトの `KARAKURI_MCP_URL` は、Docker コンテナからホスト上の `karakuri-world` に接続する想定で `http://host.docker.internal:3000/mcp` にしてあります。
別ホストや別 compose project で動かす場合は、`.env.compose` 側で上書きしてください。
また、`ADVENTURER_PORT=3101` と `SCHOLAR_PORT=3102` を使って、各 container の `GET /healthz` と `POST /webhooks/discord` をホスト側にも公開します。

## データ保存先

`DATA_DIR` 配下に以下を保存します。

```text
data/
  diary/
  memories/
  sessions/
```

- `diary/`: その日の出来事の記録
- `memories/`: 長期記憶
- `sessions/`: チャンネル別会話履歴

## 検証コマンド

```bash
npm test
npm run build
```

## 関連ファイル

- [DESIGN.md](./DESIGN.md)
- [.env.example](./.env.example)
- [.env.compose.example](./.env.compose.example)
- [ルート README (README.md)](../README.md)
- [ルート README (README.ja.md)](../README.ja.md)
