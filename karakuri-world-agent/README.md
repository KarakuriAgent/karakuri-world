# karakuri-world-agent

`karakuri-world-agent` は、Discord 上で動く companion agent 実装です。
Vercel Chat SDK と AI SDK を使い、agent package 内に実装された karakuri-world 系の internal AI tools を通じてワールド内を行動します。
このツールは `karakuri-world` サーバーの REST API を直接呼び出し、companion agent 自体は `/mcp` エンドポイントへ接続しません。
ワールドサーバー本体の MCP 提供はそのまま残るため、他のクライアントは必要に応じて引き続き利用できます。

このディレクトリはルートのワールドサーバー本体とは別の独立パッケージです。
会話状態は Chat SDK のインメモリ state を使いつつ、会話履歴そのものは `data/sessions/` に JSON 永続化します。

## できること

- Discord の通常メッセージやメンションに応答する
- 内蔵の karakuri-world 系ツールへ必要な JSON object を渡して、ワールド内の行動や情報取得を行う
- チャンネルごとに会話履歴を永続化する
- 日記 (`data/diary/`) と重要記憶 (`data/memories/`) を JSON で保存する
- 保存済みの重要記憶と直近の日記を、各ターンで読み込まれる system prompt に自動で連結する
- Discord Gateway listener と webhook サーバーを同一プロセスで動かす

同じチャンネルに短時間で複数メッセージが届いた場合は、チャンネル単位で順番に処理します。
先に届いたメッセージの応答が終わってから次のメッセージを会話履歴へ反映するため、応答順が入れ替わらないようにしています。

## 前提条件

- Node.js 20 以上
- 起動済みの `karakuri-world` サーバー
- Discord application / bot の資格情報
- OpenAI 互換 API の資格情報
- `karakuri-world` 管理 API で発行したエージェント API キー
- `karakuri-world` REST API の base URL（例: `http://127.0.0.1:3000/api`）

この companion package では MCP エンドポイント URL は不要です。

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
`personality.md` と `skills/` 配下のスキルを増やせば、新しい agent を作れます。

各 `skills/{skill-name}/SKILL.md` は callable skill guide として読み込まれ、モデルには name / description が先に公開されます。
一方でワールド操作そのものは、agent package に内蔵された karakuri-world 系の専用ツールが担当します。
各 `SKILL.md` には「どのツールを選び、どの JSON object を渡すか」を書いてください。

```text
agents/
  adventurer/
    personality.md
    skills/
      karakuri-world/
        SKILL.md
  scholar/
    personality.md
    skills/
      karakuri-world/
        SKILL.md
```

別名で増やす場合の例:

```bash
cp -R agents/adventurer agents/my-agent
```

スターターを編集してもよいですし、必要ならルートリポジトリの `skills/` から内容を抜粋して `skills/` 配下のスキルを追加・編集してください。

### 4. karakuri-world にエージェントを登録する

ルートの `karakuri-world` サーバーを起動したうえで、管理 API からエージェントを登録します。

```bash
curl -X POST http://127.0.0.1:3000/api/admin/agents \
  -H "X-Admin-Key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"adventurer","discord_bot_id":"123456789012345678"}'
```

ここで返る `api_key` を `KARAKURI_API_KEY` に、`api_base_url` を `KARAKURI_API_BASE_URL` に設定します。
通常のローカル構成では `api_base_url` は `http://127.0.0.1:3000/api` です。
`discord_bot_id` には、この agent 用 Discord bot の user ID を指定してください。

### 5. `.env` を編集する

`.env.example` にはローカル起動用のひな形を入れてあります。
`.env.compose.example` と対応するように、共通設定と単一 agent 設定を同じ粒度で並べています。
最低限、以下は実値に置き換えてください。

```bash
OPENAI_API_KEY=your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
KARAKURI_API_BASE_URL=http://127.0.0.1:3000/api
LOG_LEVEL=info

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
| `KARAKURI_API_BASE_URL` | Yes | `karakuri-world` REST API の base URL |
| `KARAKURI_API_KEY` | Yes | 管理 API で発行した agent API key |
| `LOG_LEVEL` | No | ログ出力レベル (`error`, `warn`, `info`, `debug`) |
| `AGENT_DIR` | Yes | `personality.md` と `skills/` を置いたディレクトリ |
| `BOT_NAME` | No | Chat SDK 上の bot 名 |
| `DATA_DIR` | No | 日記・記憶・セッションの保存先 |
| `PORT` | No | webhook サーバー待受ポート |

`AGENT_DIR=./agents/adventurer` のまま始めれば、同梱のスターター設定でまず起動確認できます。

### 6. 内蔵 karakuri-world 系ツール

ワールド関連の操作は、用途ごとに分かれた専用ツールで実行します。
各ツールには JSON object を 1 個だけ渡し、複数の操作を 1 回にまとめて送らないでください。
スターター `skills/karakuri-world/SKILL.md` もこの前提で書かれています。

| Tool | 用途 | 入力 JSON object |
| --- | --- | --- |
| `karakuri_world_get_perception` | 周囲の状況を確認する | `{}` |
| `karakuri_world_get_map` | マップ全体を確認する | `{}` |
| `karakuri_world_get_world_agents` | ログイン中エージェント一覧を見る | `{}` |
| `karakuri_world_get_available_actions` | 現在位置で実行できるアクションを調べる | `{}` |
| `karakuri_world_move` | 目的地ノードへ移動する | `{ "target_node_id": "..." }` |
| `karakuri_world_action` | アクションを実行する | `{ "action_id": "..." }` |
| `karakuri_world_wait` | その場で待機する | `{ "duration_ms": 1000 }` |
| `karakuri_world_conversation_start` | 近くのエージェントへ話しかける | `{ "target_agent_id": "...", "message": "..." }` |
| `karakuri_world_conversation_accept` / `karakuri_world_conversation_reject` | 会話着信を受諾 / 拒否する | `{ "conversation_id": "..." }` |
| `karakuri_world_conversation_speak` | 会話中に発言する | `{ "conversation_id": "...", "message": "..." }` |
| `karakuri_world_server_event_select` | サーバーイベントの選択肢を選ぶ | `{ "server_event_id": "...", "choice_id": "..." }` |

呼び出しイメージ:

`karakuri_world_get_perception`

```json
{}
```

`karakuri_world_move`

```json
{ "target_node_id": "3-2" }
```

`karakuri_world_action`

```json
{ "action_id": "greet-gatekeeper" }
```

### 7. 起動する

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

### 8. Discord 側を設定する

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

- `KARAKURI_API_BASE_URL`
- `LOG_LEVEL`
- `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- `ADVENTURER_*` と `SCHOLAR_*` の Discord / Karakuri / OpenAI model 設定
- `ADVENTURER_BOT_NAME` / `SCHOLAR_BOT_NAME`
- `ADVENTURER_AGENT_DIR` / `SCHOLAR_AGENT_DIR`
- `ADVENTURER_DATA_DIR` / `SCHOLAR_DATA_DIR`
- `ADVENTURER_PORT` / `SCHOLAR_PORT`

デフォルトの `KARAKURI_API_BASE_URL` は、Docker コンテナからホスト上の `karakuri-world` に接続する想定で `http://host.docker.internal:3000/api` にしてあります。
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

## ライセンス

`karakuri-world-agent` を含むこのリポジトリは PolyForm Noncommercial License 1.0.0 で source-available として公開しています。非商用利用は [`../LICENSE`](../LICENSE) の条件に従って許可されます。

商用利用には、株式会社0235との別途書面契約が必要です。概要と問い合わせ先は [`../COMMERCIAL-LICENSING.md`](../COMMERCIAL-LICENSING.md) を参照してください。

商用ライセンスの問い合わせ先: <https://0235.co.jp/contact/>
