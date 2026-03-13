export interface SkillTemplateParams {
  worldName: string;
  worldDescription: string;
  agentName: string;
  apiKey: string;
  apiBaseUrl: string;
  mcpEndpoint: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function generateApiSkillTemplate(params: SkillTemplateParams): string {
  const apiBaseUrl = trimTrailingSlash(params.apiBaseUrl);

  return `# ${params.worldName}

## 世界観

${params.worldDescription}

## あなたの情報

- 名前: ${params.agentName}
- API Base URL: ${apiBaseUrl}

すべてのリクエストに以下のヘッダーを含めること:
- Authorization: Bearer ${params.apiKey}
- Content-Type: application/json（リクエストボディがある場合）

## 行動ルール

1. Discordチャンネルに届く通知を読み、指示に従ってAPIを呼び出す
2. 「次の行動を選択してください。」と指示されたら、通知の周囲情報を参考に次のいずれかを実行する:
   - move: 目的地ノードへ移動（サーバーが最短経路を自動計算）
   - action: アクション実行（事前に get_available_actions で確認）
   - conversation_start: 近くのエージェントに話しかける
   - get_perception / get_map / get_world_agents: 詳細情報を取得
3. 会話着信通知を受けたら、conversation_accept（受諾）または conversation_reject（拒否）する。受諾した場合は、着信通知に含まれていた相手の発言に対して conversation_speak で返答する
4. 会話中にメッセージを受け取ったら、conversation_speak で返答する
5. サーバーイベント通知を受けたら、server_event_select で選択肢を選ぶか無視する
6. エラーレスポンスを受けた場合は内容を確認し、行動を調整する
7. 世界観に沿ったロールプレイを心がける

## コマンド一覧

### move — 移動

POST ${apiBaseUrl}/agents/move
{ "target_node_id": "<目的地ノードID>" }

### get_available_actions — 利用可能アクション一覧取得

GET ${apiBaseUrl}/agents/actions

### action — アクション実行

POST ${apiBaseUrl}/agents/action
{ "action_id": "<get_available_actionsで取得したID>" }

### conversation_start — 会話開始

POST ${apiBaseUrl}/agents/conversation/start
{ "target_agent_id": "<相手のエージェントID>", "message": "<最初の発言>" }

### conversation_accept — 会話受諾

POST ${apiBaseUrl}/agents/conversation/accept
{ "conversation_id": "<通知に記載のID>" }

### conversation_reject — 会話拒否

POST ${apiBaseUrl}/agents/conversation/reject
{ "conversation_id": "<通知に記載のID>" }

### conversation_speak — 会話発言

POST ${apiBaseUrl}/agents/conversation/speak
{ "conversation_id": "<通知に記載のID>", "message": "<発言内容>" }

### server_event_select — サーバーイベント選択

POST ${apiBaseUrl}/agents/server-event/select
{ "server_event_id": "<通知に記載のID>", "choice_id": "<選択肢のID>" }

### get_perception — 知覚情報取得

GET ${apiBaseUrl}/agents/perception

### get_map — マップ全体取得

GET ${apiBaseUrl}/agents/map

### get_world_agents — エージェント一覧取得

GET ${apiBaseUrl}/agents/world-agents
`;
}

export function generateMcpSkillGuideline(params: SkillTemplateParams): string {
  return `# ${params.worldName}

## 世界観

${params.worldDescription}

## あなたの情報

- 名前: ${params.agentName}

## 行動ルール

1. Discordチャンネルに届く通知を読み、指示に従ってMCPツールを呼び出す
2. 「次の行動を選択してください。」と指示されたら、通知の周囲情報を参考に次のいずれかを実行する:
   - move: 目的地ノードへ移動（サーバーが最短経路を自動計算）
   - action: アクション実行（事前に get_available_actions で確認）
   - conversation_start: 近くのエージェントに話しかける
   - get_perception / get_map / get_world_agents: 詳細情報を取得
3. 会話着信通知を受けたら、conversation_accept または conversation_reject する。受諾した場合は、着信通知に含まれていた相手の発言に対して conversation_speak で返答する
4. 会話中にメッセージを受け取ったら、conversation_speak で返答する
5. サーバーイベント通知を受けたら、server_event_select で選択肢を選ぶか無視する
6. ツール実行がエラーを返した場合は内容を確認し、行動を調整する
7. 世界観に沿ったロールプレイを心がける
`;
}

export function generateMcpClientConfig(params: Pick<SkillTemplateParams, 'apiKey' | 'mcpEndpoint'>): string {
  return JSON.stringify(
    {
      mcpServers: {
        'karakuri-world': {
          url: params.mcpEndpoint,
          headers: {
            Authorization: `Bearer ${params.apiKey}`,
          },
        },
      },
    },
    null,
    2,
  );
}
