import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Context, Hono } from 'hono';

import {
  avatarMimeTypeFromFilename,
  buildAvatarFilename,
  resolveStoredAvatarPath,
  type AvatarFileExtension,
  validateAvatarImage,
} from '../../domain/avatar.js';
import type { WorldEngine } from '../../engine/world-engine.js';
import { WorldError } from '../../types/api.js';
import type { ApiEnv } from '../context.js';
import { adminAuth } from '../middleware/auth.js';
import type { WebSocketManager } from '../websocket.js';

export function getAvatarDirectory(dataDir?: string): string {
  return join(dataDir ?? './data', 'avatars');
}

function getGeneratedAvatarPath(dataDir: string | undefined, filename: string): string {
  return join(getAvatarDirectory(dataDir), filename);
}

function getStoredAvatarPath(dataDir: string | undefined, filename: string): string {
  return resolveStoredAvatarPath(getAvatarDirectory(dataDir), filename);
}

export function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      throw error;
    }
  }
}

function readFileIfExists(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}

function restoreAvatarFile(path: string, previousBytes: Buffer | undefined): void {
  if (previousBytes) {
    writeFileSync(path, previousBytes);
    return;
  }

  unlinkIfExists(path);
}

export async function readAvatarUpload(avatarFile: File): Promise<{ bytes: Buffer; ext: AvatarFileExtension }> {
  const bytes = Buffer.from(await avatarFile.arrayBuffer());
  const metadata = validateAvatarImage(bytes, avatarFile.type);
  return {
    bytes,
    ext: metadata.ext,
  };
}

async function parseAvatarFile(c: Context<ApiEnv>): Promise<{ bytes: Buffer; ext: AvatarFileExtension }> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw new WorldError(400, 'invalid_request', 'Avatar uploads must use multipart/form-data.');
  }

  const body = await c.req.parseBody();
  const avatarValue = body.avatar;
  const avatarFile = Array.isArray(avatarValue) ? (avatarValue.length === 1 ? avatarValue[0] : null) : avatarValue;

  if (!(avatarFile instanceof File)) {
    throw new WorldError(400, 'invalid_request', 'Avatar field must be a file upload.');
  }

  return readAvatarUpload(avatarFile);
}

export function registerAdminAvatarRoutes(
  app: Hono<ApiEnv>,
  engine: WorldEngine,
  websocketManager: WebSocketManager,
  options: { adminKey: string; dataDir?: string },
): void {
  app.get('/api/admin/agents/:agent_id/avatar', (c) => {
    const registration = engine.getAgentById(c.req.param('agent_id'));
    if (!registration?.avatar_filename) {
      throw new WorldError(404, 'not_found', 'Avatar not found.');
    }

    const filePath = getStoredAvatarPath(options.dataDir, registration.avatar_filename);
    const mimeType = avatarMimeTypeFromFilename(registration.avatar_filename);
    if (!mimeType) {
      throw new WorldError(500, 'invalid_config', 'Unsupported avatar file type.');
    }

    let file: Buffer;
    try {
      file = readFileSync(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        throw new WorldError(404, 'not_found', 'Avatar not found.');
      }
      throw error;
    }

    return c.body(Uint8Array.from(file), 200, {
      'Cache-Control': 'no-store',
      'Content-Type': mimeType,
    });
  });

  app.put('/api/admin/agents/:agent_id/avatar', adminAuth(options.adminKey), async (c) => {
    const agentId = c.req.param('agent_id');
    const registration = engine.getAgentById(agentId);
    if (!registration) {
      throw new WorldError(404, 'not_found', 'Agent not found.');
    }

    const avatar = await parseAvatarFile(c);
    const previousFilename = registration.avatar_filename;
    const previousPath = previousFilename ? getStoredAvatarPath(options.dataDir, previousFilename) : undefined;
    const nextFilename = buildAvatarFilename(agentId, avatar.ext);
    const nextPath = getGeneratedAvatarPath(options.dataDir, nextFilename);
    const temporaryPath = getGeneratedAvatarPath(options.dataDir, `${randomUUID()}.upload`);

    mkdirSync(getAvatarDirectory(options.dataDir), { recursive: true });

    if (previousFilename === nextFilename) {
      const previousBytes = previousPath ? readFileIfExists(previousPath) : undefined;
      writeFileSync(temporaryPath, avatar.bytes);

      try {
        renameSync(temporaryPath, nextPath);
      } catch (error) {
        unlinkIfExists(temporaryPath);
        throw error;
      }

      try {
        engine.updateAgentAvatar(agentId, nextFilename);
      } catch (error) {
        try {
          restoreAvatarFile(nextPath, previousBytes);
        } catch (restoreError) {
          console.error('Failed to restore avatar file after persistence error.', restoreError);
        }
        throw error;
      }
    } else {
      writeFileSync(nextPath, avatar.bytes);

      try {
        engine.updateAgentAvatar(agentId, nextFilename);
      } catch (error) {
        unlinkIfExists(nextPath);
        throw error;
      }

      if (previousPath) {
        try {
          unlinkIfExists(previousPath);
        } catch (error) {
          console.error('Failed to delete previous avatar file after successful update.', error);
        }
      }
    }

    if (engine.state.isLoggedIn(agentId)) {
      websocketManager.broadcastSnapshot();
    }

    return c.json({ status: 'ok' });
  });

  app.delete('/api/admin/agents/:agent_id/avatar', adminAuth(options.adminKey), (c) => {
    const agentId = c.req.param('agent_id');
    const registration = engine.getAgentById(agentId);
    if (!registration) {
      throw new WorldError(404, 'not_found', 'Agent not found.');
    }

    const previousFilename = registration.avatar_filename;
    if (previousFilename) {
      const previousPath = getStoredAvatarPath(options.dataDir, previousFilename);
      engine.updateAgentAvatar(agentId, undefined);
      try {
        unlinkIfExists(previousPath);
      } catch (error) {
        console.error('Failed to delete avatar file after successful removal.', error);
      }
    }

    if (engine.state.isLoggedIn(agentId)) {
      websocketManager.broadcastSnapshot();
    }

    return c.json({ status: 'ok' });
  });
}
