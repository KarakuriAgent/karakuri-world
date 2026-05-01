import { describe, expect, it } from 'vitest';

import {
  appendActiveServerEventHint,
  formatActionCompletedMessage,
  formatActiveServerEventCountHint,
  formatAvailableActionsInfoMessage,
  formatAgentLoggedInMessage,
  formatAgentLoggedOutMessage,
  formatConversationClosingPromptMessage,
  formatConversationEndedMessage,
  formatConversationFYIMessage,
  formatConversationForcedEndedMessage,
  formatConversationPendingJoinCancelledMessage,
  formatConversationRejectedMessage,
  formatConversationRequestedMessage,
  formatConversationReplyPromptMessage,
  formatConversationServerAnnouncementClosingPromptMessage,
  formatConversationTurnClosingPromptMessage,
  formatConversationTurnPromptMessage,
  formatIdleReminderMessage,
  formatInConversationTransferOutcomeLine,
  formatMapInfoMessage,
  formatMovementCompletedMessage,
  formatPerceptionInfoMessage,
  formatServerAnnouncementMessage,
  formatTransferAcceptedMessage,
  formatTransferRejectedMessage,
  formatWaitCompletedMessage,
  formatWorldAgentsInfoMessage,
  formatWorldLogConversationMessage,
  formatWorldLogLoggedOut,
  type WorldContext,
} from '../../../src/discord/notification.js';
import { createTestWorld } from '../../helpers/test-world.js';

const worldContext: WorldContext = {
  worldName: '桜木町',
  worldDescription: '歯車と蒸気が行き交う町です。',
  agentName: '時計守アリス',
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
      formatConversationRejectedMessage(worldContext, 'Bob', 'server_announcement', '現在地: 2-2', skillName, choicesText),
      formatConversationReplyPromptMessage(worldContext, 'Bob', 'こんにちは。', skillName),
      formatConversationClosingPromptMessage(worldContext, 'Bob', 'またね。', skillName),
      formatConversationEndedMessage(worldContext, 'max_turns', '現在地: 2-2', skillName, choicesText),
      formatConversationForcedEndedMessage(worldContext, 'Bob', '現在地: 2-2', skillName, choicesText),
      formatConversationPendingJoinCancelledMessage(worldContext, 'participant_logged_out', '現在地: 2-2', skillName, choicesText),
      formatServerAnnouncementMessage(worldContext, '古い装置が動き出しました。', skillName, choicesText),
      formatIdleReminderMessage(worldContext, 60000, '現在地: 2-2', skillName, choicesText),
      formatConversationServerAnnouncementClosingPromptMessage(worldContext, skillName),
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

  it('formats deferred join cancellation caused by logout', () => {
    const message = formatConversationPendingJoinCancelledMessage(
      worldContext,
      'participant_logged_out',
      '現在地: 2-2',
      'karakuri-world',
      '選択肢:\n- move: ノードIDを指定して移動する',
    );

    expectWorldContextHeader(message);
    expect(message).toContain('参加予定だった会話が、参加者のログアウトにより開始前に終了しました。');
    expect(message).toContain('選択肢:');
  });

  it('formats deferred join cancellation caused by agent state desynchronization', () => {
    const message = formatConversationPendingJoinCancelledMessage(
      worldContext,
      'agent_unavailable',
      '現在地: 2-2',
      'karakuri-world',
      '選択肢:\n- move: ノードIDを指定して移動する',
    );

    expectWorldContextHeader(message);
    expect(message).toContain('エージェント状態の不整合');
    expect(message).toContain('選択肢:');
  });

  it('formats world log logout messages based on cancelled state', () => {
    expect(formatWorldLogLoggedOut('idle')).toBe('世界からログアウトしました');
    expect(formatWorldLogLoggedOut('moving')).toBe('移動をキャンセルし、ログアウトしました');
    expect(formatWorldLogLoggedOut('in_action', '調べる')).toBe('「調べる」をキャンセルし、ログアウトしました');
    expect(formatWorldLogLoggedOut('in_action')).toBe('待機をキャンセルし、ログアウトしました');
    expect(formatWorldLogLoggedOut('in_conversation')).toBe('会話を終了し、ログアウトしました');
  });

  it('formats transfer settlement result messages', () => {
    expect(formatTransferAcceptedMessage('受取側', { item_id: 'popcorn', quantity: 1 }, 0, false)).toBe(
      '受取側 が popcorn×1を受け取りました。',
    );
    expect(formatTransferAcceptedMessage('送信側', { item_id: 'popcorn', quantity: 1 }, 0, true)).toBe(
      '送信側 から popcorn×1を受け取りました。',
    );
    expect(formatTransferRejectedMessage('受取側', { kind: 'rejected_by_receiver' }, false)).toBe(
      '受取を拒否しました。',
    );
    expect(formatTransferRejectedMessage('送信側', { kind: 'rejected_by_receiver' }, true)).toBe(
      '送信側が受取を拒否しました。',
    );
    expect(formatInConversationTransferOutcomeLine('受取側', { item_id: 'popcorn', quantity: 1 }, 0, 'accepted')).toBe(
      '受取側 が popcorn×1を受け取りました。',
    );
    expect(formatInConversationTransferOutcomeLine('受取側', { item_id: 'popcorn', quantity: 1 }, 0, 'rejected_by_receiver')).toBe(
      '受取側が受取を拒否しました。',
    );
  });

  it('formats conversation prompts with choices', () => {
    const skillName = 'karakuri-world';
    const participants = [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
      { id: 'carol', name: 'Carol' },
    ];
    const conversation = formatConversationRequestedMessage(worldContext, 'Alice', 'こんにちは。', skillName);
    const reply = formatConversationReplyPromptMessage(worldContext, 'Alice', 'こんにちは。', skillName);
    const closing = formatConversationClosingPromptMessage(worldContext, 'Alice', 'またね。', skillName);
    const turnPrompt = formatConversationTurnPromptMessage(worldContext, skillName, participants);
    const closingTurnPrompt = formatConversationTurnClosingPromptMessage(worldContext, skillName, participants);
    const serverAnnouncementClosing = formatConversationServerAnnouncementClosingPromptMessage(
      worldContext,
      skillName,
      participants,
    );

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
      'server_announcement',
      '現在地: 2-2',
      skillName,
      '選択肢:\n- move: ノードIDを指定して移動する',
    );
    expect(interrupted).toContain('Alice との会話開始はサーバーアナウンスにより中断されました。');

    expectWorldContextHeader(closing);
    expect(closing).toContain('Alice: 「またね。」');
    expect(closing).toContain('これが最後のメッセージです。');
    expect(closing).toContain('選択肢:');
    expect(closing).toContain('conversation_speak');
    expect(closing).toContain('karakuri-world スキルで次の行動を選択してください。');

    expectWorldContextHeader(turnPrompt);
    expect(turnPrompt).toContain('あなたの番です。');
    expect(turnPrompt).toContain('次の話者ID');
    expect(turnPrompt).toContain('end_conversation');

    expectWorldContextHeader(closingTurnPrompt);
    expect(closingTurnPrompt).toContain('あなたが最後のメッセージを送る番です。');
    expect(closingTurnPrompt).toContain('次の話者ID');
    expect(closingTurnPrompt).toContain('conversation_speak');

    expectWorldContextHeader(serverAnnouncementClosing);
    expect(serverAnnouncementClosing).toContain('サーバーアナウンスにより会話が終了します。');
    expect(serverAnnouncementClosing).toContain('参加者: Alice (id: alice)、Bob (id: bob)、Carol (id: carol)');
    expect(serverAnnouncementClosing).toContain('選択肢:');
    expect(serverAnnouncementClosing).toContain('conversation_speak');
    expect(serverAnnouncementClosing).toContain('次の話者ID');
    expect(serverAnnouncementClosing).toContain('karakuri-world スキルで次の行動を選択してください。');
  });

  it('formats conversation FYI messages for non-speakers', () => {
    expect(formatConversationFYIMessage('Alice', 'こんにちは。', 'Bob')).toBe(
      'Alice: 「こんにちは。」\n次は Bob の番です。',
    );
    expect(formatConversationFYIMessage('Alice', 'こんにちは。')).toBe('Alice: 「こんにちは。」');
  });

  it('formats server announcement messages with the action prompt', () => {
    const serverAnnouncement = formatServerAnnouncementMessage(
      worldContext,
      '古い装置が動き出しました。',
      'karakuri-world',
      '選択肢:\n- action: 調べる',
    );

    expectWorldContextHeader(serverAnnouncement);
    expect(serverAnnouncement).toContain('【サーバーアナウンス】');
    expect(serverAnnouncement).toContain('古い装置が動き出しました。');
    expect(serverAnnouncement).toContain('選択肢:\n- action: 調べる');
    expect(serverAnnouncement).toContain('現在の行動をキャンセルして選択するか、この通知を無視してください。');
    expect(serverAnnouncement).toContain('karakuri-world スキルで行動を選択してください。');
  });

  it('formats world log conversation messages', () => {
    expect(formatWorldLogConversationMessage('こんにちは。')).toBe('「こんにちは。」');
  });

  describe('formatActiveServerEventCountHint', () => {
    it.each([
      [0, null as string | null],
      [1, '現在、サーバーイベントが 1 件実施中です。詳細は `get_event` で確認してください。'],
      [2, '現在、サーバーイベントが 2 件実施中です。詳細は `get_event` で確認してください。'],
      [3, '現在、サーバーイベントが 3 件実施中です。詳細は `get_event` で確認してください。'],
    ])('returns the right hint for N=%i', (count, expected) => {
      const { engine } = createTestWorld();
      for (let i = 0; i < count; i += 1) {
        engine.state.serverEvents.create(`event-${i}`);
      }
      expect(formatActiveServerEventCountHint(engine)).toBe(expected);
    });
  });

  describe('appendActiveServerEventHint', () => {
    it('returns content unchanged when no active server events exist', () => {
      const { engine } = createTestWorld();
      const original = '行動が完了しました。';
      expect(appendActiveServerEventHint(original, engine)).toBe(original);
    });

    it('appends the hint as a separate section when active events exist', () => {
      const { engine } = createTestWorld();
      engine.state.serverEvents.create('停電中');
      const result = appendActiveServerEventHint('行動が完了しました。', engine);
      expect(result).toContain('行動が完了しました。');
      expect(result).toContain('現在、サーバーイベントが 1 件実施中です。');
      expect(result.split('\n\n').length).toBeGreaterThanOrEqual(2);
    });
  });
});
