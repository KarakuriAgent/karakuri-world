/**
 * Docker ビルド準備スクリプト
 *
 * 標準的なマルチステージ Dockerfile の代わりに、ホスト側でファイルをステージングし
 * node:24-slim コンテナ内で npm ci / build / prune を実行することで、
 * ホストとコンテナのアーキテクチャ差異（ネイティブモジュール等）を解消する。
 *
 * 生成物: .docker-build/ ディレクトリ（本番用 node_modules, dist, package.json 等）
 * 使い方: npm run docker:prepare → docker build . または npm run docker:up
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const stageDir = join(repoRoot, '.docker-build');
// 'scripts' is needed because 'npm run build' invokes scripts/copy-assets.mjs
const stageInputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'scripts'];

function stageInput(inputPath) {
  const sourcePath = join(repoRoot, inputPath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required file or directory: ${inputPath}`);
  }

  try {
    cpSync(sourcePath, join(stageDir, inputPath), { recursive: true });
  } catch (error) {
    throw new Error(`Failed to copy '${inputPath}' to staging directory: ${error.message}`);
  }
}

try {
  rmSync(stageDir, { force: true, recursive: true });
  mkdirSync(stageDir, { recursive: true });
} catch (error) {
  console.error(`Failed to prepare staging directory '${stageDir}': ${error.message}`);
  console.error('Ensure no other process is using this directory and that you have write permissions.');
  process.exit(1);
}

for (const inputPath of stageInputs) {
  stageInput(inputPath);
}

const dockerArgs = ['run', '--rm'];
// On Linux, pass the host user's UID/GID so that files written to the
// bind-mounted .docker-build/ directory are owned by the current user
// rather than root. process.getuid/getgid are unavailable on Windows.
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
  '-c',
  'npm ci --include=dev && npm run build && npm prune --omit=dev',
);

console.log('Preparing .docker-build/ using node:24-slim...');
try {
  execFileSync('docker', dockerArgs, { stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('Error: Docker is not installed or not found in PATH.');
    console.error('Please install Docker to use this script: https://docs.docker.com/get-docker/');
    process.exit(1);
  }
  if (error.status != null) {
    // Docker error output is already visible via stdio: 'inherit'
    console.error(`Docker build failed with exit code ${error.status}.`);
    process.exit(error.status);
  }
  throw error;
}
console.log('Build preparation complete (.docker-build/)');
