import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'test/e2e/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/fingerprint/**', 'src/similarity/**', 'src/repository/**', 'src/engine/**', 'src/shared/**'],
      thresholds: {
        lines: 80,
        branches: 75,
      },
    },
  },
});
