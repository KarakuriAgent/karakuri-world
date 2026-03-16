import { describe, expect, it } from 'vitest';

import {
  formatActionCompletedMessage,
  formatAgentLoggedOutMessage,
  formatConversationRequestedMessage,
  formatServerEventMessage,
  formatWorldLogConversationMessage,
  formatWorldLogLoggedOut,
} from '../../../src/discord/notification.js';

describe('discord notifications', () => {
  it('formats actionable messages with the action prompt', () => {
    const message = formatActionCompletedMessage('調べる', '古い歯車を見つけました。', '現在地: 2-2', 'karakuri-world');

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

  it('formats conversation and server event messages', () => {
    const conversation = formatConversationRequestedMessage('Alice', 'こんにちは。', 'conversation-1');
    const serverEvent = formatServerEventMessage(
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
    );

    expect(conversation).toContain('Alice が話しかけています。');
    expect(conversation).toContain('conversation_id: conversation-1');
    expect(serverEvent).toContain('【サーバーイベント】不思議な装置');
    expect(serverEvent).toContain('inspect: 調べる - 装置の仕組みを確認する');
    expect(serverEvent).toContain('server_event_id: server-event-1');
  });

  it('formats world log conversation messages', () => {
    expect(formatWorldLogConversationMessage('Alice', 'こんにちは。')).toBe('Alice: 「こんにちは。」');
  });
});
