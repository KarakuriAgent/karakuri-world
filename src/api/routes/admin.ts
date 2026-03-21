import { File } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { buildAvatarFilename, type AvatarFileExtension } from '../../domain/avatar.js';
import type { WorldEngine } from '../../engine/world-engine.js';
import { WorldError } from '../../types/api.js';
import type { ApiEnv } from '../context.js';
import { adminAuth } from '../middleware/auth.js';
import { getAvatarDirectory, readAvatarUpload, unlinkIfExists } from './admin-avatar.js';

const agentNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;

const registerAgentSchema = z.object({
  agent_name: z.string().min(2).max(32).regex(agentNamePattern),
  agent_label: z.string().min(1).max(100),
  discord_bot_id: z.string().min(1),
});

type RegisterAgentInput = z.infer<typeof registerAgentSchema>;
type FormBodyValue = string | File | (string | File)[];

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function rollbackAgentRegistration(engine: WorldEngine, agentId: string, avatarError: unknown): Promise<void> {
  try {
    await engine.deleteAgent(agentId);
  } catch (error) {
    throw new AggregateError([avatarError, error], 'Failed to roll back agent registration after avatar persistence failed.');
  }
}

function toValidationError(error: z.ZodError): WorldError {
  return new WorldError(400, 'invalid_request', 'Request validation failed.', error.flatten());
}

function parseRegisterAgentInput(payload: unknown): RegisterAgentInput {
  const parsed = registerAgentSchema.safeParse(payload);
  if (!parsed.success) {
    throw toValidationError(parsed.error);
  }

  return parsed.data;
}

function getSingleFormValue(value: FormBodyValue | undefined): string | File | undefined {
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined;
  }

  return value;
}

function getFormString(body: Record<string, FormBodyValue>, key: keyof RegisterAgentInput): string | undefined {
  const value = getSingleFormValue(body[key]);
  return typeof value === 'string' ? value : undefined;
}

function getFormFile(body: Record<string, FormBodyValue>, key: string): File | undefined {
  const value = getSingleFormValue(body[key]);
  if (value === undefined) {
    return undefined;
  }

  if (value instanceof File) {
    return value;
  }

  throw new WorldError(400, 'invalid_request', 'Avatar field must be a file upload.');
}

async function parseRegisterAgentRequest(
  c: Context<ApiEnv>,
): Promise<{ avatar?: { bytes: Buffer; ext: AvatarFileExtension }; input: RegisterAgentInput }> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? '';

  if (contentType.startsWith('multipart/form-data')) {
    const body = (await c.req.parseBody()) as Record<string, FormBodyValue>;
    const input = parseRegisterAgentInput({
      agent_name: getFormString(body, 'agent_name'),
      agent_label: getFormString(body, 'agent_label'),
      discord_bot_id: getFormString(body, 'discord_bot_id'),
    });
    const avatarFile = getFormFile(body, 'avatar');

    return {
      input,
      ...(avatarFile ? { avatar: await readAvatarUpload(avatarFile) } : {}),
    };
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    throw new WorldError(400, 'invalid_request', 'Request body must be valid JSON.');
  }

  return {
    input: parseRegisterAgentInput(payload),
  };
}

export function registerAdminRoutes(
  app: Hono<ApiEnv>,
  engine: WorldEngine,
  options: { adminKey: string; dataDir?: string; publicBaseUrl: string },
): void {
  const publicBaseUrl = trimTrailingSlash(options.publicBaseUrl);

  app.post('/api/admin/agents', adminAuth(options.adminKey), async (c) => {
    const { avatar, input } = await parseRegisterAgentRequest(c);
    const registration = engine.registerAgent(input);

    if (avatar) {
      const filename = buildAvatarFilename(registration.agent_id, avatar.ext);
      const filePath = join(getAvatarDirectory(options.dataDir), filename);

      try {
        mkdirSync(getAvatarDirectory(options.dataDir), { recursive: true });
        writeFileSync(filePath, avatar.bytes);
        engine.updateAgentAvatar(registration.agent_id, filename);
      } catch (error) {
        unlinkIfExists(filePath);
        await rollbackAgentRegistration(engine, registration.agent_id, error);
        throw error;
      }
    }

    return c.json(
      {
        agent_id: registration.agent_id,
        api_key: registration.api_key,
        api_base_url: `${publicBaseUrl}/api`,
        mcp_endpoint: `${publicBaseUrl}/mcp`,
      },
      201,
    );
  });

  app.get('/api/admin/agents', adminAuth(options.adminKey), (c) => {
    return c.json({ agents: engine.listAgentSummaries() });
  });

  app.delete('/api/admin/agents/:agent_id', adminAuth(options.adminKey), async (c) => {
    const deleted = await engine.deleteAgent(c.req.param('agent_id'));
    if (!deleted) {
      throw new WorldError(404, 'not_found', 'Agent not found.');
    }

    return c.json({ status: 'ok' });
  });

  app.post('/api/admin/server-events/:event_id/fire', adminAuth(options.adminKey), (c) => {
    return c.json(engine.fireServerEvent(c.req.param('event_id')));
  });
}
