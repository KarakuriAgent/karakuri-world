import { describe, expect, it } from 'vitest';

import {
  formatActionCompletedMessage,
  formatAvailableActionsInfoMessage,
  formatAgentLoggedInMessage,
  formatAgentLoggedOutMessage,
  formatConversationClosingPromptMessage,
  formatConversationEndedMessage,
  formatConversationForcedEndedMessage,
  formatConversationRejectedMessage,
  formatConversationRequestedMessage,
  formatConversationReplyPromptMessage,
  formatConversationServerEventClosingPromptMessage,
  formatIdleReminderMessage,
  formatMapInfoMessage,
  formatMovementCompletedMessage,
  formatPerceptionInfoMessage,
  formatServerEventMessage,
  formatWaitCompletedMessage,
  formatWorldAgentsInfoMessage,
  formatWorldLogConversationMessage,
  formatWorldLogLoggedOut,
  type WorldContext,
} from '../../../src/discord/notification.js';

const worldContext: WorldContext = {
  worldName: '桜木町',
  worldDescription: '歯車と蒸気が行き交う町です。',
  agentLabel: '時計守アリス',
};

function expectWorldContextHeader(message: string): void {
  expect(message).toContain('あなた (時計守アリス) は仮想世界「桜木町」にログインしています。');
  expect(message).toContain('歯車と蒸気が行き交う町です。');
}

describe('discord notifications', () => {
  it('includes world context in actionable agent notifications', () => {
    const skillName = 'karakuri-world';
    const choicesText = '選択肢:\n- move: ノードIDを指定して移動する';
    const messages = [
      formatAgentLoggedInMessage(worldContext, '現在地: 2-2', skillName, choicesText),
      formatMovementCompletedMessage(worldContext, '2-3', '広場', '現在地: 2-3', skillName, choicesText),
      formatActionCompletedMessage(worldContext, '調べる', undefined, '現在地: 2-2', skillName, choicesText),
      formatWaitCompletedMessage(worldContext, 1000, '現在地: 2-2', skillName, choicesText),
      formatConversationRequestedMessage(worldContext, 'Bob', 'こんにちは。', skillName),
      formatConversationRejectedMessage(worldContext, 'Bob', 'rejected', '現在地: 2-2', skillName, choicesText),
      formatConversationRejectedMessage(worldContext, 'Bob', 'server_event', '現在地: 2-2', skillName, choicesText),
      formatConversationReplyPromptMessage(worldContext, 'Bob', 'こんにちは。', skillName),
      formatConversationClosingPromptMessage(worldContext, 'Bob', 'またね。', skillName),
      formatConversationEndedMessage(worldContext, 'max_turns', '現在地: 2-2', skillName, choicesText),
      formatConversationForcedEndedMessage(worldContext, 'Bob', '現在地: 2-2', skillName, choicesText),
      formatServerEventMessage(worldContext, '古い装置が動き出しました。', skillName, choicesText),
      formatIdleReminderMessage(worldContext, 60000, '現在地: 2-2', skillName, choicesText),
      formatConversationServerEventClosingPromptMessage(worldContext, skillName),
      formatMapInfoMessage(worldContext, 'マップ: 3行 × 5列', skillName, choicesText),
      formatWorldAgentsInfoMessage(worldContext, '- Alice (agent-1) - 位置: 2-2 - 状態: idle', skillName, choicesText),
      formatPerceptionInfoMessage(worldContext, '現在地: 2-2', skillName, choicesText),
      formatAvailableActionsInfoMessage(worldContext, '実行可能なアクション:\n- 調べる', skillName, choicesText),
    ];

    for (const message of messages) {
      expectWorldContextHeader(message);
    }
  });

  it('formats actionable messages with the action prompt', () => {
    const message = formatActionCompletedMessage(
      worldContext,
      '調べる',
      undefined,
      '現在地: 2-2',
      'karakuri-world',
      '選択肢:\n- move: ノードIDを指定して移動する',
    );

    expectWorldContextHeader(message);
    expect(message).toContain('「調べる」が完了しました。');
    expect(message).toContain('選択肢:');
    expect(message).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats agent logout messages based on cancelled state', () => {
    expect(formatAgentLoggedOutMessage('idle')).toBe('ログアウトしました。');
    expect(formatAgentLoggedOutMessage('moving')).toBe('移動をキャンセルし、ログアウトしました。');
    expect(formatAgentLoggedOutMessage('in_action', '調べる')).toBe('「調べる」をキャンセルし、ログアウトしました。');
    expect(formatAgentLoggedOutMessage('in_action')).toBe('待機をキャンセルし、ログアウトしました。');
    expect(formatAgentLoggedOutMessage('in_conversation')).toBe('会話を終了し、ログアウトしました。');
  });

  it('formats world log logout messages based on cancelled state', () => {
    expect(formatWorldLogLoggedOut('Alice', 'idle')).toBe('Alice が世界からログアウトしました');
    expect(formatWorldLogLoggedOut('Alice', 'moving')).toBe('Alice が移動をキャンセルし、ログアウトしました');
    expect(formatWorldLogLoggedOut('Alice', 'in_action', '調べる')).toBe('Alice が「調べる」をキャンセルし、ログアウトしました');
    expect(formatWorldLogLoggedOut('Alice', 'in_action')).toBe('Alice が待機をキャンセルし、ログアウトしました');
    expect(formatWorldLogLoggedOut('Alice', 'in_conversation')).toBe('Alice が会話を終了し、ログアウトしました');
  });

  it('formats conversation prompts with choices', () => {
    const skillName = 'karakuri-world';
    const conversation = formatConversationRequestedMessage(worldContext, 'Alice', 'こんにちは。', skillName);
    const reply = formatConversationReplyPromptMessage(worldContext, 'Alice', 'こんにちは。', skillName);
    const closing = formatConversationClosingPromptMessage(worldContext, 'Alice', 'またね。', skillName);
    const serverEventClosing = formatConversationServerEventClosingPromptMessage(worldContext, skillName);

    expectWorldContextHeader(conversation);
    expect(conversation).toContain('Alice が話しかけています。');
    expect(conversation).toContain('選択肢:');
    expect(conversation).toContain('conversation_accept');
    expect(conversation).toContain('conversation_reject');
    expect(conversation).toContain('karakuri-world スキルで次の行動を選択してください。');

    expectWorldContextHeader(reply);
    expect(reply).toContain('Alice: 「こんにちは。」');
    expect(reply).toContain('選択肢:');
    expect(reply).toContain('conversation_speak');
    expect(reply).toContain('end_conversation');
    expect(reply).toContain('karakuri-world スキルで次の行動を選択してください。');

    const interrupted = formatConversationRejectedMessage(
      worldContext,
      'Alice',
      'server_event',
      '現在地: 2-2',
      skillName,
      '選択肢:\n- move: ノードIDを指定して移動する',
    );
    expect(interrupted).toContain('Alice との会話開始はサーバーイベントにより中断されました。');

    expectWorldContextHeader(closing);
    expect(closing).toContain('Alice: 「またね。」');
    expect(closing).toContain('これが最後のメッセージです。');
    expect(closing).toContain('選択肢:');
    expect(closing).toContain('conversation_speak');
    expect(closing).toContain('karakuri-world スキルで次の行動を選択してください。');

    expectWorldContextHeader(serverEventClosing);
    expect(serverEventClosing).toContain('サーバーイベントにより会話が終了します。');
    expect(serverEventClosing).toContain('選択肢:');
    expect(serverEventClosing).toContain('conversation_speak');
    expect(serverEventClosing).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats server event messages with the action prompt', () => {
    const serverEvent = formatServerEventMessage(
      worldContext,
      '古い装置が動き出しました。',
      'karakuri-world',
      '選択肢:\n- action: 調べる',
    );

    expectWorldContextHeader(serverEvent);
    expect(serverEvent).toContain('【サーバーイベント】');
    expect(serverEvent).toContain('古い装置が動き出しました。');
    expect(serverEvent).toContain('選択肢:\n- action: 調べる');
    expect(serverEvent).toContain('現在の行動をキャンセルして選択するか、この通知を無視してください。');
    expect(serverEvent).toContain('karakuri-world スキルで行動を選択してください。');
  });

  it('formats world log conversation messages', () => {
    expect(formatWorldLogConversationMessage('Alice', 'こんにちは。')).toBe('Alice: 「こんにちは。」');
  });
});
