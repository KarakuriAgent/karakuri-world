import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const wranglerConfigPath = fileURLToPath(new URL('../../wrangler.toml.example', import.meta.url));
const readmePath = fileURLToPath(new URL('../../README.md', import.meta.url));
const readmeJaPath = fileURLToPath(new URL('../../README.ja.md', import.meta.url));

describe('wrangler configuration', () => {
  it('wires the relay durable object and shared snapshot/history R2 bucket bindings', () => {
    const config = readFileSync(wranglerConfigPath, 'utf8');

    expect(config).toContain('[[durable_objects.bindings]]');
    expect(config).toContain('name = "UI_BRIDGE"');
    expect(config).toContain('class_name = "UIBridgeDurableObject"');
    expect(config).toContain('[[migrations]]');
    expect(config).toContain('new_sqlite_classes = ["UIBridgeDurableObject"]');
    expect(config).not.toContain('[[d1_databases]]');
    expect(config).not.toContain('[triggers]');
    expect(config).toContain('[[r2_buckets]]');
    expect(config).toContain('binding = "SNAPSHOT_BUCKET"');
  });

  it('documents R2-only deployment without D1 provisioning or retention cron guidance', () => {
    const config = readFileSync(wranglerConfigPath, 'utf8');
    const readme = readFileSync(readmePath, 'utf8');
    const readmeJa = readFileSync(readmeJaPath, 'utf8');

    expect(config).toContain('Replace these placeholder bucket names with the real R2 bucket names');
    expect(config).toContain('bucket_name = "replace-with-real-snapshot-bucket"');
    expect(config).toContain('preview_bucket_name = "replace-with-real-snapshot-bucket-preview"');
    expect(config).not.toContain('database_id = "00000000-0000-0000-0000-000000000000"');

    expect(readme).toContain('placeholder R2 bucket names');
    expect(readmeJa).toContain('プレースホルダ R2 バケット名');

    for (const text of [readme, readmeJa]) {
      expect(text).toContain('`wrangler.toml`');
      expect(text).toContain('npx wrangler r2 bucket create <real-snapshot-bucket>');
      expect(text).not.toContain('npx wrangler d1 create');
      expect(text).not.toContain('npx wrangler d1 migrations apply HISTORY_DB --remote');
      expect(text).not.toContain('03:00 UTC');
      expect(text).not.toContain('HISTORY_RETENTION_DAYS');
      expect(text).not.toContain('schema/history.sql');
      expect(text).not.toContain('HISTORY_DB');
    }
  });
});
