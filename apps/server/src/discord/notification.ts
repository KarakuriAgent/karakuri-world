import { buildPerceptionText } from '../domain/perception.js';
import type { AgentState } from '../types/agent.js';
import type { PerceptionResponse } from '../types/api.js';
import type { ConversationClosureReason, ConversationRejectionReason, PendingJoinCancelReason } from '../types/conversation.js';
import type { ItemType } from '../types/data-model.js';
import type { TransferCancelReason, TransferMode, TransferRejectReason } from '../types/transfer.js';

export interface WorldContext {
  worldName: string;
  worldDescription: string;
  agentName: string;
}

export interface ConversationParticipantInfo {
  id: string;
  name: string;
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

function formatConversationParticipants(participants: ConversationParticipantInfo[] = []): string | undefined {
  if (participants.length === 0) {
    return undefined;
  }
  return `参加者: ${participants.map((participant) => `${participant.name} (id: ${participant.id})`).join('、')}`;
}

function formatConversationChoices(
  mode: 'reply' | 'closing',
  group: boolean,
): string {
  const lines = ['選択肢:'];
  if (mode === 'reply') {
    lines.push('- conversation_speak: 返答する (message: 発言内容, next_speaker_agent_id: 次の話者ID, transfer?: { item: { item_id, quantity } } または { money: 正の整数 } のどちらか1つ, transfer_response?: accept|reject)');
    lines.push(group
      ? '- end_conversation: 会話から退出する (message: 最後の発言, next_speaker_agent_id: 次の話者ID)'
      : '- end_conversation: 会話を終了する (message: お別れのメッセージ, next_speaker_agent_id: 次の話者ID)');
  } else {
    lines.push('- conversation_speak: お別れのメッセージを送る (message: 発言内容, next_speaker_agent_id: 次の話者ID, transfer_response?: accept|reject)');
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
  participants: ConversationParticipantInfo[] = [],
): string {
  const group = participants.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participants),
    `${speakerName}: 「${message}」`,
    formatActionPrompt(skillName, formatConversationChoices('reply', group)),
  );
}

export function formatConversationClosingPromptMessage(
  ctx: WorldContext,
  speakerName: string,
  message: string,
  skillName: string,
  participants: ConversationParticipantInfo[] = [],
): string {
  const group = participants.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participants),
    `${speakerName}: 「${message}」`,
    'これが最後のメッセージです。',
    formatActionPrompt(skillName, formatConversationChoices('closing', group)),
  );
}

export function formatConversationDeliveredClosingMessage(speakerName: string, message: string): string {
  return `${speakerName}: 「${message}」`;
}

export function formatConversationServerEventClosingPromptMessage(
  ctx: WorldContext,
  skillName: string,
  participants: ConversationParticipantInfo[] = [],
): string {
  const group = participants.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participants),
    'サーバーイベントにより会話が終了します。',
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
  participants: ConversationParticipantInfo[] = [],
): string {
  const group = participants.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participants),
    'あなたの番です。',
    formatActionPrompt(skillName, formatConversationChoices('reply', group)),
  );
}

export function formatConversationTurnClosingPromptMessage(
  ctx: WorldContext,
  skillName: string,
  participants: ConversationParticipantInfo[] = [],
): string {
  const group = participants.length > 2;
  return joinSections(
    formatWorldContextHeader(ctx),
    formatConversationParticipants(participants),
    'あなたが最後のメッセージを送る番です。',
    formatActionPrompt(skillName, formatConversationChoices('closing', group)),
  );
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

function describePendingJoinCancelReason(reason: PendingJoinCancelReason): string {
  switch (reason) {
    case 'participant_logged_out':
      return '参加予定だった会話が、参加者のログアウトにより開始前に終了しました。';
    case 'max_turns':
      return '参加予定だった会話が最大ターン数に到達して終了したため、会話への参加は取り消されました。';
    case 'turn_timeout':
      return '参加予定だった会話が応答タイムアウトで終了したため、会話への参加は取り消されました。';
    case 'server_event':
      return '参加予定だった会話がサーバーイベントにより中断されたため、会話への参加は取り消されました。';
    case 'ended_by_agent':
      return '参加予定だった会話が参加者の終了要求により終了したため、会話への参加は取り消されました。';
    case 'agent_unavailable':
      return '会話への参加要求が、エージェント状態の不整合により取り消されました。';
  }
}

export function formatConversationPendingJoinCancelledMessage(
  ctx: WorldContext,
  reason: PendingJoinCancelReason,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    describePendingJoinCancelReason(reason),
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

function formatTransferSummary(item: { item_id: string; quantity: number } | null, money: number): string {
  if (item) {
    return `${item.item_id}×${item.quantity}`;
  }
  if (money > 0) {
    return `${money.toLocaleString('ja-JP')}円`;
  }
  return '(空)';
}

function formatTransferRejectReason(reason: TransferRejectReason): string {
  switch (reason.kind) {
    case 'rejected_by_receiver':
      return '受け取り側が拒否しました。';
    case 'unanswered_speak':
      return '受け取り側が発話で応答しなかったため自動拒否されました。';
    case 'inventory_full':
      return '受け取り側のインベントリが満杯で受け取れませんでした。';
  }
}

function formatTransferCancelReason(reason: TransferCancelReason): string {
  switch (reason) {
    case 'server_event':
      return 'サーバーイベントにより取り消されました。';
    case 'sender_logged_out':
      return '送信側がログアウトしたため取り消されました。';
    case 'receiver_logged_out':
      return '受信側がログアウトしたため取り消されました。';
    case 'conversation_closing':
      return '会話終了処理により取り消されました。';
    case 'participant_inactive':
      return '会話参加者の不応答により取り消されました。';
    case 'error':
      return 'エラーにより取り消されました。';
  }
}

export function formatTransferRequestedMessage(
  ctx: WorldContext,
  fromName: string,
  item: { item_id: string; quantity: number } | null,
  money: number,
  expiresAt: number,
  timezone: string,
  skillName: string,
  mode: TransferMode,
  transferId: string,
): string {
  const choices = mode === 'in_conversation'
    ? [
        '選択肢:',
        '- conversation_speak: 返答時に transfer_response: accept|reject を指定する',
        '- end_conversation: 会話を終える場合も transfer_response: accept|reject を同時指定する',
      ].join('\n')
    : [
        '選択肢:',
        `- accept_transfer: 譲渡を受け入れる (transfer_id: ${transferId})`,
        `- reject_transfer: 譲渡を拒否する (transfer_id: ${transferId})`,
      ].join('\n');
  return joinSections(
    formatWorldContextHeader(ctx),
    `${fromName} から ${formatTransferSummary(item, money)} の譲渡提案が届きました。`,
    `transfer_id: ${transferId}`,
    `応答期限: ${formatTime(expiresAt, timezone)}`,
    formatActionPrompt(skillName, choices),
  );
}

export function formatTransferSentMessage(toName: string, item: { item_id: string; quantity: number } | null, money: number): string {
  return `${toName} に ${formatTransferSummary(item, money)} の譲渡を提案しました。`;
}

export function formatTransferAcceptedMessage(name: string, item: { item_id: string; quantity: number } | null, money: number, received: boolean): string {
  return received
    ? `${name} から ${formatTransferSummary(item, money)} を受け取りました。`
    : `${name} が ${formatTransferSummary(item, money)} の譲渡を受け取りました。`;
}

export function formatTransferRejectedMessage(name: string, reason: TransferRejectReason, received: boolean): string {
  return received
    ? `${name} からの譲渡を処理できませんでした。${formatTransferRejectReason(reason)}`
    : `${name} への譲渡は成立しませんでした。${formatTransferRejectReason(reason)}`;
}

export function formatTransferTimeoutMessage(name: string, received: boolean): string {
  return received
    ? `${name} からの譲渡は応答期限切れになりました。`
    : `${name} への譲渡は応答期限切れになりました。`;
}

export function formatTransferCancelledMessage(name: string, reason: TransferCancelReason, received: boolean): string {
  return received
    ? `${name} からの譲渡は取り消されました。${formatTransferCancelReason(reason)}`
    : `${name} への譲渡は取り消されました。${formatTransferCancelReason(reason)}`;
}

export function formatTransferEscrowLostMessage(name: string): string {
  return `${name} との譲渡で返却処理に失敗しました。管理者確認が必要です。`;
}

/**
 * standalone モードの譲渡が決着したあと、両者は idle に戻る。次の行動を選べるように
 * 結果メッセージ + perception + 選択肢を含むプロンプトを返す。in_conversation モード
 * では会話フローが次のターンを案内するので、こちらは不要。
 */
export function formatTransferAcceptedPrompt(
  ctx: WorldContext,
  partnerName: string,
  item: { item_id: string; quantity: number } | null,
  money: number,
  received: boolean,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    formatTransferAcceptedMessage(partnerName, item, money, received),
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatTransferRejectedPrompt(
  ctx: WorldContext,
  partnerName: string,
  reason: TransferRejectReason,
  received: boolean,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    formatTransferRejectedMessage(partnerName, reason, received),
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatTransferTimeoutPrompt(
  ctx: WorldContext,
  partnerName: string,
  received: boolean,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    formatTransferTimeoutMessage(partnerName, received),
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
}

export function formatTransferCancelledPrompt(
  ctx: WorldContext,
  partnerName: string,
  reason: TransferCancelReason,
  received: boolean,
  perceptionText: string,
  skillName: string,
  choicesText?: string,
): string {
  return joinSections(
    formatWorldContextHeader(ctx),
    formatTransferCancelledMessage(partnerName, reason, received),
    perceptionText,
    formatActionPrompt(skillName, choicesText),
  );
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
    case 'in_transfer':
      return '譲渡処理を中断し、ログアウトしました。';
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
    case 'in_transfer':
      return '譲渡処理を中断し、ログアウトしました';
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

export function formatWorldLogTransferRequested(toName: string): string {
  return `${toName} に譲渡を提案しました`;
}

export function formatWorldLogTransferAccepted(name: string, received: boolean): string {
  return received ? `${name} からの譲渡を受け取りました` : `${name} が譲渡を受け取りました`;
}

export function formatWorldLogTransferRejected(name: string): string {
  return `${name} との譲渡は成立しませんでした`;
}

export function formatWorldLogTransferTimeout(name: string): string {
  return `${name} との譲渡は期限切れになりました`;
}

export function formatWorldLogTransferCancelled(name: string): string {
  return `${name} との譲渡は取り消されました`;
}

export function formatWorldLogTransferEscrowLost(name: string): string {
  return `${name} との譲渡で返却処理に失敗しました`;
}
