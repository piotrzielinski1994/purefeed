import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: 'test/global-setup.ts',
    include: ['src/**/*.perf.test.ts'],
    exclude: configDefaults.exclude,
    fileParallelism: false,
  },
});
