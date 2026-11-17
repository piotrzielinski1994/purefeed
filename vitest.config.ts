import { configDefaults, defineConfig } from 'vitest/config';

const COVERED_DIRS = ['src/fingerprint', 'src/similarity', 'src/repository', 'src/engine', 'src/shared'];
const MIN_COVERAGE = { lines: 80, branches: 75 };

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: 'test/global-setup.ts',
    exclude: [...configDefaults.exclude, 'test/e2e/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      include: COVERED_DIRS.map((dir) => `${dir}/**`),
      thresholds: {
        ...MIN_COVERAGE,
        ...Object.fromEntries(COVERED_DIRS.map((dir) => [`${dir}/**`, MIN_COVERAGE])),
      },
    },
  },
});
