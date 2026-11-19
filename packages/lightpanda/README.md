# @e2e-dev/lightpanda

[Lightpanda](https://lightpanda.io), the open-source headless browser, for
[`e2e`](https://www.npmjs.com/package/e2e): `web({ browser: lightpanda() })`
starts a `lightpanda serve` for each worker slot and stops it with the run.
The web engine cannot open a page in it yet.

## Install

```bash
npm install --save-dev @e2e-dev/lightpanda
brew install lightpanda-io/browser/lightpanda
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { lightpanda } from '@e2e-dev/lightpanda';

export default {
  targets: [{ engine: web({ browser: lightpanda({ loadResources: ['stylesheet', 'iframe'] }) }), app: { url: 'http://localhost:3000' } }],
  workers: 4,
} satisfies E2EConfig;
```

The binary comes from `binary`, `LIGHTPANDA_PATH` in the run's environment,
or `lightpanda` on `PATH`, `~/.lightpanda`, or `~/.local/bin`.
`loadResources` passes `--load-resources` for `iframe`, `image`, and
`stylesheet`, and defaults to `['stylesheet']`; `args` adds any other
`serve` flag. A server already running,
such as the Docker image in CI, is a `web({ connect })` target instead.

A test that opens a page times out. See
[e2e.com/docs/integrations/lightpanda](https://e2e.com/docs/integrations/lightpanda#what-does-not-work).

## License

Apache-2.0
