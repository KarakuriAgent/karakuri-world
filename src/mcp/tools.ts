import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { WorldEngine } from '../engine/world-engine.js';
import type { NodeId } from '../types/data-model.js';
import { createNotificationAcceptedResponse, WorldError, toErrorResponse } from '../types/api.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(arguments_: unknown): Promise<CallToolResult>;
}

const emptySchema = z.object({}).strict();
const nodeIdSchema = z.custom<NodeId>((value): value is NodeId => typeof value === 'string' && /^\d+-\d+$/.test(value));
const moveSchema = z
  .object({
    target_node_id: nodeIdSchema,
  })
  .strict();

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
      if (error instanceof z.ZodError) {
        return toToolError(new WorldError(400, 'invalid_request', 'Request validation failed.', error.flatten()));
      }

      if (error instanceof WorldError) {
        return toToolError(error);
      }

      throw error;
    }
  };
}

function emitInfoRequest(
  engine: WorldEngine,
  agentId: string,
  type: 'map_info_requested' | 'world_agents_info_requested' | 'perception_requested' | 'available_actions_requested',
) {
  if (!engine.state.getLoggedIn(agentId)) {
    throw new WorldError(403, 'not_logged_in', `Agent is not logged in: ${agentId}`);
  }

  engine.emitEvent({ type, agent_id: agentId });
  return createNotificationAcceptedResponse();
}

export function createMcpToolDefinitions(engine: WorldEngine, agentId: string): McpToolDefinition[] {
  return [
    {
      name: 'move',
      description:
        '指定した目的地ノードへ移動する。サーバーがBFSで最短経路を計算し、経路のマス数に応じた移動時間で一括移動する。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。',
      inputSchema: moveSchema,
      execute: wrapTool(moveSchema, async (arguments_) => engine.move(agentId, arguments_)),
    },
    {
      name: 'action',
      description: 'アクションを実行する。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。利用可能なアクションは通知の選択肢で確認できる。',
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
      name: 'wait',
      description: 'その場で待機する。duration は 10分単位の整数（1=10分, 2=20分, ..., 6=60分）。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。',
      inputSchema: z
        .object({
          duration: z.number().int().min(1).max(6),
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            duration: z.number().int().min(1).max(6),
          })
          .strict(),
        async (arguments_) => engine.executeWait(agentId, arguments_),
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
      description: '会話の着信を受諾して返答する。',
      inputSchema: z
        .object({
          message: z.string().min(1),
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            message: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.acceptConversation(agentId, arguments_),
      ),
    },
    {
      name: 'conversation_reject',
      description: '会話の着信を拒否する。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.rejectConversation(agentId)),
    },
    {
      name: 'conversation_speak',
      description: '会話中に発言する。in_conversation状態で自分のターンのときのみ実行可能。',
      inputSchema: z
        .object({
          message: z.string().min(1),
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            message: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.speak(agentId, arguments_),
      ),
    },
    {
      name: 'end_conversation',
      description: '会話を自発的に終了する。お別れのメッセージを送り、相手の最後の返答を待って会話を終了する。',
      inputSchema: z
        .object({
          message: z.string().min(1),
        })
        .strict(),
      execute: wrapTool(
        z
          .object({
            message: z.string().min(1),
          })
          .strict(),
        async (arguments_) => engine.endConversation(agentId, arguments_),
      ),
    },
    {
      name: 'get_available_actions',
      description: '現在位置で実行可能なアクションを取得する。結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'available_actions_requested')),
    },
    {
      name: 'get_perception',
      description: '周囲の情報を取得する。結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'perception_requested')),
    },
    {
      name: 'get_map',
      description: 'マップ全体の情報を取得する。結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'map_info_requested')),
    },
    {
      name: 'get_world_agents',
      description: '全エージェントの位置と状態を取得する。結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'world_agents_info_requested')),
    },
  ];
}
