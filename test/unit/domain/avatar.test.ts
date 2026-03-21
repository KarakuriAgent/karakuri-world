import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  avatarMimeTypeFromFilename,
  buildAvatarFilename,
  buildAvatarUrlPath,
  resolveStoredAvatarPath,
  validateAvatarImage,
} from '../../../src/domain/avatar.js';
import { WorldError } from '../../../src/types/api.js';
import { SAMPLE_JPEG_BYTES, SAMPLE_PNG_BYTES } from '../../helpers/avatar-fixtures.js';

function createOversizedDimensionPng(): Buffer {
  const png = Buffer.from(SAMPLE_PNG_BYTES);
  png.writeUInt32BE(600, 16);
  png.writeUInt32BE(600, 20);
  return png;
}

describe('avatar domain', () => {
  it('validates PNG and JPEG images and returns metadata', () => {
    expect(validateAvatarImage(SAMPLE_PNG_BYTES, 'image/png')).toEqual({
      ext: 'png',
      height: 1,
      mimeType: 'image/png',
      width: 1,
    });

    expect(validateAvatarImage(SAMPLE_JPEG_BYTES, 'image/jpeg')).toEqual({
      ext: 'jpg',
      height: 1,
      mimeType: 'image/jpeg',
      width: 1,
    });
  });

  it('rejects unsupported mime types and mismatched signatures', () => {
    expect(() => validateAvatarImage(SAMPLE_PNG_BYTES, 'image/gif')).toThrowError(WorldError);
    expect(() => validateAvatarImage(SAMPLE_JPEG_BYTES, 'image/png')).toThrowError(WorldError);
  });

  it('rejects oversized payloads and dimensions', () => {
    expect(() => validateAvatarImage(Buffer.alloc(1024 * 1024 + 1), 'image/png')).toThrowError(WorldError);
    expect(() => validateAvatarImage(createOversizedDimensionPng(), 'image/png')).toThrowError(WorldError);
  });

  it('builds filenames and urls and resolves mime types from filenames', () => {
    expect(buildAvatarFilename('agent-123', 'png')).toBe('agent-123.png');
    expect(buildAvatarFilename('agent-123', 'jpg')).toBe('agent-123.jpg');
    expect(buildAvatarUrlPath('agent-123')).toBe('/api/admin/agents/agent-123/avatar');
    expect(avatarMimeTypeFromFilename('agent-123.png')).toBe('image/png');
    expect(avatarMimeTypeFromFilename('agent-123.jpg')).toBe('image/jpeg');
    expect(avatarMimeTypeFromFilename('agent-123.jpeg')).toBe('image/jpeg');
    expect(avatarMimeTypeFromFilename('../agent-123.png')).toBeNull();
    expect(avatarMimeTypeFromFilename('..\\agent-123.png')).toBeNull();
    expect(avatarMimeTypeFromFilename('agent-123.gif')).toBeNull();
  });

  it('resolves stored avatar paths within the avatar directory only', () => {
    expect(resolveStoredAvatarPath(resolve('avatars'), 'agent-123.png')).toBe(resolve('avatars', 'agent-123.png'));
    expect(() => resolveStoredAvatarPath(resolve('avatars'), '../agent-123.png')).toThrowError(WorldError);
    expect(() => resolveStoredAvatarPath(resolve('avatars'), '..\\agent-123.png')).toThrowError(WorldError);
  });
});
