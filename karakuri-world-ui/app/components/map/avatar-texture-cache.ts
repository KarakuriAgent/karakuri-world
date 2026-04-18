import { Assets, Texture } from 'pixi.js';

export type AvatarTextureStatus = 'idle' | 'pending' | 'ready' | 'error';

export interface AvatarTextureSnapshot {
  status: AvatarTextureStatus;
  texture?: Texture;
  error?: Error;
  retryAfterAtMs?: number;
}

interface AvatarTextureCacheEntry extends AvatarTextureSnapshot {
  promise?: Promise<Texture>;
  retry_after_at_ms?: number;
}

type AvatarTextureLoader = (url: string) => Texture | Promise<Texture>;

const AVATAR_TEXTURE_ERROR_RETRY_MS = 30_000;
const avatarTextureCache = new Map<string, AvatarTextureCacheEntry>();

let avatarTextureLoader: AvatarTextureLoader = (url) => Assets.load<Texture>(url);

function toError(error: unknown, url: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error('Failed to load avatar texture: ' + url);
}

function waitForTexture(texture: Texture | undefined, url: string): Promise<Texture> {
  if (!texture) {
    return Promise.reject(new Error('Avatar texture unavailable: ' + url));
  }

  if (texture.width > 0 && texture.height > 0) {
    return Promise.resolve(texture);
  }

  return new Promise<Texture>((resolve, reject) => {
    const source = texture.source as {
      on?: (eventName: string, listener: (...args: unknown[]) => void) => void;
      off?: (eventName: string, listener: (...args: unknown[]) => void) => void;
    } | undefined;

    const cleanup = () => {
      texture.off?.('update', handleReady);
      source?.off?.('update', handleReady);
      source?.off?.('error', handleError);
    };
    const handleReady = () => {
      cleanup();
      resolve(texture);
    };
    const handleError = (error?: unknown) => {
      cleanup();
      reject(toError(error, url));
    };

    texture.on?.('update', handleReady);
    source?.on?.('update', handleReady);
    source?.on?.('error', handleError);
  });
}

function shouldExpireErrorEntry(entry: AvatarTextureCacheEntry): boolean {
  return entry.status === 'error' && typeof entry.retry_after_at_ms === 'number' && entry.retry_after_at_ms <= Date.now();
}

function getFreshAvatarTextureEntry(url: string): AvatarTextureCacheEntry | undefined {
  const entry = avatarTextureCache.get(url);

  if (!entry) {
    return undefined;
  }

  if (shouldExpireErrorEntry(entry)) {
    avatarTextureCache.delete(url);
    return undefined;
  }

  return entry;
}

export function getAvatarTextureSnapshot(url?: string): AvatarTextureSnapshot {
  if (!url) {
    return { status: 'idle' };
  }

  const entry = getFreshAvatarTextureEntry(url);

  if (!entry) {
    return { status: 'idle' };
  }

  return {
    status: entry.status,
    ...(entry.texture ? { texture: entry.texture } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    ...(typeof entry.retry_after_at_ms === 'number' ? { retryAfterAtMs: entry.retry_after_at_ms } : {}),
  };
}

export function loadAvatarTexture(url: string): Promise<Texture> {
  const cachedEntry = getFreshAvatarTextureEntry(url);

  if (cachedEntry?.status === 'ready' && cachedEntry.texture) {
    return Promise.resolve(cachedEntry.texture);
  }

  if (cachedEntry?.status === 'pending' && cachedEntry.promise) {
    return cachedEntry.promise;
  }

  if (cachedEntry?.status === 'error' && cachedEntry.error) {
    return Promise.reject(cachedEntry.error);
  }

  const entry: AvatarTextureCacheEntry = {
    status: 'pending',
  };

  const loaderResult = avatarTextureLoader(url);
  const readyPromise = loaderResult instanceof Promise
    ? loaderResult.then((texture) => {
        entry.texture = texture;
        return waitForTexture(texture, url);
      })
    : (() => {
        entry.texture = loaderResult;
        return waitForTexture(loaderResult, url);
      })();

  entry.promise = readyPromise
    .then((loadedTexture) => {
      entry.status = 'ready';
      entry.texture = loadedTexture;
      entry.error = undefined;
      entry.promise = undefined;
      entry.retry_after_at_ms = undefined;
      return loadedTexture;
    })
    .catch((error) => {
      entry.status = 'error';
      entry.error = toError(error, url);
      entry.promise = undefined;
      entry.retry_after_at_ms = Date.now() + AVATAR_TEXTURE_ERROR_RETRY_MS;
      throw entry.error;
    });

  avatarTextureCache.set(url, entry);

  return entry.promise;
}

export function invalidateAvatarTexture(url?: string): void {
  if (url) {
    avatarTextureCache.delete(url);
    return;
  }

  avatarTextureCache.clear();
}

export function setAvatarTextureLoaderForTests(loader: AvatarTextureLoader): void {
  avatarTextureLoader = loader;
}

export function resetAvatarTextureCacheForTests(): void {
  avatarTextureCache.clear();
  avatarTextureLoader = (url) => Assets.load<Texture>(url);
}
