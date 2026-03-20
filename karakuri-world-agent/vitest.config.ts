import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    env: {
      LOG_LEVEL: 'error',
    },
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
