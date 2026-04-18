import { describe, expect, it } from 'vitest';

import {
  stageConversationMirrorUpdate,
  type BridgeConversationState,
} from '../src/relay/bridge.js';

describe('relay conversation mirror', () => {
  it('stages conversation state transitions and resolves participants from the next mirror state', () => {
    let mirror: Record<string, BridgeConversationState> = {};

    const requested = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-1',
      type: 'conversation_requested',
      occurred_at: 1_750_000_010_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      target_agent_id: 'bob',
      message: 'hello',
    });
    expect(requested.next_conversations['conv-1']).toMatchObject({
      status: 'pending',
      participant_agent_ids: ['alice', 'bob'],
      initiator_agent_id: 'alice',
    });
    expect(requested.resolved_agent_ids).toEqual(['alice', 'bob']);
    mirror = requested.next_conversations;

    const accepted = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-2',
      type: 'conversation_accepted',
      occurred_at: 1_750_000_020_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      participant_agent_ids: ['alice', 'bob'],
    });
    expect(accepted.next_conversations['conv-1']).toMatchObject({
      status: 'active',
      participant_agent_ids: ['alice', 'bob'],
      initiator_agent_id: 'alice',
    });
    mirror = accepted.next_conversations;

    const turnStarted = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-3',
      type: 'conversation_turn_started',
      occurred_at: 1_750_000_030_000,
      conversation_id: 'conv-1',
      current_speaker_agent_id: 'bob',
    });
    expect(turnStarted.next_conversations['conv-1']).toMatchObject({
      current_speaker_agent_id: 'bob',
      participant_agent_ids: ['alice', 'bob'],
    });
    expect(turnStarted.resolved_agent_ids).toEqual(['bob', 'alice']);
    mirror = turnStarted.next_conversations;

    const joined = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-4',
      type: 'conversation_join',
      occurred_at: 1_750_000_040_000,
      conversation_id: 'conv-1',
      agent_id: 'carol',
      agent_name: 'Carol',
      participant_agent_ids: ['alice', 'bob', 'carol'],
    });
    expect(joined.next_conversations['conv-1']).toMatchObject({
      status: 'active',
      participant_agent_ids: ['alice', 'bob', 'carol'],
      current_speaker_agent_id: 'bob',
    });
    mirror = joined.next_conversations;

    const inactiveCheck = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-5',
      type: 'conversation_inactive_check',
      occurred_at: 1_750_000_050_000,
      conversation_id: 'conv-1',
      target_agent_ids: ['carol'],
    });
    expect(inactiveCheck.resolved_agent_ids).toEqual(['carol', 'alice', 'bob']);
    expect(inactiveCheck.next_conversations['conv-1'].participant_agent_ids).toEqual(['alice', 'bob', 'carol']);
    mirror = inactiveCheck.next_conversations;

    const left = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-6',
      type: 'conversation_leave',
      occurred_at: 1_750_000_060_000,
      conversation_id: 'conv-1',
      agent_id: 'bob',
      agent_name: 'Bob',
      reason: 'voluntary',
      participant_agent_ids: ['alice', 'carol'],
      next_speaker_agent_id: 'alice',
    });
    expect(left.next_conversations['conv-1']).toMatchObject({
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
    });
    mirror = left.next_conversations;

    const closing = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-7',
      type: 'conversation_closing',
      occurred_at: 1_750_000_070_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
      reason: 'ended_by_agent',
    });
    expect(closing.next_conversations['conv-1']).toMatchObject({
      status: 'closing',
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
      closing_reason: 'ended_by_agent',
    });
    mirror = closing.next_conversations;

    const ended = stageConversationMirrorUpdate(mirror, {
      event_id: 'event-8',
      type: 'conversation_ended',
      occurred_at: 1_750_000_080_000,
      conversation_id: 'conv-1',
      initiator_agent_id: 'alice',
      participant_agent_ids: ['alice', 'carol'],
      reason: 'ended_by_agent',
      final_speaker_agent_id: 'alice',
    });
    expect(ended.next_conversations).toEqual({});
    expect(ended.resolved_conversation).toMatchObject({
      status: 'closing',
      participant_agent_ids: ['alice', 'carol'],
      current_speaker_agent_id: 'alice',
      closing_reason: 'ended_by_agent',
    });
    expect(ended.resolved_agent_ids).toEqual(['alice', 'carol']);
  });

});
