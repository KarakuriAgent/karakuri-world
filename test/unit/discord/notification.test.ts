import { describe, expect, it } from 'vitest';

import {
  formatActionCompletedMessage,
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
  formatMovementCompletedMessage,
  formatServerEventMessage,
  formatServerEventSelectedMessage,
  formatWaitCompletedMessage,
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
    const messages = [
      formatAgentLoggedInMessage(worldContext, '現在地: 2-2', skillName),
      formatMovementCompletedMessage(worldContext, '2-3', '広場', '現在地: 2-3', skillName),
      formatActionCompletedMessage(worldContext, '調べる', '古い歯車を見つけました。', '現在地: 2-2', skillName),
      formatWaitCompletedMessage(worldContext, 1000, '現在地: 2-2', skillName),
      formatConversationRequestedMessage(worldContext, 'Bob', 'こんにちは。', 'conversation-1', skillName),
      formatConversationRejectedMessage(worldContext, 'Bob', 'rejected', '現在地: 2-2', skillName),
      formatConversationReplyPromptMessage(worldContext, 'Bob', 'こんにちは。', 'conversation-1', skillName),
      formatConversationClosingPromptMessage(worldContext, 'Bob', 'またね。', 'conversation-1', skillName),
      formatConversationEndedMessage(worldContext, 'max_turns', '現在地: 2-2', skillName),
      formatConversationForcedEndedMessage(worldContext, 'Bob', '現在地: 2-2', skillName),
      formatServerEventMessage(
        worldContext,
        '不思議な装置',
        '古い装置が動き出しました。',
        [
          {
            choice_id: 'inspect',
            label: '調べる',
            description: '装置の仕組みを確認する',
          },
        ],
        'server-event-1',
        skillName,
      ),
      formatServerEventSelectedMessage(worldContext, '不思議な装置', '調べる', '現在地: 2-2', skillName),
      formatIdleReminderMessage(worldContext, 60000, '現在地: 2-2', skillName),
      formatConversationServerEventClosingPromptMessage(worldContext, '不思議な装置', 'conversation-1', skillName),
    ];

    for (const message of messages) {
      expectWorldContextHeader(message);
    }
  });

  it('formats actionable messages with the action prompt', () => {
    const message = formatActionCompletedMessage(
      worldContext,
      '調べる',
      '古い歯車を見つけました。',
      '現在地: 2-2',
      'karakuri-world',
    );

    expectWorldContextHeader(message);
    expect(message).toContain('「調べる」が完了しました。');
    expect(message).toContain('古い歯車を見つけました。');
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

  it('formats conversation prompts with the action prompt', () => {
    const skillName = 'karakuri-world';
    const conversation = formatConversationRequestedMessage(worldContext, 'Alice', 'こんにちは。', 'conversation-1', skillName);
    const reply = formatConversationReplyPromptMessage(worldContext, 'Alice', 'こんにちは。', 'conversation-1', skillName);
    const closing = formatConversationClosingPromptMessage(worldContext, 'Alice', 'またね。', 'conversation-1', skillName);
    const serverEventClosing = formatConversationServerEventClosingPromptMessage(
      worldContext,
      '不思議な装置',
      'conversation-1',
      skillName,
    );

    expectWorldContextHeader(conversation);
    expect(conversation).toContain('Alice が話しかけています。');
    expect(conversation).toContain('conversation_id: conversation-1');
    expect(conversation).toContain('karakuri-world スキルで次の行動を選択してください。');

    expectWorldContextHeader(reply);
    expect(reply).toContain('Alice: 「こんにちは。」');
    expect(reply).toContain('返答してください。');
    expect(reply).toContain('conversation_id: conversation-1');
    expect(reply).toContain('karakuri-world スキルで次の行動を選択してください。');

    expectWorldContextHeader(closing);
    expect(closing).toContain('Alice: 「またね。」');
    expect(closing).toContain('これが最後のメッセージです。お別れのメッセージを送ってください。');
    expect(closing).toContain('conversation_id: conversation-1');
    expect(closing).toContain('karakuri-world スキルで次の行動を選択してください。');

    expectWorldContextHeader(serverEventClosing);
    expect(serverEventClosing).toContain('サーバーイベント「不思議な装置」の選択により会話を終了します。');
    expect(serverEventClosing).toContain('お別れのメッセージを送ってください。');
    expect(serverEventClosing).toContain('conversation_id: conversation-1');
    expect(serverEventClosing).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats server event messages with the action prompt', () => {
    const serverEvent = formatServerEventMessage(
      worldContext,
      '不思議な装置',
      '古い装置が動き出しました。',
      [
        {
          choice_id: 'inspect',
          label: '調べる',
          description: '装置の仕組みを確認する',
        },
      ],
      'server-event-1',
      'karakuri-world',
    );

    expectWorldContextHeader(serverEvent);
    expect(serverEvent).toContain('【サーバーイベント】不思議な装置');
    expect(serverEvent).toContain('inspect: 調べる - 装置の仕組みを確認する');
    expect(serverEvent).toContain('server_event_id: server-event-1');
    expect(serverEvent).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats world log conversation messages', () => {
    expect(formatWorldLogConversationMessage('Alice', 'こんにちは。')).toBe('Alice: 「こんにちは。」');
  });
});
