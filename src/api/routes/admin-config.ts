import type { Hono } from 'hono';
import { z } from 'zod';

import { ConfigValidationError } from '../../config/validation.js';
import { loadConfigFromFile, saveConfigToFile, validateConfig } from '../../config/index.js';
import { WorldError } from '../../types/api.js';
import type { ApiEnv } from '../context.js';
import { adminAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

const configEnvelopeSchema = z.object({
  config: z.unknown(),
}).strict();

function getValidatedConfig(rawConfig: unknown) {
  const result = validateConfig(rawConfig);
  if (!result.success) {
    throw new WorldError(400, 'validation_error', 'Config validation failed.', result.issues);
  }

  return result.config;
}

async function readConfigOrThrow(configPath: string) {
  try {
    return await loadConfigFromFile(configPath);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw new WorldError(500, 'invalid_config', 'Stored config is invalid.', error.issues);
    }

    throw error;
  }
}

export function registerAdminConfigRoutes(
  app: Hono<ApiEnv>,
  options: { adminKey: string; configPath: string },
): void {
  app.get('/api/admin/config', adminAuth(options.adminKey), async (c) => {
    return c.json({
      config: await readConfigOrThrow(options.configPath),
    });
  });

  app.put('/api/admin/config', adminAuth(options.adminKey), validateBody(configEnvelopeSchema), async (c) => {
    const body = c.get('validatedBody') as z.infer<typeof configEnvelopeSchema>;
    const config = getValidatedConfig(body.config);
    await saveConfigToFile(options.configPath, config);
    return c.json({ status: 'ok' });
  });

  app.post('/api/admin/config/validate', adminAuth(options.adminKey), validateBody(configEnvelopeSchema), (c) => {
    const body = c.get('validatedBody') as z.infer<typeof configEnvelopeSchema>;
    getValidatedConfig(body.config);
    return c.json({ valid: true });
  });
}
