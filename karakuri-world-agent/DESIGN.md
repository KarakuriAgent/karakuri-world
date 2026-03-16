# karakuri-world-agent 設計書

karakuri-world の動作確認用エージェントシステム。
Discord からの入力に対してLLMが応答し、MCP経由で karakuri-world を操作する。

## 技術スタック

| ライブラリ | バージョン | 用途 |
|---|---|---|
| `ai` | ^6.x | ToolLoopAgent, generateText |
| `@ai-sdk/openai` | ^1.x | OpenAI Chat API プロバイダー |
| `@ai-sdk/mcp` | ^0.x | karakuri-world MCPサーバー接続 |
| `chat` | ^1.x | 統一チャットボットフレームワーク |
| `@chat-adapter/discord` | ^1.x | Discord アダプター |
| `@chat-adapter/state-memory` | ^1.x | 開発用インメモリ状態管理 |
| `zod` | ^3.x | スキーマ定義 |
| `typescript` | ^5.x | 言語 |
| `tsx` | ^4.x | 開発時実行 |

## ディレクトリ構成

```
karakuri-world-agent/
├── DESIGN.md
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── agents/                          # エージェント個別設定 (ユーザーが作成)
│   ├── adventurer/
│   │   ├── personality.md           # 性格定義
│   │   └── SKILL.md                 # callable skill tool として読み込むスキル定義
│   └── scholar/
│       ├── personality.md
│       └── SKILL.md
├── src/
│   ├── index.ts                     # エントリポイント
│   ├── config.ts                    # 環境変数ベースの設定
│   ├── bot.ts                       # Chat SDK Discord Bot + Gateway loop
│   ├── server.ts                    # Discord webhook を受ける HTTP サーバー
│   ├── agent.ts                     # ToolLoopAgent + MCP統合
│   ├── compact.ts                   # Auto Compact helper
│   ├── keyed-task-runner.ts         # チャンネル単位の逐次実行キュー
│   ├── memory/
│   │   ├── diary.ts                 # 日記メモリ (その日のワールドでの行動記録)
│   │   └── important.ts            # 重要メモリ (ワールドで得た重要情報)
│   └── session/
│       └── channel-session.ts      # チャンネルID別の会話履歴管理 (永続化)
└── data/                            # 実行時データ (Docker volume, エージェントごとに独立)
    ├── diary/                       # 日記ファイル (YYYY-MM-DD.json)
    ├── memories/                    # 重要記憶ファイル ({id}.json)
    └── sessions/                    # セッションファイル ({channelId}.json)
```

## 環境変数

| 変数名 | 必須 | 説明 | デフォルト |
|---|---|---|---|
| `DISCORD_TOKEN` | Yes* | Discord Bot Token (`DISCORD_BOT_TOKEN` でも可) | — |
| `DISCORD_PUBLIC_KEY` | Yes | Discord Interactions の署名検証用公開鍵 | — |
| `DISCORD_APPLICATION_ID` | Yes | Discord Application ID | — |
| `DISCORD_MENTION_ROLE_IDS` | No | `@AI` のようなロールメンションも onNewMention 対象にしたい場合のロールID一覧 (カンマ区切り) | — |
| `OPENAI_API_KEY` | Yes | OpenAI API Key | — |
| `OPENAI_BASE_URL` | No | OpenAI互換APIのベースURL | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | No | 使用モデル | `gpt-4o` |
| `KARAKURI_MCP_URL` | Yes | karakuri-world MCPサーバーURL | — |
| `KARAKURI_API_KEY` | Yes | karakuri-world エージェントAPIキー | — |
| `AGENT_DIR` | Yes | エージェント設定ディレクトリパス | — |
| `BOT_NAME` | No | Discord上の表示名 | `karakuri-agent` |
| `DATA_DIR` | No | データ永続化ディレクトリ | `./data` |
| `PORT` | No | Discord webhook を受ける HTTP サーバーの待受ポート | `3000` |

\* `DISCORD_TOKEN` または `DISCORD_BOT_TOKEN` のどちらか一方が必要。

## エージェント設定ディレクトリ

ユーザーが `agents/{name}/` に以下のファイルを配置して起動する。

### personality.md

エージェントの性格・振る舞いを自由記述するシステムプロンプト。

```markdown
# 冒険者アレックス

あなたは陽気な冒険者アレックスです。
好奇心旺盛で、未知の場所を探索するのが大好きです。
誰とでもフレンドリーに話します。
```

### SKILL.md

karakuri-world の `skills/` ディレクトリからコピペして配置する。
エージェントはこのファイルの name / description を callable skill tool として公開し、本文は必要になったときだけツール経由でLLMに渡す。
スキルの実行自体はMCPツール（action等）経由で行う。MCP tool の公開は upfront に行うが、MCP クライアントの初期化と実際のツール解決は最初の MCP tool 実行時まで遅延する。

```markdown
# Available Skills

## 釣り
釣り場ノードで `action` ツールを使い `fishing` アクションを実行する。
結果に応じて魚が手に入る。

## 挨拶
近くにいるエージェントに `conversation_start` で話しかける。
...
```

## コンポーネント詳細

### 1. config.ts — 設定管理

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const agentDir = process.env.AGENT_DIR!;

function readAgentFile(filename: string): string | undefined {
  const filePath = join(agentDir, filename);
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined;
}

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN ?? process.env.DISCORD_BOT_TOKEN!,
    publicKey: process.env.DISCORD_PUBLIC_KEY!,
    applicationId: process.env.DISCORD_APPLICATION_ID!,
  },
  server: {
    port: Number(process.env.PORT ?? '3000'),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL ?? 'gpt-4o',
  },
  karakuri: {
    mcpUrl: process.env.KARAKURI_MCP_URL!,
    apiKey: process.env.KARAKURI_API_KEY!,
  },
  agent: {
    personality: readAgentFile('personality.md')
      ?? 'You are a helpful agent living in a virtual world.',
    skillTools: loadAgentSkills(agentDir),
    botName: process.env.BOT_NAME ?? 'karakuri-agent',
  },
  dataDir: process.env.DATA_DIR ?? './data',
};
```

### 2. agent.ts — ToolLoopAgent + MCP統合

MCPクライアントで karakuri-world に接続し、ツールを自動取得する。
MCP接続にはURLとAPIキーだけあればよく、ツール定義はサーバー側で管理されるためメンテ不要。

personality.md を instructions とし、`SKILL.md` は callable skill tool として公開する。
MCP tool 定義はローカル metadata で upfront 公開し、MCP クライアント生成とサーバー側ツール取得は最初の MCP tool 実行時まで遅延する。

```ts
import { ToolLoopAgent, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMCPClient } from '@ai-sdk/mcp';
import { config } from './config.js';
import { diaryTools } from './memory/diary.js';
import { importantMemoryTools } from './memory/important.js';

const openai = createOpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseURL,
});

// karakuri-world MCP接続 — URLだけでツール自動取得
const mcpClient = await createMCPClient({
  transport: {
    type: 'http',
    url: config.karakuri.mcpUrl,
    headers: { Authorization: `Bearer ${config.karakuri.apiKey}` },
  },
});

// personality と callable skill hint を組み合わせた instructions
const instructions = buildInstructions(
  config.agent.personality,
  config.agent.skillTools.length > 0,
);

export const agent = new ToolLoopAgent({
  model: openai.chat(config.openai.model),
  instructions,
  tools: {
    ...await mcpClient.tools(),   // karakuri-world ツール (自動取得)
    ...diaryTools,                 // 日記メモリツール
    ...importantMemoryTools,       // 重要メモリツール
  },
  stopWhen: [stepCountIs(10)],
});

export { mcpClient };
```

### 3. bot.ts — Discord Bot

Chat SDK + Discord アダプターで新規メッセージと継続メッセージに応答する。
最新の Discord adapter 仕様に合わせて HTTP webhook エンドポイントと Gateway listener を同一プロセスで動かす。
チャンネルごとの処理は逐次化し、会話履歴の順序を保つ。

```ts
import { Chat } from 'chat';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createMemoryState } from '@chat-adapter/state-memory';
import { config } from './config.js';
import { agent } from './agent.js';
import { ChannelSessionStore } from './session/channel-session.js';

const sessionStore = new ChannelSessionStore({ dataDir: config.dataDir });
const bot = new Chat({
  userName: config.agent.botName,
  adapters: {
    discord: createDiscordAdapter({
      botToken: config.discord.token,
      publicKey: config.discord.publicKey,
      applicationId: config.discord.applicationId,
      mentionRoleIds: config.discord.mentionRoleIds,
    }),
  },
  state: createMemoryState(), // Chat SDK 内部状態用。会話永続化は別レイヤーで担保
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  const session = sessionStore.getOrCreateSession(thread.channelId);
  await session.addUserMessage(message.text);

  const result = await agent.generate({
    messages: session.getMessages(),
  });

  await session.addAssistantMessage(result.text);
  await thread.post(result.text);
});

bot.onNewMessage(/[\s\S]+/, async (thread, message) => {
  await thread.subscribe();
  const session = sessionStore.getOrCreateSession(thread.channelId);
  await session.addUserMessage(message.text);

  const result = await agent.generate({
    messages: session.getMessages(),
  });

  await session.addAssistantMessage(result.text);
  await thread.post(result.text);
});

bot.onSubscribedMessage(async (thread, message) => {
  const session = sessionStore.getOrCreateSession(thread.channelId);
  await session.addUserMessage(message.text);

  const result = await agent.generate({
    messages: session.getMessages(),
  });

  await session.addAssistantMessage(result.text);
  await thread.post(result.text);
});

export async function handleDiscordWebhook(request: Request): Promise<Response> {
  return bot.webhooks.discord(request, {
    waitUntil(task) {
      void task;
    },
  });
}
```

### 4. session/channel-session.ts — チャンネル別セッション管理 (永続化)

Discord チャンネルIDをキーに会話履歴を管理する。
メッセージ追加のたびにファイルへ書き出し、起動時にファイルから復元する。
Docker volume がエージェントごとに独立しているため、エージェント単位で自動分離される。

保存先: `data/sessions/{channelId}.json`

```ts
import type { ModelMessage } from 'ai';
import {
  readFileSync, writeFileSync, readdirSync,
  mkdirSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const sessionsDir = join(config.dataDir, 'sessions');
const SESSION_TTL_MS = 30 * 60 * 1000; // 30分

interface SessionData {
  channelId: string;
  messages: ModelMessage[];
  lastActivity: number;
}

const sessions = new Map<string, SessionData>();

// 起動時: ファイルから全セッション復元
function loadAllSessions(): void {
  if (!existsSync(sessionsDir)) return;
  for (const file of readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
    try {
      const data: SessionData = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
      // TTL内のセッションのみ復元
      if (Date.now() - data.lastActivity < SESSION_TTL_MS) {
        sessions.set(data.channelId, data);
      }
    } catch {
      // 破損ファイルは無視
    }
  }
}

loadAllSessions();

// ファイルへ永続化
function persist(session: SessionData): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${session.channelId}.json`),
    JSON.stringify(session, null, 2),
  );
}

export function getOrCreateSession(channelId: string): {
  addUserMessage(text: string): void;
  addAssistantMessage(text: string): void;
  getMessages(): ModelMessage[];
} {
  let session = sessions.get(channelId);
  if (!session) {
    session = { channelId, messages: [], lastActivity: Date.now() };
    sessions.set(channelId, session);
  }
  session.lastActivity = Date.now();

  const s = session;
  return {
    addUserMessage(text: string) {
      s.messages.push({ role: 'user', content: text });
      s.lastActivity = Date.now();
      persist(s);
    },
    addAssistantMessage(text: string) {
      s.messages.push({ role: 'assistant', content: text });
      s.lastActivity = Date.now();
      persist(s);
    },
    getMessages(): ModelMessage[] {
      return [...s.messages];
    },
  };
}

// 期限切れセッション自動削除
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
      const filePath = join(sessionsDir, `${id}.json`);
      if (existsSync(filePath)) {
        const { unlinkSync } = require('node:fs');
        unlinkSync(filePath);
      }
    }
  }
}, 60_000);
```

### 5. compact.ts — Auto Compact

agent.generate の直前に呼び出して、メッセージ数が閾値を超えたら古いメッセージをLLMで要約し、
永続化済みセッションへ書き戻したうえでトークンを節約する。

```ts
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { config } from './config.js';

const MAX_MESSAGES = 20;
const KEEP_RECENT = 10;

const openai = createOpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseURL,
});

export async function compactConversation(messages: ModelMessage[]): Promise<ModelMessage[] | null> {
  if (messages.length <= MAX_MESSAGES) return null;

  const oldMessages = messages.slice(0, -KEEP_RECENT);
  const recentMessages = messages.slice(-KEEP_RECENT);

  const { text: summary } = await generateText({
    model: openai.chat(config.openai.model),
    messages: [
      {
        role: 'system',
        content:
          'Summarize the following conversation concisely in the same language. '
          + 'Preserve key facts, decisions, and context about the virtual world.',
      },
      ...oldMessages,
    ],
  });

  return [
    {
      role: 'system',
      content: `[Previous conversation summary]\n${summary}`,
    },
    ...recentMessages,
  ];
}
```

### 6. memory/diary.ts — 日記メモリ

ワールドでのその日の行動・体験を日記形式で記録するツール。
エージェントが自発的に「今日あったこと」を書き残す用途。

保存先: `data/diary/YYYY-MM-DD.json`

```ts
import { tool } from 'ai';
import { z } from 'zod';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const diaryDir = join(config.dataDir, 'diary');

export const diaryTools = {
  write_diary: tool({
    description:
      'ワールドでの今日の行動や出来事を日記として記録する。'
      + '「どこへ行った」「誰と話した」「何をした」「何を感じた」などを書く。'
      + '同じ日に複数回呼ぶと追記される。',
    inputSchema: z.object({
      content: z.string().describe('日記の内容'),
    }),
    execute: async ({ content }) => {
      mkdirSync(diaryDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(diaryDir, `${today}.json`);

      let entry: { date: string; entries: string[]; updatedAt: string };
      if (existsSync(filePath)) {
        entry = JSON.parse(readFileSync(filePath, 'utf-8'));
        entry.entries.push(content);
      } else {
        entry = { date: today, entries: [content], updatedAt: '' };
      }
      entry.updatedAt = new Date().toISOString();

      writeFileSync(filePath, JSON.stringify(entry, null, 2));
      return { success: true, date: today, totalEntries: entry.entries.length };
    },
  }),

  read_diary: tool({
    description:
      '過去の日記を読む。日付指定で特定の日、未指定なら直近7日分を返す。',
    inputSchema: z.object({
      date: z.string().optional().describe('YYYY-MM-DD形式。省略時は直近7日分'),
    }),
    execute: async ({ date }) => {
      if (!existsSync(diaryDir)) return { entries: [] };

      if (date) {
        const filePath = join(diaryDir, `${date}.json`);
        if (!existsSync(filePath)) return { entries: [] };
        return { entries: [JSON.parse(readFileSync(filePath, 'utf-8'))] };
      }

      const entries = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const filePath = join(diaryDir, `${key}.json`);
        if (existsSync(filePath)) {
          entries.push(JSON.parse(readFileSync(filePath, 'utf-8')));
        }
      }
      return { entries };
    },
  }),
};
```

### 7. memory/important.ts — 重要メモリ

ワールドで得た重要な情報を長期記憶として保存するツール。
人間関係、場所の情報、約束、発見した事実などを記録する。

保存先: `data/memories/{id}.json`

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  readFileSync, writeFileSync, readdirSync,
  mkdirSync, existsSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const memoriesDir = join(config.dataDir, 'memories');

export const importantMemoryTools = {
  save_memory: tool({
    description:
      'ワールドで得た重要な情報を記憶する。'
      + '例: 「〇〇は鍛冶屋の場所を知っている」「北の森は夜に危険」'
      + '「△△と明日広場で会う約束をした」',
    inputSchema: z.object({
      content: z.string().describe('記憶する内容'),
      tags: z.array(z.string()).optional().describe('検索用タグ (人名、場所名など)'),
    }),
    execute: async ({ content, tags }) => {
      mkdirSync(memoriesDir, { recursive: true });
      const id = randomUUID();
      const memory = {
        id, content,
        tags: tags ?? [],
        createdAt: new Date().toISOString(),
      };
      writeFileSync(join(memoriesDir, `${id}.json`), JSON.stringify(memory, null, 2));
      return { success: true, id };
    },
  }),

  search_memories: tool({
    description: '保存した重要記憶をキーワードで検索する。',
    inputSchema: z.object({
      query: z.string().describe('検索キーワード (人名、場所名、出来事など)'),
    }),
    execute: async ({ query }) => {
      if (!existsSync(memoriesDir)) return { results: [] };
      const q = query.toLowerCase();
      const files = readdirSync(memoriesDir).filter(f => f.endsWith('.json'));
      const results = files
        .map(f => JSON.parse(readFileSync(join(memoriesDir, f), 'utf-8')))
        .filter(m =>
          m.content.toLowerCase().includes(q)
          || m.tags.some((t: string) => t.toLowerCase().includes(q)),
        );
      return { results };
    },
  }),

  list_memories: tool({
    description: '保存済みの重要記憶を全件一覧表示する。',
    inputSchema: z.object({}),
    execute: async () => {
      if (!existsSync(memoriesDir)) return { memories: [] };
      const files = readdirSync(memoriesDir).filter(f => f.endsWith('.json'));
      const memories = files.map(f =>
        JSON.parse(readFileSync(join(memoriesDir, f), 'utf-8')),
      );
      return { memories };
    },
  }),

  delete_memory: tool({
    description: '不要になった記憶を削除する。',
    inputSchema: z.object({
      id: z.string().describe('削除する記憶のID'),
    }),
    execute: async ({ id }) => {
      const filePath = join(memoriesDir, `${id}.json`);
      if (existsSync(filePath)) unlinkSync(filePath);
      return { success: true };
    },
  }),
};
```

### 8. index.ts — エントリポイント

```ts
import { config } from './config.js';
import { startBot } from './bot.js';
import { mcpClient } from './agent.js';
import { startServer } from './server.js';

const server = await startServer();
await startBot(server.localWebhookUrl);
console.log(`Agent "${config.agent.botName}" started on :${config.server.port}.`);

process.on('SIGINT', async () => {
  await server.close();
  await mcpClient.close();
  process.exit(0);
});
```

## Docker構成

### Dockerfile

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
RUN npx tsc
CMD ["node", "dist/index.js"]
```

### docker-compose.yml

```yaml
services:
  adventurer:
    build: .
    restart: unless-stopped
    environment:
      - DISCORD_TOKEN=${ADVENTURER_DISCORD_TOKEN}
      - DISCORD_PUBLIC_KEY=${ADVENTURER_DISCORD_PUBLIC_KEY}
      - DISCORD_APPLICATION_ID=${ADVENTURER_DISCORD_APPLICATION_ID}
      - DISCORD_MENTION_ROLE_IDS=${ADVENTURER_DISCORD_MENTION_ROLE_IDS:-}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_BASE_URL=${OPENAI_BASE_URL:-}
      - OPENAI_MODEL=${ADVENTURER_OPENAI_MODEL:-gpt-4o}
      - KARAKURI_MCP_URL=${KARAKURI_MCP_URL:-http://host.docker.internal:3000/mcp}
      - KARAKURI_API_KEY=${ADVENTURER_KARAKURI_API_KEY}
      - AGENT_DIR=/app/agent
      - BOT_NAME=${ADVENTURER_BOT_NAME:-adventurer}
      - DATA_DIR=/app/data
      - PORT=${ADVENTURER_PORT:-3101}
    extra_hosts:
      - host.docker.internal:host-gateway
    ports:
      - ${ADVENTURER_PORT:-3101}:${ADVENTURER_PORT:-3101}
    volumes:
      - ${ADVENTURER_AGENT_DIR:-./agents/adventurer}:/app/agent:ro
      - ${ADVENTURER_DATA_DIR:-./data/adventurer}:/app/data

  scholar:
    build: .
    restart: unless-stopped
    environment:
      - DISCORD_TOKEN=${SCHOLAR_DISCORD_TOKEN}
      - DISCORD_PUBLIC_KEY=${SCHOLAR_DISCORD_PUBLIC_KEY}
      - DISCORD_APPLICATION_ID=${SCHOLAR_DISCORD_APPLICATION_ID}
      - DISCORD_MENTION_ROLE_IDS=${SCHOLAR_DISCORD_MENTION_ROLE_IDS:-}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_BASE_URL=${OPENAI_BASE_URL:-}
      - OPENAI_MODEL=${SCHOLAR_OPENAI_MODEL:-gpt-4o-mini}
      - KARAKURI_MCP_URL=${KARAKURI_MCP_URL:-http://host.docker.internal:3000/mcp}
      - KARAKURI_API_KEY=${SCHOLAR_KARAKURI_API_KEY}
      - AGENT_DIR=/app/agent
      - BOT_NAME=${SCHOLAR_BOT_NAME:-scholar}
      - DATA_DIR=/app/data
      - PORT=${SCHOLAR_PORT:-3102}
    extra_hosts:
      - host.docker.internal:host-gateway
    ports:
      - ${SCHOLAR_PORT:-3102}:${SCHOLAR_PORT:-3102}
    volumes:
      - ${SCHOLAR_AGENT_DIR:-./agents/scholar}:/app/agent:ro
      - ${SCHOLAR_DATA_DIR:-./data/scholar}:/app/data
```

### エージェント追加手順

1. `agents/{name}/personality.md` を作成 (性格設定)
2. `agents/{name}/SKILL.md` を作成 (karakuri-worldのスキル定義をコピペ)
3. karakuri-world にエージェントを登録しAPIキーを取得
4. `.env.compose` に `ADVENTURER_*` / `SCHOLAR_*` を設定
5. 必要なら `docker-compose.yml` にサービスを追加
6. `docker compose --env-file .env.compose -f docker-compose.yml up -d` で起動

## データ永続化

compose 例では全データを `./data/{agent-name}/` に保存し、bind mount でエージェントごとに独立させる。
再起動しても全データが復元される。

```
data/
├── adventurer/
│   ├── diary/                     # 日記: ワールドでの行動記録
│   │   ├── 2026-03-15.json        #   その日の行動を追記形式で記録
│   │   └── 2026-03-16.json
│   ├── memories/                  # 重要記憶: ワールドで得た重要情報
│   │   ├── {uuid-1}.json          #   「〇〇は鍛冶屋の場所を知っている」
│   │   └── {uuid-2}.json          #   「北の森は夜に危険」
│   └── sessions/                  # セッション: チャンネル別会話履歴
│       ├── {channelId-1}.json     #   メッセージ追加のたびに書き出し
│       └── {channelId-2}.json     #   起動時にファイルから復元
└── scholar/
```

| データ種別 | 保存単位 | 永続化タイミング | 復元タイミング |
|---|---|---|---|
| 日記 | 日付 (YYYY-MM-DD) | write_diary実行時 | read_diary実行時 (都度読込) |
| 重要記憶 | 個別 (UUID) | save_memory実行時 | search/list実行時 (都度読込) |
| セッション | チャンネルID | メッセージ追加時 | 起動時に全件ロード |

## データフロー

```
Discord メッセージ
    │
    ▼
bot.ts (Chat SDK)
    │ channelId でセッション取得
    ▼
channel-session.ts (永続化)
    │ 会話履歴 (messages) — ファイルから復元 / ファイルへ書出し
    ▼
agent.ts (ToolLoopAgent)
    │
    ├─ compact.ts
    │   └─ メッセージ数 > 20 → 古いメッセージをLLM要約し、要約済み履歴を sessions に保存
    │
    ├─ MCP Tools (自動取得、メンテ不要)
    │   └─ move, action, wait, conversation_*, get_perception, ...
    │
    ├─ Diary Tools
    │   ├─ write_diary: 今日のワールドでの行動を記録 → data/diary/
    │   └─ read_diary: 過去の日記を読み返す ← data/diary/
    │
    └─ Important Memory Tools
        ├─ save_memory: 重要な発見・人間関係・約束を記録 → data/memories/
        ├─ search_memories: キーワードで記憶を検索 ← data/memories/
        ├─ list_memories: 全記憶一覧 ← data/memories/
        └─ delete_memory: 不要な記憶を削除
    │
    ▼
結果テキスト → Discord レスポンス

永続化:
  data/sessions/ ← セッション (メッセージ追加ごとに書出し、起動時に復元)
  data/diary/    ← 日記 (ツール実行時に読書き)
  data/memories/ ← 重要記憶 (ツール実行時に読書き)
```

## 設計上のポイント

- **Discord adapter は server 型で動かす**: HTTP webhook と Gateway listener を組み合わせて、Discord Interactions と通常メッセージの両方を扱う
- **MCP接続はURL+APIキーのみ**: ツール定義はkarakuri-world側が管理。サーバー側の更新が即座に反映されメンテ不要
- **Skills は callable tool 方式**: karakuri-worldのskills定義を `agents/{name}/SKILL.md` に配置し、name / description だけ先に公開する。本文とMCPツールの有効化は必要時に遅延実行し、ツール実行はMCPのactionツール経由
- **メモリはワールド体験専用**: 日記=その日の行動ログ、重要記憶=ワールドで得た情報。JSONファイルベースで永続化
- **全データがエージェント単位で分離**: Docker volume が独立しているため、日記・記憶・セッション全てがエージェントごとに自動分離
- **再起動耐性**: セッションは起動時にファイルから復元。メモリと日記は都度読込のため常に最新
- **Docker Compose で量産**: 共通イメージ1つ、agents/ディレクトリと環境変数の差し替えだけで新エージェント追加
