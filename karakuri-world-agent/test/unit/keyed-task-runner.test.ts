import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { KeyedTaskRunner } from '../../src/keyed-task-runner.js';

describe('keyed task runner', () => {
  it('runs tasks sequentially for the same key', async () => {
    const runner = new KeyedTaskRunner();
    const events: string[] = [];

    await Promise.all([
      runner.run('channel-1', async () => {
        events.push('start-1');
        await delay(20);
        events.push('end-1');
      }),
      runner.run('channel-1', async () => {
        events.push('start-2');
        events.push('end-2');
      }),
    ]);

    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('allows different keys to run independently', async () => {
    const runner = new KeyedTaskRunner();
    const events: string[] = [];

    await Promise.all([
      runner.run('channel-1', async () => {
        events.push('a-start');
        await delay(20);
        events.push('a-end');
      }),
      runner.run('channel-2', async () => {
        events.push('b-start');
        events.push('b-end');
      }),
    ]);

    expect(events[0]).toBe('a-start');
    expect(events).toContain('b-start');
    expect(events).toContain('b-end');
    expect(events[events.length - 1]).toBe('a-end');
  });
});
