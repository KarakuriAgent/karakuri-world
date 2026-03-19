import { describe, expect, it } from 'vitest';

import {
  formatActionCompletedMessage,
  formatAgentLoggedOutMessage,
  formatConversationClosingPromptMessage,
  formatConversationRequestedMessage,
  formatConversationReplyPromptMessage,
  formatConversationServerEventClosingPromptMessage,
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

  it('formats conversation prompts with the action prompt', () => {
    const skillName = 'karakuri-world';
    const conversation = formatConversationRequestedMessage('Alice', 'こんにちは。', 'conversation-1', skillName);
    const reply = formatConversationReplyPromptMessage('Alice', 'こんにちは。', 'conversation-1', skillName);
    const closing = formatConversationClosingPromptMessage('Alice', 'またね。', 'conversation-1', skillName);
    const serverEventClosing = formatConversationServerEventClosingPromptMessage('不思議な装置', 'conversation-1', skillName);

    expect(conversation).toContain('Alice が話しかけています。');
    expect(conversation).toContain('conversation_id: conversation-1');
    expect(conversation).toContain('karakuri-world スキルで次の行動を選択してください。');

    expect(reply).toContain('Alice: 「こんにちは。」');
    expect(reply).toContain('返答してください。');
    expect(reply).toContain('conversation_id: conversation-1');
    expect(reply).toContain('karakuri-world スキルで次の行動を選択してください。');

    expect(closing).toContain('Alice: 「またね。」');
    expect(closing).toContain('これが最後のメッセージです。お別れのメッセージを送ってください。');
    expect(closing).toContain('conversation_id: conversation-1');
    expect(closing).toContain('karakuri-world スキルで次の行動を選択してください。');

    expect(serverEventClosing).toContain('サーバーイベント「不思議な装置」の選択により会話を終了します。');
    expect(serverEventClosing).toContain('お別れのメッセージを送ってください。');
    expect(serverEventClosing).toContain('conversation_id: conversation-1');
    expect(serverEventClosing).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats server event messages with the action prompt', () => {
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
      'karakuri-world',
    );

    expect(serverEvent).toContain('【サーバーイベント】不思議な装置');
    expect(serverEvent).toContain('inspect: 調べる - 装置の仕組みを確認する');
    expect(serverEvent).toContain('server_event_id: server-event-1');
    expect(serverEvent).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats world log conversation messages', () => {
    expect(formatWorldLogConversationMessage('Alice', 'こんにちは。')).toBe('Alice: 「こんにちは。」');
  });
});
