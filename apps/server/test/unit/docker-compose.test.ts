import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const composePath = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url));
const envExamplePath = fileURLToPath(new URL('../../.env.example', import.meta.url));
const dockerfilePath = fileURLToPath(new URL('../../Dockerfile', import.meta.url));

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

  it('mounts the daily log directory into the container', () => {
    const compose = readFileSync(composePath, 'utf8');
    const envExample = readFileSync(envExamplePath, 'utf8');

    expect(envExample).toContain('LOG_DIR=');
    expect(compose).toContain('${LOG_DIR:-./logs}:/app/logs');
  });

  it('pipes container stdout and stderr to daily rotatelogs files', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).toContain('apache2-utils');
    expect(dockerfile).toContain('tini');
    expect(dockerfile).toMatch(/ENTRYPOINT\s+\["\/usr\/bin\/tini",\s*"-g",\s*"--"\]/);
    expect(dockerfile).toMatch(
      /rotatelogs\s+-e\s+-l\s+\/app\/logs\/%Y-%m-%d\.log\s+86400/,
    );
    expect(dockerfile).toMatch(/exec\s+node\s+dist\/src\/index\.js\s+2>&1/);
  });
});
