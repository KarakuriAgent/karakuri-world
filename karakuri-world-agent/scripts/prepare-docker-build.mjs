import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const stageDir = join(repoRoot, '.docker-build');
const stageInputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'agents'];

function stageInput(inputPath) {
  const sourcePath = join(repoRoot, inputPath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required file or directory: ${inputPath}`);
  }

  cpSync(sourcePath, join(stageDir, inputPath), { recursive: true });
}

rmSync(stageDir, { force: true, recursive: true });
mkdirSync(stageDir, { recursive: true });

for (const inputPath of stageInputs) {
  stageInput(inputPath);
}

const dockerArgs = ['run', '--rm'];
if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
  dockerArgs.push('--user', `${process.getuid()}:${process.getgid()}`);
}

dockerArgs.push(
  '--volume',
  `${stageDir}:/app`,
  '--workdir',
  '/app',
  'node:24-slim',
  'sh',
  '-lc',
  'npm ci --include=dev && npm run build && npm prune --omit=dev',
);

console.log('Preparing .docker-build/ using node:24-slim...');
execFileSync('docker', dockerArgs, { stdio: 'inherit' });
console.log('Prepared .docker-build/. You can now run docker build or docker compose up --build.');
