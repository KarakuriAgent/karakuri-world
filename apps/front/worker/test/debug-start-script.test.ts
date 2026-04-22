import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const debugStartScriptPath = fileURLToPath(new URL('../../scripts/debug-start.sh', import.meta.url));
const readmePath = fileURLToPath(new URL('../../README.md', import.meta.url));
const readmeJaPath = fileURLToPath(new URL('../../README.ja.md', import.meta.url));

describe('debug-start script', () => {
  it('provisions the shared publish secret before deploying the debug worker', () => {
    const script = readFileSync(debugStartScriptPath, 'utf8');

    expect(script).not.toContain('wrangler secret put KW_ADMIN_KEY');
    expect(script).toContain('wrangler secret put SNAPSHOT_PUBLISH_AUTH_KEY');
    expect(script).toContain('SNAPSHOT_PUBLISH_AUTH_KEY シークレットを設定してください:');
    expect(script).toContain('本体サーバー側の SNAPSHOT_PUBLISH_AUTH_KEY と同じ値を入力してください');
  });

  it('uses the snapshot manifest URL contract in the interactive prompts', () => {
    const script = readFileSync(debugStartScriptPath, 'utf8');

    expect(script).toContain('Cache Everything on snapshot/manifest.json');
    expect(script).toContain('https://snapshot.example.com/snapshot/manifest.json');
    expect(script).not.toContain('https://snapshot.example.com/snapshot/latest.json');
  });

  it('documents that debug:start must use the backend publish secret', () => {
    const readme = readFileSync(readmePath, 'utf8');
    const readmeJa = readFileSync(readmeJaPath, 'utf8');

    expect(readme).toContain('npm run debug:start');
    expect(readme).toContain('same `SNAPSHOT_PUBLISH_AUTH_KEY` value that your backend uses');
    expect(readmeJa).toContain('npm run debug:start');
    expect(readmeJa).toContain('本体サーバーで使っている値と同じ共有キー');
  });
});
