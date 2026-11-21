# @e2e-dev/revyl

Run `@e2e-dev/mobile` tests on [Revyl](https://revyl.com) hosted iOS simulators and
Android emulators. Each worker slot leases one device, with your app installed, and
releases it when the run ends.

```bash
npm install --save-dev e2e @e2e-dev/mobile @e2e-dev/revyl
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { revyl } from '@e2e-dev/revyl';

export default {
  targets: [
    {
      engine: mobile({
        platform: 'android',
        device: revyl({ app: 'https://builds.example.com/app.apk', device: 'Pixel 7' }),
      }),
      app: { bundleId: 'com.example.app' },
    },
  ],
  workers: 2,
} satisfies E2EConfig;
```

Set `REVYL_API_KEY` in the run environment. `app` is an `https` URL Revyl downloads the
build from, and `device` and `osVersion` are names from Revyl's device catalog.

For websites, `revylWeb()` from `@e2e-dev/revyl/web` runs web targets in Chrome on Revyl.
It is an engine of its own and needs neither `@e2e-dev/mobile` nor `@e2e-dev/web`:

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { revylWeb } from '@e2e-dev/revyl/web';

export default {
  targets: [{ engine: revylWeb({ app: '<Revyl Web app id>' }), app: { url: 'https://staging.example.com' } }],
  assertionTimeout: 15_000,
} satisfies E2EConfig;
```

See the [integration guide](https://e2e.com/docs/integrations/revyl) for every option
and the limits.
