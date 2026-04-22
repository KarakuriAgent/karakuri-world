import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const composePath = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url));
const envExamplePath = fileURLToPath(new URL('../../.env.example', import.meta.url));

describe('docker compose runtime env wiring', () => {
  it('passes mandatory snapshot publish settings into the container', () => {
    const compose = readFileSync(composePath, 'utf8');
    const envExample = readFileSync(envExamplePath, 'utf8');

    expect(envExample).toContain('SNAPSHOT_PUBLISH_BASE_URL=');
    expect(envExample).toContain('SNAPSHOT_PUBLISH_AUTH_KEY=');

    expect(compose).toContain(
      'SNAPSHOT_PUBLISH_BASE_URL: ${SNAPSHOT_PUBLISH_BASE_URL:?SNAPSHOT_PUBLISH_BASE_URL must be set in .env}',
    );
    expect(compose).toContain(
      'SNAPSHOT_PUBLISH_AUTH_KEY: ${SNAPSHOT_PUBLISH_AUTH_KEY:?SNAPSHOT_PUBLISH_AUTH_KEY must be set in .env}',
    );
  });
});
