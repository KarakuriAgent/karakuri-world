import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(rootDir, 'src', 'admin');
const destinationDir = join(rootDir, 'dist', 'src', 'admin');

async function copyDirectory(sourcePath, destinationPath) {
  await mkdir(destinationPath, { recursive: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    const sourceEntryPath = join(sourcePath, entry.name);
    const destinationEntryPath = join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntryPath, destinationEntryPath);
      continue;
    }

    await mkdir(dirname(destinationEntryPath), { recursive: true });
    await copyFile(sourceEntryPath, destinationEntryPath);
  }
}

await rm(destinationDir, { recursive: true, force: true });
await copyDirectory(sourceDir, destinationDir);
