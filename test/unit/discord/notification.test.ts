import { describe, expect, it } from 'vitest';

import {
  formatActionCompletedMessage,
  formatConversationRequestedMessage,
  formatServerEventMessage,
} from '../../../src/discord/notification.js';

describe('discord notifications', () => {
  it('formats actionable messages with the action prompt', () => {
    const message = formatActionCompletedMessage('調べる', '古い歯車を見つけました。', '現在地: 2-2');

    expect(message).toContain('「調べる」が完了しました。');
    expect(message).toContain('古い歯車を見つけました。');
    expect(message).toContain('次の行動を選択してください。');
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
