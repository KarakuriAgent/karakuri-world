import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateDrill,
  loadJson,
  validateAlertCatalog,
  validateReadinessManifest,
} from '../ops/relay-readiness.js';

const specPath = fileURLToPath(new URL('../ops/relay-alerting-spec.json', import.meta.url));
const drillsPath = fileURLToPath(new URL('../ops/relay-synthetic-drills.json', import.meta.url));
const templateManifestPath = fileURLToPath(new URL('../ops/relay-production-readiness.template.json', import.meta.url));
const exampleManifestPath = fileURLToPath(new URL('../ops/relay-production-readiness.example.json', import.meta.url));
const realWranglerPath = fileURLToPath(new URL('../../wrangler.toml', import.meta.url));
const productionWranglerFixturePath = fileURLToPath(new URL('./fixtures/wrangler.production.example.toml', import.meta.url));
const readinessScriptPath = fileURLToPath(new URL('../scripts/relay-readiness.mjs', import.meta.url));
const repoRootPath = fileURLToPath(new URL('../..', import.meta.url));
const readmePath = fileURLToPath(new URL('../../README.md', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));

function loadCatalog() {
  const spec = loadJson(specPath);
  const drillsDocument = loadJson(drillsPath);

  return {
    spec,
    drills: drillsDocument.drills,
  };
}

describe('relay alerting readiness', () => {
  it('keeps the checked-in alert catalog and synthetic drills internally consistent', () => {
    const { spec, drills } = loadCatalog();

    expect(validateAlertCatalog(spec, drills)).toEqual([]);

    const authRejectedAlert = spec.alerts.find((alert: { id: string }) => alert.id === 'relay-ws-auth-rejected-page');
    expect(authRejectedAlert).toMatchObject({
      route: 'relay-config-pager',
      page_policy: 'immediate',
    });

    const networkAlert = spec.alerts.find((alert: { id: string }) => alert.id === 'relay-ws-network-sustained-page');
    expect(networkAlert).toMatchObject({
      route: 'relay-sustained-pager',
      page_policy: 'sustained_15m',
    });

    const retentionSilenceAlert = spec.alerts.find((alert: { id: string }) => alert.id === 'relay-retention-silence-page');
    expect(retentionSilenceAlert.condition).toMatchObject({
      type: 'absent_counter',
      metric: 'relay.d1.retention_run_total',
      missing_for_days: 2,
    });

    const retentionBacklogAlert = spec.alerts.find((alert: { id: string }) => alert.id === 'relay-retention-backlog-ticket');
    expect(retentionBacklogAlert).toMatchObject({
      route: 'relay-ops-ticket',
    });
    expect(retentionBacklogAlert.condition).toMatchObject({
      type: 'gauge',
      metric: 'relay.d1.retention_deleted_rows',
      min_value: 10000,
    });

    const retryBrakeAlert = spec.alerts.find((alert: { id: string }) => alert.id === 'relay-r2-backoff-saturation-page');
    expect(retryBrakeAlert.condition).toMatchObject({
      type: 'gauge',
      metric: 'relay.r2.publish_failure_streak',
      min_value: 5,
    });
  });

  it('evaluates every staged drill into the expected alert and route set', () => {
    const { spec, drills } = loadCatalog();

    for (const drill of drills) {
      expect(evaluateDrill(spec, drill)).toEqual({
        alert_ids: [...drill.expected_alert_ids].sort(),
        route_ids: [...drill.expected_route_ids].sort(),
      });
    }
  });

  it('requires every alert path to stay covered by at least one staged drill', () => {
    const { spec, drills } = loadCatalog();
    const brokenDrills = drills.filter((drill: { id: string }) => drill.id !== 'event-ingest-failure');

    expect(validateAlertCatalog(spec, brokenDrills)).toEqual(
      expect.arrayContaining([
        'alert relay-d1-ingest-failure-ticket must be covered by at least one synthetic drill',
        'alert relay-unknown-event-ticket must be covered by at least one synthetic drill',
      ]),
    );
  });

  it('blocks production readiness when the manifest is unfinished or wrangler still contains placeholders', () => {
    const { spec, drills } = loadCatalog();
    const templateManifest = loadJson(templateManifestPath);
    const realWrangler = readFileSync(realWranglerPath, 'utf8');

    const issues = validateReadinessManifest(spec, drills, templateManifest, {
      target: 'production',
      wranglerText: realWrangler,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        'route binding relay-config-pager must define a non-placeholder destination_ref',
        'missing alert_rule_receipt for relay-ws-auth-rejected-page',
        'missing staging_drill_receipt for auth-rejected-handshake',
        'deployment_checklist.auth_rejected_route_verified_at must be an ISO timestamp',
        'wrangler.toml still contains placeholder D1 database IDs',
        'wrangler.toml still contains placeholder R2 bucket names',
      ]),
    );
  });

  it('accepts a fully populated production readiness manifest against a deployable wrangler config', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const fixtureWrangler = readFileSync(productionWranglerFixturePath, 'utf8');

    expect(
      validateReadinessManifest(spec, drills, exampleManifest, {
        target: 'production',
        wranglerText: fixtureWrangler,
      }),
    ).toEqual([]);
  });

  it('requires deployable HISTORY_DB and SNAPSHOT_BUCKET bindings in production wrangler configs', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const incompleteWrangler = `
name = "karakuri-world-ui"
main = "worker/src/index.ts"
compatibility_date = "2025-04-14"

[triggers]
crons = ["0 3 * * *"]
`;

    expect(
      validateReadinessManifest(spec, drills, exampleManifest, {
        target: 'production',
        wranglerText: incompleteWrangler,
      }),
    ).toEqual(
      expect.arrayContaining([
        'wrangler.toml must define [[d1_databases]] binding = "HISTORY_DB"',
        'wrangler.toml must define [[r2_buckets]] binding = "SNAPSHOT_BUCKET"',
      ]),
    );
  });

  it('ignores commented-out wrangler bindings and cron entries during production validation', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const commentedWrangler = `
name = "x"
# [triggers]
# crons = ["0 3 * * *"]
# [[d1_databases]]
# binding = "HISTORY_DB"
# database_id = "11111111-1111-1111-1111-111111111111"
# preview_database_id = "22222222-2222-2222-2222-222222222222"
# [[r2_buckets]]
# binding = "SNAPSHOT_BUCKET"
# bucket_name = "bucket-prod"
# preview_bucket_name = "bucket-preview"
`;

    expect(
      validateReadinessManifest(spec, drills, exampleManifest, {
        target: 'production',
        wranglerText: commentedWrangler,
      }),
    ).toEqual(
      expect.arrayContaining([
        'wrangler.toml must keep the daily 03:00 UTC retention cron enabled',
        'wrangler.toml must define [[d1_databases]] binding = "HISTORY_DB"',
        'wrangler.toml must define [[r2_buckets]] binding = "SNAPSHOT_BUCKET"',
      ]),
    );
  });

  it('rejects generic placeholder values inside deployable wrangler bindings', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const placeholderWrangler = `
name = "karakuri-world-ui"
main = "worker/src/index.ts"
compatibility_date = "2025-04-14"

[triggers]
crons = ["0 3 * * *"]

[[d1_databases]]
binding = "HISTORY_DB"
database_id = "REPLACE_ME"
preview_database_id = "CHANGE_ME"

[[r2_buckets]]
binding = "SNAPSHOT_BUCKET"
bucket_name = "example only"
preview_bucket_name = "CHANGE_ME"
`;

    expect(
      validateReadinessManifest(spec, drills, exampleManifest, {
        target: 'production',
        wranglerText: placeholderWrangler,
      }),
    ).toEqual(
      expect.arrayContaining([
        'wrangler.toml still contains placeholder D1 database IDs',
        'wrangler.toml still contains placeholder R2 bucket names',
      ]),
    );
  });

  it('rejects production manifests that collapse the config pager and sustained pager into one destination or record the wrong route receipt', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const brokenManifest = {
      ...exampleManifest,
      route_bindings: {
        ...exampleManifest.route_bindings,
        'relay-sustained-pager': {
          ...exampleManifest.route_bindings['relay-sustained-pager'],
          destination_ref: exampleManifest.route_bindings['relay-config-pager'].destination_ref,
        },
      },
      staging_drill_receipts: {
        ...exampleManifest.staging_drill_receipts,
        'auth-rejected-handshake': {
          ...exampleManifest.staging_drill_receipts['auth-rejected-handshake'],
          observed_route_ids: ['relay-sustained-pager'],
        },
      },
    };
    const fixtureWrangler = readFileSync(productionWranglerFixturePath, 'utf8');

    expect(
      validateReadinessManifest(spec, drills, brokenManifest, {
        target: 'production',
        wranglerText: fixtureWrangler,
      }),
    ).toEqual(
      expect.arrayContaining([
        'relay-config-pager and relay-sustained-pager must resolve to different destinations',
        'staging_drill_receipt auth-rejected-handshake must record routes relay-config-pager',
        'staging_drill_receipts must cover alert relay-ws-auth-rejected-page',
      ]),
    );
  });

  it('treats the documented --target=production CLI form as a real production gate', () => {
    const templateRun = spawnSync(
      process.execPath,
      [
        readinessScriptPath,
        '--target=production',
        '--manifest',
        templateManifestPath,
        '--wrangler',
        realWranglerPath,
      ],
      {
        cwd: repoRootPath,
        encoding: 'utf8',
      },
    );
    const exampleRun = spawnSync(
      process.execPath,
      [
        readinessScriptPath,
        '--target=production',
        '--manifest',
        exampleManifestPath,
        '--wrangler',
        productionWranglerFixturePath,
      ],
      {
        cwd: repoRootPath,
        encoding: 'utf8',
      },
    );

    expect(templateRun.status).toBe(1);
    expect(templateRun.stderr).toContain('wrangler.toml still contains placeholder D1 database IDs');
    expect(templateRun.stderr).toContain('wrangler.toml still contains placeholder R2 bucket names');
    expect(exampleRun.status).toBe(0);
    expect(exampleRun.stdout).toContain('relay readiness validation passed');
  });

  it('rejects unsupported readiness targets instead of silently skipping production-only checks', () => {
    const invalidTargetRun = spawnSync(
      process.execPath,
      [
        readinessScriptPath,
        '--target=prod',
        '--manifest',
        exampleManifestPath,
        '--wrangler',
        realWranglerPath,
      ],
      {
        cwd: repoRootPath,
        encoding: 'utf8',
      },
    );

    expect(invalidTargetRun.status).toBe(1);
    expect(invalidTargetRun.stderr).toContain('unsupported relay readiness target: prod');
  });

  it('fails closed when production gate arguments are incomplete', () => {
    const missingManifestRun = spawnSync(process.execPath, [readinessScriptPath, '--target=production'], {
      cwd: repoRootPath,
      encoding: 'utf8',
    });
    const missingTargetRun = spawnSync(
      process.execPath,
      [
        readinessScriptPath,
        '--manifest',
        exampleManifestPath,
        '--wrangler',
        realWranglerPath,
      ],
      {
        cwd: repoRootPath,
        encoding: 'utf8',
      },
    );

    expect(missingManifestRun.status).toBe(1);
    expect(missingManifestRun.stderr).toContain('--target=production requires --manifest');
    expect(missingTargetRun.status).toBe(1);
    expect(missingTargetRun.stderr).toContain('--manifest requires --target=production');
    expect(missingTargetRun.stderr).toContain('--wrangler requires --target=production');
  });

  it('treats empty inline manifest and wrangler values as missing arguments', () => {
    const emptyManifestRun = spawnSync(
      process.execPath,
      [
        readinessScriptPath,
        '--target=production',
        '--manifest=',
        '--wrangler',
        productionWranglerFixturePath,
      ],
      {
        cwd: repoRootPath,
        encoding: 'utf8',
      },
    );
    const emptyWranglerRun = spawnSync(
      process.execPath,
      [
        readinessScriptPath,
        '--target=production',
        '--manifest',
        exampleManifestPath,
        '--wrangler=',
      ],
      {
        cwd: repoRootPath,
        encoding: 'utf8',
      },
    );

    expect(emptyManifestRun.status).toBe(1);
    expect(emptyManifestRun.stderr).toContain('missing value for --manifest');
    expect(emptyWranglerRun.status).toBe(1);
    expect(emptyWranglerRun.stderr).toContain('missing value for --wrangler');
  });

  it('documents the relay readiness gate in package scripts and README', () => {
    const readme = readFileSync(readmePath, 'utf8');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['relay:readiness']).toBe('node worker/scripts/relay-readiness.mjs');
    expect(readme).toContain('## Relay alert wiring and readiness gate');
    expect(readme).toContain('worker/ops/relay-alerting-spec.json');
    expect(readme).toContain('worker/ops/relay-synthetic-drills.json');
    expect(readme).toContain('worker/ops/relay-production-readiness.template.json');
    expect(readme).toContain('npm run relay:readiness');
    expect(readme).toContain('--target=production --manifest');
    expect(readme).toContain('different production destinations');
    expect(readme).toContain('observed route IDs');
  });
});
