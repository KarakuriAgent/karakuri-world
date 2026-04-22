import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateDrill,
  loadJson,
  validateAlertCatalog,
  validateReadinessManifest,
} from '../ops/relay-readiness.js';

const SUPPORTED_TARGETS = new Set(['catalog', 'production']);

function defaultWranglerPath() {
  const deployable = resolve('wrangler.toml');
  if (existsSync(deployable)) {
    return deployable;
  }
  return resolve('wrangler.toml.example');
}

function parseArgs(argv) {
  const options = {
    target: 'catalog',
    spec: resolve('worker/ops/relay-alerting-spec.json'),
    drills: resolve('worker/ops/relay-synthetic-drills.json'),
    wrangler: defaultWranglerPath(),
    manifest: undefined,
  };
  const errors = [];
  const provided = new Set();
  const optionHandlers = {
    target: (value) => {
      options.target = value;
    },
    spec: (value) => {
      options.spec = resolve(value);
    },
    drills: (value) => {
      options.drills = resolve(value);
    },
    manifest: (value) => {
      options.manifest = resolve(value);
    },
    wrangler: (value) => {
      options.wrangler = resolve(value);
    },
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? '';

    if (!value.startsWith('--')) {
      errors.push(`unexpected positional argument: ${value}`);
      continue;
    }

    const [rawFlag, inlineValue] = value.split(/=(.*)/s, 2);
    const optionName = rawFlag.slice(2);
    const handler = optionHandlers[optionName];

    if (!handler) {
      errors.push(`unsupported relay readiness option: ${rawFlag}`);
      continue;
    }

    const optionValue = inlineValue ?? argv[index + 1];
    if (
      optionValue === undefined ||
      optionValue.trim().length === 0 ||
      (inlineValue === undefined && optionValue.startsWith('--'))
    ) {
      errors.push(`missing value for ${rawFlag}`);
      continue;
    }

    provided.add(optionName);
    handler(optionValue);

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return {
    options,
    errors,
    provided,
  };
}

const { options, errors, provided } = parseArgs(process.argv.slice(2));

if (!SUPPORTED_TARGETS.has(options.target)) {
  errors.push(`unsupported relay readiness target: ${options.target}`);
}

if (options.target === 'production' && !options.manifest) {
  errors.push('--target=production requires --manifest');
}

if (provided.has('manifest') && options.target !== 'production') {
  errors.push('--manifest requires --target=production');
}

if (provided.has('wrangler') && options.target !== 'production') {
  errors.push('--wrangler requires --target=production');
}

if (errors.length > 0) {
  console.error('relay readiness invocation failed');
  for (const issue of errors) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

const spec = loadJson(options.spec);
const drillsDocument = loadJson(options.drills);
const drills = drillsDocument.drills ?? [];
const issues = validateAlertCatalog(spec, drills);

if (options.manifest) {
  const manifest = loadJson(options.manifest);
  const wranglerText = readFileSync(options.wrangler, 'utf8');
  issues.push(...validateReadinessManifest(spec, drills, manifest, { target: options.target, wranglerText }));
}

if (issues.length > 0) {
  console.error('relay readiness validation failed');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.info(`relay readiness validation passed (${spec.alerts.length} alerts, ${drills.length} drills)`);
for (const drill of drills) {
  const evaluation = evaluateDrill(spec, drill);
  console.info(`- ${drill.id}: ${evaluation.alert_ids.join(', ')} -> ${evaluation.route_ids.join(', ')}`);
}
