import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ActionCompletedEvent,
  ActionStartedEvent,
  ConversationEndedEvent,
  ServerAnnouncementFiredEvent,
  WorldEvent,
} from '../src/contracts/world-event.js';
import { createEventSanitizer, sanitize } from '../src/contracts/persisted-spectator-event.js';
import type {
  PersistedSpectatorActionCompletedEvent,
  PersistedSpectatorActionStartedEvent,
  PersistedSpectatorConversationEndedEvent,
  PersistedSpectatorEvent,
  PersistedSpectatorServerAnnouncementFiredEvent,
} from '../src/contracts/persisted-spectator-event.js';

describe('persisted spectator event sanitizer', () => {
  it('sanitizes the allowlisted world event payloads without leaking private fields', () => {
    const sanitizedEvents = [
      sanitize({
        event_id: 'evt-1',
        type: 'agent_logged_in',
        occurred_at: 100,
        agent_id: 'alice',
        agent_name: 'Alice',
        node_id: '1-1',
        discord_channel_id: 'discord-1',
      }),
      sanitize({
        event_id: 'evt-2',
        type: 'action_started',
        occurred_at: 200,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'craft',
        action_name: 'Craft',
        duration_ms: 60_000,
        completes_at: 61_000,
        cost_money: 100,
        items_consumed: [{ item_id: 'wood', quantity: 1 }],
      }),
      sanitize({
        event_id: 'evt-3',
        type: 'action_completed',
        occurred_at: 300,
        agent_id: 'alice',
        agent_name: 'Alice',
        action_id: 'craft',
        action_name: 'Craft',
        cost_money: 100,
        reward_money: 50,
        money_balance: 450,
        items_granted: [{ item_id: 'chair', quantity: 1 }],
        items_dropped: [{ item_id: 'sawdust', quantity: 1 }],
      }),
      sanitize({
        event_id: 'evt-4',
        type: 'conversation_ended',
        occurred_at: 400,
        conversation_id: 'conv-1',
        initiator_agent_id: 'alice',
        participant_agent_ids: ['alice', 'bob'],
        reason: 'ended_by_agent',
        final_message: 'bye',
        final_speaker_agent_id: 'alice',
      }),
      sanitize({
        event_id: 'evt-5',
        type: 'server_announcement_fired',
        occurred_at: 500,
        server_announcement_id: 'event-1',
        description: 'Harvest Festival',
        delivered_agent_ids: ['alice'],
        pending_agent_ids: ['bob'],
        delayed: true,
      }),
    ];

    expect(sanitizedEvents).toMatchInlineSnapshot(`
      [
        {
          "agent_id": "alice",
          "agent_name": "Alice",
          "node_id": "1-1",
          "type": "agent_logged_in",
        },
        {
          "action_id": "craft",
          "action_name": "Craft",
          "agent_id": "alice",
          "agent_name": "Alice",
          "completes_at": 61000,
          "duration_ms": 60000,
          "type": "action_started",
        },
        {
          "action_id": "craft",
          "action_name": "Craft",
          "agent_id": "alice",
          "agent_name": "Alice",
          "type": "action_completed",
        },
        {
          "conversation_id": "conv-1",
          "final_message": "bye",
          "final_speaker_agent_id": "alice",
          "initiator_agent_id": "alice",
          "participant_agent_ids": [
            "alice",
            "bob",
          ],
          "reason": "ended_by_agent",
          "type": "conversation_ended",
        },
        {
          "delayed": true,
          "delivered_agent_ids": [
            "alice",
          ],
          "description": "Harvest Festival",
          "pending_agent_ids": [
            "bob",
          ],
          "server_announcement_id": "event-1",
          "type": "server_announcement_fired",
        },
      ]
    `);
  });

  it('drops unknown event types and reports them through hooks', () => {
    const unknownTypes: string[] = [];
    const sanitizeEvent = createEventSanitizer({
      onUnknownEventType: (eventType) => {
        unknownTypes.push(eventType);
      },
    });

    const result = sanitizeEvent({
      event_id: 'evt-unknown',
      type: 'idle_reminder_fired',
      occurred_at: 1,
      agent_id: 'alice',
      agent_name: 'Alice',
      idle_since: 0,
    } as unknown as WorldEvent);

    expect(result).toBeNull();
    expect(unknownTypes).toEqual(['idle_reminder_fired']);
  });

  it('drops unknown fields from known events and reports them through hooks', () => {
    const unknownFieldCalls: Array<{ type: string; fields: string[] }> = [];
    const sanitizeEvent = createEventSanitizer({
      onUnknownFields: (eventType, fields) => {
        unknownFieldCalls.push({ type: eventType, fields });
      },
    });

    const result = sanitizeEvent({
      event_id: 'evt-6',
      type: 'action_started',
      occurred_at: 600,
      agent_id: 'alice',
      agent_name: 'Alice',
      action_id: 'craft',
      action_name: 'Craft',
      duration_ms: 60_000,
      completes_at: 61_000,
      cost_money: 100,
      items_consumed: [{ item_id: 'wood', quantity: 1 }],
      leaked_field: 'drop-me',
    } as ActionStartedEvent & { leaked_field: string });

    expect(result).toEqual({
      type: 'action_started',
      agent_id: 'alice',
      agent_name: 'Alice',
      action_id: 'craft',
      action_name: 'Craft',
      duration_ms: 60_000,
      completes_at: 61_000,
    });
    expect(unknownFieldCalls).toEqual([
      {
        type: 'action_started',
        fields: ['cost_money', 'items_consumed', 'leaked_field'],
      },
    ]);
  });

  it('keeps persisted event types pinned to explicit Pick allowlists', () => {
    expectTypeOf<PersistedSpectatorActionStartedEvent>().toEqualTypeOf<
      Pick<ActionStartedEvent, 'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name' | 'duration_ms' | 'completes_at'>
    >();
    expectTypeOf<PersistedSpectatorActionCompletedEvent>().toEqualTypeOf<
      Pick<ActionCompletedEvent, 'type' | 'agent_id' | 'agent_name' | 'action_id' | 'action_name'>
    >();
    expectTypeOf<PersistedSpectatorConversationEndedEvent>().toEqualTypeOf<
      Pick<
        ConversationEndedEvent,
        'type' | 'conversation_id' | 'initiator_agent_id' | 'participant_agent_ids' | 'reason' | 'final_message' | 'final_speaker_agent_id'
      >
    >();
    expectTypeOf<PersistedSpectatorServerAnnouncementFiredEvent>().toEqualTypeOf<
      Pick<ServerAnnouncementFiredEvent, 'type' | 'server_announcement_id' | 'description' | 'delivered_agent_ids' | 'pending_agent_ids' | 'delayed'>
    >();
  });
});
