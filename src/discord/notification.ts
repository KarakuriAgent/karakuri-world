import { buildPerceptionText } from '../domain/perception.js';
import type { PerceptionResponse } from '../types/api.js';
import type { ConversationClosureReason, ConversationRejectionReason } from '../types/conversation.js';
import type { ServerEventChoiceConfig } from '../types/server-event.js';

export function formatActionPrompt(skillName: string): string {
  return `${skillName} スキルで次の行動を選択してください。`;
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
    case 'target_left':
      return `${targetName} が世界から退出しました。`;
  }
}

function formatClosureReason(reason: Exclude<ConversationClosureReason, 'partner_left'>): string {
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

export function formatPerceptionMessage(perception: PerceptionResponse): string {
  return buildPerceptionText(perception);
}

export function formatAgentJoinedMessage(perceptionText: string, skillName: string): string {
  return joinSections('世界に参加しました。', perceptionText, formatActionPrompt(skillName));
}

export function formatMovementCompletedMessage(toNodeId: string, label: string | undefined, perceptionText: string, skillName: string): string {
  const destination = label ? `${toNodeId} (${label})` : toNodeId;
  return joinSections(`${destination} に到着しました。`, perceptionText, formatActionPrompt(skillName));
}

export function formatActionCompletedMessage(
  actionName: string,
  resultDescription: string,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(`「${actionName}」が完了しました。`, resultDescription, perceptionText, formatActionPrompt(skillName));
}

export function formatWaitCompletedMessage(durationMs: number, perceptionText: string, skillName: string): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間待機しました。` : `${Math.floor(durationMs / 1000)}秒間待機しました。`;
  return joinSections(durationText, perceptionText, formatActionPrompt(skillName));
}

export function formatConversationRequestedMessage(
  initiatorName: string,
  initialMessage: string,
  conversationId: string,
): string {
  return joinSections(
    `${initiatorName} が話しかけています。`,
    `「${initialMessage}」`,
    `会話を受諾するか拒否してください。\nconversation_id: ${conversationId}`,
  );
}

export function formatConversationAcceptedMessage(targetName: string): string {
  return `${targetName} が会話を受諾しました。相手の応答を待っています。`;
}

export function formatConversationRejectedMessage(
  targetName: string,
  reason: ConversationRejectionReason,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(formatReasonMessage(targetName, reason), perceptionText, formatActionPrompt(skillName));
}

export function formatConversationReplyPromptMessage(
  speakerName: string,
  message: string,
  conversationId: string,
): string {
  return joinSections(`${speakerName}: 「${message}」`, `返答してください。\nconversation_id: ${conversationId}`);
}

export function formatConversationClosingPromptMessage(
  speakerName: string,
  message: string,
  conversationId: string,
): string {
  return joinSections(
    `${speakerName}: 「${message}」`,
    `これが最後のメッセージです。お別れのメッセージを送ってください。\nconversation_id: ${conversationId}`,
  );
}

export function formatConversationDeliveredClosingMessage(speakerName: string, message: string): string {
  return `${speakerName}: 「${message}」`;
}

export function formatConversationServerEventClosingPromptMessage(eventName: string, conversationId: string): string {
  return `サーバーイベント「${eventName}」の選択により会話を終了します。\nお別れのメッセージを送ってください。\nconversation_id: ${conversationId}`;
}

export function formatConversationEndedMessage(
  reason: Exclude<ConversationClosureReason, 'partner_left'>,
  perceptionText: string,
  skillName: string,
): string {
  return joinSections(`会話が終了しました。（${formatClosureReason(reason)}）`, perceptionText, formatActionPrompt(skillName));
}

export function formatConversationForcedEndedMessage(partnerName: string, perceptionText: string, skillName: string): string {
  return joinSections(`${partnerName} が世界から退出したため、会話が強制終了されました。`, perceptionText, formatActionPrompt(skillName));
}

export function formatServerEventMessage(
  eventName: string,
  description: string,
  choices: ServerEventChoiceConfig[],
  serverEventId: string,
): string {
  return joinSections(
    `【サーバーイベント】${eventName}\n${description}`,
    `選択肢:\n${formatChoiceLines(choices)}`,
    `選択するか、無視してください。\nserver_event_id: ${serverEventId}`,
  );
}

export function formatServerEventSelectedMessage(eventName: string, choiceLabel: string, perceptionText: string, skillName: string): string {
  return joinSections(
    `サーバーイベント「${eventName}」で「${choiceLabel}」を選択しました。\n実行中の操作はキャンセルされました。`,
    perceptionText,
    formatActionPrompt(skillName),
  );
}

export function formatWorldLogJoined(agentName: string): string {
  return `${agentName} が世界に参加しました`;
}

export function formatWorldLogLeft(agentName: string): string {
  return `${agentName} が世界から退出しました`;
}

export function formatWorldLogMovementStarted(agentName: string, nodeId: string, label?: string): string {
  const destination = label ? `${nodeId} (${label})` : nodeId;
  return `${agentName} が ${destination} に向かっています`;
}

export function formatWorldLogMovement(agentName: string, nodeId: string, label?: string): string {
  const destination = label ? `${nodeId} (${label})` : nodeId;
  return `${agentName} が ${destination} に到着しました`;
}

export function formatWorldLogActionStarted(agentName: string, actionName: string): string {
  return `${agentName} が「${actionName}」を開始しました`;
}

export function formatWorldLogAction(agentName: string, actionName: string): string {
  return `${agentName} が「${actionName}」を実行しました`;
}

export function formatWorldLogWaitStarted(agentName: string, durationMs: number): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(durationMs / 1000)}秒間`;
  return `${agentName} が${durationText}の待機を開始しました`;
}

export function formatWorldLogWait(agentName: string, durationMs: number): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(durationMs / 1000)}秒間`;
  return `${agentName} が${durationText}待機しました`;
}

export function formatWorldLogConversationStarted(initiatorName: string, targetName: string): string {
  return `${initiatorName} と ${targetName} の会話が始まりました`;
}

export function formatWorldLogConversationEnded(initiatorName: string, targetName: string): string {
  return `${initiatorName} と ${targetName} の会話が終了しました`;
}

export function formatIdleReminderMessage(elapsedMs: number, perceptionText: string, skillName: string): string {
  const minutes = Math.floor(elapsedMs / 60000);
  const elapsedText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(elapsedMs / 1000)}秒間`;
  return joinSections(`前回の行動から${elapsedText}が経過しました。`, perceptionText, formatActionPrompt(skillName));
}

export function formatWorldLogServerEvent(eventName: string, description: string): string {
  return `【サーバーイベント】${eventName}: ${description}`;
}
