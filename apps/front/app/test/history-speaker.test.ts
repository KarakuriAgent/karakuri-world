import { describe, expect, it } from 'vitest';

import {
  collapseConversationHistoryForAgentTimeline,
  isSpeakingHistoryEntry,
  isUtteranceHistoryEntry,
  resolveHistorySpeaker,
} from '../lib/history-speaker.js';
import { createFixtureSnapshot } from './fixtures/snapshot.js';
import type { HistoryEntry } from '../../worker/src/history/api.js';

describe('history-speaker', () => {
  it('classifies speaking event types', () => {
    const speakingTypes: HistoryEntry['type'][] = [
      'conversation_message',
      'conversation_interval_interrupted',
      'conversation_ended',
    ];
    for (const type of speakingTypes) {
      expect(
        isSpeakingHistoryEntry({
          event_id: `e-${type}`,
          type,
          occurred_at: 0,
          agent_ids: [],
          summary: { emoji: '💬', title: 't', text: 'x' },
          detail: {},
        }),
      ).toBe(true);
    }

    expect(
      isSpeakingHistoryEntry({
        event_id: 'e-action',
        type: 'action_completed',
        occurred_at: 0,
        agent_ids: [],
        summary: { emoji: '✅', title: 't', text: 'x' },
        detail: {},
      }),
    ).toBe(false);
  });

  it('treats only pure message events as utterances so meta events stay in the agent timeline', () => {
    const utteranceTypes: HistoryEntry['type'][] = [
      'conversation_message',
      'conversation_interval_interrupted',
    ];
    for (const type of utteranceTypes) {
      expect(
        isUtteranceHistoryEntry({
          event_id: `e-${type}`,
          type,
          occurred_at: 0,
          agent_ids: [],
          summary: { emoji: '💬', title: 't', text: 'x' },
          detail: {},
        }),
      ).toBe(true);
    }

    const metaTypes: HistoryEntry['type'][] = [
      'conversation_accepted',
      'conversation_ended',
      'conversation_join',
      'conversation_leave',
    ];
    for (const type of metaTypes) {
      expect(
        isUtteranceHistoryEntry({
          event_id: `e-${type}`,
          type,
          occurred_at: 0,
          agent_ids: [],
          summary: { emoji: '🔚', title: 't', text: 'x' },
          detail: {},
        }),
      ).toBe(false);
    }
  });

  it('resolves the speaker from conversation_message detail', () => {
    const snapshot = createFixtureSnapshot();
    const alice = snapshot.agents.find((agent) => agent.agent_id === 'alice')!;

    const result = resolveHistorySpeaker(
      {
        event_id: 'e1',
        type: 'conversation_message',
        occurred_at: 0,
        agent_ids: ['alice', 'bob'],
        conversation_id: 'conv-1',
        summary: { emoji: '💬', title: 'Message', text: 'Hi there' },
        detail: { speaker_agent_id: 'alice' },
      },
      snapshot,
    );

    expect(result?.speaker_agent_id).toBe('alice');
    expect(result?.agent).toBe(alice);
    expect(result?.display_name).toBe(alice.agent_name);
  });

  it('uses final_speaker_agent_id for conversation_ended entries', () => {
    const snapshot = createFixtureSnapshot();

    const result = resolveHistorySpeaker(
      {
        event_id: 'e2',
        type: 'conversation_ended',
        occurred_at: 0,
        agent_ids: ['alice', 'bob'],
        conversation_id: 'conv-1',
        summary: { emoji: '🔚', title: 'End', text: 'bye' },
        detail: { final_speaker_agent_id: 'bob' },
      },
      snapshot,
    );

    expect(result?.speaker_agent_id).toBe('bob');
    expect(result?.display_name).toBe('Bob');
  });

  it('falls back to the raw id when the speaker is not in the snapshot', () => {
    const snapshot = createFixtureSnapshot();

    const result = resolveHistorySpeaker(
      {
        event_id: 'e3',
        type: 'conversation_message',
        occurred_at: 0,
        agent_ids: ['ghost'],
        conversation_id: 'conv-1',
        summary: { emoji: '💬', title: 'Message', text: 'boo' },
        detail: { speaker_agent_id: 'ghost' },
      },
      snapshot,
    );

    expect(result?.speaker_agent_id).toBe('ghost');
    expect(result?.agent).toBeUndefined();
    expect(result?.display_name).toBe('ghost');
  });

  it('returns undefined for non-speaking events', () => {
    const snapshot = createFixtureSnapshot();

    const result = resolveHistorySpeaker(
      {
        event_id: 'e4',
        type: 'action_completed',
        occurred_at: 0,
        agent_ids: ['alice'],
        summary: { emoji: '✅', title: 'Done', text: 'ok' },
        detail: {},
      },
      snapshot,
    );

    expect(result).toBeUndefined();
  });

  it('collapses each conversation to a head utterance, preferring conversation_requested', () => {
    const baseItem = {
      occurred_at: 0,
      agent_ids: ['alice'],
      summary: { emoji: '', title: '', text: '' },
      detail: {},
    };

    const input: HistoryEntry[] = [
      // newest-first as returned by the API
      {
        ...baseItem,
        event_id: 'conv-a-msg-2',
        type: 'conversation_message',
        occurred_at: 300,
        conversation_id: 'conv-a',
      },
      {
        ...baseItem,
        event_id: 'action-done',
        type: 'action_completed',
        occurred_at: 250,
      },
      {
        ...baseItem,
        event_id: 'conv-a-msg-1',
        type: 'conversation_message',
        occurred_at: 200,
        conversation_id: 'conv-a',
      },
      {
        ...baseItem,
        event_id: 'conv-a-req',
        type: 'conversation_requested',
        occurred_at: 100,
        conversation_id: 'conv-a',
      },
      {
        ...baseItem,
        event_id: 'conv-b-msg-2',
        type: 'conversation_message',
        occurred_at: 90,
        conversation_id: 'conv-b',
      },
      {
        ...baseItem,
        event_id: 'conv-b-msg-1',
        type: 'conversation_message',
        occurred_at: 80,
        conversation_id: 'conv-b',
      },
      {
        ...baseItem,
        event_id: 'conv-c-accepted',
        type: 'conversation_accepted',
        occurred_at: 70,
        conversation_id: 'conv-c',
      },
    ];

    const collapsed = collapseConversationHistoryForAgentTimeline(input);
    const eventIds = collapsed.map((item) => item.event_id);

    // conv-a keeps only conversation_requested (preferred head)
    // conv-b has no conversation_requested, so the earliest (last in newest-first list) utterance is kept
    // conv-c has only meta events, so it is dropped entirely
    expect(eventIds).toEqual(['action-done', 'conv-a-req', 'conv-b-msg-1']);
  });

  it('returns undefined when speaker id is missing from detail', () => {
    const snapshot = createFixtureSnapshot();

    const result = resolveHistorySpeaker(
      {
        event_id: 'e5',
        type: 'conversation_message',
        occurred_at: 0,
        agent_ids: ['alice'],
        conversation_id: 'conv-1',
        summary: { emoji: '💬', title: 'Message', text: 'no speaker' },
        detail: {},
      },
      snapshot,
    );

    expect(result).toBeUndefined();
  });
});
