import { buildPerceptionText } from '../domain/perception.js';
import type { AgentState } from '../types/agent.js';
import type { PerceptionResponse } from '../types/api.js';
import type { ConversationClosureReason, ConversationRejectionReason } from '../types/conversation.js';
import type { ItemType } from '../types/data-model.js';

export interface WorldContext {
  worldName: string;
  worldDescription: string;
  agentName: string;
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

function formatClosureReason(reason: Exclude<ConversationClosureReason, 'participant_logged_out'>): string {
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
  return `あなた (${ctx.agentName}) は仮想世界「${ctx.worldName}」にログインしています。\n${ctx.worldDescription}`;
}

function formatConversationParticipants(participantNames: string[] = []): string | undefined {
  if (participantNames.length === 0) {
    return undefined;
  }
  return `参加者: ${participantNames.join('、')}`;
}

function formatConversationChoices(
  mode: 'reply' | 'closing',
  group: boolean,
): string {
  const lines = ['選択肢:'];
  if (mode === 'reply') {
    lines.push(group
      ? '- conversation_speak: 返答する (message: 発言内容, next_speaker_agent_id: 次の話者ID)'
      : '- conversation_speak: 返答する (message: 発言内容)');
    lines.push(group
      ? '- end_conversation: 会話から退出する (message: 最後の発言, next_speaker_agent_id: 次の話者ID)'
      : '- end_conversation: 会話を終了する (message: お別れのメッセージ)');
  } else {
    lines.push(group
      ? '- conversation_speak: お別れのメッセージを送る (message: 発言内容, next_speaker_agent_id: 次の話者ID)'
      : '- conversation_speak: お別れのメッセージを送る (message: 発言内容)');
  }
  return lines.join('\n');
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
  participantNames: string[] = [],
): string {
  const group = participantNames.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participantNames),
    `${speakerName}: 「${message}」`,
    group ? '3人以上の会話では next_speaker_agent_id の指定が必要です。' : undefined,
    formatActionPrompt(skillName, formatConversationChoices('reply', group)),
  );
}

export function formatConversationClosingPromptMessage(
  ctx: WorldContext,
  speakerName: string,
  message: string,
  skillName: string,
  participantNames: string[] = [],
): string {
  const group = participantNames.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participantNames),
    `${speakerName}: 「${message}」`,
    'これが最後のメッセージです。',
    group ? '3人以上の会話では next_speaker_agent_id の指定が必要です。' : undefined,
    formatActionPrompt(skillName, formatConversationChoices('closing', group)),
  );
}

export function formatConversationDeliveredClosingMessage(speakerName: string, message: string): string {
  return `${speakerName}: 「${message}」`;
}

export function formatConversationServerEventClosingPromptMessage(
  ctx: WorldContext,
  skillName: string,
  participantNames: string[] = [],
): string {
  const group = participantNames.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participantNames),
    'サーバーイベントにより会話が終了します。',
    group ? '3人以上の会話では next_speaker_agent_id の指定が必要です。' : undefined,
    formatActionPrompt(skillName, formatConversationChoices('closing', group)),
  );
}

export function formatConversationFYIMessage(speakerName: string, message: string, nextSpeakerName?: string): string {
  return nextSpeakerName
    ? `${speakerName}: 「${message}」\n次は ${nextSpeakerName} の番です。`
    : `${speakerName}: 「${message}」`;
}

export function formatConversationTurnPromptMessage(
  ctx: WorldContext,
  skillName: string,
  participantNames: string[] = [],
): string {
  const group = participantNames.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participantNames),
    'あなたの番です。',
    group ? '3人以上の会話では next_speaker_agent_id の指定が必要です。' : undefined,
    formatActionPrompt(skillName, formatConversationChoices('reply', group)),
  );
}

export function formatConversationTurnClosingPromptMessage(
  ctx: WorldContext,
  skillName: string,
  participantNames: string[] = [],
): string {
  const group = participantNames.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participantNames),
    'あなたが最後のメッセージを送る番です。',
    group ? '3人以上の会話では next_speaker_agent_id の指定が必要です。' : undefined,
    formatActionPrompt(skillName, formatConversationChoices('closing', group)),
  );
}

export function formatConversationJoinSystemMessage(agentName: string, message: string): string {
  return `🔔 ${agentName} が会話に参加しました。\n「${message}」`;
}

export function formatConversationLeaveSystemMessage(agentName: string, message?: string, nextSpeakerName?: string): string {
  const base = [`🔔 ${agentName} が会話から離れました。`];
  if (message) {
    base.push(`「${message}」`);
  }
  if (nextSpeakerName) {
    base.push(`次は ${nextSpeakerName} の番です。`);
  }
  return base.join('\n');
}

export function formatConversationInactiveCheckMessage(ctx: WorldContext, skillName: string): string {
  const choices = [
    '選択肢:',
    '- conversation_stay: 会話に残る',
    '- conversation_leave: 会話から離れる (message: 任意)',
  ].join('\n');
  return joinSections(
    formatWorldContextHeader(ctx),
    'しばらく会話に関与していないため、会話を続けるか確認しています。',
    formatActionPrompt(skillName, choices),
  );
}

export function formatConversationThreadName(initiatorName: string, targetName: string, extraCount: number): string {
  return extraCount > 0 ? `${initiatorName} と ${targetName} 他${extraCount}名` : `${initiatorName} と ${targetName}`;
}

export function formatConversationEndedMessage(
  ctx: WorldContext,
  reason: Exclude<ConversationClosureReason, 'participant_logged_out'>,
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
  participantName: string,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    `${participantName} が世界からログアウトしたため、会話が強制終了されました。`,
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

export function formatWorldLogLoggedIn(): string {
  return '世界にログインしました';
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

export function formatWorldLogLoggedOut(cancelledState: AgentState, cancelledActionName?: string): string {
  switch (cancelledState) {
    case 'in_action':
      if (cancelledActionName) {
        return `「${cancelledActionName}」をキャンセルし、ログアウトしました`;
      }
      return '待機をキャンセルし、ログアウトしました';
    case 'moving':
      return '移動をキャンセルし、ログアウトしました';
    case 'in_conversation':
      return '会話を終了し、ログアウトしました';
    case 'idle':
      return '世界からログアウトしました';
  }
}

export function formatWorldLogMovementStarted(nodeId: string, arrivesAt: number, timezone: string, label?: string): string {
  const destination = label ? `${nodeId} (${label})` : nodeId;
  return `${destination} に向かっています（${formatTime(arrivesAt, timezone)} 到着予定）`;
}

export function formatWorldLogMovement(nodeId: string, label?: string): string {
  const destination = label ? `${nodeId} (${label})` : nodeId;
  return `${destination} に到着しました`;
}

export function formatWorldLogActionStarted(actionName: string, completesAt: number, timezone: string): string {
  return `「${actionName}」を開始しました（${formatTime(completesAt, timezone)} 終了予定）`;
}

export function formatWorldLogAction(actionName: string): string {
  return `「${actionName}」を終了しました`;
}

export function formatWorldLogActionRejected(actionName: string, rejectionReason: string): string {
  if (rejectionReason.includes('所持金')) {
    return `「${actionName}」を試みたが、所持金が足りなかった`;
  }
  if (rejectionReason.includes('アイテム')) {
    return `「${actionName}」を試みたが、必要なアイテムが足りなかった`;
  }
  return `「${actionName}」を試みたが、実行できなかった`;
}

export function formatWorldLogWaitStarted(durationMs: number, completesAt: number, timezone: string): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(durationMs / 1000)}秒間`;
  return `${durationText}の待機を開始しました（${formatTime(completesAt, timezone)} 終了予定）`;
}

export function formatWorldLogWait(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60000);
  const durationText = minutes >= 1 ? `${minutes}分間` : `${Math.floor(durationMs / 1000)}秒間`;
  return `${durationText}待機しました`;
}

export function formatWorldLogItemUseStarted(itemName: string, completesAt: number, timezone: string): string {
  return `「${itemName}」の使用を開始しました（${formatTime(completesAt, timezone)} 終了予定）`;
}

export function formatWorldLogItemUseCompleted(itemName: string): string {
  return `「${itemName}」を使用しました`;
}

export function formatWorldLogItemUseVenueRejected(itemName: string): string {
  return `「${itemName}」を使おうとしたが、ここでは利用できなかった`;
}

export function formatWorldLogConversationStarted(...participantNames: string[]): string {
  return `${participantNames.join(' と ')} の会話が始まりました`;
}

export function formatWorldLogConversationMessage(message: string): string {
  return `「${message}」`;
}

export function formatWorldLogConversationEnded(...participantNames: string[]): string {
  return `${participantNames.join(' と ')} の会話が終了しました`;
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
