import { buildPerceptionText } from '../domain/perception.js';
import type { AgentState } from '../types/agent.js';
import type { PerceptionResponse } from '../types/api.js';
import type { ConversationClosureReason, ConversationRejectionReason } from '../types/conversation.js';
import type { ServerEventChoiceConfig } from '../types/server-event.js';

export interface WorldContext {
  worldName: string;
  worldDescription: string;
  agentLabel: string;
}

export function formatActionPrompt(skillName: string): string {
  return `※ テキストで直接返答せず、${skillName} スキルの指示に従い、適切なツールを使って行動してください。`;
}

function formatPromptInstruction(instruction: string, skillName: string, identifierLine: string): string {
  return [instruction, formatActionPrompt(skillName), identifierLine].join('\n');
}

function joinSections(...sections: Array<string | undefined>): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}

function formatReasonMessage(targetName: string, reason: ConversationRejectionReason): string {
  switch (reason) {
    case 'rejected':
      return `${targetName} が会話を拒否しました。`;
    case 'timeout':
      return `${targetName} が応答しませんでした。`;
    case 'target_logged_out':
      return `${targetName} が世界からログアウトしました。`;
  }
}

function formatTime(timestamp: number, timezone: string): string {
  return new Date(timestamp).toLocaleTimeString('ja-JP', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatClosureReason(reason: Exclude<ConversationClosureReason, 'partner_logged_out'>): string {
  switch (reason) {
    case 'max_turns':
      return '最大ターン数に到達しました';
    case 'turn_timeout':
      return '応答がタイムアウトしました';
    case 'server_event':
      return 'サーバーイベントにより終了しました';
  }
}

function formatChoiceLines(choices: ServerEventChoiceConfig[]): string {
  return choices.map((choice) => `  ${choice.choice_id}: ${choice.label} - ${choice.description}`).join('\n');
}

function formatWorldContextHeader(ctx: WorldContext): string {
  return `あなた (${ctx.agentLabel}) は仮想世界「${ctx.worldName}」にログインしています。\n${ctx.worldDescription}`;
}

export function formatPerceptionMessage(perception: PerceptionResponse): string {
  return buildPerceptionText(perception);
}

export function formatAgentLoggedInMessage(ctx: WorldContext, perceptionText: string, skillName: string): string {
  return joinSections(formatWorldContextHeader(ctx), '世界にログインしました。', perceptionText, formatActionPrompt(skillName));
}

export function formatMovementCompletedMessage(
  ctx: WorldContext,
  toNodeId: string,
  label: string | undefined,
  perceptionText: string,
  skillName: string,
): string {
  const destination = label ? `${toNodeId} (${label})` : toNodeId;
  return joinSections(formatWorldContextHeader(ctx), `${destination} に到着しました。`, perceptionText, formatActionPrompt(skillName));
}

export function formatActionCompletedMessage(
  ctx: WorldContext,
  actionName: string,
  resultDescription: string,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `「${actionName}」が完了しました。`,
    resultDescription,
    perceptionText,
    formatActionPrompt(skillName),
  );
}

export function formatWaitCompletedMessage(
  ctx: WorldContext,
  durationMs: number,
  perceptionText: string,
  skillName: string,
): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間待機しました。` : `${Math.floor(durationMs / 1000)}秒間待機しました。`;
  return joinSections(formatWorldContextHeader(ctx), durationText, perceptionText, formatActionPrompt(skillName));
}

export function formatConversationRequestedMessage(
  ctx: WorldContext,
  initiatorName: string,
  initialMessage: string,
  conversationId: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `${initiatorName} が話しかけています。`,
    `「${initialMessage}」`,
    formatPromptInstruction('会話を受諾するか拒否してください。', skillName, `conversation_id: ${conversationId}`),
  );
}

export function formatConversationAcceptedMessage(targetName: string): string {
  return `${targetName} が会話を受諾しました。相手の応答を待っています。`;
}

export function formatConversationRejectedMessage(
  ctx: WorldContext,
  targetName: string,
  reason: ConversationRejectionReason,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(formatWorldContextHeader(ctx), formatReasonMessage(targetName, reason), perceptionText, formatActionPrompt(skillName));
}

export function formatConversationReplyPromptMessage(
  ctx: WorldContext,
  speakerName: string,
  message: string,
  conversationId: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `${speakerName}: 「${message}」`,
    formatPromptInstruction('返答してください。', skillName, `conversation_id: ${conversationId}`),
  );
}

export function formatConversationClosingPromptMessage(
  ctx: WorldContext,
  speakerName: string,
  message: string,
  conversationId: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `${speakerName}: 「${message}」`,
    formatPromptInstruction(
      'これが最後のメッセージです。お別れのメッセージを送ってください。',
      skillName,
      `conversation_id: ${conversationId}`,
    ),
  );
}

export function formatConversationDeliveredClosingMessage(speakerName: string, message: string): string {
  return `${speakerName}: 「${message}」`;
}

export function formatConversationServerEventClosingPromptMessage(
  ctx: WorldContext,
  eventName: string,
  conversationId: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `サーバーイベント「${eventName}」の選択により会話を終了します。`,
    formatPromptInstruction('お別れのメッセージを送ってください。', skillName, `conversation_id: ${conversationId}`),
  );
}

export function formatConversationEndedMessage(
  ctx: WorldContext,
  reason: Exclude<ConversationClosureReason, 'partner_logged_out'>,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `会話が終了しました。（${formatClosureReason(reason)}）`,
    perceptionText,
    formatActionPrompt(skillName),
  );
}

export function formatConversationForcedEndedMessage(
  ctx: WorldContext,
  partnerName: string,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `${partnerName} が世界からログアウトしたため、会話が強制終了されました。`,
    perceptionText,
    formatActionPrompt(skillName),
  );
}

export function formatServerEventMessage(
  ctx: WorldContext,
  eventName: string,
  description: string,
  choices: ServerEventChoiceConfig[],
  serverEventId: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `【サーバーイベント】${eventName}\n${description}`,
    `選択肢:\n${formatChoiceLines(choices)}`,
    formatPromptInstruction('選択するか、無視してください。', skillName, `server_event_id: ${serverEventId}`),
  );
}

export function formatServerEventSelectedMessage(
  ctx: WorldContext,
  eventName: string,
  choiceLabel: string,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `サーバーイベント「${eventName}」で「${choiceLabel}」を選択しました。\n実行中の操作はキャンセルされました。`,
    perceptionText,
    formatActionPrompt(skillName),
  );
}

export function formatWorldLogLoggedIn(agentName: string): string {
  return `${agentName} が世界にログインしました`;
}

export function formatAgentLoggedOutMessage(cancelledState: AgentState, cancelledActionName?: string): string {
  switch (cancelledState) {
    case 'in_action':
      return cancelledActionName
        ? `「${cancelledActionName}」をキャンセルし、ログアウトしました。`
        : '待機をキャンセルし、ログアウトしました。';
    case 'moving':
      return '移動をキャンセルし、ログアウトしました。';
    case 'in_conversation':
      return '会話を終了し、ログアウトしました。';
    case 'idle':
      return 'ログアウトしました。';
  }
}

export function formatWorldLogLoggedOut(agentName: string, cancelledState: AgentState, cancelledActionName?: string): string {
  switch (cancelledState) {
    case 'in_action':
      if (cancelledActionName) {
        return `${agentName} が「${cancelledActionName}」をキャンセルし、ログアウトしました`;
      }
      return `${agentName} が待機をキャンセルし、ログアウトしました`;
    case 'moving':
      return `${agentName} が移動をキャンセルし、ログアウトしました`;
    case 'in_conversation':
      return `${agentName} が会話を終了し、ログアウトしました`;
    case 'idle':
      return `${agentName} が世界からログアウトしました`;
  }
}

export function formatWorldLogMovementStarted(agentName: string, nodeId: string, arrivesAt: number, timezone: string, label?: string): string {
  const destination = label ? `${nodeId} (${label})` : nodeId;
  return `${agentName} が ${destination} に向かっています（${formatTime(arrivesAt, timezone)} 到着予定）`;
}

export function formatWorldLogMovement(agentName: string, nodeId: string, label?: string): string {
  const destination = label ? `${nodeId} (${label})` : nodeId;
  return `${agentName} が ${destination} に到着しました`;
}

export function formatWorldLogActionStarted(agentName: string, actionName: string, completesAt: number, timezone: string): string {
  return `${agentName} が「${actionName}」を開始しました（${formatTime(completesAt, timezone)} 終了予定）`;
}

export function formatWorldLogAction(agentName: string, actionName: string): string {
  return `${agentName} が「${actionName}」を終了しました`;
}

export function formatWorldLogWaitStarted(agentName: string, durationMs: number, completesAt: number, timezone: string): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(durationMs / 1000)}秒間`;
  return `${agentName} が${durationText}の待機を開始しました（${formatTime(completesAt, timezone)} 終了予定）`;
}

export function formatWorldLogWait(agentName: string, durationMs: number): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(durationMs / 1000)}秒間`;
  return `${agentName} が${durationText}待機しました`;
}

export function formatWorldLogConversationStarted(initiatorName: string, targetName: string): string {
  return `${initiatorName} と ${targetName} の会話が始まりました`;
}

export function formatWorldLogConversationMessage(speakerName: string, message: string): string {
  return `${speakerName}: 「${message}」`;
}

export function formatWorldLogConversationEnded(initiatorName: string, targetName: string): string {
  return `${initiatorName} と ${targetName} の会話が終了しました`;
}

export function formatIdleReminderMessage(
  ctx: WorldContext,
  elapsedMs: number,
  perceptionText: string,
  skillName: string,
): string {
  const minutes = Math.floor(elapsedMs / 60000);
  const elapsedText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(elapsedMs / 1000)}秒間`;
  return joinSections(formatWorldContextHeader(ctx), `前回の行動から${elapsedText}が経過しました。`, perceptionText, formatActionPrompt(skillName));
}

export function formatWorldLogServerEvent(eventName: string, description: string): string {
  return `【サーバーイベント】${eventName}: ${description}`;
}
