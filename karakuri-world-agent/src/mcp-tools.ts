import type { JSONValue } from '@ai-sdk/provider';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { tool } from 'ai';
import { z } from 'zod';

import type { LazyMcpTool } from './lazy-mcp.js';

interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
}

export interface CreateMcpProxyToolsOptions {
  getRuntimeTools: () => Promise<Record<string, LazyMcpTool>>;
  resetRuntime?: () => Promise<void>;
}

const emptySchema = z.object({}).strict();

const MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: 'move',
    description:
      '指定した目的地ノードへ移動する。サーバーがBFSで最短経路を計算し、経路のマス数に応じた移動時間で一括移動する。idle状態でのみ実行可能。',
    inputSchema: z
      .object({
        target_node_id: z.string().regex(/^\d+-\d+$/),
      })
      .strict(),
  },
  {
    name: 'action',
    description: 'アクションを実行する。idle状態でのみ実行可能。利用可能なアクションはget_available_actionsで確認できる。',
    inputSchema: z
      .object({
        action_id: z.string().min(1),
      })
      .strict(),
  },
  {
    name: 'wait',
    description: '指定した時間（ミリ秒）だけその場で待機する。idle状態でのみ実行可能。',
    inputSchema: z
      .object({
        duration_ms: z.number().int().min(1).max(3600000),
      })
      .strict(),
  },
  {
    name: 'conversation_start',
    description:
      '他のエージェントに話しかけて会話を開始する。隣接または同一ノードにいるエージェントが対象。idle状態でのみ実行可能。',
    inputSchema: z
      .object({
        target_agent_id: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
  },
  {
    name: 'conversation_accept',
    description: '会話の着信を受諾する。',
    inputSchema: z
      .object({
        conversation_id: z.string().min(1),
      })
      .strict(),
  },
  {
    name: 'conversation_reject',
    description: '会話の着信を拒否する。',
    inputSchema: z
      .object({
        conversation_id: z.string().min(1),
      })
      .strict(),
  },
  {
    name: 'conversation_speak',
    description: '会話中に発言する。in_conversation状態で自分のターンのときのみ実行可能。',
    inputSchema: z
      .object({
        conversation_id: z.string().min(1),
        message: z.string().min(1),
      })
      .strict(),
  },
  {
    name: 'server_event_select',
    description: 'サーバーイベントの選択肢を選ぶ。',
    inputSchema: z
      .object({
        server_event_id: z.string().min(1),
        choice_id: z.string().min(1),
      })
      .strict(),
  },
  {
    name: 'get_available_actions',
    description: '現在位置で実行可能なアクションの一覧を取得する。',
    inputSchema: emptySchema,
  },
  {
    name: 'get_perception',
    description: '現在位置の知覚範囲内の情報を取得する。周囲のノード、エージェント、NPC、建物の情報を含む。',
    inputSchema: emptySchema,
  },
  {
    name: 'get_map',
    description: 'マップ全体の構造情報を取得する。ノード構成、建物、NPCの配置を含む。',
    inputSchema: emptySchema,
  },
  {
    name: 'get_world_agents',
    description: '世界にログイン中のすべてのエージェントの位置と状態を取得する。',
    inputSchema: emptySchema,
  },
];

function mcpToModelOutput({
  output,
}: {
  toolCallId: string;
  input: unknown;
  output: unknown;
}): ToolResultOutput {
  const result = output as {
    content?: Array<{ type: string; [key: string]: unknown }>;
  };

  if (!Array.isArray(result.content)) {
    return { type: 'json', value: result as JSONValue };
  }

  return {
    type: 'content',
    value: result.content.map((part) => {
      if (part.type === 'text' && 'text' in part) {
        return { type: 'text' as const, text: part.text as string };
      }

      if (part.type === 'image' && 'data' in part && 'mimeType' in part) {
        return {
          type: 'image-data' as const,
          data: part.data as string,
          mediaType: part.mimeType as string,
        };
      }

      return { type: 'text' as const, text: JSON.stringify(part) };
    }),
  };
}

function requireRuntimeTool(
  runtimeTools: Record<string, LazyMcpTool>,
  toolName: string,
): LazyMcpTool & Required<Pick<LazyMcpTool, 'execute'>> {
  const runtimeTool = runtimeTools[toolName];
  if (!runtimeTool?.execute) {
    throw new Error(`MCP tool "${toolName}" is not available.`);
  }

  return runtimeTool as LazyMcpTool & Required<Pick<LazyMcpTool, 'execute'>>;
}

function isMcpConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = 'code' in error ? error.code : undefined;
  if (code === -32002 || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return true;
  }

  return /not initialized/i.test(error.message);
}

export function createMcpProxyTools({
  getRuntimeTools,
  resetRuntime,
}: CreateMcpProxyToolsOptions) {
  return Object.fromEntries(
    MCP_TOOL_SPECS.map((toolSpec) => [
      toolSpec.name,
      tool({
        description: toolSpec.description,
        inputSchema: toolSpec.inputSchema,
        execute: async (input, options) => {
          try {
            const runtimeTool = requireRuntimeTool(await getRuntimeTools(), toolSpec.name);
            return await runtimeTool.execute(input, options);
          } catch (error) {
            if (!resetRuntime || !isMcpConnectionError(error)) {
              throw error;
            }

            await resetRuntime();
            const runtimeTool = requireRuntimeTool(await getRuntimeTools(), toolSpec.name);
            return runtimeTool.execute(input, options);
          }
        },
        toModelOutput: mcpToModelOutput,
      }),
    ]),
  );
}
