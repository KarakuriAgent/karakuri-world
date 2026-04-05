import { describe, expect, it } from 'vitest';

import { formatWorldTime, isWithinHours } from '../../../src/domain/time-utils.js';

describe('time utils', () => {
  it('treats undefined hours as always open', () => {
    expect(isWithinHours(undefined, new Date('2026-01-01T00:00:00Z'), 'Asia/Tokyo')).toBe(true);
  });

  it('supports normal and overnight business hours', () => {
    expect(isWithinHours({ open: '09:00', close: '17:00' }, new Date('2026-01-01T03:00:00Z'), 'Asia/Tokyo')).toBe(true);
    expect(isWithinHours({ open: '09:00', close: '17:00' }, new Date('2026-01-01T09:00:00Z'), 'Asia/Tokyo')).toBe(false);
    expect(isWithinHours({ open: '22:00', close: '06:00' }, new Date('2026-01-01T14:00:00Z'), 'Asia/Tokyo')).toBe(true);
    expect(isWithinHours({ open: '22:00', close: '06:00' }, new Date('2026-01-01T12:00:00Z'), 'Asia/Tokyo')).toBe(false);
  });

  it('formats world time with timezone', () => {
    expect(formatWorldTime(new Date('2026-01-01T00:00:00Z'), 'Asia/Tokyo')).toBe('2026-01-01 09:00 (Asia/Tokyo)');
  });
});
