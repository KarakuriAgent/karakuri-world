import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { WorldError } from '../types/api.js';

export type AvatarMimeType = 'image/png' | 'image/jpeg';
export type AvatarFileExtension = 'png' | 'jpg';

export interface AvatarImageMetadata {
  ext: AvatarFileExtension;
  height: number;
  mimeType: AvatarMimeType;
  width: number;
}

const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_AVATAR_DIMENSION = 512;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

export function validateAvatarImage(data: Uint8Array, mimeType: string): AvatarImageMetadata {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  if (buffer.byteLength === 0) {
    throw new WorldError(400, 'invalid_request', 'Avatar image must not be empty.');
  }

  if (buffer.byteLength > MAX_AVATAR_BYTES) {
    throw new WorldError(400, 'invalid_request', 'Avatar image must be 1MB or smaller.');
  }

  if (normalizedMimeType === 'image/png') {
    if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new WorldError(400, 'invalid_request', 'Avatar image content does not match its declared MIME type.');
    }

    const { width, height } = readPngDimensions(buffer);
    validateDimensions(width, height);
    return { ext: 'png', height, mimeType: normalizedMimeType, width };
  }

  if (!buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    throw new WorldError(400, 'invalid_request', 'Avatar image content does not match its declared MIME type.');
  }

  const { width, height } = readJpegDimensions(buffer);
  validateDimensions(width, height);
  return { ext: 'jpg', height, mimeType: normalizedMimeType, width };
}

export function buildAvatarFilename(agentId: string, ext: AvatarFileExtension): string {
  return `${agentId}.${ext}`;
}

export function buildAvatarUrlPath(agentId: string): string {
  return `/api/admin/agents/${agentId}/avatar`;
}

export function isSafeAvatarFilename(filename: string): boolean {
  if (filename.length === 0 || filename.includes('/') || filename.includes('\\')) {
    return false;
  }

  return avatarMimeTypeFromExtension(extname(filename).toLowerCase()) !== null;
}

export function resolveStoredAvatarPath(directory: string, filename: string): string {
  if (!isSafeAvatarFilename(filename)) {
    throw new WorldError(500, 'invalid_config', 'Invalid avatar filename.');
  }

  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(resolvedDirectory, filename);
  const relativePath = relative(resolvedDirectory, resolvedPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new WorldError(500, 'invalid_config', 'Invalid avatar filename.');
  }

  return resolvedPath;
}

export function avatarMimeTypeFromFilename(filename: string): AvatarMimeType | null {
  if (!isSafeAvatarFilename(filename)) {
    return null;
  }

  return avatarMimeTypeFromExtension(extname(filename).toLowerCase());
}

function normalizeMimeType(value: string): AvatarMimeType {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'image/png' || normalized === 'image/jpeg') {
    return normalized;
  }

  throw new WorldError(400, 'invalid_request', 'Avatar image must be PNG or JPEG.');
}

function avatarMimeTypeFromExtension(extension: string): AvatarMimeType | null {
  if (extension === '.png') {
    return 'image/png';
  }

  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }

  return null;
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new WorldError(400, 'invalid_request', 'Avatar image must include valid dimensions.');
  }

  if (width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION) {
    throw new WorldError(400, 'invalid_request', 'Avatar image must be 512x512 or smaller.');
  }
}

function readPngDimensions(buffer: Buffer): { height: number; width: number } {
  if (buffer.length < PNG_SIGNATURE.length + 12) {
    throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid PNG file.');
  }

  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let seenIhdr = false;
  let seenIend = false;

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    const crcEnd = dataEnd + 4;

    if (crcEnd > buffer.length) {
      throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid PNG file.');
    }

    const chunkType = buffer.toString('ascii', typeOffset, typeOffset + 4);
    if (chunkType === 'IHDR') {
      if (seenIhdr || chunkLength < 13) {
        throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid PNG file.');
      }
      width = buffer.readUInt32BE(dataOffset);
      height = buffer.readUInt32BE(dataOffset + 4);
      seenIhdr = true;
    }

    offset = crcEnd;
    if (chunkType === 'IEND') {
      seenIend = true;
      break;
    }
  }

  if (!seenIhdr || !seenIend || width === undefined || height === undefined) {
    throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid PNG file.');
  }

  return { height, width };
}

function readJpegDimensions(buffer: Buffer): { height: number; width: number } {
  if (buffer.length < JPEG_SIGNATURE.length + 4) {
    throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid JPEG file.');
  }

  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid JPEG file.');
    }

    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= buffer.length) {
      break;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9) {
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > buffer.length) {
      throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid JPEG file.');
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid JPEG file.');
    }

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid JPEG file.');
      }

      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return { height, width };
    }

    if (marker === 0xda) {
      break;
    }

    offset += segmentLength;
  }

  throw new WorldError(400, 'invalid_request', 'Avatar image must be a valid JPEG file.');
}
