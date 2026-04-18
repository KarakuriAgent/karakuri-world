import { readFileSync } from 'node:fs';

const PLACEHOLDER_PATTERN =
  /REPLACE_ME|CHANGE_ME|placeholder|example only|00000000-0000-0000-0000-000000000000|replace-with-real-snapshot-bucket/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function tagsMatch(sampleTags = {}, expectedTags = {}) {
  return Object.entries(expectedTags).every(([key, expectedValue]) => {
    const actual = sampleTags[key];

    if (Array.isArray(expectedValue)) {
      return expectedValue.includes(actual);
    }

    return actual === expectedValue;
  });
}

function collectConditionMetrics(condition, bucket) {
  if (!condition) {
    return;
  }

  if (condition.type === 'all_of' || condition.type === 'any_of') {
    for (const nested of condition.conditions ?? []) {
      collectConditionMetrics(nested, bucket);
    }
    return;
  }

  if (typeof condition.metric === 'string') {
    bucket.add(condition.metric);
  }
}

function findAlert(spec, alertId) {
  return spec.alerts.find((alert) => alert.id === alertId);
}

function routeById(spec, routeId) {
  return spec.routes.find((route) => route.id === routeId);
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isFilledString(value) {
  return typeof value === 'string' && value.trim().length > 0 && !PLACEHOLDER_PATTERN.test(value);
}

function matchingSamples(samples, condition, evaluationAtMs, windowMs) {
  return samples.filter((sample) => {
    if (sample.metric !== condition.metric) {
      return false;
    }

    const sampleMs = Date.parse(sample.timestamp);

    if (Number.isNaN(sampleMs)) {
      return false;
    }

    if (windowMs !== undefined && (sampleMs < evaluationAtMs - windowMs || sampleMs > evaluationAtMs)) {
      return false;
    }

    return tagsMatch(sample.tags, condition.match_tags);
  });
}

function evaluateTerminalCondition(condition, samples, evaluationAtMs) {
  if (condition.type === 'counter') {
    const windowMs = Number(condition.within_minutes) * MINUTE_MS;
    const total = matchingSamples(samples, condition, evaluationAtMs, windowMs).reduce(
      (sum, sample) => sum + Number(sample.value ?? 1),
      0,
    );
    return total >= Number(condition.min_occurrences ?? 1);
  }

  if (condition.type === 'gauge') {
    if (condition.sustained_minutes !== undefined) {
      const windowMs = Number(condition.sustained_minutes) * MINUTE_MS;
      const matched = matchingSamples(samples, condition, evaluationAtMs, windowMs)
        .filter((sample) => Number(sample.value) >= Number(condition.min_value))
        .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

      if (matched.length === 0) {
        return false;
      }

      return Date.parse(matched[0].timestamp) <= evaluationAtMs - windowMs && Date.parse(matched.at(-1).timestamp) >= evaluationAtMs;
    }

    const windowMs = condition.within_minutes !== undefined ? Number(condition.within_minutes) * MINUTE_MS : undefined;
    return matchingSamples(samples, condition, evaluationAtMs, windowMs).some(
      (sample) => Number(sample.value) >= Number(condition.min_value),
    );
  }

  if (condition.type === 'absent_counter') {
    const windowMs = Number(condition.missing_for_days) * DAY_MS;
    return matchingSamples(samples, condition, evaluationAtMs, windowMs).length === 0;
  }

  return false;
}

function evaluateCondition(condition, samples, evaluationAtMs) {
  if (condition.type === 'all_of') {
    return (condition.conditions ?? []).every((nested) => evaluateCondition(nested, samples, evaluationAtMs));
  }

  if (condition.type === 'any_of') {
    return (condition.conditions ?? []).some((nested) => evaluateCondition(nested, samples, evaluationAtMs));
  }

  return evaluateTerminalCondition(condition, samples, evaluationAtMs);
}

export function evaluateDrill(spec, drill) {
  const evaluationAtMs = Date.parse(drill.verification.evaluation_at);
  const triggeredAlerts = spec.alerts
    .filter((alert) => evaluateCondition(alert.condition, drill.verification.samples, evaluationAtMs))
    .map((alert) => alert.id)
    .sort();
  const triggeredRoutes = [...new Set(triggeredAlerts.map((alertId) => findAlert(spec, alertId)?.route).filter(Boolean))].sort();

  return {
    alert_ids: triggeredAlerts,
    route_ids: triggeredRoutes,
  };
}

export function validateAlertCatalog(spec, drills) {
  const issues = [];
  const routeIds = new Set();
  const alertIds = new Set();
  const alertSignals = new Set();
  const drillCoveredAlerts = new Set();

  for (const route of spec.routes ?? []) {
    if (routeIds.has(route.id)) {
      issues.push(`duplicate route id: ${route.id}`);
    }
    routeIds.add(route.id);
  }

  for (const alert of spec.alerts ?? []) {
    if (alertIds.has(alert.id)) {
      issues.push(`duplicate alert id: ${alert.id}`);
    }
    alertIds.add(alert.id);

    if (!routeIds.has(alert.route)) {
      issues.push(`alert ${alert.id} references missing route ${alert.route}`);
    }

    collectConditionMetrics(alert.condition, alertSignals);
  }

  for (const drill of drills) {
    if (!isIsoTimestamp(drill.verification?.evaluation_at)) {
      issues.push(`drill ${drill.id} must define an ISO evaluation_at timestamp`);
    }

    for (const sample of drill.verification?.samples ?? []) {
      if (!isIsoTimestamp(sample.timestamp)) {
        issues.push(`drill ${drill.id} has a sample with invalid timestamp for ${sample.metric}`);
      }
    }

    for (const alertId of drill.expected_alert_ids ?? []) {
      if (!alertIds.has(alertId)) {
        issues.push(`drill ${drill.id} references missing alert ${alertId}`);
      } else {
        drillCoveredAlerts.add(alertId);
      }
    }

    for (const routeId of drill.expected_route_ids ?? []) {
      if (!routeIds.has(routeId)) {
        issues.push(`drill ${drill.id} references missing route ${routeId}`);
      }
    }

    const evaluation = evaluateDrill(spec, drill);
    const expectedAlerts = [...(drill.expected_alert_ids ?? [])].sort();
    const expectedRoutes = [...(drill.expected_route_ids ?? [])].sort();

    if (JSON.stringify(evaluation.alert_ids) !== JSON.stringify(expectedAlerts)) {
      issues.push(
        `drill ${drill.id} expected alerts ${expectedAlerts.join(', ')} but evaluated ${evaluation.alert_ids.join(', ')}`,
      );
    }

    if (JSON.stringify(evaluation.route_ids) !== JSON.stringify(expectedRoutes)) {
      issues.push(
        `drill ${drill.id} expected routes ${expectedRoutes.join(', ')} but evaluated ${evaluation.route_ids.join(', ')}`,
      );
    }
  }

  for (const metric of spec.required_signals ?? []) {
    if (!alertSignals.has(metric)) {
      issues.push(`required relay signal is not wired into an alert condition: ${metric}`);
    }
  }

  for (const alertId of alertIds) {
    if (!drillCoveredAlerts.has(alertId)) {
      issues.push(`alert ${alertId} must be covered by at least one synthetic drill`);
    }
  }

  const authRejectedAlert = findAlert(spec, 'relay-ws-auth-rejected-page');
  if (!authRejectedAlert || authRejectedAlert.route !== 'relay-config-pager' || authRejectedAlert.page_policy !== 'immediate') {
    issues.push('relay-ws-auth-rejected-page must stay on the immediate configuration pager route');
  }

  const networkAlert = findAlert(spec, 'relay-ws-network-sustained-page');
  if (!networkAlert || networkAlert.route !== 'relay-sustained-pager' || !String(networkAlert.page_policy).startsWith('sustained')) {
    issues.push('relay-ws-network-sustained-page must stay on a sustained paging route');
  }

  const retentionSilenceAlert = findAlert(spec, 'relay-retention-silence-page');
  if (retentionSilenceAlert?.condition?.type !== 'absent_counter' || retentionSilenceAlert.condition?.missing_for_days < 2) {
    issues.push('relay-retention-silence-page must enforce at least a two-day silence window');
  }

  const retryBrakeAlert = findAlert(spec, 'relay-r2-backoff-saturation-page');
  if (retryBrakeAlert?.condition?.type !== 'gauge' || retryBrakeAlert.condition?.metric !== 'relay.r2.publish_failure_streak' || retryBrakeAlert.condition?.min_value < 5) {
    issues.push('relay-r2-backoff-saturation-page must alert once publish_failure_streak reaches the 60-second retry ceiling');
  }

  return issues;
}

function validateRouteBindings(spec, manifest, issues) {
  const bindings = manifest.route_bindings ?? {};

  for (const route of spec.routes) {
    const binding = bindings[route.id];

    if (!binding) {
      issues.push(`missing route binding for ${route.id}`);
      continue;
    }

    if (!isFilledString(binding.destination_ref)) {
      issues.push(`route binding ${route.id} must define a non-placeholder destination_ref`);
    }

    if (!isFilledString(binding.owner)) {
      issues.push(`route binding ${route.id} must define a non-placeholder owner`);
    }

    if (!isIsoTimestamp(binding.validated_at)) {
      issues.push(`route binding ${route.id} must define validated_at`);
    }
  }

  const configPager = bindings['relay-config-pager'];
  const sustainedPager = bindings['relay-sustained-pager'];

  if (
    configPager &&
    sustainedPager &&
    isFilledString(configPager.destination_ref) &&
    isFilledString(sustainedPager.destination_ref) &&
    configPager.destination_ref === sustainedPager.destination_ref
  ) {
    issues.push('relay-config-pager and relay-sustained-pager must resolve to different destinations');
  }
}

function validateAlertReceipts(spec, manifest, issues) {
  const receipts = manifest.alert_rule_receipts ?? {};

  for (const alert of spec.alerts) {
    const receipt = receipts[alert.id];

    if (!receipt) {
      issues.push(`missing alert_rule_receipt for ${alert.id}`);
      continue;
    }

    if (!isFilledString(receipt.provider_rule_ref)) {
      issues.push(`alert_rule_receipt ${alert.id} must define provider_rule_ref`);
    }

    if (!isIsoTimestamp(receipt.validated_at)) {
      issues.push(`alert_rule_receipt ${alert.id} must define validated_at`);
    }
  }
}

function validateDrillReceipts(spec, drills, manifest, issues) {
  const receipts = manifest.staging_drill_receipts ?? {};
  const coveredAlerts = new Set();

  for (const drill of drills) {
    const receipt = receipts[drill.id];

    if (!receipt) {
      issues.push(`missing staging_drill_receipt for ${drill.id}`);
      continue;
    }

    if (receipt.environment !== 'staging') {
      issues.push(`staging_drill_receipt ${drill.id} must record environment=staging`);
    }

    if (!isIsoTimestamp(receipt.performed_at)) {
      issues.push(`staging_drill_receipt ${drill.id} must define performed_at`);
    }

    if (!isFilledString(receipt.evidence_ref)) {
      issues.push(`staging_drill_receipt ${drill.id} must define evidence_ref`);
    }

    if (!isFilledString(receipt.validated_by)) {
      issues.push(`staging_drill_receipt ${drill.id} must define validated_by`);
    }

    const observedAlerts = [...new Set(receipt.observed_alert_ids ?? [])].sort();
    const expectedAlerts = [...(drill.expected_alert_ids ?? [])].sort();
    const observedRoutes = [...new Set(receipt.observed_route_ids ?? [])].sort();
    const expectedRoutes = [...(drill.expected_route_ids ?? [])].sort();
    let matchesExpectedCoverage = true;

    if (JSON.stringify(observedAlerts) !== JSON.stringify(expectedAlerts)) {
      issues.push(`staging_drill_receipt ${drill.id} must record alerts ${expectedAlerts.join(', ')}`);
      matchesExpectedCoverage = false;
    }

    if (JSON.stringify(observedRoutes) !== JSON.stringify(expectedRoutes)) {
      issues.push(`staging_drill_receipt ${drill.id} must record routes ${expectedRoutes.join(', ')}`);
      matchesExpectedCoverage = false;
    }

    if (!matchesExpectedCoverage) {
      continue;
    }

    for (const alertId of expectedAlerts) {
      coveredAlerts.add(alertId);
    }
  }

  for (const alert of spec.alerts) {
    if (!coveredAlerts.has(alert.id)) {
      issues.push(`staging_drill_receipts must cover alert ${alert.id}`);
    }
  }
}

function validateChecklist(spec, manifest, issues) {
  const checklist = manifest.deployment_checklist ?? {};

  for (const key of spec.readiness_checklist ?? []) {
    const value = checklist[key];

    if (key.endsWith('_by')) {
      if (!isFilledString(value)) {
        issues.push(`deployment_checklist.${key} must be filled in`);
      }
      continue;
    }

    if (!isIsoTimestamp(value)) {
      issues.push(`deployment_checklist.${key} must be an ISO timestamp`);
    }
  }
}

function findTomlBindingBlock(wranglerText, sectionName, bindingName) {
  const sectionPattern = new RegExp(`\\[\\[${sectionName}\\]\\][\\s\\S]*?(?=\\n\\[\\[|\\n\\[[^\\[]|$)`, 'g');
  const bindingPattern = new RegExp(`\\bbinding\\s*=\\s*"${bindingName}"`);

  return (wranglerText.match(sectionPattern) ?? []).find((block) => bindingPattern.test(block));
}

function extractTomlBindingValue(block, key) {
  return block.match(new RegExp(`\\b${key}\\s*=\\s*"([^"\n]*)"`))?.[1];
}

function stripTomlComments(wranglerText) {
  return wranglerText
    .split('\n')
    .map((line) => {
      let stripped = '';
      let inQuote = false;
      let escaped = false;

      for (const character of line) {
        if (character === '"' && !escaped) {
          inQuote = !inQuote;
          stripped += character;
          escaped = false;
          continue;
        }

        if (character === '#' && !inQuote) {
          break;
        }

        stripped += character;
        escaped = character === '\\' && !escaped;
      }

      return stripped.trimEnd();
    })
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

export function validateWranglerProductionConfig(wranglerText) {
  const issues = [];
  const normalizedWranglerText = stripTomlComments(wranglerText);

  if (!/crons\s*=\s*\[\s*"0 3 \* \* \*"\s*\]/.test(normalizedWranglerText)) {
    issues.push('wrangler.toml must keep the daily 03:00 UTC retention cron enabled');
  }

  const historyDatabaseBlock = findTomlBindingBlock(normalizedWranglerText, 'd1_databases', 'HISTORY_DB');
  if (!historyDatabaseBlock) {
    issues.push('wrangler.toml must define [[d1_databases]] binding = "HISTORY_DB"');
  } else {
    const databaseId = extractTomlBindingValue(historyDatabaseBlock, 'database_id');
    const previewDatabaseId = extractTomlBindingValue(historyDatabaseBlock, 'preview_database_id');

    if (databaseId === undefined) {
      issues.push('wrangler.toml must define a database_id for HISTORY_DB');
    }
    if (previewDatabaseId === undefined) {
      issues.push('wrangler.toml must define a preview_database_id for HISTORY_DB');
    }

    if ((databaseId !== undefined && !isFilledString(databaseId)) || (previewDatabaseId !== undefined && !isFilledString(previewDatabaseId))) {
      issues.push('wrangler.toml still contains placeholder D1 database IDs');
    }
  }

  const snapshotBucketBlock = findTomlBindingBlock(normalizedWranglerText, 'r2_buckets', 'SNAPSHOT_BUCKET');
  if (!snapshotBucketBlock) {
    issues.push('wrangler.toml must define [[r2_buckets]] binding = "SNAPSHOT_BUCKET"');
  } else {
    const bucketName = extractTomlBindingValue(snapshotBucketBlock, 'bucket_name');
    const previewBucketName = extractTomlBindingValue(snapshotBucketBlock, 'preview_bucket_name');

    if (bucketName === undefined) {
      issues.push('wrangler.toml must define a bucket_name for SNAPSHOT_BUCKET');
    }
    if (previewBucketName === undefined) {
      issues.push('wrangler.toml must define a preview_bucket_name for SNAPSHOT_BUCKET');
    }

    if ((bucketName !== undefined && !isFilledString(bucketName)) || (previewBucketName !== undefined && !isFilledString(previewBucketName))) {
      issues.push('wrangler.toml still contains placeholder R2 bucket names');
    }
  }

  return issues;
}

export function validateReadinessManifest(spec, drills, manifest, { target, wranglerText }) {
  const issues = [];
  if (!['catalog', 'production'].includes(target)) {
    issues.push(`unsupported readiness target: ${target}`);
    return issues;
  }

  if (manifest.spec_version !== spec.version) {
    issues.push(`manifest spec_version ${manifest.spec_version} does not match ${spec.version}`);
  }

  if (target === 'production' && manifest.environment !== 'production') {
    issues.push('production validation requires manifest.environment to be production');
  }

  validateRouteBindings(spec, manifest, issues);
  validateAlertReceipts(spec, manifest, issues);
  validateDrillReceipts(spec, drills, manifest, issues);
  validateChecklist(spec, manifest, issues);

  if (target === 'production') {
    issues.push(...validateWranglerProductionConfig(wranglerText));
  }

  return issues;
}
