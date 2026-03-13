import { describe, expect, it } from 'vitest';

import {
  formatActionCompletedMessage,
  formatAgentLeftMessage,
  formatConversationRequestedMessage,
  formatServerEventMessage,
  formatWorldLogLeft,
} from '../../../src/discord/notification.js';

describe('discord notifications', () => {
  it('formats actionable messages with the action prompt', () => {
    const message = formatActionCompletedMessage('調べる', '古い歯車を見つけました。', '現在地: 2-2', 'karakuri-world');

    expect(message).toContain('「調べる」が完了しました。');
    expect(message).toContain('古い歯車を見つけました。');
    expect(message).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats agent left messages based on cancelled state', () => {
    expect(formatAgentLeftMessage('idle')).toBe('退出しました。');
    expect(formatAgentLeftMessage('moving')).toBe('移動をキャンセルし、退出しました。');
    expect(formatAgentLeftMessage('in_action', '調べる')).toBe('「調べる」をキャンセルし、退出しました。');
    expect(formatAgentLeftMessage('in_action')).toBe('待機をキャンセルし、退出しました。');
    expect(formatAgentLeftMessage('in_conversation')).toBe('会話を終了し、退出しました。');
  });

  it('formats world log left messages based on cancelled state', () => {
    expect(formatWorldLogLeft('Alice', 'idle')).toBe('Alice が世界から退出しました');
    expect(formatWorldLogLeft('Alice', 'moving')).toBe('Alice が移動をキャンセルし、退出しました');
    expect(formatWorldLogLeft('Alice', 'in_action', '調べる')).toBe('Alice が「調べる」をキャンセルし、退出しました');
    expect(formatWorldLogLeft('Alice', 'in_action')).toBe('Alice が待機をキャンセルし、退出しました');
    expect(formatWorldLogLeft('Alice', 'in_conversation')).toBe('Alice が会話を終了し、退出しました');
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
});
