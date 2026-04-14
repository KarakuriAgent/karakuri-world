import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMapRenderTheme } from '../../../src/discord/map-renderer.js';
import { buildWorldCalendarSnapshot } from '../../../src/engine/world-snapshot.js';
import { createTestWorld } from '../../helpers/test-world.js';

describe('world snapshot helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a calendar snapshot from the configured timezone', () => {
    const snapshot = buildWorldCalendarSnapshot(Date.parse('2026-01-01T00:00:00Z'), 'Asia/Tokyo');

    expect(snapshot).toEqual({
      timezone: 'Asia/Tokyo',
      local_date: '2026-01-01',
      local_time: '09:00:00',
      season: 'winter',
      season_label: '冬',
      day_in_season: 32,
      display_label: '冬・32日目',
    });
  });

  it('counts season days across a year boundary', () => {
    const snapshot = buildWorldCalendarSnapshot(Date.parse('2026-02-28T14:59:59Z'), 'Asia/Tokyo');

    expect(snapshot).toMatchObject({
      local_date: '2026-02-28',
      local_time: '23:59:59',
      season: 'winter',
      season_label: '冬',
      day_in_season: 90,
      display_label: '冬・90日目',
    });
  });

  it('includes calendar and map render theme in world snapshots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T03:04:05Z'));

    const { engine } = createTestWorld();
    const snapshot = engine.getSnapshot();

    expect(snapshot.calendar).toEqual({
      timezone: 'Asia/Tokyo',
      local_date: '2026-06-15',
      local_time: '12:04:05',
      season: 'summer',
      season_label: '夏',
      day_in_season: 15,
      display_label: '夏・15日目',
    });
    expect(snapshot.map_render_theme).toEqual(getMapRenderTheme());
  });
});
