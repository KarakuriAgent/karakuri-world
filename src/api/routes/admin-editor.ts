import { readFile } from 'node:fs/promises';

import type { Hono } from 'hono';

import { WorldError } from '../../types/api.js';
import type { ApiEnv } from '../context.js';

const EDITOR_ASSET_CONTENT_TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'editor.js': 'text/javascript; charset=utf-8',
  'editor.css': 'text/css; charset=utf-8',
} as const;

type EditorAssetName = keyof typeof EDITOR_ASSET_CONTENT_TYPES;

const editorAssetBaseUrl = new URL('../../admin/editor/', import.meta.url);

function getEditorAssetPath(rawAssetPath: string): EditorAssetName {
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(rawAssetPath);
  } catch {
    throw new WorldError(404, 'not_found', 'Editor asset not found.');
  }

  if (!Object.hasOwn(EDITOR_ASSET_CONTENT_TYPES, assetPath)) {
    throw new WorldError(404, 'not_found', 'Editor asset not found.');
  }

  return assetPath as EditorAssetName;
}

async function serveEditorAsset(assetName: EditorAssetName): Promise<Response> {
  const body = await readFile(new URL(assetName, editorAssetBaseUrl));
  return new Response(body, {
    headers: {
      'content-type': EDITOR_ASSET_CONTENT_TYPES[assetName],
    },
  });
}

export function registerAdminEditorRoutes(app: Hono<ApiEnv>): void {
  app.get('/admin/editor', async () => serveEditorAsset('index.html'));
  app.get('/admin/editor/', async () => serveEditorAsset('index.html'));
  app.get('/admin/editor/*', async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const assetPath = pathname.slice('/admin/editor/'.length);
    return serveEditorAsset(getEditorAssetPath(assetPath));
  });
}
