import type { Texture } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateAvatarTexture,
  getAvatarTextureSnapshot,
  loadAvatarTexture,
  resetAvatarTextureCacheForTests,
  setAvatarTextureLoaderForTests,
} from '../components/map/avatar-texture-cache.js';

type Listener = (...args: unknown[]) => void;

class MockEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(eventName: string, listener: Listener) {
    const currentListeners = this.listeners.get(eventName) ?? new Set<Listener>();
    currentListeners.add(listener);
    this.listeners.set(eventName, currentListeners);
  }

  off(eventName: string, listener: Listener) {
    this.listeners.get(eventName)?.delete(listener);
  }

  emit(eventName: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(...args);
    }
  }
}

function createPendingTexture() {
  const textureEmitter = new MockEmitter();
  const sourceEmitter = new MockEmitter();
  const texture = {
    width: 0,
    height: 0,
    source: {
      on: sourceEmitter.on.bind(sourceEmitter),
      off: sourceEmitter.off.bind(sourceEmitter),
    },
    on: textureEmitter.on.bind(textureEmitter),
    off: textureEmitter.off.bind(textureEmitter),
  } as unknown as Texture;

  return {
    texture,
    emitReady: () => sourceEmitter.emit('update'),
    emitError: (error?: unknown) => sourceEmitter.emit('error', error),
  };
}

afterEach(() => {
  resetAvatarTextureCacheForTests();
  vi.useRealTimers();
});

describe('avatar texture cache', () => {
  it('reuses the same in-flight load for the same avatar URL', async () => {
    const pending = createPendingTexture();
    const loader = vi.fn(() => pending.texture);
    setAvatarTextureLoaderForTests(loader);

    const firstLoad = loadAvatarTexture('https://example.com/alice.png');
    const secondLoad = loadAvatarTexture('https://example.com/alice.png');

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getAvatarTextureSnapshot('https://example.com/alice.png').status).toBe('pending');

    pending.emitReady();

    await expect(firstLoad).resolves.toBe(pending.texture);
    await expect(secondLoad).resolves.toBe(pending.texture);
    expect(getAvatarTextureSnapshot('https://example.com/alice.png').status).toBe('ready');
  });

  it('keeps avatar load failures cached until the retry window expires', async () => {
    vi.useFakeTimers();
    const pending = createPendingTexture();
    const loader = vi.fn(() => pending.texture);
    setAvatarTextureLoaderForTests(loader);

    const loadPromise = loadAvatarTexture('https://example.com/broken.png');
    pending.emitError(new Error('boom'));

    await expect(loadPromise).rejects.toThrow('boom');
    await expect(loadAvatarTexture('https://example.com/broken.png')).rejects.toThrow('boom');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getAvatarTextureSnapshot('https://example.com/broken.png').status).toBe('error');

    vi.advanceTimersByTime(30_001);

    const retryPending = createPendingTexture();
    loader.mockReturnValueOnce(retryPending.texture);

    const retryLoad = loadAvatarTexture('https://example.com/broken.png');

    expect(loader).toHaveBeenCalledTimes(2);
    retryPending.emitReady();
    await expect(retryLoad).resolves.toBe(retryPending.texture);
    expect(getAvatarTextureSnapshot('https://example.com/broken.png').status).toBe('ready');
  });

  it('allows callers to invalidate a cached failure and retry immediately', async () => {
    const pending = createPendingTexture();
    const loader = vi.fn(() => pending.texture);
    setAvatarTextureLoaderForTests(loader);

    const loadPromise = loadAvatarTexture('https://example.com/reset.png');
    pending.emitError(new Error('boom'));

    await expect(loadPromise).rejects.toThrow('boom');
    expect(getAvatarTextureSnapshot('https://example.com/reset.png').status).toBe('error');

    invalidateAvatarTexture('https://example.com/reset.png');
    expect(getAvatarTextureSnapshot('https://example.com/reset.png').status).toBe('idle');

    const retryPending = createPendingTexture();
    loader.mockReturnValueOnce(retryPending.texture);

    const retryLoad = loadAvatarTexture('https://example.com/reset.png');

    expect(loader).toHaveBeenCalledTimes(2);
    retryPending.emitReady();
    await expect(retryLoad).resolves.toBe(retryPending.texture);
  });
});
