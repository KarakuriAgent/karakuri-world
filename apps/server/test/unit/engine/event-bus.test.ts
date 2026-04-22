import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../../src/engine/event-bus.js';

describe('EventBus', () => {
  it('notifies specific and catch-all listeners while logging JSON', () => {
    const logger = vi.fn();
    const bus = new EventBus(logger);
    const specific = vi.fn();
    const any = vi.fn();

    bus.on('agent_logged_in', specific);
    bus.onAny(any);

    const event = {
      event_id: 'evt-1',
      occurred_at: 1,
      type: 'agent_logged_in' as const,
      agent_id: 'agent-1',
      agent_name: 'Alice',
      node_id: '3-1' as const,
      discord_channel_id: 'channel-Alice',
    };

    bus.emit(event);

    expect(logger).toHaveBeenCalledWith(JSON.stringify(event));
    expect(specific).toHaveBeenCalledWith(event);
    expect(any).toHaveBeenCalledWith(event);
  });
});
