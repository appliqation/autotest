import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
  },
});
