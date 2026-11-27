import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';
import base from './e2e.config.ts';

/**
 * The SwiftUI suite: TaskBoard, a SwiftUI app with the surfaces the AppKit
 * sign-in form has none of (sheets, alerts, popovers, steppers, a toolbar
 * menu, a lazy 200-row list, tabs, a window with no focusable control).
 * `pnpm build:app` builds it beside the sign-in form; `pnpm test` runs this
 * suite after the default one, in the background like it.
 */
export default {
  ...base,
  projectId: 'dev.e2e.desktop-testbed-swiftui',
  tests: 'tests-swiftui/**/*.e2e.ts',
  targets: [{ name: 'macos', engine: desktop(), app: { appPath: 'build/TaskBoard.app' } }],
} satisfies E2EConfig;
