import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['app/test/**/*.test.ts', 'app/test/**/*.test.tsx', 'worker/test/**/*.test.ts'],
    setupFiles: ['app/test/setup.ts'],
  },
});
