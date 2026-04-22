import { describe, expect, it } from 'vitest';

import {
  OVERLAY_WIDTH_DEFAULT_PX,
  OVERLAY_WIDTH_MAX_PX,
  OVERLAY_WIDTH_MIN_PX,
  OVERLAY_WIDTH_STORAGE_KEY,
  clampOverlayWidth,
  loadOverlayWidth,
  saveOverlayWidth,
} from '../lib/overlay-width.js';

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));

  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

describe('overlay-width helpers', () => {
  it('clamps narrow widths up to the minimum', () => {
    expect(clampOverlayWidth(100)).toBe(OVERLAY_WIDTH_MIN_PX);
  });

  it('clamps wide widths down to the absolute maximum', () => {
    expect(clampOverlayWidth(10_000)).toBe(OVERLAY_WIDTH_MAX_PX);
  });

  it('applies the viewport-aware dynamic maximum (40% of viewport width)', () => {
    expect(clampOverlayWidth(600, 800)).toBe(Math.floor(800 * 0.4));
  });

  it('returns the default when the value is not finite', () => {
    expect(clampOverlayWidth(Number.NaN)).toBe(OVERLAY_WIDTH_DEFAULT_PX);
  });

  it('loads saved width from storage and clamps it', () => {
    const storage = createMemoryStorage({ [OVERLAY_WIDTH_STORAGE_KEY]: '10000' });
    expect(loadOverlayWidth(storage)).toBe(OVERLAY_WIDTH_MAX_PX);
  });

  it('falls back to the default when storage is empty', () => {
    const storage = createMemoryStorage();
    expect(loadOverlayWidth(storage)).toBe(OVERLAY_WIDTH_DEFAULT_PX);
  });

  it('falls back to the default when the stored value is non-numeric', () => {
    const storage = createMemoryStorage({ [OVERLAY_WIDTH_STORAGE_KEY]: 'not-a-number' });
    expect(loadOverlayWidth(storage)).toBe(OVERLAY_WIDTH_DEFAULT_PX);
  });

  it('saves width values rounded to storage', () => {
    const storage = createMemoryStorage();
    saveOverlayWidth(412.4, storage);
    expect(storage.getItem(OVERLAY_WIDTH_STORAGE_KEY)).toBe('412');
  });
});
