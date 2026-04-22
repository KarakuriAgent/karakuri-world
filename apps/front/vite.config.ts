import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type ConfigEnv } from 'vite';

import { validateEnv } from './app/env-contract.js';

export function shouldValidateEnv({ command, isPreview }: Pick<ConfigEnv, 'command' | 'isPreview'>): boolean {
  return command === 'build' || (command === 'serve' && !isPreview);
}

export default defineConfig(({ mode, ...configEnv }) => {
  if (shouldValidateEnv(configEnv)) {
    validateEnv(loadEnv(mode, process.cwd(), ''));
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '0.0.0.0',
    },
    preview: {
      host: '0.0.0.0',
    },
  };
});
