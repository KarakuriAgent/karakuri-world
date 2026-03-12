import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError, toErrorResponse } from '../types/api.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(arguments_: unknown): Promise<CallToolResult>;
}

const emptySchema = z.object({}).strict();
const directionSchema = z.enum(['north', 'south', 'east', 'west']);

function toToolSuccess(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function toToolError(error: WorldError): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(toErrorResponse(error)),
      },
    ],
    isError: true,
  };
}

function wrapTool<TArguments>(
  schema: z.ZodType<TArguments>,
  handler: (arguments_: TArguments) => Promise<unknown> | unknown,
): (arguments_: unknown) => Promise<CallToolResult> {
  return async (arguments_: unknown) => {
    try {
      return toToolSuccess(await handler(schema.parse(arguments_)));
    } catch (error) {
      if (error instanceof WorldError) {
        return toToolError(error);
      }

      throw error;
    }
  };
}

export function createMcpToolDefinitions(engine: WorldEngine, agentId: string): McpToolDefinition[] {
  return [
    {
      name: 'join',
      description: '世界に参加する。スポーン地点に配置され、行動可能になる。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.joinAgent(agentId)),
    },
    {
      name: 'leave',
      description: '世界から退出する。移動・アクション・会話など進行中の活動はすべて中断される。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.leaveAgent(agentId)),
    },
    {
      name: 'move',
      description: '指定方向の隣接ノードへ移動する。idle状態でのみ実行可能。',
      inputSchema: z
        .object({
          direction: directionSchema,
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            direction: directionSchema,
          })
          .strict(),
        async (arguments_) => engine.move(agentId, arguments_),
      ),
    },
    {
      name: 'action',
      description: 'アクションを実行する。idle状態でのみ実行可能。利用可能なアクションはget_available_actionsで確認できる。',
      inputSchema: z
        .object({
          action_id: z.string().min(1),
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            action_id: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.executeAction(agentId, arguments_),
      ),
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
      execute: wrapTool(
        z
          .object({
            target_agent_id: z.string().min(1),
            message: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.startConversation(agentId, arguments_),
      ),
    },
    {
      name: 'conversation_accept',
      description: '会話の着信を受諾する。',
      inputSchema: z
        .object({
          conversation_id: z.string().min(1),
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            conversation_id: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.acceptConversation(agentId, arguments_),
      ),
    },
    {
      name: 'conversation_reject',
      description: '会話の着信を拒否する。',
      inputSchema: z
        .object({
          conversation_id: z.string().min(1),
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            conversation_id: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.rejectConversation(agentId, arguments_),
      ),
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
      execute: wrapTool(
        z
          .object({
            conversation_id: z.string().min(1),
            message: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.speak(agentId, arguments_),
      ),
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
      execute: wrapTool(
        z
          .object({
            server_event_id: z.string().min(1),
            choice_id: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.selectServerEvent(agentId, arguments_),
      ),
    },
    {
      name: 'get_available_actions',
      description: '現在位置で実行可能なアクションの一覧を取得する。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.getAvailableActions(agentId)),
    },
    {
      name: 'get_perception',
      description: '現在位置の知覚範囲内の情報を取得する。周囲のノード、エージェント、NPC、建物の情報を含む。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.getPerception(agentId)),
    },
    {
      name: 'get_map',
      description: 'マップ全体の構造情報を取得する。ノード構成、建物、NPCの配置を含む。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.getMap()),
    },
    {
      name: 'get_world_agents',
      description: '世界に参加中のすべてのエージェントの位置と状態を取得する。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.getWorldAgents()),
    },
  ];
}
