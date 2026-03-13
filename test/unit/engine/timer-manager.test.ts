import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimerManager } from '../../../src/engine/timer-manager.js';

describe('TimerManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires timers through registered handlers', () => {
    const manager = new TimerManager();
    const fired: string[] = [];

    manager.onFire('movement', (timer) => {
      fired.push(timer.agent_id);
    });

    manager.create({
      type: 'movement',
      agent_ids: ['agent-1'],
      agent_id: 'agent-1',
      from_node_id: '1-1',
      to_node_id: '1-2',
      path: ['1-2'],
      fires_at: Date.now() + 1000,
    });

    vi.advanceTimersByTime(1000);

    expect(fired).toEqual(['agent-1']);
  });

  it('cancels timers by id and by agent/type', () => {
    const manager = new TimerManager();
    const turnHandler = vi.fn();
    manager.onFire('conversation_turn', turnHandler);

    const timer = manager.create({
      type: 'conversation_turn',
      agent_ids: ['agent-1', 'agent-2'],
      conversation_id: 'conv-1',
      current_speaker_agent_id: 'agent-1',
      fires_at: Date.now() + 1000,
    });

    expect(manager.cancel(timer.timer_id)?.timer_id).toBe(timer.timer_id);

    manager.create({
      type: 'conversation_turn',
      agent_ids: ['agent-1', 'agent-2'],
      conversation_id: 'conv-2',
      current_speaker_agent_id: 'agent-2',
      fires_at: Date.now() + 1000,
    });
    manager.create({
      type: 'movement',
      agent_ids: ['agent-1'],
      agent_id: 'agent-1',
      from_node_id: '1-1',
      to_node_id: '2-1',
      path: ['2-1'],
      fires_at: Date.now() + 1000,
    });

    expect(manager.cancelByType('agent-1', 'movement')).toHaveLength(1);
    expect(manager.cancelByAgent('agent-2')).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(turnHandler).not.toHaveBeenCalled();
  });
});
