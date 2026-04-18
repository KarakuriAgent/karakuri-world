import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const wranglerConfigPath = fileURLToPath(new URL('../../wrangler.toml.example', import.meta.url));
const readmePath = fileURLToPath(new URL('../../README.md', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../schema/history.sql', import.meta.url));
const migrationPath = fileURLToPath(new URL('../../migrations/0001_plan05_history_schema.sql', import.meta.url));

describe('wrangler configuration', () => {
  it('wires the relay durable object, history database, and snapshot bucket bindings', () => {
    const config = readFileSync(wranglerConfigPath, 'utf8');

    expect(config).toContain('[triggers]');
    expect(config).toContain('crons = ["0 3 * * *"]');
    expect(config).toContain('[[durable_objects.bindings]]');
    expect(config).toContain('name = "UI_BRIDGE"');
    expect(config).toContain('class_name = "UIBridgeDurableObject"');
    expect(config).toContain('[[migrations]]');
    expect(config).toContain('new_sqlite_classes = ["UIBridgeDurableObject"]');
    expect(config).toContain('[[d1_databases]]');
    expect(config).toContain('binding = "HISTORY_DB"');
    expect(config).toContain('database_name = "karakuri-world-ui-history"');
    expect(config).toContain('[[r2_buckets]]');
    expect(config).toContain('binding = "SNAPSHOT_BUCKET"');
  });

  it('documents that checked-in D1 ids and R2 bucket names are placeholders that must be replaced before deploy', () => {
    const config = readFileSync(wranglerConfigPath, 'utf8');
    const readme = readFileSync(readmePath, 'utf8');

    expect(config).toContain('Replace these placeholder IDs with the real D1 IDs');
    expect(config).toContain('database_id = "00000000-0000-0000-0000-000000000000"');
    expect(config).toContain('preview_database_id = "00000000-0000-0000-0000-000000000000"');
    expect(config).toContain('Replace these placeholder bucket names with the real R2 bucket names');
    expect(config).toContain('bucket_name = "replace-with-real-snapshot-bucket"');
    expect(config).toContain('preview_bucket_name = "replace-with-real-snapshot-bucket-preview"');
    expect(readme).toContain('`wrangler.toml` is git-ignored and must be generated locally from the tracked template `wrangler.toml.example`');
    expect(readme).toContain('placeholder R2 bucket names for snapshot publishing');
    expect(readme).toContain('npx wrangler d1 create karakuri-world-ui-history');
    expect(readme).toContain('npx wrangler r2 bucket create <real-snapshot-bucket>');
    expect(readme).toContain('npx wrangler d1 migrations apply HISTORY_DB --remote');
    expect(readme).toContain('schedules the worker `scheduled()` handler once per day at `03:00 UTC`');
    expect(readme).toContain('`HISTORY_RETENTION_DAYS` remains optional and defaults to `180`');
    expect(readme).toContain('Choose exactly one auth mode per deployment');
    expect(readme).toContain('Do not point this at `/api/snapshot`');
    expect(readme).toContain('Do not mix modes within one deployment');
    expect(readme).toContain('do not add a Worker/Pages snapshot proxy fallback');
    expect(readme).toContain('`AUTH_MODE=access` is valid only when the browser already has a usable Access session');
    expect(readme).toContain('HISTORY_CORS_ALLOWED_ORIGINS');
    expect(readme).toContain('If Pages and Worker `/api/history` are cross-origin');
    expect(readme).toContain('configure R2 CORS so the Pages origin is allowed in both auth modes');
    expect(readme).toContain('Access-Control-Allow-Credentials: true');
    expect(readme).toContain('`AUTH_MODE=public`: expect success without Access login');
    expect(readme).toContain('`AUTH_MODE=access`: expect an Access auth challenge/failure before login, then success');
  });

  it('ships the checked-in D1 schema and first migration for fresh deployments', () => {
    expect(existsSync(schemaPath)).toBe(true);
    expect(existsSync(migrationPath)).toBe(true);

    const schema = readFileSync(schemaPath, 'utf8');
    const migration = readFileSync(migrationPath, 'utf8');

    for (const sql of [schema, migration]) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS world_events');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS server_event_instances');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS world_event_agents');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS world_event_conversations');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS world_event_agents_agent_timeline_idx');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS world_event_conversations_type_timeline_idx');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS server_event_instances_recent_idx');
    }
  });
});
