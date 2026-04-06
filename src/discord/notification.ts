import { buildPerceptionText } from '../domain/perception.js';
import type { AgentState } from '../types/agent.js';
import type { PerceptionResponse } from '../types/api.js';
import type { ConversationClosureReason, ConversationRejectionReason } from '../types/conversation.js';
import type { ItemType } from '../types/data-model.js';

export interface WorldContext {
  worldName: string;
  worldDescription: string;
  agentLabel: string;
}

export function formatActionPrompt(skillName: string, choicesText?: string): string {
  const prompt = `${skillName} スキルで次の行動を選択してください。`;
  return choicesText ? `${choicesText}\n\n${prompt}` : prompt;
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
    case 'server_event':
      return `${targetName} との会話開始はサーバーイベントにより中断されました。`;
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
    case 'ended_by_agent':
      return 'エージェントにより終了しました';
  }
}

function formatWorldContextHeader(ctx: WorldContext): string {
  return `あなた (${ctx.agentLabel}) は仮想世界「${ctx.worldName}」にログインしています。\n${ctx.worldDescription}`;
}

export function formatPerceptionMessage(perception: PerceptionResponse): string {
  return buildPerceptionText(perception);
}

export function formatAgentLoggedInMessage(
  ctx: WorldContext,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(formatWorldContextHeader(ctx), '世界にログインしました。', perceptionText, formatActionPrompt(skillName, choicesText));
}

export function formatMovementCompletedMessage(
  ctx: WorldContext,
  toNodeId: string,
  label: string | undefined,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  const destination = label ? `${toNodeId} (${label})` : toNodeId;
  return joinSections(formatWorldContextHeader(ctx), `${destination} に到着しました。`, perceptionText, formatActionPrompt(skillName, choicesText));
}

export function formatActionCompletedMessage(
  ctx: WorldContext,
  actionName: string,
  effectText: string | undefined,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `「${actionName}」が完了しました。`,
    effectText,
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatActionRejectedMessage(
  ctx: WorldContext,
  actionName: string,
  rejectionReason: string,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `「${actionName}」を実行できませんでした。${rejectionReason}。`,
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatWaitCompletedMessage(
  ctx: WorldContext,
  durationMs: number,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間待機しました。` : `${Math.floor(durationMs / 1000)}秒間待機しました。`;
  return joinSections(formatWorldContextHeader(ctx), durationText, perceptionText, formatActionPrompt(skillName, choicesText));
}

function formatItemUseVerb(itemType: ItemType): string {
  switch (itemType) {
    case 'food':
      return '食べました';
    case 'drink':
      return '飲みました';
    case 'general':
    case 'venue':
      return '使用しました';
  }
}

export function formatItemUseCompletedMessage(
  ctx: WorldContext,
  itemName: string,
  itemType: ItemType,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `「${itemName}」を${formatItemUseVerb(itemType)}。`,
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatItemUseVenueRejectedMessage(
  ctx: WorldContext,
  itemName: string,
  venueHints: string[],
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  const hintsText = venueHints.length > 0
    ? `${venueHints.join('、')} で利用できます。`
    : '';
  return joinSections(
    formatWorldContextHeader(ctx),
    `ここでは「${itemName}」を利用できません。${hintsText}`,
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatConversationRequestedMessage(
  ctx: WorldContext,
  initiatorName: string,
  initialMessage: string,
  skillName: string,
): string {
  const choices = [
    '選択肢:',
    '- conversation_accept: 会話を受諾して返答する (message: 発言内容)',
    '- conversation_reject: 会話を拒否する',
  ].join('\n');
  return joinSections(
    formatWorldContextHeader(ctx),
    `${initiatorName} が話しかけています。`,
    `「${initialMessage}」`,
    formatActionPrompt(skillName, choices),
  );
}

export function formatConversationAcceptedMessage(targetName: string): string {
  return `${targetName} が会話を受諾しました。返答しました。`;
}

export function formatConversationRejectedMessage(
  ctx: WorldContext,
  targetName: string,
  reason: ConversationRejectionReason,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    formatReasonMessage(targetName, reason),
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatConversationReplyPromptMessage(
  ctx: WorldContext,
  speakerName: string,
  message: string,
  skillName: string,
): string {
  const choices = [
    '選択肢:',
    '- conversation_speak: 返答する (message: 発言内容)',
    '- end_conversation: 会話を終了する (message: お別れのメッセージ)',
  ].join('\n');
  return joinSections(
    formatWorldContextHeader(ctx),
    `${speakerName}: 「${message}」`,
    formatActionPrompt(skillName, choices),
  );
}

export function formatConversationClosingPromptMessage(
  ctx: WorldContext,
  speakerName: string,
  message: string,
  skillName: string,
): string {
  const choices = [
    '選択肢:',
    '- conversation_speak: お別れのメッセージを送る (message: 発言内容)',
  ].join('\n');
  return joinSections(
    formatWorldContextHeader(ctx),
    `${speakerName}: 「${message}」`,
    'これが最後のメッセージです。',
    formatActionPrompt(skillName, choices),
  );
}

export function formatConversationDeliveredClosingMessage(speakerName: string, message: string): string {
  return `${speakerName}: 「${message}」`;
}

export function formatConversationServerEventClosingPromptMessage(
  ctx: WorldContext,
  skillName: string,
): string {
  const choices = [
    '選択肢:',
    '- conversation_speak: お別れのメッセージを送る (message: 発言内容)',
  ].join('\n');
  return joinSections(
    formatWorldContextHeader(ctx),
    'サーバーイベントにより会話が終了します。',
    formatActionPrompt(skillName, choices),
  );
}

export function formatConversationEndedMessage(
  ctx: WorldContext,
  reason: Exclude<ConversationClosureReason, 'partner_logged_out'>,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `会話が終了しました。（${formatClosureReason(reason)}）`,
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatConversationForcedEndedMessage(
  ctx: WorldContext,
  partnerName: string,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `${partnerName} が世界からログアウトしたため、会話が強制終了されました。`,
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatServerEventMessage(
  ctx: WorldContext,
  description: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `【サーバーイベント】\n${description}`,
    choicesText,
    '現在の行動をキャンセルして選択するか、この通知を無視してください。',
    `${skillName} スキルで行動を選択してください。`,
  );
}

export function formatMapInfoMessage(ctx: WorldContext, mapSummaryText: string, skillName: string, choicesText?: string): string {
  return joinSections(formatWorldContextHeader(ctx), mapSummaryText, formatActionPrompt(skillName, choicesText));
}

export function formatWorldAgentsInfoMessage(ctx: WorldContext, agentsText: string, skillName: string, choicesText?: string): string {
  return joinSections(formatWorldContextHeader(ctx), agentsText, formatActionPrompt(skillName, choicesText));
}

export function formatPerceptionInfoMessage(
  ctx: WorldContext,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(formatWorldContextHeader(ctx), perceptionText, formatActionPrompt(skillName, choicesText));
}

export function formatAvailableActionsInfoMessage(
  ctx: WorldContext,
  actionsText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(formatWorldContextHeader(ctx), actionsText, formatActionPrompt(skillName, choicesText));
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

export function formatWorldLogActionRejected(agentName: string, actionName: string, rejectionReason: string): string {
  if (rejectionReason.includes('所持金')) {
    return `${agentName} が「${actionName}」を試みたが、所持金が足りなかった`;
  }
  if (rejectionReason.includes('アイテム')) {
    return `${agentName} が「${actionName}」を試みたが、必要なアイテムが足りなかった`;
  }
  return `${agentName} が「${actionName}」を試みたが、実行できなかった`;
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

export function formatWorldLogItemUseStarted(agentName: string, itemName: string, completesAt: number, timezone: string): string {
  return `${agentName} が「${itemName}」の使用を開始しました（${formatTime(completesAt, timezone)} 終了予定）`;
}

export function formatWorldLogItemUseCompleted(agentName: string, itemName: string): string {
  return `${agentName} が「${itemName}」を使用しました`;
}

export function formatWorldLogItemUseVenueRejected(agentName: string, itemName: string): string {
  return `${agentName} が「${itemName}」を使おうとしたが、ここでは利用できなかった`;
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
  choicesText?: string,
): string {
  const minutes = Math.floor(elapsedMs / 60000);
  const elapsedText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(elapsedMs / 1000)}秒間`;
  return joinSections(
    formatWorldContextHeader(ctx),
    `前回の行動から${elapsedText}が経過しました。`,
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatWorldLogServerEvent(description: string): string {
  return `【サーバーイベント】${description}`;
}
