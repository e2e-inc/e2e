import type { E2EConfig, LaunchArguments } from 'e2e';
import base, { ios } from './e2e.config.ts';

/**
 * Hand-run check that `app.launchArguments` reaches the app as an object and as
 * a list (`tests-launch-arguments/launch-arguments.e2e.ts`). Each
 * deterministic target runs twice, once per form, with the arguments the
 * docs give as the example for its platform.
 */
interface Forms {
  readonly object: LaunchArguments;
  readonly list: LaunchArguments;
}

const IOS: Forms = {
  object: { AppleLanguages: ['fr'], AppleLocale: 'fr_FR' },
  list: ['-AppleLanguages', '(fr)', '-AppleLocale', 'fr_FR'],
};

const ANDROID: Forms = { object: { e2e: true }, list: ['--es', 'e2e', 'true'] };

export default {
  ...base,
  projectId: 'dev.e2e.mobile-benchmark-launch-arguments',
  tests: 'tests-launch-arguments/**/*.e2e.ts',
  targets: base.targets.flatMap((target) => {
    const forms = target.engine === ios ? IOS : ANDROID;
    return (['object', 'list'] as const).map((form) => ({
      ...target,
      name: `${target.name}-${form}`,
      app: { ...target.app, identity: `${target.app.identity}-${form}`, launchArguments: forms[form] },
    }));
  }),
  workers: 1,
  retries: 0,
  reporters: ['list'],
} satisfies E2EConfig;
