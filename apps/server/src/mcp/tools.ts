import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { requireInfoCommandReadyAgent } from '../domain/agent-guards.js';
import type { WorldEngine } from '../engine/world-engine.js';
import type { NodeId } from '../types/data-model.js';
import type { InfoCommandChoice } from '../types/choices.js';
import { createNotificationAcceptedResponse, WorldError, toErrorResponse } from '../types/api.js';
import { transferAttachmentSchema, transferIdSchema, transferRequestSchema } from '../api/schemas/transfer.js';

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
const actionSchema = z
  .object({
    action_id: z.string().min(1),
    duration_minutes: z.number().int().min(1).max(10080).optional(),
  })
  .strict();
const nextSpeakerSchema = z.string().min(1);
const speakSchema = z.object({ message: z.string().min(1), next_speaker_agent_id: nextSpeakerSchema, transfer: transferAttachmentSchema.optional(), transfer_response: z.enum(['accept', 'reject']).optional(), }).strict();
const endConversationSchema = z.object({ message: z.string().min(1), next_speaker_agent_id: nextSpeakerSchema, transfer_response: z.enum(['accept', 'reject']).optional(), }).strict();
const transferRequestToolSchema = transferRequestSchema;
const transferResponseToolSchema = transferIdSchema;

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
  command: InfoCommandChoice,
  type: 'map_info_requested' | 'world_agents_info_requested' | 'perception_requested' | 'available_actions_requested',
) {
  requireInfoCommandReadyAgent(engine, agentId, command);
  engine.state.addExcludedInfoCommand(agentId, command);
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
      description:
        'アクションを実行する。所持金や必要アイテムが不足していても選択肢に表示されるが、実行結果は通知で届く。可変時間アクションでは duration_minutes を指定する。レスポンスは常に notification-accepted。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。',
      inputSchema: actionSchema,
      execute: wrapTool(actionSchema, async (arguments_) => engine.executeAction(agentId, arguments_)),
    },
    {
      name: 'use_item',
      description:
        '所持しているアイテムを使用する。アイテムを1つ消費する。アイテムをどう使うかはエージェント次第。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。',
      inputSchema: z.object({ item_id: z.string().min(1) }).strict(),
      execute: wrapTool(z.object({ item_id: z.string().min(1) }).strict(), async (arguments_) => engine.useItem(agentId, arguments_)),
    },
    {
      name: 'wait',
      description: 'その場で待機する。duration は 10分単位の整数（1=10分, 2=20分, ..., 6=60分）。通常はidle状態でのみ実行可能だが、アクティブなサーバーイベント通知の割り込みウィンドウ中のみ in_action / in_conversation からも実行できる。',
      inputSchema: z.object({ duration: z.number().int().min(1).max(6) }).strict(),
      execute: wrapTool(z.object({ duration: z.number().int().min(1).max(6) }).strict(), async (arguments_) => engine.executeWait(agentId, arguments_)),
    },
    {
      name: 'transfer',
      description: '隣接するエージェントへ「アイテム1種類 (item: { item_id, quantity })」または「お金 (money: 正の整数)」のどちらか1つを譲渡する。両方同時指定・両方未指定は不可。受信側は accept_transfer / reject_transfer で応答する。',
      inputSchema: transferRequestToolSchema,
      execute: wrapTool(transferRequestToolSchema, async (arguments_) => engine.startTransfer(agentId, arguments_)),
    },
    {
      name: 'accept_transfer',
      description: '保留中の譲渡を受諾する。',
      inputSchema: transferResponseToolSchema,
      execute: wrapTool(transferResponseToolSchema, async (arguments_) => engine.acceptTransfer(agentId, arguments_)),
    },
    {
      name: 'reject_transfer',
      description: '保留中の譲渡を拒否する。',
      inputSchema: transferResponseToolSchema,
      execute: wrapTool(transferResponseToolSchema, async (arguments_) => engine.rejectTransfer(agentId, arguments_)),
    },
    {
      name: 'conversation_start',
      description: '他のエージェントに話しかけて会話を開始する。隣接または同一ノードにいるエージェントが対象。idle状態でのみ実行可能。',
      inputSchema: z.object({ target_agent_id: z.string().min(1), message: z.string().min(1) }).strict(),
      execute: wrapTool(z.object({ target_agent_id: z.string().min(1), message: z.string().min(1) }).strict(), async (arguments_) => engine.startConversation(agentId, arguments_)),
    },
    {
      name: 'conversation_accept',
      description: '会話の着信を受諾して返答する。',
      inputSchema: z.object({ message: z.string().min(1) }).strict(),
      execute: wrapTool(z.object({ message: z.string().min(1) }).strict(), async (arguments_) => engine.acceptConversation(agentId, arguments_)),
    },
    {
      name: 'conversation_join',
      description: '近くで進行中の会話に参加する。会話IDを指定する。参加は次のターン境界で反映され、それまでは発言機会はない。',
      inputSchema: z.object({ conversation_id: z.string().min(1) }).strict(),
      execute: wrapTool(z.object({ conversation_id: z.string().min(1) }).strict(), async (arguments_) => engine.joinConversation(agentId, arguments_)),
    },
    {
      name: 'conversation_stay',
      description: 'inactive_check 通知に応答して会話に残る。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.stayInConversation(agentId)),
    },
    {
      name: 'conversation_leave',
      description: 'inactive_check 通知に応答して会話から離脱する。必要ならメッセージも付けられる。',
      inputSchema: z.object({ message: z.string().min(1).optional() }).strict(),
      execute: wrapTool(z.object({ message: z.string().min(1).optional() }).strict(), async (arguments_) => engine.leaveConversation(agentId, arguments_)),
    },
    {
      name: 'conversation_reject',
      description: '会話の着信を拒否する。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => engine.rejectConversation(agentId)),
    },
    {
      name: 'conversation_speak',
      description: '会話中に発言する。in_conversation状態で自分のターンのときのみ実行可能。next_speaker_agent_id で次の話者を指名する必要がある。',
      inputSchema: speakSchema,
      execute: wrapTool(speakSchema, async (arguments_) => engine.speak(agentId, arguments_)),
    },
    {
      name: 'end_conversation',
      description: '会話を終了または退出する。2人会話では message を最後のメッセージとして送り会話全体を終了する。3人以上の会話では自分だけ退出し、next_speaker_agent_id で残留話者を指名する。2人会話では next_speaker_agent_id は受け取るが使用されない。',
      inputSchema: endConversationSchema,
      execute: wrapTool(endConversationSchema, async (arguments_) => engine.endConversation(agentId, arguments_)),
    },
    {
      name: 'get_available_actions',
      description: '現在位置で実行可能なアクションを取得する。通常は idle かサーバーイベントウィンドウ中のみ実行可能で、結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'get_available_actions', 'available_actions_requested')),
    },
    {
      name: 'get_perception',
      description: '周囲の情報を取得する。通常は idle かサーバーイベントウィンドウ中のみ実行可能で、結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'get_perception', 'perception_requested')),
    },
    {
      name: 'get_map',
      description: 'マップ全体の情報を取得する。通常は idle かサーバーイベントウィンドウ中のみ実行可能で、結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'get_map', 'map_info_requested')),
    },
    {
      name: 'get_world_agents',
      description: '全エージェントの位置と状態を取得する。通常は idle かサーバーイベントウィンドウ中のみ実行可能で、結果は通知で届く。',
      inputSchema: emptySchema,
      execute: wrapTool(emptySchema, async () => emitInfoRequest(engine, agentId, 'get_world_agents', 'world_agents_info_requested')),
    },
  ];
}
