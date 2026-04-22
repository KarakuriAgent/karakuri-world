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
import { SNAPSHOT_REFRESH_REASONS } from '../src/relay/bridge.js';

const specPath = fileURLToPath(new URL('../ops/relay-alerting-spec.json', import.meta.url));
const drillsPath = fileURLToPath(new URL('../ops/relay-synthetic-drills.json', import.meta.url));
const templateManifestPath = fileURLToPath(new URL('../ops/relay-production-readiness.template.json', import.meta.url));
const exampleManifestPath = fileURLToPath(new URL('../ops/relay-production-readiness.example.json', import.meta.url));
const realWranglerPath = fileURLToPath(new URL('../../wrangler.toml.example', import.meta.url));
const productionWranglerFixturePath = fileURLToPath(new URL('./fixtures/wrangler.production.example.toml', import.meta.url));
const readinessScriptPath = fileURLToPath(new URL('../scripts/relay-readiness.mjs', import.meta.url));
const repoRootPath = fileURLToPath(new URL('../..', import.meta.url));

function loadCatalog() {
  const spec = loadJson(specPath);
  const drillsDocument = loadJson(drillsPath);

  return {
    spec,
    drills: drillsDocument.drills,
  };
}

describe('relay alerting readiness', () => {
  it('keeps readiness artifacts aligned with the Phase 8 refresh failure reasons emitted by the worker', () => {
    const { spec, drills } = loadCatalog();
    const allowedReasons = new Set(SNAPSHOT_REFRESH_REASONS);
    const freshnessCounter = spec.alerts
      .find((alert: { id: string }) => alert.id === 'relay-snapshot-freshness-page')
      ?.condition?.conditions?.find((condition: { metric?: string }) => condition.metric === 'ui.snapshot.refresh_failure_total');
    const counterReasons = freshnessCounter?.match_tags?.reason;
    const drillReasons = drills
      .flatMap((drill: { verification?: { samples?: Array<{ metric?: string; tags?: { reason?: string } }> } }) =>
        (drill.verification?.samples ?? [])
          .filter((sample) => sample.metric === 'ui.snapshot.refresh_failure_total')
          .map((sample) => sample.tags?.reason),
      )
      .filter((reason: unknown): reason is string => typeof reason === 'string');

    expect(counterReasons).toEqual(SNAPSHOT_REFRESH_REASONS);
    expect(drillReasons).toContain('fallback-refresh');
    expect(drillReasons).not.toContain('fixed-cadence');
    expect([...counterReasons, ...drillReasons].every((reason) => allowedReasons.has(reason))).toBe(true);
  });

  it('keeps the checked-in alert catalog and synthetic drills internally consistent', () => {
    const { spec, drills } = loadCatalog();

    expect(validateAlertCatalog(spec, drills)).toEqual([]);

    const retryBrakeAlert = spec.alerts.find((alert: { id: string }) => alert.id === 'relay-r2-backoff-saturation-page');
    expect(retryBrakeAlert.condition).toMatchObject({
      type: 'gauge',
      metric: 'ui.r2.publish_failure_streak',
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

  it('requires every primary alert path to stay covered by at least one staged drill', () => {
    const { spec, drills } = loadCatalog();
    const brokenDrills = drills.filter((drill: { id: string }) => drill.id !== 'r2-publish-retry-brake');

    expect(validateAlertCatalog(spec, brokenDrills)).toEqual(
      expect.arrayContaining([
        'alert relay-r2-backoff-saturation-page must be covered by at least one synthetic drill',
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
        'route binding relay-sustained-pager must define a non-placeholder destination_ref',
        'missing alert_rule_receipt for relay-snapshot-freshness-page',
        'missing staging_drill_receipt for polling-freshness-failure',
        'deployment_checklist.r2_custom_domain_verified_at must be an ISO timestamp',
        'deployment_checklist.cache_rules_edge_ttl_verified_at must be an ISO timestamp',
        'deployment_checklist.auth_mode_smoke_verified_at must be an ISO timestamp',
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

  it('requires a deployable SNAPSHOT_BUCKET binding in production wrangler configs', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const incompleteWrangler = `
name = "karakuri-world-ui"
main = "worker/src/index.ts"
compatibility_date = "2025-04-14"
`;

    expect(
      validateReadinessManifest(spec, drills, exampleManifest, {
        target: 'production',
        wranglerText: incompleteWrangler,
      }),
    ).toEqual(
      expect.arrayContaining([
        'wrangler.toml must define [[r2_buckets]] binding = "SNAPSHOT_BUCKET"',
      ]),
    );
  });

  it('ignores commented-out wrangler bindings during production validation', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const commentedWrangler = `
name = "x"
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
        'wrangler.toml still contains placeholder R2 bucket names',
      ]),
    );
  });

  it('rejects production manifests that omit a required route binding or record mismatched drill routes', () => {
    const { spec, drills } = loadCatalog();
    const exampleManifest = loadJson(exampleManifestPath);
    const routeBindings = exampleManifest.route_bindings as Record<string, unknown>;
    const { 'relay-ops-ticket': _removed, ...remainingBindings } = routeBindings;
    const drillReceipts = exampleManifest.staging_drill_receipts as Record<string, Record<string, unknown>>;
    const brokenManifest = {
      ...exampleManifest,
      route_bindings: remainingBindings,
      staging_drill_receipts: {
        ...drillReceipts,
        'r2-publish-retry-brake': {
          ...drillReceipts['r2-publish-retry-brake'],
          observed_route_ids: ['relay-ops-ticket'],
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
        'missing route binding for relay-ops-ticket',
        'staging_drill_receipt r2-publish-retry-brake must record routes relay-sustained-pager',
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
  });
});
