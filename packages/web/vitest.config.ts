import { defineConfig } from 'vitest/config';

/**
 * The budget of one test and of one hook. `E2E_WEB_TEST_TIMEOUT_MS` raises
 * both on a runner where a browser launch alone takes many seconds: the
 * `--hookTimeout` flag does not reach a project.
 */
const TIMEOUT_MS = Number(process.env['E2E_WEB_TEST_TIMEOUT_MS'] ?? 30_000);

/**
 * Unit tests are pure and run fully in parallel. Integration tests own real
 * browser processes, so their concurrency is bounded: oversubscribing CPUs
 * starves them into timeouts that are indistinguishable from product failures.
 * The integration suite runs once on Chromium and once on Firefox; a test
 * gets its browser from `testBrowser` (`tests/helpers/web-session.ts`), and
 * each project sets it, whatever `E2E_WEB_BROWSER` the shell exports. A
 * file in `tests/integration/chromium/` runs on Chromium only: it attaches
 * to Chrome over CDP, reads Chrome's own accessibility tree, or installs
 * Chromium itself.
 */
const integration = {
  include: ['tests/integration/**/*.test.ts'],
  testTimeout: TIMEOUT_MS,
  hookTimeout: TIMEOUT_MS,
  pool: 'forks',
  maxWorkers: 3,
  minWorkers: 1,
  sequence: { groupOrder: 1 },
} as const;

export default defineConfig({
  test: {
    testTimeout: TIMEOUT_MS,
    hookTimeout: TIMEOUT_MS,
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: TIMEOUT_MS,
          hookTimeout: TIMEOUT_MS,
          pool: 'forks',
        },
      },
      { test: { ...integration, name: 'integration', env: { E2E_WEB_BROWSER: 'chromium' } } },
      {
        test: {
          ...integration,
          name: 'integration-firefox',
          exclude: ['tests/integration/chromium/**'],
          env: { E2E_WEB_BROWSER: 'firefox' },
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
