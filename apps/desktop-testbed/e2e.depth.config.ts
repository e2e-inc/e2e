import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';
import base from './e2e.config.ts';

/**
 * The read-depth suite: the same app read with `desktop({ maxDepth: 1 })`,
 * which reads the window and the level below it. `pnpm test` runs it after
 * the default suite.
 */
export default {
  ...base,
  projectId: 'dev.e2e.desktop-testbed-depth',
  tests: 'tests-depth/**/*.e2e.ts',
  targets: [{ ...base.targets[0], engine: desktop({ maxDepth: 1 }) }],
} satisfies E2EConfig;
